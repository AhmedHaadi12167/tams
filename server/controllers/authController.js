const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { withTransaction, query } = require('../config/db');
const response = require('../utils/response');

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

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

    const result = await query(
      `SELECT u.id, u.business_id, u.name, u.email, u.password_hash, u.role, u.is_active,
              b.name AS business_name, b.status AS business_status
       FROM users u
       LEFT JOIN businesses b ON b.id = u.business_id
       WHERE u.email = $1`,
      [email]
    );

    const user = result.rows[0];
    if (!user) return response.unauthorized(res, 'Invalid email or password');
    if (!user.is_active) return response.unauthorized(res, 'Account is deactivated');
    if (user.business_status === 'suspended') return response.unauthorized(res, 'Agency account is suspended');

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) return response.unauthorized(res, 'Invalid email or password');

    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    const token = generateToken(user.id);
    const { password_hash, ...safeUser } = user;

    return response.success(res, { token, user: safeUser }, 'Login successful');
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

module.exports = { createBusiness, businessValidation, login, loginValidation, getMe };
