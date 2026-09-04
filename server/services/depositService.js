/**
 * depositService.js — spending money the agency is holding for a customer.
 *
 * THE ONE RULE
 *
 * Applying a deposit moves no cash.
 *
 * The money arrived when the deposit was taken. It is already sitting in
 * Salaam Bank or the cash drawer, and it is already in the ledger. What
 * changes when it is applied to a booking is not where the money is, but
 * what the agency owes: it stops owing the customer a refund and the booking
 * stops being unpaid.
 *
 * Get that wrong and the damage is quiet and severe. Insert an ordinary
 * payment row pointing at an account and the same $300 is counted twice —
 * once when it was deposited, once when it was spent — so every balance it
 * touches inflates and the Accounts page stops matching the bank. That is
 * exactly the class of bug this system has been chasing all week.
 *
 * So an application does three things and no more:
 *
 *   1. records where the deposit went, in deposit_applications
 *   2. adds a payment row on the booking flagged `from_deposit`, so
 *      amount_paid still equals the sum of its payments
 *   3. leaves the cash ledger alone — v_cash_ledger skips flagged rows
 *
 * The effect on the balance sheet: cash unchanged, the deposit liability
 * down, the receivable down. Assets and liabilities fall together and the
 * sheet still balances.
 */

const { query } = require("../config/db");
const { hasTable } = require("./schemaInfo");
const { uuidOrThrow } = require("../utils/sqlSafe");

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * What can still be spent for this customer: taken, less already applied.
 * Never negative — a deposit cannot be overspent, and a negative here would
 * silently become a credit note nobody authorised.
 */
const depositBalance = async (businessId, customerId, client = null) => {
  if (!customerId) return 0;
  if (!(await hasTable("deposit_applications"))) return 0;
  const run = client ? client.query.bind(client) : query;

  const res = await run(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM customer_deposits
                  WHERE business_id = $1 AND customer_id = $2), 0)
     - COALESCE((SELECT SUM(amount) FROM deposit_applications
                  WHERE business_id = $1 AND customer_id = $2), 0) AS balance`,
    [businessId, uuidOrThrow(customerId, "customer id")],
  );
  return Math.max(round2(res.rows[0].balance), 0);
};

/**
 * The four things a deposit can pay for, and how each records a payment.
 *
 * Kept as data rather than four near-identical functions, so a fifth kind of
 * booking is one entry here instead of a fourth place to forget the
 * from_deposit flag.
 */
const TARGETS = {
  ticket: {
    table: "tickets",
    payments: "ticket_payments",
    fk: "ticket_id",
    total: "selling_price",
    collector: "collected_by",
  },
  visa: {
    table: "visa_applications",
    payments: "visa_payments",
    fk: "visa_id",
    total: "selling_price",
    collector: "collected_by",
  },
  package: {
    table: "packages",
    payments: "package_payments",
    fk: "package_id",
    total: "selling_price",
    collector: "collected_by",
  },
  cargo: {
    table: "cargo_shipments",
    payments: "cargo_payments",
    fk: "cargo_id",
    total: "total_price",
    collector: "collected_by",
  },
};

const targetOrThrow = (kind) => {
  const t = TARGETS[kind];
  if (!t) {
    const err = new Error(
      `A deposit cannot be applied to "${kind}". Expected ticket, visa, package or cargo.`,
    );
    err.statusCode = 400;
    err.expose = true;
    throw err;
  }
  return t;
};

/**
 * Apply a customer's deposit to one booking.
 *
 * Must be called inside a transaction: the application, the payment row and
 * the booking's running total have to land together or not at all.
 *
 * @param {object} client        pg client inside a transaction
 * @param {object} args
 * @param {string} args.businessId
 * @param {string} args.customerId
 * @param {string} args.userId
 * @param {string} args.kind     ticket | visa | package | cargo
 * @param {string} args.recordId
 * @param {number} [args.amount] omit to use as much as will fit
 * @returns {Promise<{applied:number, remaining:number, outstanding:number}>}
 */
const applyDeposit = async (
  client,
  { businessId, customerId, userId, kind, recordId, amount },
) => {
  const t = targetOrThrow(kind);
  const id = uuidOrThrow(recordId, `${kind} id`);

  const held = await depositBalance(businessId, customerId, client);
  if (held <= 0.001) return { applied: 0, remaining: 0, outstanding: 0 };

  const recRes = await client.query(
    `SELECT ${t.total} AS total, COALESCE(amount_paid, 0) AS paid
       FROM ${t.table} WHERE id = $1 AND business_id = $2`,
    [id, businessId],
  );
  if (recRes.rows.length === 0) {
    const err = new Error("Record not found");
    err.statusCode = 404;
    err.expose = true;
    throw err;
  }

  const outstanding = round2(
    Number(recRes.rows[0].total) - Number(recRes.rows[0].paid),
  );
  if (outstanding <= 0.001)
    return { applied: 0, remaining: held, outstanding: 0 };

  // Never more than is held, and never more than is owed. Overpaying a
  // booking out of a deposit would turn the surplus into a negative balance
  // nobody can explain.
  const requested =
    amount === undefined || amount === null || amount === ""
      ? Math.min(held, outstanding)
      : round2(amount);

  const applied = round2(Math.min(requested, held, outstanding));
  if (applied <= 0.001) return { applied: 0, remaining: held, outstanding };

  await client.query(
    `INSERT INTO deposit_applications
       (business_id, customer_id, amount, ${t.fk}, applied_by, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [businessId, customerId, applied, id, userId, `Applied to ${kind}`],
  );

  // The booking gets a real payment row — amount_paid must equal the sum of
  // its payments or the two drift and nobody can tell which is right — but
  // flagged, and with no account, because no account moved.
  await client.query(
    `INSERT INTO ${t.payments}
       (business_id, ${t.fk}, ${t.collector}, amount, method, note, account_id, from_deposit)
     VALUES ($1,$2,$3,$4,'deposit','Paid from customer deposit',NULL,TRUE)`,
    [businessId, id, userId, applied],
  );

  await client.query(
    `UPDATE ${t.table}
        SET amount_paid = COALESCE(amount_paid, 0) + $1,
            payment_status = CASE
              WHEN COALESCE(amount_paid, 0) + $1 >= ${t.total} THEN 'paid'::payment_status
              WHEN COALESCE(amount_paid, 0) + $1 > 0           THEN 'partial'::payment_status
              ELSE 'unpaid'::payment_status
            END
      WHERE id = $2 AND business_id = $3`,
    [applied, id, businessId],
  );

  return {
    applied,
    remaining: round2(held - applied),
    outstanding: round2(outstanding - applied),
  };
};

module.exports = { depositBalance, applyDeposit, TARGETS };
