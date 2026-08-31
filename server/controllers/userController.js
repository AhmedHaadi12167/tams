const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const response = require('../utils/response');
const { hasColumn } = require('../services/schemaInfo');

const userValidation = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('role').isIn(['admin', 'agent', 'accountant']).withMessage('Invalid role'),
  // Optional, and free text on purpose. Every agency invents its own ladder,
  // and a fixed list would be wrong for the second one that signed up.
  body('title').optional({ nullable: true }).trim().isLength({ max: 120 })
    .withMessage('Title must be 120 characters or fewer'),
];

/**
 * The job title arrives with migration_v20 and is shown to customers on
 * invoices. Everything below asks before naming the column, so a database
 * that has not been migrated manages its team exactly as before.
 */
const titleReady = () => hasColumn('users', 'title');

/** Trim to null — an empty box means "no title", not an empty string. */
const blankToNull = (v) => {
  const t = String(v ?? '').trim();
  return t === '' ? null : t;
};

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
    const withTitle = await titleReady();
    const [countRes, dataRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM users WHERE ${where}`, params),
      query(
        `SELECT id, name, email, role, ${withTitle ? 'title' : 'NULL::TEXT AS title'},
                is_active, last_login, created_at
           FROM users WHERE ${where}
          ORDER BY created_at DESC LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, parseInt(limit), offset],
      ),
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

    const { name, email, role, password, title } = req.body;
    if (!password || password.length < 8) return response.error(res, 'Password must be at least 8 characters', 422);

    const withTitle = await titleReady();
    const passwordHash = await bcrypt.hash(password, 12);

    const cols = ['business_id', 'name', 'email', 'password_hash', 'role'];
    const vals = [req.businessId, name, email, passwordHash, role];
    if (withTitle) { cols.push('title'); vals.push(blankToNull(title)); }

    const result = await query(
      `INSERT INTO users (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING id, name, email, role,
                 ${withTitle ? 'title' : 'NULL::TEXT AS title'},
                 is_active, created_at`,
      vals
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

    const { name, role, is_active, title } = req.body;
    const withTitle = await titleReady();

    // Numbered as the values are pushed rather than written out by hand,
    // because the title column is optional and hand-numbering a list that
    // changes length is how $4 ends up meaning the user id in one branch
    // and the business id in the other.
    const vals = [];
    const p = (v) => `$${vals.push(v)}`;
    const sets = [
      `name = ${p(name)}`,
      `role = ${p(role)}`,
      `is_active = COALESCE(${p(is_active !== undefined ? is_active : null)}, is_active)`,
    ];
    // Only when the caller sent the field. The activate/deactivate toggle
    // posts just name, role and is_active, and must not wipe a title it was
    // never shown.
    if (withTitle && title !== undefined) sets.push(`title = ${p(blankToNull(title))}`);

    const result = await query(
      `UPDATE users SET ${sets.join(', ')}
       WHERE id=${p(req.params.id)} AND business_id=${p(req.businessId)}
       RETURNING id, name, email, role,
                 ${withTitle ? 'title' : 'NULL::TEXT AS title'},
                 is_active`,
      vals
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
