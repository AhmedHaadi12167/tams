const { body, validationResult } = require("express-validator");
const { query } = require("../config/db");
const response = require("../utils/response");
const { generateCustomerStatementPDF } = require("../services/reportService");

/**
 * Shared query: everything a customer owes / has paid.
 * Includes tickets they are the passenger on AND tickets they
 * booked for family members / friends (booked_by_customer_id).
 */
const fetchStatementData = async (customerId, businessId) => {
  const customerResult = await query(
    `SELECT * FROM customers WHERE id = $1 AND business_id = $2`,
    [customerId, businessId],
  );
  if (customerResult.rows.length === 0) return null;
  const customerName = customerResult.rows[0].name || "";

  // A ticket is "for himself" when he is the passenger — matched either by
  // customer link or by passenger name (covers duplicate customer records).
  const ticketsResult = await query(
    `SELECT t.id, t.passenger_name, t.contact_number, t.ticket_type,
            t.from_city, t.to_city, t.flight_date, t.return_date, t.trip_type,
            t.airline_name, t.ticket_reference, t.status,
            t.selling_price, t.amount_paid,
            (t.selling_price - t.amount_paid) AS balance,
            t.payment_status, t.created_at AS booked_date,
            u.name AS agent_name,
            (t.customer_id = $1 OR LOWER(TRIM(t.passenger_name)) = LOWER(TRIM($3))) AS is_self
     FROM tickets t
     LEFT JOIN users u ON u.id = t.created_by
     WHERE t.business_id = $2
       AND (t.customer_id = $1 OR t.booked_by_customer_id = $1)
       AND t.status != 'cancelled'
     ORDER BY t.created_at DESC`,
    [customerId, businessId, customerName],
  );

  const paymentsResult = await query(
    `SELECT p.amount, p.method, p.note, p.created_at,
            u.name AS collected_by_name, t.passenger_name
     FROM ticket_payments p
     JOIN users u ON u.id = p.collected_by
     JOIN tickets t ON t.id = p.ticket_id
     WHERE p.business_id = $2
       AND (t.customer_id = $1 OR t.booked_by_customer_id = $1)
     ORDER BY p.created_at DESC`,
    [customerId, businessId],
  );

  const tickets = ticketsResult.rows;
  const totals = tickets.reduce(
    (acc, t) => {
      acc.total_amount += parseFloat(t.selling_price) || 0;
      acc.total_paid += parseFloat(t.amount_paid) || 0;
      acc.total_balance += parseFloat(t.balance) || 0;
      return acc;
    },
    { total_amount: 0, total_paid: 0, total_balance: 0 },
  );

  return {
    customer: customerResult.rows[0],
    tickets,
    payments: paymentsResult.rows,
    summary: {
      ticket_count: tickets.length,
      total_amount: totals.total_amount.toFixed(2),
      total_paid: totals.total_paid.toFixed(2),
      total_balance: totals.total_balance.toFixed(2),
    },
  };
};

/**
 * GET /api/customers/:id/statement
 */
