/**
 * visaController.js
 *
 * Visa applications handled on a customer's behalf.
 *
 *   cost_price     what the embassy / handler charges us
 *   selling_price  what the customer is charged
 *   revenue        the difference (generated column)
 *
 * Money comes IN from the customer, so this behaves like a ticket:
 * amount_paid plus a payment ledger.
 */

const { body, validationResult } = require("express-validator");
const { query, withTransaction } = require("../config/db");
const response = require("../utils/response");
const { hasTable } = require("../services/schemaInfo");

const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

const MIGRATION_MSG = "Visa services need a database update. Run migration_v8.sql.";
const STATUSES = [
  "applied",
  "processing",
  "approved",
  "rejected",
  "collected",
  "cancelled",
];

const calcPaymentStatus = (paid, total) => {
  const p = Number(paid) || 0;
  const t = Number(total) || 0;
  if (p <= 0) return "unpaid";
  if (p >= t) return "paid";
  return "partial";
};

const visaValidation = [
  body("applicant_name").trim().notEmpty().withMessage("Applicant name is required"),
  body("destination_country")
    .trim()
    .notEmpty()
    .withMessage("Destination country is required"),
  body("cost_price")
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage("Cost must be a positive number"),
  body("selling_price")
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage("Charge must be a positive number"),
  body("status").optional().isIn(STATUSES).withMessage("Invalid status"),
  body("applied_date")
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage("Valid applied date required"),
];

