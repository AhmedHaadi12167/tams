/**
 * supplierController.js
 *
 * Paying the people the agency buys from: embassies and visa handlers, tour
 * operators, cargo carriers.
 *
 * Airlines already worked this way — a cost recorded when the sale is made,
 * a balance showing what is still owed, and a Pay button that names the
 * account the money leaves. Visas, packages and cargo did not. Their cost
 * was typed on the record and then *assumed paid*, which is how a $1,900
 * embassy fee disappeared from the agency's cash without a single shilling
 * moving. The balance sheet said $130 while the bank held $2,030.
 *
 * So the same three ideas, applied to the other three kinds of supplier:
 *
 *   owed = what the record says it cost
 *   paid = what has actually gone out, recorded against an account
 *   balance = the difference, which is a liability until it is settled
 *
 * Everything here writes to `supplier_payments`, which the ledger reads, so
 * a payment moves an account balance the moment it is recorded.
 */

const { query, withTransaction } = require("../config/db");
const response = require("../utils/response");
const { body, validationResult } = require("express-validator");
const { uuidOrThrow } = require("../utils/sqlSafe");
const { hasTable } = require("../services/schemaInfo");
const { requireAccount } = require("../services/accountResolver");

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const MIGRATION_MSG =
  "Paying suppliers needs a database update. Ask your administrator to run migration_v22.sql.";

/**
 * The three kinds, and where each keeps its cost.
 *
 * Cargo has no cost column: it has a margin, and the cost is what's left of
 * the price. Deriving it here keeps that decision in one place rather than
 * repeated in every query that wants to know what a shipment cost.
 */
const KINDS = {
  visa: {
    table: "visa_applications",
    column: "visa_id",
    cost: "cost_price",
    label: "applicant_name",
    statusColumn: "status",
    what: "visa fee",
  },
  package: {
    table: "packages",
    column: "package_id",
    cost: "total_cost",
    label: "label",
    statusColumn: "status",
    what: "package cost",
  },
  cargo: {
    table: "cargo_shipments",
    column: "cargo_id",
    // NULL profit means no cost was recorded, so nothing is owed — not that
    // the whole price is owed. GREATEST keeps a mis-entered margin larger
    // than the price from producing a negative debt.
    cost: "CASE WHEN profit_total IS NULL THEN 0 ELSE GREATEST(total_price - profit_total, 0) END",
    label: "COALESCE(tracking_number, sender_name)",
    statusColumn: "cargo_status",
    what: "carrier cost",
  },
};

const kindOrThrow = (kind) => {
  const k = KINDS[kind];
  if (!k) {
    const err = new Error(
      `Unknown supplier type "${kind}". Expected visa, package or cargo.`,
    );
    err.statusCode = 400;
    err.expose = true;
    throw err;
  }
  return k;
};

const supplierPaymentValidation = [
  body("amount")
    .optional()
    .isFloat({ gt: 0 })
    .withMessage("Amount must be greater than zero"),
  body("reference").optional({ nullable: true }).trim(),
  body("note").optional({ nullable: true }).trim(),
];

/**
 * GET /api/suppliers/:kind
 *
 * What is owed on every record of one kind, and to whom.
 */
