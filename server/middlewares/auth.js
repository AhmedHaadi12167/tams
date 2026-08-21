const jwt = require("jsonwebtoken");
const { query } = require("../config/db");
const response = require("../utils/response");
const { sessionsReady } = require("../services/loginSecurity");

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return response.unauthorized(res, "No token provided");
    }
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // One session per account. The check is free: this row is fetched on
    // every request anyway to confirm the user is still active, so adding
    // session_id to the SELECT costs nothing.
    const trackSessions = await sessionsReady();

    const result = await query(
      `SELECT id, business_id, name, email, role, is_active
              ${trackSessions ? ", session_id" : ""}
         FROM users WHERE id = $1`,
      [decoded.userId],
    );
    if (result.rows.length === 0 || !result.rows[0].is_active) {
      return response.unauthorized(res, "User not found or deactivated");
    }

    if (trackSessions) {
      const current = result.rows[0].session_id;
      // Mismatch means someone signed in elsewhere and this token was
      // retired. Null means the account signed out. Both end the session,
      // but the message differs so the person isn't left guessing.
      if (!current) {
        return response.unauthorized(
          res,
          "You have been signed out. Please sign in again.",
          "SESSION_ENDED",
        );
      }
      if (decoded.sid !== current) {
        return response.unauthorized(
          res,
          "Signed out because this account was used to sign in on another device.",
          "SESSION_REPLACED",
        );
      }
    }

    const { session_id, ...user } = result.rows[0];
    req.user = user;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return response.unauthorized(
        res,
        "Your session expired. Please sign in again.",
        "TOKEN_EXPIRED",
      );
    }
    if (err.name === "JsonWebTokenError") {
      return response.unauthorized(res, "Invalid token", "TOKEN_INVALID");
    }
    next(err);
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) return response.unauthorized(res);
    if (!roles.includes(req.user.role)) {
      return response.forbidden(res, "Insufficient permissions");
    }
    next();
  };
};

const scopeBusiness = (req, res, next) => {
  if (req.user.role === "super_admin") {
    req.businessId = req.query.business_id || req.body.business_id || null;
  } else {
    if (!req.user.business_id)
      return response.forbidden(
        res,
        "No business associated with this account",
      );
    req.businessId = req.user.business_id;
  }
  next();
};

module.exports = { authenticate, authorize, scopeBusiness };