/** GET /api/visas */
const getVisas = async (req, res, next) => {
  try {
    if (!(await hasTable("visa_applications")))
      return response.error(res, MIGRATION_MSG, 503);

    const {
      page = 1,
      limit = 20,
      search = "",
      status,
      country,
      payment_status,
      from_date,
      to_date,
      only_due,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.businessId];
    const conditions = ["v.business_id = $1"];
    let pi = 2;

    if (search) {
      conditions.push(
        `(v.applicant_name ILIKE $${pi} OR v.passport_number ILIKE $${pi} OR v.contact_number ILIKE $${pi} OR v.reference ILIKE $${pi})`,
      );
      params.push(`%${search}%`);
      pi++;
    }
    if (status) {
      conditions.push(`v.status = $${pi}`);
      params.push(status);
      pi++;
    }
    if (country) {
      conditions.push(`v.destination_country ILIKE $${pi}`);
      params.push(country);
      pi++;
    }
    if (payment_status) {
      conditions.push(`v.payment_status = $${pi}`);
      params.push(payment_status);
      pi++;
    }
    if (from_date) {
      conditions.push(`v.applied_date >= $${pi}`);
      params.push(from_date);
      pi++;
    }
    if (to_date) {
      conditions.push(`v.applied_date <= $${pi}`);
      params.push(to_date);
      pi++;
    }
    if (only_due === "true" || only_due === "1") {
      conditions.push(`(v.selling_price - v.amount_paid) > 0`);
    }

    const where = conditions.join(" AND ");

    const [countRes, dataRes, countriesRes] = await Promise.all([
      query(
        `SELECT COUNT(*),
                COALESCE(SUM(v.selling_price), 0)               AS total_charged,
                COALESCE(SUM(v.cost_price), 0)                  AS total_cost,
                COALESCE(SUM(v.revenue), 0)                     AS total_revenue,
                COALESCE(SUM(v.amount_paid), 0)                 AS total_collected,
                COALESCE(SUM(v.selling_price - v.amount_paid), 0) AS total_balance
         FROM visa_applications v WHERE ${where}`,
        params,
      ),
      query(
        `SELECT v.*, u.name AS created_by_name, c.name AS customer_name
         FROM visa_applications v
         LEFT JOIN users u     ON u.id = v.created_by
         LEFT JOIN customers c ON c.id = v.customer_id
         WHERE ${where}
         ORDER BY v.applied_date DESC, v.created_at DESC
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, parseInt(limit), offset],
      ),
      query(
        `SELECT DISTINCT destination_country FROM visa_applications
         WHERE business_id = $1 ORDER BY destination_country`,
        [req.businessId],
      ),
    ]);

    const c = countRes.rows[0];
    return response.success(
      res,
      {
        visas: dataRes.rows,
        countries: countriesRes.rows.map((r) => r.destination_country),
        summary: {
          total_charged: round2(c.total_charged),
          total_cost: round2(c.total_cost),
          total_revenue: round2(c.total_revenue),
          total_collected: round2(c.total_collected),
          total_balance: round2(c.total_balance),
        },
      },
      "Success",
      200,
      {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(c.count),
        totalPages: Math.ceil(parseInt(c.count) / parseInt(limit)),
      },
    );
  } catch (err) {
    next(err);
  }
};

/** POST /api/visas */
const createVisa = async (req, res, next) => {
  try {
    if (!(await hasTable("visa_applications")))
      return response.error(res, MIGRATION_MSG, 503);

    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const {
      customer_id,
      contact_number,
      passport_number,
      nationality,
      destination_country,
      visa_type,
      reference,
      applied_date,
      expiry_date,
      status,
      cost_price,
      selling_price,
      amount_paid,
      payment_method,
      notes,
    } = req.body;

    const applicant_name = req.body.applicant_name.toUpperCase().trim();
    const selling = round2(selling_price);
    const paid = round2(amount_paid);
    if (paid > selling + 0.001) {
      return response.error(
        res,
        "Amount paid cannot exceed what the customer is charged",
        400,
      );
    }
    const paymentStatus = calcPaymentStatus(paid, selling);

    // Link to an existing customer by phone when one wasn't picked
    let finalCustomerId = customer_id || null;
    if (!finalCustomerId && contact_number) {
      const byPhone = await query(
        `SELECT id FROM customers WHERE business_id = $1 AND phone = $2 LIMIT 1`,
        [req.businessId, contact_number.trim()],
      );
      if (byPhone.rows.length > 0) finalCustomerId = byPhone.rows[0].id;
    }

    const visa = await withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO visa_applications (
           business_id, customer_id, created_by, applicant_name, contact_number,
           passport_number, nationality, destination_country, visa_type,
           reference, applied_date, expiry_date, status,
           cost_price, selling_price, amount_paid, payment_status, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                   COALESCE($11::DATE, CURRENT_DATE),$12,COALESCE($13::visa_status,'applied'),
                   $14,$15,$16,$17,$18)
         RETURNING *`,
        [
          req.businessId,
          finalCustomerId,
          req.user.id,
          applicant_name,
          contact_number?.trim() || null,
          passport_number?.trim() || null,
          nationality || null,
          destination_country.trim(),
          visa_type || null,
          reference || null,
          applied_date || null,
          expiry_date || null,
          status || null,
          round2(cost_price),
          selling,
          paid,
          paymentStatus,
          notes || null,
        ],
      );

      if (paid > 0) {
        await client.query(
          `INSERT INTO visa_payments (business_id, visa_id, collected_by, amount, method, note)
           VALUES ($1,$2,$3,$4,$5,'Initial payment')`,
          [
            req.businessId,
            r.rows[0].id,
            req.user.id,
            paid,
            payment_method || "cash",
          ],
        );
      }
      return r.rows[0];
    });

    return response.created(res, visa, "Visa application recorded");
  } catch (err) {
    next(err);
  }
};

/** GET /api/visas/:id */
const getVisa = async (req, res, next) => {
  try {
    if (!(await hasTable("visa_applications")))
      return response.error(res, MIGRATION_MSG, 503);

    const [visaRes, paymentsRes] = await Promise.all([
      query(
        `SELECT v.*, u.name AS created_by_name, c.name AS customer_name
         FROM visa_applications v
         LEFT JOIN users u     ON u.id = v.created_by
         LEFT JOIN customers c ON c.id = v.customer_id
         WHERE v.id = $1 AND v.business_id = $2`,
        [req.params.id, req.businessId],
      ),
      query(
        `SELECT p.*, u.name AS collected_by_name
         FROM visa_payments p
         JOIN users u ON u.id = p.collected_by
         WHERE p.visa_id = $1 AND p.business_id = $2
         ORDER BY p.created_at DESC`,
        [req.params.id, req.businessId],
      ),
    ]);

    if (visaRes.rows.length === 0)
      return response.notFound(res, "Visa application not found");

    return response.success(res, {
      visa: visaRes.rows[0],
      payments: paymentsRes.rows,
    });
  } catch (err) {
    next(err);
  }
};