const getSupplierAccount = async (req, res, next) => {
  try {
    if (!(await hasTable("supplier_payments")))
      return response.error(res, MIGRATION_MSG, 503);

    const k = kindOrThrow(req.params.kind);
    const { settled } = req.query;

    // Only records that actually cost something are worth listing; a visa
    // with no fee has nothing to pay and would be noise on the page.
    const rows = await query(
      `SELECT r.id,
              ${k.label} AS name,
              (${k.cost})::NUMERIC(12,2)                      AS cost,
              COALESCE(r.supplier_paid, 0)                    AS paid,
              GREATEST((${k.cost}) - COALESCE(r.supplier_paid, 0), 0) AS balance,
              r.${k.statusColumn}::TEXT                       AS status,
              r.created_at
         FROM ${k.table} r
        WHERE r.business_id = $1
          AND r.${k.statusColumn}::TEXT <> 'cancelled'
          AND (${k.cost}) > 0
        ORDER BY r.created_at DESC`,
      [req.businessId],
    );

    const all = rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      cost: round2(r.cost),
      paid: round2(r.paid),
      balance: round2(r.balance),
      status: r.status,
      created_at: r.created_at,
    }));

    const list =
      settled === "true" ? all : all.filter((r) => r.balance > 0.001);

    return response.success(res, {
      kind: req.params.kind,
      summary: {
        total_cost: round2(all.reduce((a, r) => a + r.cost, 0)),
        total_paid: round2(all.reduce((a, r) => a + r.paid, 0)),
        total_owed: round2(all.reduce((a, r) => a + r.balance, 0)),
        unsettled: all.filter((r) => r.balance > 0.001).length,
      },
      records: list,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/suppliers/:kind/:id/pay
 *
 * Send money to the supplier for one record. Omit the amount to settle the
 * whole balance, which is what the button does.
 */
const paySupplier = async (req, res, next) => {
  try {
    if (!(await hasTable("supplier_payments")))
      return response.error(res, MIGRATION_MSG, 503);

    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const k = kindOrThrow(req.params.kind);
    const id = uuidOrThrow(req.params.id, "record id");

    const recRes = await query(
      `SELECT r.id, ${k.label} AS name,
              (${k.cost})::NUMERIC(12,2)   AS cost,
              COALESCE(r.supplier_paid, 0) AS paid
         FROM ${k.table} r
        WHERE r.id = $1 AND r.business_id = $2`,
      [id, req.businessId],
    );
    if (recRes.rows.length === 0) return response.notFound(res, "Record not found");

    const rec = recRes.rows[0];
    const owed = round2(Number(rec.cost) - Number(rec.paid));

    if (owed <= 0.001)
      return response.error(
        res,
        `Nothing is owed on this ${k.what} — it is already settled.`,
        400,
      );

    // No amount means "settle it", which is the common case and the one the
    // button uses. An amount means a part payment.
    const amount =
      req.body.amount === undefined || req.body.amount === null || req.body.amount === ""
        ? owed
        : round2(req.body.amount);

    if (amount > owed + 0.001)
      return response.error(
        res,
        `That is more than the $${owed.toFixed(2)} still owed on this ${k.what}.`,
        400,
      );

    // Money is leaving. It has to leave from somewhere, or it appears in no
    // balance and the Accounts page and this page stop agreeing.
    const accountId = await requireAccount(
      req.body,
      req.businessId,
      null,
      k.what,
    );

    const result = await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO supplier_payments
           (business_id, ${k.column}, amount, account_id, paid_by, method, reference, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          req.businessId,
          id,
          amount,
          accountId,
          req.user.id,
          (req.body.method || "cash").trim() || "cash",
          req.body.reference || null,
          req.body.note || `Paid ${k.what} — ${rec.name}`,
        ],
      );

      // The running total is kept in the same transaction as the payment, so
      // the two can never drift apart. A ledger that says one thing and a
      // record that says another is worse than either being wrong alone.
      const upd = await client.query(
        `UPDATE ${k.table}
            SET supplier_paid = COALESCE(supplier_paid, 0) + $1
          WHERE id = $2 AND business_id = $3
          RETURNING id, supplier_paid`,
        [amount, id, req.businessId],
      );
      return upd.rows[0];
    });

    const left = round2(owed - amount);
    return response.success(
      res,
      { ...result, paid: amount, still_owed: left },
      left > 0.001
        ? `$${amount.toFixed(2)} paid. $${left.toFixed(2)} still owed.`
        : `$${amount.toFixed(2)} paid — settled in full.`,
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/suppliers/:kind/:id/payments
 * Every payment made against one record, newest first.
 */
const getSupplierPayments = async (req, res, next) => {
  try {
    if (!(await hasTable("supplier_payments")))
      return response.error(res, MIGRATION_MSG, 503);

    const k = kindOrThrow(req.params.kind);
    const id = uuidOrThrow(req.params.id, "record id");

    const rows = await query(
      `SELECT p.id, p.amount, p.method, p.reference, p.note, p.created_at,
              a.name AS account_name, u.name AS paid_by_name
         FROM supplier_payments p
         LEFT JOIN payment_accounts a ON a.id = p.account_id
         LEFT JOIN users u            ON u.id = p.paid_by
        WHERE p.business_id = $1 AND p.${k.column} = $2
        ORDER BY p.created_at DESC`,
      [req.businessId, id],
    );

    return response.success(
      res,
      rows.rows.map((r) => ({ ...r, amount: round2(r.amount) })),
    );
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getSupplierAccount,
  paySupplier,
  getSupplierPayments,
  supplierPaymentValidation,
};
