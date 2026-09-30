/**
 * journalController.js
 *
 * The books, QuickBooks-style — but nobody types a journal entry.
 *
 * v_journal turns every record in TAMS (bookings, payments, refunds,
 * cancellations, expenses, transfers, deposits, opening balances, owners'
 * capital and drawings) into balanced debit/credit lines. Because the lines
 * are generated from the records themselves, the journal can't drift from
 * the bookings, and every cent can be traced from where it came to where it
 * went.
 *
 *   GET /financials/chart-of-accounts
 *   GET /financials/trial-balance   ?as_of
 *   GET /financials/general-ledger  ?code&party_id&from_date&to_date&page&limit
 *   GET /financials/journal         ?from_date&to_date&source&search&page&limit
 */

const { query } = require("../config/db");
const response = require("../utils/response");
const { hasTable } = require("../services/schemaInfo");
const { TZ } = require("../services/cashLedger");
const { isUuid } = require("../utils/sqlSafe");

const MIGRATION_MSG =
  "The journal needs a database update. Ask your administrator to run migration_v29.sql.";
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const DAY = `(j.entry_at AT TIME ZONE '${TZ}')::DATE`;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

// Credit-normal accounts read the other way round: a liability of 500 is
// stored as -500 (a credit) and shown as 500.
const NATURAL_SIGN = { asset: 1, expense: 1, liability: -1, equity: -1, income: -1 };

/** Who a line is about, in words. */
const PARTY_JOIN = `
  LEFT JOIN customers        pc ON j.party_type = 'customer' AND pc.id = j.party_id
  LEFT JOIN airlines         pa ON j.party_type = 'airline'  AND pa.id = j.party_id
  LEFT JOIN agents           pg ON j.party_type = 'agent'    AND pg.id = j.party_id
  LEFT JOIN business_owners  po ON j.party_type = 'owner'    AND po.id = j.party_id
  LEFT JOIN payment_accounts pp ON j.party_type = 'account'  AND pp.id = j.party_id`;
const PARTY_NAME = `COALESCE(pc.name, pa.name, pg.name, po.name, pp.name,
  CASE WHEN j.party_type = 'account' THEN 'Unassigned cash' END)`;

const ready = async (res) => {
  if (!(await hasTable("journal_accounts"))) {
    response.error(res, MIGRATION_MSG, 503);
    return false;
  }
  return true;
};
const needBusiness = (req, res) => {
  if (!req.businessId) {
    response.error(res, "Select a business to view its books (pass business_id)", 400);
    return false;
  }
  return true;
};

/** GET /financials/chart-of-accounts */
const getChartOfAccounts = async (req, res, next) => {
  try {
    if (!(await ready(res))) return;
    const r = await query(`SELECT code, name, type, description FROM journal_accounts ORDER BY code`);
    return response.success(res, r.rows);
  } catch (err) {
    next(err);
  }
};

