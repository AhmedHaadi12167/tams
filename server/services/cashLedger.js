/**
 * One definition of "money in" and "money out", for every screen.
 *
 * TAMS was reporting four different figures for the same question. The
 * Accounts page said 2,960 collected, Cash Flow said 2,560, the Dashboard and
 * Reports said 2,550. None of them was lying; they were answering four
 * different questions and all calling the answer "collected".
 *
 *   - The Dashboard and Reports summed `amount_paid` off the ticket, visa,
 *     package and cargo rows. That column is a running total of everything
 *     ever paid on that record, and it was being filtered by the record's
 *     *booking* date. Collect $100 today against a ticket sold last week and
 *     the Dashboard showed nothing for today; book a ticket today that gets
 *     paid off next month and today's figure grows retroactively. They also
 *     dropped cancelled records entirely, which silently disappeared real
 *     money that had really been received.
 *
 *   - Cash Flow read the ticket payments properly but still took cargo from
 *     the shipment row, so it agreed with neither.
 *
 *   - The Accounts page read the ledger, which is why it was the only one
 *     that matched the bank balances.
 *
 * A payment is an event: an amount, an account, and the moment it happened.
 * `v_cash_ledger` already holds every one of them — that is what makes the
 * account balances reconcile — so every screen now asks it, and the question
 * "how much did we take today" finally means the same thing everywhere.
 *
 * Transfers are excluded throughout. Moving $1,500 from EVC to Premier Bank
 * is not $1,500 collected and $1,500 paid out; it is the same $1,500 in a
 * different pocket, and counting it inflates both sides of the page.
 */

const { query } = require('../config/db');
const { hasTable } = require('./schemaInfo');
const { uuidOrThrow } = require('../utils/sqlSafe');

/** Rounded to cents, because money is not a float. */
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * The agency's own clock.
 *
 * Timestamps are stored with a zone, but "today" is a local idea. A server
 * running on UTC calls 01:00 in Mogadishu yesterday, so a payment taken first
 * thing in the morning would land in the wrong day's total and the Dashboard
 * would show nothing for money that had just been collected.
 *
 * Validated against the shape of an IANA name before it goes near SQL — it is
 * interpolated, not bound, because a time zone is part of the expression
 * rather than a value.
 */
const TZ = (() => {
  const raw = process.env.APP_TIMEZONE || 'Africa/Mogadishu';
  return /^[A-Za-z][A-Za-z0-9+_\-]*(\/[A-Za-z0-9+_\-]+)*$/.test(raw)
    ? raw
    : 'UTC';
})();

/** The moment a movement happened, as a date on the agency's calendar. */
const LOCAL_DAY = `(l.occurred_at AT TIME ZONE '${TZ}')::DATE`;

/**
 * Build a date filter over the ledger's own timestamp — when the money
 * actually moved, never when the booking was made.
 *
 * Both ends are inclusive and compared as dates, so asking for today gets
 * everything up to tonight rather than stopping at midnight this morning.
 */
const ledgerRange = (from, to, startIndex) => {
  const parts = [];
  const params = [];
  let i = startIndex;
  if (from) {
    parts.push(`${LOCAL_DAY} >= $${i++}::DATE`);
    params.push(from);
  }
  if (to) {
    parts.push(`${LOCAL_DAY} <= $${i++}::DATE`);
    params.push(to);
  }
  return { clause: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
};

/**
 * The window a dashboard period covers, on the agency's calendar.
 * Returned as ISO dates so they can be shown to the user and passed to any
 * other query that needs the same window.
 */
const periodWindow = async (period) => {
  const res = await query(
    `SELECT (NOW() AT TIME ZONE '${TZ}')::DATE AS today`,
  );
  const today = res.rows[0].today;
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const minus = (d, days) => {
    const x = new Date(d);
    x.setDate(x.getDate() - days);
    return iso(x);
  };

  if (period === 'today') return { from: iso(today), to: iso(today) };
  if (period === 'week') return { from: minus(today, 6), to: iso(today) };
  if (period === 'month') return { from: minus(today, 29), to: iso(today) };
  return { from: null, to: null }; // all time
};

/**
 * What a business took in and paid out over a window.
 *
 * Returns zeros rather than throwing when the ledger doesn't exist yet, so a
 * database that hasn't run migration v11 still renders every page.
 *
 * @param {string} businessId
 * @param {{from?: string, to?: string}} [range] ISO dates, inclusive
 */
const cashMovement = async (businessId, range = {}) => {
  if (!(await hasTable('v_cash_ledger')))
    return { collected: 0, paid_out: 0, net: 0, entries: 0 };

  const id = uuidOrThrow(businessId, 'business id');
  const { clause, params } = ledgerRange(range.from, range.to, 2);

  const res = await query(
    `SELECT
       COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'in'), 0)  AS collected,
       COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'out'), 0) AS paid_out,
       COUNT(*)                                                      AS entries
     FROM v_cash_ledger l
     WHERE l.business_id = $1
       AND l.source NOT LIKE 'transfer%'${clause}`,
    [id, ...params],
  );

  const r = res.rows[0];
  return {
    collected: round2(r.collected),
    paid_out: round2(r.paid_out),
    net: round2(Number(r.collected) - Number(r.paid_out)),
    entries: parseInt(r.entries, 10) || 0,
  };
};

/**
 * The same figures split by where the money came from, for the breakdown
 * under the headline. Sums to `cashMovement` exactly.
 */
const cashBySource = async (businessId, range = {}) => {
  if (!(await hasTable('v_cash_ledger'))) return [];

  const id = uuidOrThrow(businessId, 'business id');
  const { clause, params } = ledgerRange(range.from, range.to, 2);

  const res = await query(
    `SELECT l.source,
            COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'in'), 0)  AS collected,
            COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'out'), 0) AS paid_out
       FROM v_cash_ledger l
      WHERE l.business_id = $1
        AND l.source NOT LIKE 'transfer%'${clause}
      GROUP BY l.source
      ORDER BY 2 DESC`,
    [id, ...params],
  );

  return res.rows.map((r) => ({
    source: r.source,
    collected: round2(r.collected),
    paid_out: round2(r.paid_out),
  }));
};

/** Day-by-day in and out, for the cash flow chart. */
const cashDaily = async (businessId, range = {}) => {
  if (!(await hasTable('v_cash_ledger'))) return [];

  const id = uuidOrThrow(businessId, 'business id');
  const { clause, params } = ledgerRange(range.from, range.to, 2);

  const res = await query(
    `SELECT ${LOCAL_DAY} AS day,
            COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'in'), 0)  AS inflow,
            COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'out'), 0) AS outflow
       FROM v_cash_ledger l
      WHERE l.business_id = $1
        AND l.source NOT LIKE 'transfer%'${clause}
      GROUP BY 1 ORDER BY 1`,
    [id, ...params],
  );

  return res.rows.map((r) => ({
    day: r.day,
    inflow: round2(r.inflow),
    outflow: round2(r.outflow),
  }));
};

module.exports = {
  cashMovement,
  cashBySource,
  cashDaily,
  ledgerRange,
  periodWindow,
  TZ,
};
