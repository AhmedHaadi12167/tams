/**
 * financialsController.js
 *
 * Service-company financial reporting.
 *
 * A travel agency doesn't hold inventory — it buys a seat from an airline
 * and resells it. So the accounting shape is:
 *
 *   Gross Sales      = what the customer was charged (tickets + cargo)
 *   Cost of Sales    = what we paid the airline for the seat
 *   Gross Profit     = Gross Sales - Cost of Sales
 *   Operating Costs  = agent commission + recorded expenses
 *   Net Profit       = Gross Profit - Operating Costs
 *
 * Cargo has no purchase cost in this system, so its full price is margin.
 */

const { query } = require("../config/db");
const response = require("../utils/response");

// ── helpers ──────────────────────────────────────────────────────────────────

const n = (v) => Number(v || 0);
const round2 = (v) => Math.round(n(v) * 100) / 100;

/** Requires a concrete business scope (super_admin must pass ?business_id=). */
const requireBusiness = (req, res) => {
  if (!req.businessId) {
    response.error(
      res,
      "Select a business to view its financials (pass business_id)",
      400,
    );
    return false;
  }
  return true;
};

/**
 * Builds a reusable date-range clause.
 * Returns { clause, params } where params start at index `startIdx`.
 */
const dateRange = (column, from, to, startIdx) => {
  const parts = [];
  const params = [];
  let pi = startIdx;
  if (from) {
    parts.push(`${column} >= $${pi}`);
    params.push(from);
    pi++;
  }
  if (to) {
    parts.push(`${column} <= $${pi}`);
    params.push(to);
    pi++;
  }
  return { clause: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
};

// ── GET /api/financials/profit-loss ──────────────────────────────────────────

const getProfitLoss = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const businessId = req.businessId;
    const { from_date, to_date } = req.query;

    const tRange = dateRange("t.created_at::DATE", from_date, to_date, 2);
    const cRange = dateRange("cs.created_at::DATE", from_date, to_date, 2);
    const eRange = dateRange("e.expense_date", from_date, to_date, 2);

    const [ticketRes, cargoRes, expenseRes, categoryRes, trendRes] =
      await Promise.all([
        query(
          `SELECT
             COUNT(*)                                 AS ticket_count,
             COALESCE(SUM(t.selling_price), 0)        AS gross_sales,
             COALESCE(SUM(t.cost_price), 0)           AS cost_of_sales,
             COALESCE(SUM(t.agent_commission), 0)     AS agent_commission,
             COALESCE(SUM(t.amount_paid), 0)          AS collected
           FROM tickets t
           WHERE t.business_id = $1 AND t.status <> 'cancelled'${tRange.clause}`,
          [businessId, ...tRange.params],
        ),
        query(
          `SELECT
             COUNT(*)                                 AS shipment_count,
             COALESCE(SUM(cs.total_price), 0)         AS gross_sales,
             COALESCE(SUM(cs.amount_paid), 0)         AS collected
           FROM cargo_shipments cs
           WHERE cs.business_id = $1 AND cs.cargo_status <> 'cancelled'${cRange.clause}`,
          [businessId, ...cRange.params],
        ),
        query(
          `SELECT COALESCE(SUM(e.amount), 0) AS total_expenses, COUNT(*) AS expense_count
           FROM expenses e WHERE e.business_id = $1${eRange.clause}`,
          [businessId, ...eRange.params],
        ),
        query(
          `SELECT e.category, COALESCE(SUM(e.amount), 0) AS amount, COUNT(*) AS entries
           FROM expenses e WHERE e.business_id = $1${eRange.clause}
           GROUP BY e.category ORDER BY amount DESC`,
          [businessId, ...eRange.params],
        ),
        query(
          `SELECT
             m.month,
             COALESCE(m.gross_sales, 0)   AS gross_sales,
             COALESCE(m.gross_profit, 0)  AS gross_profit,
             COALESCE(x.expenses, 0)      AS expenses,
             COALESCE(m.gross_profit, 0) - COALESCE(x.expenses, 0) AS net_profit
           FROM v_monthly_income m
           LEFT JOIN (
             SELECT DATE_TRUNC('month', expense_date)::DATE AS month,
                    SUM(amount) AS expenses
             FROM expenses WHERE business_id = $1 GROUP BY 1
           ) x ON x.month = m.month
           WHERE m.business_id = $1
             AND m.month >= DATE_TRUNC('month', NOW() - INTERVAL '11 months')::DATE
           ORDER BY m.month`,
          [businessId],
        ),
      ]);

    const t = ticketRes.rows[0];
    const c = cargoRes.rows[0];
    const e = expenseRes.rows[0];

    const grossSales = round2(n(t.gross_sales) + n(c.gross_sales));
    const costOfSales = round2(t.cost_of_sales);
    const grossProfit = round2(grossSales - costOfSales);
    const commission = round2(t.agent_commission);
    const recordedExpenses = round2(e.total_expenses);
    const operatingCosts = round2(commission + recordedExpenses);
    const netProfit = round2(grossProfit - operatingCosts);

    return response.success(res, {
      period: { from: from_date || null, to: to_date || null },
      revenue: {
        ticket_sales: round2(t.gross_sales),
        cargo_sales: round2(c.gross_sales),
        gross_sales: grossSales,
        ticket_count: parseInt(t.ticket_count),
        shipment_count: parseInt(c.shipment_count),
      },
      cost_of_sales: {
        airline_tickets: costOfSales,
        total: costOfSales,
      },
      gross_profit: grossProfit,
      gross_margin_pct: grossSales > 0 ? round2((grossProfit / grossSales) * 100) : 0,
      operating_costs: {
        agent_commission: commission,
        recorded_expenses: recordedExpenses,
        by_category: categoryRes.rows.map((r) => ({
          category: r.category,
          amount: round2(r.amount),
          entries: parseInt(r.entries),
        })),
        total: operatingCosts,
      },
      net_profit: netProfit,
      net_margin_pct: grossSales > 0 ? round2((netProfit / grossSales) * 100) : 0,
      cash: {
        collected: round2(n(t.collected) + n(c.collected)),
        outstanding: round2(grossSales - (n(t.collected) + n(c.collected))),
      },
      trend: trendRes.rows.map((r) => ({
        month: r.month,
        gross_sales: round2(r.gross_sales),
        gross_profit: round2(r.gross_profit),
        expenses: round2(r.expenses),
        net_profit: round2(r.net_profit),
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/financials/balance-sheet ────────────────────────────────────────

const getBalanceSheet = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const businessId = req.businessId;
    const { as_of } = req.query;

    const asOfClause = as_of ? ` AND created_at::DATE <= $2` : "";
    const asOfExpClause = as_of ? ` AND expense_date <= $2` : "";
    const p = as_of ? [businessId, as_of] : [businessId];

    const [bizRes, ticketRes, cargoRes, expenseRes] = await Promise.all([
      query(
        `SELECT name, opening_cash, fixed_assets, liabilities, owner_capital, financials_start
         FROM businesses WHERE id = $1`,
        [businessId],
      ),
      query(
        `SELECT
           COALESCE(SUM(selling_price), 0)     AS gross_sales,
           COALESCE(SUM(cost_price), 0)        AS cost_of_sales,
           COALESCE(SUM(agent_commission), 0)  AS commission,
           COALESCE(SUM(amount_paid), 0)       AS collected
         FROM tickets
         WHERE business_id = $1 AND status <> 'cancelled'${asOfClause}`,
        p,
      ),
      query(
        `SELECT
           COALESCE(SUM(total_price), 0) AS gross_sales,
           COALESCE(SUM(amount_paid), 0) AS collected
         FROM cargo_shipments
         WHERE business_id = $1 AND cargo_status <> 'cancelled'${asOfClause}`,
        p,
      ),
      query(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM expenses WHERE business_id = $1${asOfExpClause}`,
        p,
      ),
    ]);

    const biz = bizRes.rows[0] || {};
    const t = ticketRes.rows[0];
    const c = cargoRes.rows[0];

    const openingCash = round2(biz.opening_cash);
    const fixedAssets = round2(biz.fixed_assets);
    const manualLiabilities = round2(biz.liabilities);

    const grossSales = round2(n(t.gross_sales) + n(c.gross_sales));
    const collected = round2(n(t.collected) + n(c.collected));
    const costOfSales = round2(t.cost_of_sales);
    const commission = round2(t.commission);
    const expensesPaid = round2(expenseRes.rows[0].total);

    // ── Assets ──────────────────────────────────────────────
    const cash = round2(openingCash + collected - expensesPaid);
    const receivables = round2(grossSales - collected);
    const totalAssets = round2(cash + receivables + fixedAssets);

    // ── Liabilities ─────────────────────────────────────────
    // Airline costs and agent commission are accrued at booking but this
    // system doesn't record paying them out, so they sit as payables.
    const supplierPayable = round2(costOfSales + commission);
    const totalLiabilities = round2(supplierPayable + manualLiabilities);

    // ── Equity ──────────────────────────────────────────────
    const retainedEarnings = round2(
      grossSales - costOfSales - commission - expensesPaid,
    );
    // If the owner never entered a capital figure, derive it from the
    // opening balances so the sheet balances (Assets = Liabilities + Equity).
    const ownerCapital = n(biz.owner_capital)
      ? round2(biz.owner_capital)
      : round2(openingCash + fixedAssets - manualLiabilities);
    const totalEquity = round2(ownerCapital + retainedEarnings);

    const difference = round2(totalAssets - (totalLiabilities + totalEquity));

    return response.success(res, {
      business_name: biz.name,
      as_of: as_of || new Date().toISOString().slice(0, 10),
      assets: {
        cash_and_bank: cash,
        accounts_receivable: receivables,
        fixed_assets: fixedAssets,
        total: totalAssets,
      },
      liabilities: {
        payable_to_airlines: round2(costOfSales),
        agent_commission_payable: commission,
        other_liabilities: manualLiabilities,
        total: totalLiabilities,
      },
      equity: {
        owner_capital: ownerCapital,
        retained_earnings: retainedEarnings,
        total: totalEquity,
      },
      total_liabilities_and_equity: round2(totalLiabilities + totalEquity),
      balanced: Math.abs(difference) < 0.01,
      difference,
      notes: [
        "Cash = opening cash + money collected − expenses paid.",
        "Airline costs and agent commission are shown as payables because supplier payouts are not recorded in TAMS.",
        "Set opening cash, fixed assets, liabilities and owner capital on the business record for an accurate opening position.",
      ],
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/financials/cash-flow ────────────────────────────────────────────

const getCashFlow = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const businessId = req.businessId;
    const { from_date, to_date } = req.query;

    const pRange = dateRange("p.created_at::DATE", from_date, to_date, 2);
    const cRange = dateRange("cs.created_at::DATE", from_date, to_date, 2);
    const eRange = dateRange("e.expense_date", from_date, to_date, 2);
    // The daily query unions payments and expenses in one statement, so the
    // expense placeholders must continue where the payment ones stopped —
    // otherwise Postgres is handed more parameters than the query references.
    const eRangeShifted = dateRange(
      "e.expense_date",
      from_date,
      to_date,
      2 + pRange.params.length,
    );

    const [inflowRes, cargoInRes, outflowRes, dailyRes, methodRes] =
      await Promise.all([
        query(
          `SELECT COALESCE(SUM(p.amount), 0) AS total, COUNT(*) AS entries
           FROM ticket_payments p
           WHERE p.business_id = $1${pRange.clause}`,
          [businessId, ...pRange.params],
        ),
        query(
          `SELECT COALESCE(SUM(cs.amount_paid), 0) AS total
           FROM cargo_shipments cs
           WHERE cs.business_id = $1 AND cs.cargo_status <> 'cancelled'${cRange.clause}`,
          [businessId, ...cRange.params],
        ),
        query(
          `SELECT COALESCE(SUM(e.amount), 0) AS total, COUNT(*) AS entries
           FROM expenses e WHERE e.business_id = $1${eRange.clause}`,
          [businessId, ...eRange.params],
        ),
        query(
          `SELECT day, COALESCE(SUM(inflow), 0) AS inflow, COALESCE(SUM(outflow), 0) AS outflow
           FROM (
             SELECT p.created_at::DATE AS day, p.amount AS inflow, 0 AS outflow
             FROM ticket_payments p WHERE p.business_id = $1${pRange.clause}
             UNION ALL
             SELECT e.expense_date AS day, 0 AS inflow, e.amount AS outflow
             FROM expenses e WHERE e.business_id = $1${eRangeShifted.clause}
           ) x
           GROUP BY day ORDER BY day`,
          [businessId, ...pRange.params, ...eRangeShifted.params],
        ),
        query(
          `SELECT p.method, COALESCE(SUM(p.amount), 0) AS total
           FROM ticket_payments p
           WHERE p.business_id = $1${pRange.clause}
           GROUP BY p.method ORDER BY total DESC`,
          [businessId, ...pRange.params],
        ),
      ]);

    const ticketIn = round2(inflowRes.rows[0].total);
    const cargoIn = round2(cargoInRes.rows[0].total);
    const totalIn = round2(ticketIn + cargoIn);
    const totalOut = round2(outflowRes.rows[0].total);

    return response.success(res, {
      period: { from: from_date || null, to: to_date || null },
      inflow: {
        ticket_payments: ticketIn,
        cargo_payments: cargoIn,
        total: totalIn,
        entries: parseInt(inflowRes.rows[0].entries),
        by_method: methodRes.rows.map((r) => ({
          method: r.method || "cash",
          total: round2(r.total),
        })),
      },
      outflow: {
        expenses: totalOut,
        total: totalOut,
        entries: parseInt(outflowRes.rows[0].entries),
      },
      net_cash_flow: round2(totalIn - totalOut),
      daily: dailyRes.rows.map((r) => ({
        day: r.day,
        inflow: round2(r.inflow),
        outflow: round2(r.outflow),
        net: round2(n(r.inflow) - n(r.outflow)),
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/financials/receivables ──────────────────────────────────────────

const getReceivables = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const businessId = req.businessId;
    const { source, page = 1, limit = 50 } = req.query;

    const params = [businessId];
    let where = "r.business_id = $1";
    let pi = 2;
    if (source) {
      where += ` AND r.source = $${pi}`;
      params.push(source);
      pi++;
    }
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [agingRes, countRes, listRes] = await Promise.all([
      query(
        `SELECT
           COALESCE(SUM(r.balance) FILTER (WHERE age <= 30), 0)               AS current_0_30,
           COALESCE(SUM(r.balance) FILTER (WHERE age > 30 AND age <= 60), 0)  AS days_31_60,
           COALESCE(SUM(r.balance) FILTER (WHERE age > 60 AND age <= 90), 0)  AS days_61_90,
           COALESCE(SUM(r.balance) FILTER (WHERE age > 90), 0)                AS over_90,
           COALESCE(SUM(r.balance), 0)                                        AS total,
           COUNT(*)                                                           AS open_items
         FROM (
           SELECT *, (CURRENT_DATE - issued_at::DATE) AS age
           FROM v_receivables WHERE business_id = $1
         ) r`,
        [businessId],
      ),
      query(`SELECT COUNT(*) FROM v_receivables r WHERE ${where}`, params),
      query(
        `SELECT r.*, (CURRENT_DATE - r.issued_at::DATE) AS age_days
         FROM v_receivables r
         WHERE ${where}
         ORDER BY r.issued_at ASC
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, parseInt(limit), offset],
      ),
    ]);

    const a = agingRes.rows[0];
    return response.success(res, {
      aging: {
        current_0_30: round2(a.current_0_30),
        days_31_60: round2(a.days_31_60),
        days_61_90: round2(a.days_61_90),
        over_90: round2(a.over_90),
        total: round2(a.total),
        open_items: parseInt(a.open_items),
      },
      items: listRes.rows.map((r) => ({
        ...r,
        total_amount: round2(r.total_amount),
        paid_amount: round2(r.paid_amount),
        balance: round2(r.balance),
        age_days: parseInt(r.age_days),
      })),
      meta: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countRes.rows[0].count),
        totalPages: Math.ceil(parseInt(countRes.rows[0].count) / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/financials/opening-balances ─────────────────────────────────────

const updateOpeningBalances = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const {
      opening_cash,
      fixed_assets,
      liabilities,
      owner_capital,
      financials_start,
    } = req.body;

    const result = await query(
      `UPDATE businesses SET
         opening_cash     = COALESCE($1, opening_cash),
         fixed_assets     = COALESCE($2, fixed_assets),
         liabilities      = COALESCE($3, liabilities),
         owner_capital    = COALESCE($4, owner_capital),
         financials_start = COALESCE($5, financials_start)
       WHERE id = $6
       RETURNING id, name, opening_cash, fixed_assets, liabilities, owner_capital, financials_start`,
      [
        opening_cash ?? null,
        fixed_assets ?? null,
        liabilities ?? null,
        owner_capital ?? null,
        financials_start || null,
        req.businessId,
      ],
    );

    if (result.rows.length === 0)
      return response.notFound(res, "Business not found");
    return response.success(res, result.rows[0], "Opening balances updated");
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getProfitLoss,
  getBalanceSheet,
  getCashFlow,
  getReceivables,
  updateOpeningBalances,
};
