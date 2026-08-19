const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const response = require('../utils/response');

const userValidation = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('role').isIn(['admin', 'agent', 'accountant']).withMessage('Invalid role'),
];

/**
 * GET /api/users
 */
const getUsers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.businessId];
    const conditions = ['business_id = $1'];
    let pi = 2;

    if (search) {
      conditions.push(`(name ILIKE $${pi} OR email ILIKE $${pi})`);
      params.push(`%${search}%`);
      pi++;
    }

    const where = conditions.join(' AND ');
    const [countRes, dataRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM users WHERE ${where}`, params),
      query(`SELECT id, name, email, role, is_active, last_login, created_at FROM users WHERE ${where} ORDER BY created_at DESC LIMIT $${pi} OFFSET $${pi + 1}`, [...params, parseInt(limit), offset]),
    ]);

    return response.paginated(res, dataRes.rows, page, limit, parseInt(countRes.rows[0].count));
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/users
 */
const createUser = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const { name, email, role, password } = req.body;
    if (!password || password.length < 8) return response.error(res, 'Password must be at least 8 characters', 422);

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await query(
      `INSERT INTO users (business_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, email, role, is_active, created_at`,
      [req.businessId, name, email, passwordHash, role]
    );

    return response.created(res, result.rows[0], 'User created');
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/users/:id
 */
const updateUser = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const { name, role, is_active } = req.body;
    const result = await query(
      `UPDATE users SET name=$1, role=$2, is_active=COALESCE($3, is_active)
       WHERE id=$4 AND business_id=$5
       RETURNING id, name, email, role, is_active`,
      [name, role, is_active !== undefined ? is_active : null, req.params.id, req.businessId]
    );

    if (result.rows.length === 0) return response.notFound(res, 'User not found');
    return response.success(res, result.rows[0], 'User updated');
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/users/:id
 */
const deleteUser = async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) return response.error(res, 'Cannot delete your own account', 400);
    const result = await query(
      `DELETE FROM users WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.id, req.businessId]
    );
    if (result.rows.length === 0) return response.notFound(res, 'User not found');
    return response.success(res, null, 'User deleted');
  } catch (err) {
    next(err);
  }
};

module.exports = { getUsers, createUser, updateUser, deleteUser, userValidation };
