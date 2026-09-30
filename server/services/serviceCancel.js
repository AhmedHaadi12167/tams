/**
 * serviceCancel.js
 *
 * Cancelling a visa application or a package, the same way a ticket is
 * cancelled: as an event that records where the money went.
 *
 * Up to two movements, both optional and independent:
 *
 *   refund_amount    back to the customer, out of an account
 *   supplier_refund  back from the embassy / tour operator, into an account
 *
 * Whatever the customer's payments net to afterwards is kept by the agency.
 * The income statement counts it (less whatever the supplier kept) as the
 * result of the cancellation, and the balance sheet sees exactly the same
 * figures, so the two can never disagree.
 *
 * Before this existed the only way to cancel was to set the status in the
 * edit form. The sale vanished from the books while the customer's money
 * stayed in the bank, and nothing recorded a refund.
 */

const { withTransaction } = require("../config/db");
const { requireAccount } = require("./accountResolver");
const { uuidOrThrow } = require("../utils/sqlSafe");

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const KINDS = {
  visa: {
    table: "visa_applications",
    payments: "visa_payments",
    fk: "visa_id",
    label: "applicant_name",
    what: "visa application",
    supplier: "embassy / visa supplier",
  },
  package: {
    table: "packages",
    payments: "package_payments",
    fk: "package_id",
    label: "COALESCE(NULLIF(label, ''), lead_name)",
    what: "package",
    supplier: "package supplier",
  },
};

/**
 * @returns {Promise<{notFound?:true, error?:string, status?:number,
 *                    record?:object, message?:string}>}
 */
const cancelService = async (kind, req) => {
  const k = KINDS[kind];
  const refund = round2(req.body.refund_amount);
  const supplierRefund = round2(req.body.supplier_refund);
  if (refund < 0 || supplierRefund < 0)
    return { error: "Refunds cannot be negative", status: 400 };

  return withTransaction(async (client) => {
    const found = await client.query(
      `SELECT id, ${k.label} AS label, status::TEXT AS status,
              COALESCE(amount_paid, 0)   AS paid,
              COALESCE(supplier_paid, 0) AS supplier_paid
         FROM ${k.table}
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [uuidOrThrow(req.params.id, `${kind} id`), req.businessId],
    );
    if (found.rows.length === 0) return { notFound: true };
    const rec = found.rows[0];
    if (rec.status === "cancelled")
      return { error: `This ${k.what} is already cancelled`, status: 409 };

    const paid = round2(rec.paid);
    const supplierPaid = round2(rec.supplier_paid);
    if (refund > paid + 0.001)
      return {
        error: `You can't refund more than the customer paid ($${paid.toFixed(2)}).`,
        status: 400,
      };
    if (supplierRefund > supplierPaid + 0.001)
      return {
        error: `The supplier can't return more than you paid them ($${supplierPaid.toFixed(2)}).`,
        status: 400,
      };

    const method = (req.body.method || "cash").trim() || "cash";
    const note = `Refund on cancellation${req.body.reason ? ` — ${req.body.reason}` : ""}`;

    if (refund > 0.001) {
      const accountId = await requireAccount(
        req.body,
        req.businessId,
        client,
        "refund",
      );
      await client.query(
        `INSERT INTO ${k.payments}
           (business_id, ${k.fk}, collected_by, amount, method, note, account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.businessId, rec.id, req.user.id, -refund, method, note, accountId],
      );
    }

    if (supplierRefund > 0.001) {
      const accountId = await requireAccount(
        { account_id: req.body.supplier_account_id || req.body.account_id },
        req.businessId,
        client,
        "supplier refund",
      );
      await client.query(
        `INSERT INTO supplier_payments
           (business_id, ${k.fk}, amount, account_id, paid_by, method, reference, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          req.businessId,
          rec.id,
          -supplierRefund,
          accountId,
          req.user.id,
          method,
          req.body.reference || null,
          `Returned by ${k.supplier} on cancellation — ${rec.label}`,
        ],
      );
    }

    const kept = round2(paid - refund);
    const upd = await client.query(
      `UPDATE ${k.table}
          SET status = 'cancelled',
              amount_paid = $1,
              payment_status = CASE WHEN $1::NUMERIC > 0 THEN 'paid'::payment_status
                                    ELSE 'unpaid'::payment_status END,
              supplier_paid = COALESCE(supplier_paid, 0) - $2,
              refunded_amount = COALESCE(refunded_amount, 0) + $3,
              cancelled_at = NOW(),
              cancelled_by = $4,
              cancel_reason = $5
        WHERE id = $6 AND business_id = $7
        RETURNING *`,
      [
        kept,
        supplierRefund,
        refund,
        req.user.id,
        req.body.reason || null,
        rec.id,
        req.businessId,
      ],
    );

    const lost = round2(supplierPaid - supplierRefund);
    const parts = [];
    if (refund > 0) parts.push(`$${refund.toFixed(2)} refunded`);
    if (kept > 0) parts.push(`$${kept.toFixed(2)} kept`);
    if (supplierRefund > 0)
      parts.push(`$${supplierRefund.toFixed(2)} returned by the supplier`);
    if (lost > 0) parts.push(`$${lost.toFixed(2)} paid to the supplier not returned`);

    return {
      record: upd.rows[0],
      message: parts.length ? `Cancelled. ${parts.join(", ")}.` : "Cancelled.",
    };
  });
};

/** Express handler factory. */
const cancelHandler = (kind) => async (req, res, next) => {
  const response = require("../utils/response");
  try {
    const out = await cancelService(kind, req);
    if (out.notFound)
      return response.notFound(res, `${KINDS[kind].what} not found`);
    if (out.error) return response.error(res, out.error, out.status);
    return response.success(res, out.record, out.message);
  } catch (err) {
    next(err);
  }
};

module.exports = { cancelService, cancelHandler };
