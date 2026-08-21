const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { withTransaction, query } = require('../config/db');
const response = require('../utils/response');
const {
  MAX_ATTEMPTS,
  recordAttempt,
  lockState,
  registerFailure,
  clearFailures,
  sessionsReady,
  lockoutReady,
} = require('../services/loginSecurity');

/**
 * The token carries the session id alongside the user id. The auth
 * middleware checks that id against the users row on every request, which
 * is what makes "logging in here signs you out there" possible without
 * keeping server-side session state.
 */
const generateToken = (userId, sessionId) => {
  const payload = { userId };
  if (sessionId) payload.sid = sessionId;
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

/**
 * One message for "no such account" and for "wrong password".
 *
 * Telling them apart would let anyone confirm which email addresses have
 * accounts here simply by trying them — the first step of a targeted
 * attack, and a privacy leak about your staff besides.
 */
const GENERIC_REJECT = 'Invalid email or password';

/**
 * A throwaway hash to compare against when the email doesn't exist.
 *
 * Without this, a missing account returns in a millisecond while a real
 * one takes the ~200ms bcrypt needs — a difference an attacker can measure
 * to enumerate valid addresses. Doing the work either way removes the tell.
 */
const DUMMY_HASH = bcrypt.hashSync('timing-attack-placeholder', 12);

const businessValidation = [
  body('business_name').trim().notEmpty().withMessage('Business name is required'),
  body('business_email').isEmail().withMessage('Valid business email is required'),
  body('admin_name').trim().notEmpty().withMessage('Admin name is required'),
  body('admin_email').isEmail().withMessage('Valid admin email is required'),
  body('admin_password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
];

const loginValidation = [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
];

/**
 * POST /api/auth/create-business
 * Super admin only — creates a new tenant + admin user
 */
const createBusiness = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const { business_name, business_email, business_phone, business_address, admin_name, admin_email, admin_password } = req.body;

    const result = await withTransaction(async (client) => {
      const bizResult = await client.query(
        `INSERT INTO businesses (name, email, phone, address) VALUES ($1, $2, $3, $4) RETURNING id, name, email`,
        [business_name, business_email, business_phone || null, business_address || null]
      );
      const business = bizResult.rows[0];

      const passwordHash = await bcrypt.hash(admin_password, 12);
      const userResult = await client.query(
        `INSERT INTO users (business_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'admin') RETURNING id, name, email, role`,
        [business.id, admin_name, admin_email, passwordHash]
      );

      return { business, user: userResult.rows[0] };
    });

    return response.created(res, result, 'Business registered successfully');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/login
 */
const login = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const { email, password } = req.body;
    const trackLockout = await lockoutReady();

    // Email is matched case-insensitively — people capitalise inconsistently,
    // and an address is not case-sensitive in practice.
    const result = await query(
      `SELECT u.id, u.business_id, u.name, u.email, u.password_hash, u.role, u.is_active,
              ${trackLockout ? 'u.failed_attempts, u.locked_until,' : ''}
              b.name AS business_name, b.status AS business_status
       FROM users u
       LEFT JOIN businesses b ON b.id = u.business_id
       WHERE LOWER(u.email) = LOWER($1)`,
      [email]
    );

    const user = result.rows[0];

    // Unknown address: burn the same time a real check would, so the
    // response time gives nothing away.
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      await recordAttempt({ req, email, success: false, reason: 'unknown_email' });
      return response.unauthorized(res, GENERIC_REJECT);
    }

    // Frozen by too many failures. Checked before the password so that
    // guessing during a lockout gains an attacker nothing at all.
    const lock = lockState(user);
    if (lock.locked) {
      await recordAttempt({
        req, userId: user.id, email, success: false, reason: 'locked_out',
      });
      return response.unauthorized(
        res,
        `Too many failed attempts. Try again in ${lock.minutesLeft} minute${
          lock.minutesLeft === 1 ? '' : 's'
        }.`,
        'ACCOUNT_LOCKED'
      );
    }

    if (!user.is_active) {
      await recordAttempt({
        req, userId: user.id, email, success: false, reason: 'deactivated',
      });
      return response.unauthorized(res, 'Account is deactivated');
    }

    if (user.business_status === 'suspended') {
      await recordAttempt({
        req, userId: user.id, email, success: false, reason: 'business_suspended',
      });
      return response.unauthorized(res, 'Agency account is suspended');
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      const after = await registerFailure(user.id);
      await recordAttempt({
        req, userId: user.id, email, success: false, reason: 'bad_password',
      });

      // Say so at the moment it happens, rather than letting them discover
      // the lockout on an attempt they think should have worked.
      if (after.locked) {
        return response.unauthorized(
          res,
          `Too many failed attempts. This account is locked for ${after.minutesLeft} minutes.`,
          'ACCOUNT_LOCKED'
        );
      }
      if (after.remaining !== null && after.remaining <= 2) {
        return response.unauthorized(
          res,
          `${GENERIC_REJECT}. ${after.remaining} attempt${
            after.remaining === 1 ? '' : 's'
          } left before the account is locked.`
        );
      }
      return response.unauthorized(res, GENERIC_REJECT);
    }

    // ── Success ────────────────────────────────────────────────────────
    await clearFailures(user.id);

    // A new session id retires whatever token was issued last time. The
    // other device is signed out the moment it next talks to the server.
    let sessionId = null;
    if (await sessionsReady()) {
      sessionId = crypto.randomUUID();
      await query(
        'UPDATE users SET last_login = NOW(), session_id = $2 WHERE id = $1',
        [user.id, sessionId]
      );
    } else {
      await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    }

    await recordAttempt({ req, userId: user.id, email, success: true, reason: 'ok' });

    const token = generateToken(user.id, sessionId);
    const { password_hash, failed_attempts, locked_until, ...safeUser } = user;

    return response.success(res, { token, user: safeUser }, 'Login successful');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/logout
 *
 * Clears the stored session id, which retires the caller's token
 * immediately instead of leaving it valid until it expires. Without this,
 * "log out" would only mean "forget the token on this device" — and a copy
 * taken from the browser beforehand would keep working for days.
 */
const logout = async (req, res, next) => {
  try {
    if (await sessionsReady()) {
      await query('UPDATE users SET session_id = NULL WHERE id = $1', [req.user.id]);
    }
    return response.success(res, null, 'Signed out');
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/auth/me
 */
const getMe = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.business_id, u.name, u.email, u.role, u.last_login,
              b.name AS business_name, b.logo_url
       FROM users u
       LEFT JOIN businesses b ON b.id = u.business_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    return response.success(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createBusiness,
  businessValidation,
  login,
  loginValidation,
  logout,
  getMe,
};
