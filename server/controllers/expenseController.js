const { body, validationResult } = require("express-validator");
const { query } = require("../config/db");
const response = require("../utils/response");

const CATEGORIES = [
  "salaries",
  "rent",
  "utilities",
  "marketing",
  "office_supplies",
  "transport",
  "communication",
  "bank_charges",
  "licenses_permits",
  "maintenance",
  "refunds",
  "other",
];

const expenseValidation = [
  body("description").trim().notEmpty().withMessage("Description is required"),
  body("amount")
    .isFloat({ gt: 0 })
    .withMessage("Amount must be greater than 0"),
  body("category")
    .optional()
    .isIn(CATEGORIES)
    .withMessage("Invalid expense category"),
  body("expense_date")
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage("Valid expense date required (YYYY-MM-DD)"),
];

/**
 * GET /api/expenses/categories
 */
const getCategories = async (req, res) => {
  return response.success(
    res,
    CATEGORIES.map((c) => ({
      value: c,
      label: c
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
    })),
  );
};

/**
 * GET /api/expenses
 */
const getExpenses = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = "",
      category,
      from_date,
      to_date,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.businessId];
    const conditions = ["e.business_id = $1"];
    let pi = 2;

    if (search) {
      conditions.push(
        `(e.description ILIKE $${pi} OR e.vendor ILIKE $${pi} OR e.reference ILIKE $${pi})`,
      );
      params.push(`%${search}%`);
      pi++;
    }
    if (category) {
      conditions.push(`e.category = $${pi}`);
      params.push(category);
      pi++;
    }
    if (from_date) {
      conditions.push(`e.expense_date >= $${pi}`);
      params.push(from_date);
      pi++;
    }
    if (to_date) {
      conditions.push(`e.expense_date <= $${pi}`);
      params.push(to_date);
      pi++;
    }

    const where = conditions.join(" AND ");

    const [countRes, dataRes] = await Promise.all([
      query(
        `SELECT COUNT(*), COALESCE(SUM(e.amount), 0) AS total_amount
         FROM expenses e WHERE ${where}`,
        params,
      ),
      query(
        `SELECT e.*, u.name AS created_by_name
         FROM expenses e
         LEFT JOIN users u ON u.id = e.created_by
         WHERE ${where}
         ORDER BY e.expense_date DESC, e.created_at DESC
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, parseInt(limit), offset],
      ),
    ]);

    const c = countRes.rows[0];
    return response.paginated(
      res,
      dataRes.rows,
      page,
      limit,
      parseInt(c.count),
      `Total expenses: $${Number(c.total_amount).toFixed(2)}`,
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/expenses
 */
const createExpense = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const {
      category,
      description,
      amount,
      expense_date,
      vendor,
      payment_method,
      reference,
      notes,
    } = req.body;

    const result = await query(
      `INSERT INTO expenses (
        business_id, created_by, category, description, amount,
        expense_date, vendor, payment_method, reference, notes
      ) VALUES ($1,$2,$3,$4,$5,COALESCE($6, CURRENT_DATE),$7,$8,$9,$10)
      RETURNING *`,
      [
        req.businessId,
        req.user.id,
        category || "other",
        description.trim(),
        amount,
        expense_date || null,
        vendor || null,
        payment_method || "cash",
        reference || null,
        notes || null,
      ],
    );

    return response.created(res, result.rows[0], "Expense recorded");
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/expenses/:id
 */
const getExpense = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT e.*, u.name AS created_by_name
       FROM expenses e
       LEFT JOIN users u ON u.id = e.created_by
       WHERE e.id = $1 AND e.business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Expense not found");
    return response.success(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/expenses/:id
 */
const updateExpense = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const {
      category,
      description,
      amount,
      expense_date,
      vendor,
      payment_method,
      reference,
      notes,
    } = req.body;

    const result = await query(
      `UPDATE expenses SET
        category       = COALESCE($1::expense_category, category),
        description    = $2,
        amount         = $3,
        expense_date   = COALESCE($4, expense_date),
        vendor         = $5,
        payment_method = COALESCE($6, payment_method),
        reference      = $7,
        notes          = $8
       WHERE id = $9 AND business_id = $10
       RETURNING *`,
      [
        category || null,
        description.trim(),
        amount,
        expense_date || null,
        vendor || null,
        payment_method || null,
        reference || null,
        notes || null,
        req.params.id,
        req.businessId,
      ],
    );

    if (result.rows.length === 0)
      return response.notFound(res, "Expense not found");
    return response.success(res, result.rows[0], "Expense updated");
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/expenses/:id
 */
const deleteExpense = async (req, res, next) => {
  try {
    const result = await query(
      `DELETE FROM expenses WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.id, req.businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Expense not found");
    return response.success(res, null, "Expense deleted");
  } catch (err) {
    next(err);
  }
};

module.exports = {
  CATEGORIES,
  expenseValidation,
  getCategories,
  getExpenses,
  createExpense,
  getExpense,
  updateExpense,
  deleteExpense,
};
