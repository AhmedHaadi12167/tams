/**
 * loginSecurity.js
 *
 * Everything that decides whether a login attempt is allowed, and what gets
 * written down about it afterwards.
 *
 * Two ideas, kept deliberately separate from the controller so the login
 * flow reads as a sequence of plain questions:
 *
 *   1. Lockout — after MAX_ATTEMPTS consecutive failures an account is
 *      frozen for LOCK_MINUTES. The counter is per account, not per IP,
 *      because an attacker can change address far more easily than they
 *      can guess a password.
 *
 *   2. Audit — every attempt leaves a row saying who, when, from where and
 *      what happened. No password material is ever stored.
 *
 * Both degrade quietly if migration_v10 has not been run yet: the login
 * still works, it just isn't protected or recorded. A pending migration
 * should never lock people out of their own system.
 */

const { query } = require("../config/db");
const { hasTable, hasColumn } = require("./schemaInfo");

/** Consecutive failures before an account is frozen. */
const MAX_ATTEMPTS = 5;

/** How long the freeze lasts. */
const LOCK_MINUTES = 15;

/**
 * The caller's address. `app.set("trust proxy", 1)` in index.js means
 * req.ip is the real client address from Nginx's X-Forwarded-For, not
 * Nginx's own loopback address.
 */
const clientIp = (req) =>
  String(req.ip || req.connection?.remoteAddress || "").slice(0, 64) || null;

/**
 * Write one row to login_audit. Never throws — a failure to record must
 * not turn a valid login into an error.
 */
const recordAttempt = async ({ req, userId, email, success, reason }) => {
  try {
    if (!(await hasTable("login_audit"))) return;
    await query(
      `INSERT INTO login_audit (user_id, email, success, reason, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId || null,
        email ? String(email).slice(0, 255) : null,
        Boolean(success),
        reason ? String(reason).slice(0, 64) : null,
        clientIp(req),
        String(req.headers["user-agent"] || "").slice(0, 1000) || null,
      ],
    );
  } catch {
    /* auditing is best-effort */
  }
};

/** True once the lockout columns exist. */
const lockoutReady = () => hasColumn("users", "locked_until");

/**
 * Is this account currently frozen, and for how much longer?
 * Rounds up, so "1 minute" never displays as "0 minutes".
 */
const lockState = (user) => {
  if (!user?.locked_until) return { locked: false, minutesLeft: 0 };
  const until = new Date(user.locked_until).getTime();
  const ms = until - Date.now();
  if (ms <= 0) return { locked: false, minutesLeft: 0 };
  return { locked: true, minutesLeft: Math.ceil(ms / 60000) };
};

/**
 * Count a failure. Returns the resulting state so the caller can tell the
 * user they have just been locked out rather than leaving them to discover
 * it on the next attempt.
 */
const registerFailure = async (userId) => {
  if (!(await lockoutReady())) return { locked: false, remaining: null };

  const r = await query(
    `UPDATE users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE
              WHEN failed_attempts + 1 >= $2
              THEN NOW() + ($3 || ' minutes')::INTERVAL
              ELSE locked_until
            END
      WHERE id = $1
      RETURNING failed_attempts, locked_until`,
    [userId, MAX_ATTEMPTS, String(LOCK_MINUTES)],
  );

  const row = r.rows[0];
  if (!row) return { locked: false, remaining: null };

  const state = lockState(row);
  return {
    locked: state.locked,
    minutesLeft: state.minutesLeft,
    remaining: Math.max(0, MAX_ATTEMPTS - row.failed_attempts),
  };
};

/** A successful login wipes the slate. */
const clearFailures = async (userId) => {
  if (!(await lockoutReady())) return;
  await query(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`,
    [userId],
  );
};

/** True once single-session support exists in the database. */
const sessionsReady = () => hasColumn("users", "session_id");

module.exports = {
  MAX_ATTEMPTS,
  LOCK_MINUTES,
  clientIp,
  recordAttempt,
  lockState,
  registerFailure,
  clearFailures,
  lockoutReady,
  sessionsReady,
};