const getCustomerStatement = async (req, res, next) => {
  try {
    const data = await fetchStatementData(req.params.id, req.businessId);
    if (!data) return response.notFound(res, "Customer not found");
    return response.success(res, data);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/customers/:id/statement/pdf
 */
const exportCustomerStatementPDF = async (req, res, next) => {
  try {
    const data = await fetchStatementData(req.params.id, req.businessId);
    if (!data) return response.notFound(res, "Customer not found");
    generateCustomerStatementPDF(res, data);
  } catch (err) {
    next(err);
  }
};

const customerValidation = [
  body("name").trim().notEmpty().withMessage("Customer name is required"),
  body("email").optional().isEmail().withMessage("Valid email required"),
];

/**
 * GET /api/customers
 */
const getCustomers = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = "",
      only_due,
      sort = "recent",
    } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.businessId];
    let pi = 2;
    const conditions = ["c.business_id = $1"];

    if (search) {
      conditions.push(
        `(c.name ILIKE $${pi} OR c.passport_number ILIKE $${pi} OR c.phone ILIKE $${pi})`,
      );
      params.push(`%${search}%`);
      pi++;
    }

    // What each customer still owes — on their own tickets and on any they
    // booked for someone else. Matches the statement page's definition.
    const balanceExpr = `(
      SELECT COALESCE(SUM(t.selling_price - t.amount_paid), 0)
      FROM tickets t
      WHERE (t.customer_id = c.id OR t.booked_by_customer_id = c.id)
        AND t.business_id = c.business_id
        AND t.status != 'cancelled'
    )`;

    if (only_due === "true" || only_due === "1") {
      conditions.push(`${balanceExpr} > 0`);
    }

    const whereClause = conditions.join(" AND ");

    const orderBy =
      sort === "balance"
        ? "balance DESC, c.created_at DESC"
        : sort === "name"
          ? "c.name ASC"
          : "c.created_at DESC";

    const [countResult, dataResult, totalsResult] = await Promise.all([
      query(`SELECT COUNT(*) FROM customers c WHERE ${whereClause}`, params),
      query(
        `SELECT c.*,
          (SELECT COUNT(*) FROM tickets t
           WHERE (t.customer_id = c.id OR t.booked_by_customer_id = c.id)
             AND t.business_id = c.business_id
             AND t.status != 'cancelled') AS ticket_count,
          ${balanceExpr} AS balance,
          (SELECT COALESCE(SUM(t.selling_price), 0) FROM tickets t
           WHERE (t.customer_id = c.id OR t.booked_by_customer_id = c.id)
             AND t.business_id = c.business_id
             AND t.status != 'cancelled') AS total_billed,
          (SELECT COALESCE(SUM(t.amount_paid), 0) FROM tickets t
           WHERE (t.customer_id = c.id OR t.booked_by_customer_id = c.id)
             AND t.business_id = c.business_id
             AND t.status != 'cancelled') AS total_paid
         FROM customers c
         WHERE ${whereClause}
         ORDER BY ${orderBy}
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, parseInt(limit), offset],
      ),
      // Totals across the whole filtered set, not just this page
      query(
        `SELECT
           COUNT(*) FILTER (WHERE ${balanceExpr} > 0) AS customers_owing,
           COALESCE(SUM(${balanceExpr}), 0)           AS total_outstanding
         FROM customers c WHERE ${whereClause}`,
        params,
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const t = totalsResult.rows[0];

    return response.success(
      res,
      dataResult.rows,
      `${t.customers_owing} customer(s) owing $${Number(t.total_outstanding).toFixed(2)}`,
      200,
      {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
        customers_owing: parseInt(t.customers_owing),
        total_outstanding: Number(t.total_outstanding).toFixed(2),
      },
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/customers/:id
 */
const getCustomer = async (req, res, next) => {
  try {
    const customerResult = await query(
      `SELECT * FROM customers WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (customerResult.rows.length === 0)
      return response.notFound(res, "Customer not found");

    const ticketsResult = await query(
      `SELECT id, ticket_type, from_city, to_city, flight_date, airline_name,
              selling_price, revenue, status, created_at
       FROM tickets WHERE customer_id = $1 AND business_id = $2
       ORDER BY created_at DESC`,
      [req.params.id, req.businessId],
    );

    return response.success(res, {
      customer: customerResult.rows[0],
      tickets: ticketsResult.rows,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/customers/:id
 */
const updateCustomer = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const { phone, email, passport_number, date_of_birth, nationality } =
      req.body;
    const name = req.body.name?.toUpperCase().trim();
    const result = await query(
      `UPDATE customers SET name=$1, phone=$2, email=$3, passport_number=$4, date_of_birth=$5, nationality=$6
       WHERE id=$7 AND business_id=$8 RETURNING *`,
      [
        name,
        phone || null,
        email || null,
        passport_number || null,
        date_of_birth || null,
        nationality || null,
        req.params.id,
        req.businessId,
      ],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Customer not found");
    return response.success(res, result.rows[0], "Customer updated");
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/customers/:id
 */
const deleteCustomer = async (req, res, next) => {
  try {
    const result = await query(
      `DELETE FROM customers WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.id, req.businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Customer not found");
    return response.success(res, null, "Customer deleted");
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getCustomers,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  customerValidation,
  getCustomerStatement,
  exportCustomerStatementPDF,
};