/** GET /financials/trial-balance */
const getTrialBalance = async (req, res, next) => {
  try {
    if (!(await ready(res)) || !needBusiness(req, res)) return;
    const asOf = isDate(req.query.as_of) ? req.query.as_of : null;
    const params = asOf ? [req.businessId, asOf] : [req.businessId];
    const cut = asOf ? ` AND ${DAY} <= $2::DATE` : "";

    const [byCode, byParty] = await Promise.all([
      query(
        `SELECT a.code, a.name, a.type,
                COALESCE(SUM(j.amount) FILTER (WHERE j.amount > 0), 0)  AS debits,
                COALESCE(-SUM(j.amount) FILTER (WHERE j.amount < 0), 0) AS credits,
                COALESCE(SUM(j.amount), 0)                               AS net
           FROM journal_accounts a
           LEFT JOIN v_journal j ON j.code = a.code AND j.business_id = $1${cut}
          GROUP BY a.code, a.name, a.type
          ORDER BY a.code`,
        params,
      ),
      // Cash split by payment account, expenses split by category — the two
      // places a single line hides the detail people ask about.
      query(
        `SELECT j.code,
                CASE WHEN j.code = '1000' THEN COALESCE(pp.name, 'Unassigned cash')
                     ELSE j.detail END AS label,
                CASE WHEN j.code = '1000' THEN j.party_id END AS party_id,
                COALESCE(SUM(j.amount), 0) AS net
           FROM v_journal j
           LEFT JOIN payment_accounts pp ON j.party_type = 'account' AND pp.id = j.party_id
          WHERE j.business_id = $1${cut} AND j.code IN ('1000', '6100')
          GROUP BY 1, 2, 3
         HAVING ROUND(SUM(j.amount), 2) <> 0
          ORDER BY 1, 2`,
        params,
      ),
    ]);

    const rows = byCode.rows.map((r) => {
      const net = round2(r.net);
      return {
        code: r.code,
        name: r.name,
        type: r.type,
        debit: net > 0 ? net : 0,
        credit: net < 0 ? -net : 0,
        balance: round2(net * NATURAL_SIGN[r.type]),
        total_debits: round2(r.debits),
        total_credits: round2(r.credits),
        detail: byParty.rows
          .filter((d) => d.code === r.code)
          .map((d) => ({
            label: d.label,
            party_id: d.party_id,
            balance: round2(Number(d.net) * NATURAL_SIGN[r.type]),
          })),
      };
    });

    const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
    const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
    const sumType = (t) => round2(rows.filter((r) => r.type === t).reduce((s, r) => s + r.balance, 0));
    const income = sumType("income");
    const expenses = sumType("expense");

    return response.success(res, {
      as_of: asOf || new Date().toISOString().slice(0, 10),
      rows,
      totals: {
        debit: totalDebit,
        credit: totalCredit,
        difference: round2(totalDebit - totalCredit),
        balanced: Math.abs(totalDebit - totalCredit) < 0.005,
      },
      summary: {
        assets: sumType("asset"),
        liabilities: sumType("liability"),
        equity: sumType("equity"),
        income,
        expenses,
        net_profit: round2(income - expenses),
      },
    });
  } catch (err) {
    next(err);
  }
};

/** GET /financials/general-ledger — one account, every line, running balance. */
const getGeneralLedger = async (req, res, next) => {
  try {
    if (!(await ready(res)) || !needBusiness(req, res)) return;
    const code = String(req.query.code || "");
    const acc = await query(`SELECT code, name, type FROM journal_accounts WHERE code = $1`, [code]);
    if (!acc.rows.length) return response.error(res, "Choose an account from the chart of accounts", 400);
    const account = acc.rows[0];
    const sign = NATURAL_SIGN[account.type];

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);

    const params = [req.businessId, code];
    let where = `j.business_id = $1 AND j.code = $2`;
    if (req.query.party_id === "none") where += ` AND j.party_id IS NULL`;
    else if (isUuid(req.query.party_id)) {
      params.push(req.query.party_id);
      where += ` AND j.party_id = $${params.length}`;
    }
    const base = [...params];
    let before = "";
    if (isDate(req.query.from_date)) {
      params.push(req.query.from_date);
      before = ` AND ${DAY} < $${params.length}::DATE`;
    }
    const range = [];
    const rangeParams = [...base];
    if (isDate(req.query.from_date)) {
      rangeParams.push(req.query.from_date);
      range.push(`${DAY} >= $${rangeParams.length}::DATE`);
    }
    if (isDate(req.query.to_date)) {
      rangeParams.push(req.query.to_date);
      range.push(`${DAY} <= $${rangeParams.length}::DATE`);
    }
    const rangeSql = range.length ? ` AND ${range.join(" AND ")}` : "";

    const opening = before
      ? (await query(`SELECT COALESCE(SUM(j.amount), 0) AS net FROM v_journal j WHERE ${where}${before}`, params)).rows[0].net
      : 0;

    const all = await query(
      `SELECT j.entry_at, j.source, j.source_id, j.memo, j.detail,
              j.party_type, j.party_id, ${PARTY_NAME} AS party_name, j.amount
         FROM v_journal j ${PARTY_JOIN}
        WHERE ${where}${rangeSql}
        ORDER BY j.entry_at, j.source, j.source_id`,
      rangeParams,
    );

    // Running balance over the whole range, then paginate — so page 3 still
    // shows the true balance after each line, not one restarted from zero.
    let running = Number(opening);
    const lines = all.rows.map((r) => {
      running += Number(r.amount);
      return {
        entry_at: r.entry_at,
        source: r.source,
        source_id: r.source_id,
        memo: r.memo,
        detail: r.detail,
        party_type: r.party_type,
        party_id: r.party_id,
        party_name: r.party_name,
        debit: Number(r.amount) > 0 ? round2(r.amount) : 0,
        credit: Number(r.amount) < 0 ? round2(-r.amount) : 0,
        balance: round2(running * sign),
      };
    });
    const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
    const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));

    return response.success(res, {
      account,
      opening_balance: round2(Number(opening) * sign),
      closing_balance: round2(running * sign),
      totals: { debit: totalDebit, credit: totalCredit },
      lines: lines.slice((page - 1) * limit, page * limit),
      meta: { page, limit, total: lines.length, totalPages: Math.max(Math.ceil(lines.length / limit), 1) },
    });
  } catch (err) {
    next(err);
  }
};

