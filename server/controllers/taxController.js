/**
 * taxController.js
 *
 * Tax collected on ticket sales, and paying it over.
 *
 * The money is not the agency's. It arrives inside the fare, sits in an
 * account until the authority is paid, and leaves again — which makes it a
 * liability, not income. Treating it as revenue is how a business ends up
 * spending money it was only holding.
 *
 * Deliberately the same shape as settling an airline: a balance that goes to
 * zero, payments recorded against a real account, and a history you can read.
 */

const { body, validationResult } = require("express-validator");
const { query } = require("../config/db");
const response = require("../utils/response");
const { hasTable } = require("../services/schemaInfo");
const { requireAccount } = require("../services/accountResolver");
const { uuidOrThrow } = require("../utils/sqlSafe");

const MIGRATION_MSG = "Tax tracking needs a database update. Run migration_v15.sql.";
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const taxPaymentValidation = [
  body("amount").isFloat({ gt: 0 }).withMessage("Amount must be greater than zero"),
  body("period_from")
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage("Valid start date required"),
  body("period_to")
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage("Valid end date required"),
];

/**
 * GET /api/tax
 * What has accrued, what has been paid, what is still owed.
 */
const getTaxAccount = async (req, res, next) => {
  try {
    if (!(await hasTable("tax_payments")))
      return response.error(res, MIGRATION_MSG, 503);

    const { from_date, to_date } = req.query;

    const [accountRes, paymentsRes, byMonthRes] = await Promise.all([
      query(
        `SELECT tax_accrued, tax_paid, tax_owed, taxed_tickets, last_payment_at
           FROM v_tax_account WHERE business_id = $1`,
        [req.businessId],
      ),
      query(
        `SELECT tp.*, a.name AS account_name, u.name AS paid_by_name
           FROM tax_payments tp
           LEFT JOIN payment_accounts a ON a.id = tp.account_id
           LEFT JOIN users u            ON u.id = tp.paid_by
          WHERE tp.business_id = $1
          ORDER BY tp.paid_at DESC
          LIMIT 100`,
        [req.businessId],
      ),
      // Tax accrued month by month, so a quarterly or monthly return can be
      // filled in without exporting anything.
      query(
        `SELECT DATE_TRUNC('month', created_at)::DATE AS month,
                COALESCE(SUM(COALESCE(tax, 0)), 0)    AS tax,
                COUNT(*) FILTER (WHERE COALESCE(tax,0) > 0) AS tickets
           FROM tickets
          WHERE business_id = $1 AND status <> 'cancelled'
            ${from_date ? "AND created_at >= $2" : ""}
            ${to_date ? `AND created_at <= $${from_date ? 3 : 2}` : ""}
          GROUP BY 1
         HAVING COALESCE(SUM(COALESCE(tax, 0)), 0) > 0
          ORDER BY 1 DESC
          LIMIT 24`,
        [
          req.businessId,
          ...(from_date ? [from_date] : []),
          ...(to_date ? [to_date + " 23:59:59"] : []),
        ],
      ),
    ]);

    const a = accountRes.rows[0] || {
      tax_accrued: 0,
      tax_paid: 0,
      tax_owed: 0,
      taxed_tickets: 0,
    };

    return response.success(res, {
      summary: {
        tax_accrued: round2(a.tax_accrued),
        tax_paid: round2(a.tax_paid),
        tax_owed: round2(a.tax_owed),
        taxed_tickets: parseInt(a.taxed_tickets) || 0,
        last_payment_at: a.last_payment_at || null,
      },
      payments: paymentsRes.rows.map((p) => ({
        ...p,
        amount: round2(p.amount),
      })),
      by_month: byMonthRes.rows.map((r) => ({
        month: r.month,
        tax: round2(r.tax),
        tickets: parseInt(r.tickets),
      })),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/tax/payments
 * Hand tax over to the authority, out of a named account.
 */
const payTax = async (req, res, next) => {
  try {
    if (!(await hasTable("tax_payments")))
      return response.error(res, MIGRATION_MSG, 503);

    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const amount = round2(req.body.amount);

    const owedRes = await query(
      `SELECT tax_owed FROM v_tax_account WHERE business_id = $1`,
      [req.businessId],
    );
    const owed = round2(owedRes.rows[0]?.tax_owed);

    // Overpaying would drive the balance negative and read as though the
    // authority owed the agency money, which is never what happened.
    if (amount > owed + 0.001)
      return response.error(
        res,
        `That's more than the $${owed.toFixed(2)} of tax currently owed.`,
        400,
      );

    const accountId = await requireAccount(
      req.body,
      req.businessId,
      null,
      "tax payment",
    );

    const result = await query(
      `INSERT INTO tax_payments
         (business_id, account_id, paid_by, amount, period_from, period_to,
          reference, note, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::TIMESTAMPTZ, NOW()))
       RETURNING *`,
      [
        req.businessId,
        accountId,
        req.user.id,
        amount,
        req.body.period_from || null,
        req.body.period_to || null,
        req.body.reference || null,
        req.body.note || null,
        req.body.paid_at || null,
      ],
    );

    const after = await query(
      `SELECT tax_owed FROM v_tax_account WHERE business_id = $1`,
      [req.businessId],
    );

    return response.created(
      res,
      { payment: result.rows[0], tax_owed: round2(after.rows[0]?.tax_owed) },
      `$${amount.toFixed(2)} paid. $${round2(after.rows[0]?.tax_owed).toFixed(2)} still owed.`,
    );
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/tax/payments/:id
 * For a payment entered by mistake.
 */
const deleteTaxPayment = async (req, res, next) => {
  try {
    if (!(await hasTable("tax_payments")))
      return response.error(res, MIGRATION_MSG, 503);

    const r = await query(
      `DELETE FROM tax_payments WHERE id = $1 AND business_id = $2 RETURNING id`,
      [uuidOrThrow(req.params.id, "payment id"), req.businessId],
    );
    if (r.rows.length === 0) return response.notFound(res, "Payment not found");
    return response.success(res, null, "Payment removed");
  } catch (err) {
    next(err);
  }
};

module.exports = {
  taxPaymentValidation,
  getTaxAccount,
  payTax,
  deleteTaxPayment,
};
