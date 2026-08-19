const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");
const { query } = require("../config/db");
const response = require("../utils/response");
const { sendOTPEmail } = require("../services/emailService");

// In-memory OTP store { email: { otp, expiresAt, name } }
const otpStore = new Map();

const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

/**
 * GET /api/profile
 */
const getProfile = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.name, u.email, u.role, u.last_login, u.created_at,
              b.name AS business_name, b.email AS business_email, b.phone AS business_phone
       FROM users u
       LEFT JOIN businesses b ON b.id = u.business_id
       WHERE u.id = $1`,
      [req.user.id],
    );
    return response.success(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/profile
 * Update own name
 */
const updateProfile = async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim())
      return response.error(res, "Name is required", 422);
    const result = await query(
      `UPDATE users SET name = $1 WHERE id = $2 RETURNING id, name, email, role`,
      [name.trim(), req.user.id],
    );
    return response.success(res, result.rows[0], "Profile updated");
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/profile/change-password
 * Requires current password
 */
const changePassword = async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password)
      return response.error(res, "Both fields required", 422);
    if (new_password.length < 8)
      return response.error(
        res,
        "New password must be at least 8 characters",
        422,
      );

    const result = await query(
      `SELECT password_hash FROM users WHERE id = $1`,
      [req.user.id],
    );
    const valid = await bcrypt.compare(
      current_password,
      result.rows[0].password_hash,
    );
    if (!valid)
      return response.error(res, "Current password is incorrect", 400);

    const hash = await bcrypt.hash(new_password, 12);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
      hash,
      req.user.id,
    ]);
    return response.success(res, null, "Password changed successfully");
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/forgot-password
 * Send OTP to email
 */
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return response.error(res, "Email is required", 422);

    const result = await query(
      `SELECT id, name, email FROM users WHERE email = $1`,
      [email],
    );
    // Always return success to prevent email enumeration
    if (result.rows.length === 0) {
      return response.success(
        res,
        null,
        "If this email exists, an OTP has been sent",
      );
    }

    const user = result.rows[0];
    const otp = generateOTP();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    otpStore.set(email.toLowerCase(), {
      otp,
      expiresAt,
      userId: user.id,
      name: user.name,
    });

    await sendOTPEmail(email, user.name, otp);

    return response.success(res, null, "OTP sent to your email");
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/verify-otp
 * Check OTP is valid
 */
const verifyOTP = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp)
      return response.error(res, "Email and OTP required", 422);

    const stored = otpStore.get(email.toLowerCase());
    if (!stored)
      return response.error(
        res,
        "OTP not found. Please request a new one.",
        400,
      );
    if (Date.now() > stored.expiresAt) {
      otpStore.delete(email.toLowerCase());
      return response.error(
        res,
        "OTP has expired. Please request a new one.",
        400,
      );
    }
    if (stored.otp !== otp.toString())
      return response.error(res, "Invalid OTP", 400);

    // Mark as verified (don't delete yet — needed for reset step)
    stored.verified = true;
    return response.success(res, null, "OTP verified");
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/reset-password
 * Set new password after OTP verified
 */
const resetPassword = async (req, res, next) => {
  try {
    const { email, otp, new_password } = req.body;
    if (!email || !otp || !new_password)
      return response.error(res, "All fields required", 422);
    if (new_password.length < 8)
      return response.error(res, "Password must be at least 8 characters", 422);

    const stored = otpStore.get(email.toLowerCase());
    if (!stored || !stored.verified)
      return response.error(res, "Please verify OTP first", 400);
    if (stored.otp !== otp.toString())
      return response.error(res, "Invalid OTP", 400);
    if (Date.now() > stored.expiresAt) {
      otpStore.delete(email.toLowerCase());
      return response.error(res, "OTP expired. Please start again.", 400);
    }

    const hash = await bcrypt.hash(new_password, 12);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
      hash,
      stored.userId,
    ]);
    otpStore.delete(email.toLowerCase());

    return response.success(
      res,
      null,
      "Password reset successfully. You can now log in.",
    );
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getProfile,
  updateProfile,
  changePassword,
  forgotPassword,
  verifyOTP,
  resetPassword,
};