/** GET /financials/journal — every event and its balanced lines, newest first. */
const getJournal = async (req, res, next) => {
  try {
    if (!(await ready(res)) || !needBusiness(req, res)) return;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);

    const params = [req.businessId];
    const conds = ["j.business_id = $1"];
    if (isDate(req.query.from_date)) {
      params.push(req.query.from_date);
      conds.push(`${DAY} >= $${params.length}::DATE`);
    }
    if (isDate(req.query.to_date)) {
      params.push(req.query.to_date);
      conds.push(`${DAY} <= $${params.length}::DATE`);
    }
    if (req.query.source) {
      params.push(String(req.query.source) + "%");
      conds.push(`j.source LIKE $${params.length}`);
    }
    if (req.query.search) {
      params.push(`%${String(req.query.search).trim()}%`);
      conds.push(`j.memo ILIKE $${params.length}`);
    }
    const where = conds.join(" AND ");

    const events = await query(
      `SELECT j.source, j.source_id, j.entry_at, MIN(j.memo) AS memo,
              SUM(GREATEST(j.amount, 0)) AS total,
              COUNT(*) OVER () AS total_events
         FROM v_journal j
        WHERE ${where}
        GROUP BY j.source, j.source_id, j.entry_at
        ORDER BY j.entry_at DESC, j.source
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    const total = Number(events.rows[0]?.total_events || 0);

    let lines = [];
    if (events.rows.length) {
      const keys = events.rows.map((e) => `${e.source}|${e.source_id}|${new Date(e.entry_at).toISOString()}`);
      const ids = [...new Set(events.rows.map((e) => e.source_id))];
      const r = await query(
        `SELECT j.source, j.source_id, j.entry_at, j.code, a.name AS account_name,
                j.detail, j.party_type, j.party_id, ${PARTY_NAME} AS party_name, j.amount
           FROM v_journal j
           JOIN journal_accounts a ON a.code = j.code
           ${PARTY_JOIN}
          WHERE j.business_id = $1 AND j.source_id = ANY($2::UUID[])
          ORDER BY j.amount DESC`,
        [req.businessId, ids],
      );
      lines = r.rows.filter((l) =>
        keys.includes(`${l.source}|${l.source_id}|${new Date(l.entry_at).toISOString()}`),
      );
    }

    const entries = events.rows.map((e) => {
      const key = `${e.source}|${e.source_id}|${new Date(e.entry_at).toISOString()}`;
      const own = lines.filter(
        (l) => `${l.source}|${l.source_id}|${new Date(l.entry_at).toISOString()}` === key,
      );
      return {
        source: e.source,
        source_id: e.source_id,
        entry_at: e.entry_at,
        memo: e.memo,
        total: round2(e.total),
        lines: own.map((l) => ({
          code: l.code,
          account_name: l.account_name,
          detail: l.detail,
          party_type: l.party_type,
          party_name: l.party_name,
          debit: Number(l.amount) > 0 ? round2(l.amount) : 0,
          credit: Number(l.amount) < 0 ? round2(-l.amount) : 0,
        })),
      };
    });

    return response.success(res, {
      entries,
      meta: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getChartOfAccounts, getTrialBalance, getGeneralLedger, getJournal };