/** PUT /api/visas/:id */
const updateVisa = async (req, res, next) => {
  try {
    if (!(await hasTable("visa_applications")))
      return response.error(res, MIGRATION_MSG, 503);

    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const existing = await query(
      `SELECT amount_paid FROM visa_applications WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (existing.rows.length === 0)
      return response.notFound(res, "Visa application not found");

    // amount_paid is owned by the payment ledger, not this form
    const paid = round2(existing.rows[0].amount_paid);
    const selling = round2(req.body.selling_price);
    if (paid > selling + 0.001) {
      return response.error(
        res,
        `Already collected $${paid.toFixed(2)} — the charge cannot be lower than that.`,
        400,
      );
    }

    const r = await query(
      `UPDATE visa_applications SET
         applicant_name      = $1,
         contact_number      = $2,
         passport_number     = $3,
         nationality         = $4,
         destination_country = $5,
         visa_type           = $6,
         reference           = $7,
         applied_date        = COALESCE($8, applied_date),
         decision_date       = $9,
         expiry_date         = $10,
         status              = COALESCE($11::visa_status, status),
         cost_price          = $12,
         selling_price       = $13,
         payment_status      = $14,
         notes               = $15,
         customer_id         = COALESCE($16, customer_id)
       WHERE id = $17 AND business_id = $18
       RETURNING *`,
      [
        req.body.applicant_name.toUpperCase().trim(),
        req.body.contact_number?.trim() || null,
        req.body.passport_number?.trim() || null,
        req.body.nationality || null,
        req.body.destination_country.trim(),
        req.body.visa_type || null,
        req.body.reference || null,
        req.body.applied_date || null,
        req.body.decision_date || null,
        req.body.expiry_date || null,
        req.body.status || null,
        round2(req.body.cost_price),
        selling,
        calcPaymentStatus(paid, selling),
        req.body.notes || null,
        req.body.customer_id || null,
        req.params.id,
        req.businessId,
      ],
    );

    return response.success(res, r.rows[0], "Visa application updated");
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/visas/:id */
const deleteVisa = async (req, res, next) => {
  try {
    if (!(await hasTable("visa_applications")))
      return response.error(res, MIGRATION_MSG, 503);
    const r = await query(
      `DELETE FROM visa_applications WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.id, req.businessId],
    );
    if (r.rows.length === 0)
      return response.notFound(res, "Visa application not found");
    return response.success(res, null, "Visa application deleted");
  } catch (err) {
    next(err);
  }
};

/** POST /api/visas/:id/payments  { amount, method, note } */
const addVisaPayment = async (req, res, next) => {
  try {
    if (!(await hasTable("visa_applications")))
      return response.error(res, MIGRATION_MSG, 503);

    const visaRes = await query(
      `SELECT id, applicant_name, selling_price, amount_paid
       FROM visa_applications WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (visaRes.rows.length === 0)
      return response.notFound(res, "Visa application not found");

    const v = visaRes.rows[0];
    const balance = round2(Number(v.selling_price) - Number(v.amount_paid));
    const amount =
      req.body.amount === undefined ||
      req.body.amount === null ||
      req.body.amount === ""
        ? balance
        : round2(req.body.amount);

    if (!(amount > 0))
      return response.error(res, "Amount must be greater than 0", 400);
    if (amount > balance + 0.001)
      return response.error(
        res,
        `Amount exceeds the remaining balance ($${balance.toFixed(2)})`,
        400,
      );

    const updated = await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO visa_payments (business_id, visa_id, collected_by, amount, method, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          req.businessId,
          v.id,
          req.user.id,
          amount,
          req.body.method || "cash",
          req.body.note || null,
        ],
      );
      const newPaid = round2(Number(v.amount_paid) + amount);
      const r = await client.query(
        `UPDATE visa_applications SET amount_paid = $1, payment_status = $2
         WHERE id = $3 RETURNING *`,
        [newPaid, calcPaymentStatus(newPaid, v.selling_price), v.id],
      );
      return r.rows[0];
    });

    return response.created(
      res,
      updated,
      `Collected $${amount.toFixed(2)} from ${v.applicant_name}`,
    );
  } catch (err) {
    next(err);
  }
};

module.exports = {
  visaValidation,
  getVisas,
  createVisa,
  getVisa,
  updateVisa,
  deleteVisa,
  addVisaPayment,
};
