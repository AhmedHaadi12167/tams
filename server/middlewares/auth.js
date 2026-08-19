const jwt = require("jsonwebtoken");
const { query } = require("../config/db");
const response = require("../utils/response");

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return response.unauthorized(res, "No token provided");
    }
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query(
      "SELECT id, business_id, name, email, role, is_active FROM users WHERE id = $1",
      [decoded.userId],
    );
    if (result.rows.length === 0 || !result.rows[0].is_active) {
      return response.unauthorized(res, "User not found or deactivated");
    }
    req.user = result.rows[0];
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return response.unauthorized(res, "Invalid or expired token");
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
