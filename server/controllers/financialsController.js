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

const { query, withTransaction } = require("../config/db");
const response = require("../utils/response");
const {
  cashMovement,
  cashBySource,
  cashDaily,
  TZ,
} = require("../services/cashLedger");
const { hasTable } = require("../services/schemaInfo");

// ── helpers ──────────────────────────────────────────────────────────────────

const n = (v) => Number(v || 0);
const round2 = (v) => Math.round(n(v) * 100) / 100;

/**
 * Run a query only if its table exists, otherwise hand back a row of zeros.
 * Lets the statements stay correct on a database where migration_v8 has not
 * been run yet, instead of 500ing on a missing relation.
 */
const optional = async (table, sql, params, zeros) => {
  if (!(await hasTable(table))) return { rows: [zeros] };
  return query(sql, params);
};

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
    const vRange = dateRange("v.created_at::DATE", from_date, to_date, 2);
    const pRange = dateRange("pk.created_at::DATE", from_date, to_date, 2);

    const sRange = (alias) =>
      dateRange(`${alias}.created_at::DATE`, from_date, to_date, 2);
    const fRange = dateRange(
      `(tr.transferred_at AT TIME ZONE '${TZ}')::DATE`,
      from_date,
      to_date,
      2,
    );

    const [
      ticketRes,
      cargoRes,
      expenseRes,
      categoryRes,
      trendRes,
      visaRes,
      packageRes,
      serviceCancelRes,
      feeRes,
    ] = await Promise.all([
      query(
        `SELECT
             COUNT(*) FILTER (WHERE t.status <> 'cancelled')                     AS ticket_count,
             COALESCE(SUM(t.selling_price)    FILTER (WHERE t.status <> 'cancelled'), 0) AS gross_sales,
             COALESCE(SUM(t.cost_price)       FILTER (WHERE t.status <> 'cancelled'), 0) AS cost_of_sales,
             COALESCE(SUM(t.agent_commission) FILTER (WHERE t.status <> 'cancelled'), 0) AS agent_commission,
             COALESCE(SUM(t.amount_paid)      FILTER (WHERE t.status <> 'cancelled'), 0) AS collected,
             -- A cancelled booking is no longer a sale, but the fee retained
             -- on it was still earned. Dropping the row entirely would lose
             -- that income and leave the accounts holding money the profit
             -- and loss could not explain.
             -- What the customer's payments net to, less the tax still owed
             -- on it. Derived here rather than read from cancellation_fee so
             -- the three parts below always add up to each ticket's revenue.
             COALESCE(SUM(GREATEST(COALESCE(t.amount_paid, 0)
                          - GREATEST(COALESCE(t.tax, 0) - COALESCE(t.tax_refunded, 0), 0), 0))
                      FILTER (WHERE t.status = 'cancelled'), 0)                  AS cancellation_fees,
             -- Tax still owed on a cancelled ticket that the customer never
             -- paid: the agency pays it out of its own pocket.
             COALESCE(SUM(GREATEST(GREATEST(COALESCE(t.tax, 0) - COALESCE(t.tax_refunded, 0), 0)
                          - COALESCE(t.amount_paid, 0), 0))
                      FILTER (WHERE t.status = 'cancelled'), 0)                  AS tax_shortfall,
             COUNT(*) FILTER (WHERE t.status = 'cancelled')                      AS cancelled_count,
             -- What the agency paid the airline and never got back on a
             -- cancelled ticket. The sale disappears from revenue, so if this
             -- disappeared too the profit would be overstated by exactly the
             -- amount lost — the books would look better for losing money.
             --
             -- It is what was *paid*, not what the ticket cost. An airline
             -- cannot refund money it was never sent, so a ticket cancelled
             -- before the agency paid for it loses nothing. airline_paid has
             -- already had any refund taken off it by the cancellation.
             COALESCE(SUM(
               GREATEST(COALESCE(t.airline_paid, 0), 0)
             ) FILTER (WHERE t.status = 'cancelled'), 0)                         AS unrecovered_cost,
             -- Balances given up on when a ticket was cancelled. Reported
             -- so the loss is visible, but NOT subtracted from profit: a
             -- cancelled sale never entered revenue in the first place, so
             -- taking the unpaid part out again would count the same loss
             -- twice and make a bad cancellation look worse than it was.
             COALESCE(SUM(COALESCE(t.written_off, 0))
                      FILTER (WHERE t.status = 'cancelled'), 0)                  AS written_off,
             -- Tax sits inside cost_price but belongs to the government, so
             -- it is neither the agency's cost nor the airline's income.
             -- Cancelling the journey does not cancel the tax, so cancelled
             -- tickets count too — less anything the airline handed back.
             COALESCE(SUM(
               GREATEST(COALESCE(t.tax, 0) - COALESCE(t.tax_refunded, 0), 0)
             ), 0)                                                               AS tax_collected
           FROM tickets t
           WHERE t.business_id = $1${tRange.clause}`,
        [businessId, ...tRange.params],
      ),
      query(
        `SELECT
             COUNT(*)                                 AS shipment_count,
             COALESCE(SUM(cs.total_price), 0)         AS gross_sales,
             COALESCE(SUM(cs.amount_paid), 0)         AS collected,
             -- Cargo used to be counted as pure margin, because the agency
             -- was assumed to have no cost. True for a parcel carried on a
             -- flight already booked; false whenever a carrier charges per
             -- kilo. Where a profit has been entered, the rest is cost.
             COALESCE(SUM(GREATEST(cs.total_price - cs.profit_total, 0))
                      FILTER (WHERE cs.profit_total IS NOT NULL), 0) AS carrier_cost
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
      optional(
        "visa_applications",
        `SELECT COUNT(*) AS visa_count,
                COALESCE(SUM(v.selling_price), 0) AS gross_sales,
                COALESCE(SUM(v.cost_price), 0)    AS cost_of_sales,
                COALESCE(SUM(v.amount_paid), 0)   AS collected
         FROM visa_applications v
         WHERE v.business_id = $1 AND v.status <> 'cancelled'${vRange.clause}`,
        [businessId, ...vRange.params],
        { visa_count: 0, gross_sales: 0, cost_of_sales: 0, collected: 0 },
      ),
      optional(
        "packages",
        `SELECT COUNT(*) AS package_count,
                COALESCE(SUM(pk.selling_price), 0) AS gross_sales,
                COALESCE(SUM(pk.total_cost), 0)    AS cost_of_sales,
                COALESCE(SUM(pk.amount_paid), 0)   AS collected
         FROM packages pk
         WHERE pk.business_id = $1 AND pk.status <> 'cancelled'${pRange.clause}`,
        [businessId, ...pRange.params],
        { package_count: 0, gross_sales: 0, cost_of_sales: 0, collected: 0 },
      ),
      // Cancelled visas, packages and shipments: what the customer's payments
      // net to, less what was paid to the supplier and not returned.
      query(
        `SELECT
           (SELECT COALESCE(SUM(COALESCE(v.amount_paid, 0) - COALESCE(v.supplier_paid, 0)), 0)
              FROM visa_applications v
             WHERE v.business_id = $1 AND v.status = 'cancelled'${sRange("v").clause})
         + (SELECT COALESCE(SUM(COALESCE(pk.amount_paid, 0) - COALESCE(pk.supplier_paid, 0)), 0)
              FROM packages pk
             WHERE pk.business_id = $1 AND pk.status = 'cancelled'${sRange("pk").clause})
         + (SELECT COALESCE(SUM(COALESCE(cs.amount_paid, 0) - COALESCE(cs.supplier_paid, 0)), 0)
              FROM cargo_shipments cs
             WHERE cs.business_id = $1 AND cs.cargo_status = 'cancelled'${sRange("cs").clause}) AS net,
           (SELECT COUNT(*) FROM visa_applications v
             WHERE v.business_id = $1 AND v.status = 'cancelled'${sRange("v").clause})
         + (SELECT COUNT(*) FROM packages pk
             WHERE pk.business_id = $1 AND pk.status = 'cancelled'${sRange("pk").clause})
         + (SELECT COUNT(*) FROM cargo_shipments cs
             WHERE cs.business_id = $1 AND cs.cargo_status = 'cancelled'${sRange("cs").clause}) AS count`,
        [businessId, ...sRange("v").params],
      ),
      // Fees charged on transfers between the agency's own accounts.
      query(
        `SELECT COALESCE(SUM(COALESCE(tr.fee, 0)), 0) AS total
           FROM account_transfers tr
          WHERE tr.business_id = $1${fRange.clause}`,
        [businessId, ...fRange.params],
      ),
    ]);

    const t = ticketRes.rows[0];
    const c = cargoRes.rows[0];
    const e = expenseRes.rows[0];
    const v = visaRes.rows[0];
    const pk = packageRes.rows[0];

    const grossSales = round2(
      n(t.gross_sales) +
        n(c.gross_sales) +
        n(v.gross_sales) +
        n(pk.gross_sales),
    );
    const costOfSales = round2(
      n(t.cost_of_sales) +
        n(v.cost_of_sales) +
        n(pk.cost_of_sales) +
        n(c.carrier_cost),
    );
    const grossProfit = round2(grossSales - costOfSales);
    const commission = round2(t.agent_commission);
    const recordedExpenses = round2(e.total_expenses);
    const bankFees = round2(feeRes.rows[0].total);
    const operatingCosts = round2(commission + recordedExpenses + bankFees);

    // Fees kept on cancelled bookings. Not a sale — there is no journey and
    // no cost of sale against it — but money genuinely earned, so it belongs
    // below gross profit rather than inside gross sales.
    const cancellationFees = round2(t.cancellation_fees);

    // The other half of a cancellation: fare paid to the airline and not
    // returned. A cost with no sale against it.
    const unrecoveredCost = round2(t.unrecovered_cost);
    const writtenOff = round2(t.written_off);

    // Tax collected on behalf of the government. Held, not earned.
    const taxCollected = round2(t.tax_collected);

    // What every cancellation left behind, netted: fees kept less fares the
    // airline didn't return. This is the same arithmetic the revenue column
    // on each cancelled ticket performs, so the figure below equals the sum
    // of those tickets — the Tickets page and the income statement cannot
    // drift apart. The written-off balances are shown beside it but not
    // subtracted; see the query above.
    const taxShortfall = round2(t.tax_shortfall);
    const serviceCancellations = round2(serviceCancelRes.rows[0].net);
    const cancellationNet = round2(
      cancellationFees - unrecoveredCost - taxShortfall + serviceCancellations,
    );

    const netProfit = round2(grossProfit + cancellationNet - operatingCosts);

    return response.success(res, {
      period: { from: from_date || null, to: to_date || null },
      revenue: {
        ticket_sales: round2(t.gross_sales),
        cargo_sales: round2(c.gross_sales),
        visa_sales: round2(v.gross_sales),
        package_sales: round2(pk.gross_sales),
        gross_sales: grossSales,
        ticket_count: parseInt(t.ticket_count),
        shipment_count: parseInt(c.shipment_count),
        visa_count: parseInt(v.visa_count),
        package_count: parseInt(pk.package_count),
      },
      cost_of_sales: {
        airline_tickets: round2(t.cost_of_sales),
        visa_fees: round2(v.cost_of_sales),
        package_suppliers: round2(pk.cost_of_sales),
        cargo_carriers: round2(c.carrier_cost),
        total: costOfSales,
      },
      gross_profit: grossProfit,
      gross_margin_pct:
        grossSales > 0 ? round2((grossProfit / grossSales) * 100) : 0,
      cancellations: {
        cancelled_count: parseInt(t.cancelled_count),
        fees_kept: cancellationFees,
        unrecovered_cost: unrecoveredCost,
        tax_shortfall: taxShortfall,
        other_services: serviceCancellations,
        other_services_count: parseInt(serviceCancelRes.rows[0].count),
        written_off: writtenOff,
        net: cancellationNet,
      },
      // Shown so it is obvious this money is being held, not earned.
      tax: { collected: taxCollected },
      operating_costs: {
        agent_commission: commission,
        recorded_expenses: recordedExpenses,
        bank_fees: bankFees,
        by_category: categoryRes.rows.map((r) => ({
          category: r.category,
          amount: round2(r.amount),
          entries: parseInt(r.entries),
        })),
        total: operatingCosts,
      },
      net_profit: netProfit,
      net_margin_pct:
        grossSales > 0 ? round2((netProfit / grossSales) * 100) : 0,
      cash: {
        collected: round2(
          n(t.collected) + n(c.collected) + n(v.collected) + n(pk.collected),
        ),
        outstanding: round2(
          grossSales -
            (n(t.collected) +
              n(c.collected) +
              n(v.collected) +
              n(pk.collected)),
        ),
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
//
// Built so that it balances by construction, on any date.
//
// Every figure is read from the same events the Accounts page reads — the
// payment rows, not the running totals on the booking — and every one is cut
// off at the same moment: the end of `as_of` on the agency's own calendar.
// Cash is therefore what the accounts held THAT night, receivables are what
// was owed THAT night, and the profit behind retained earnings is the
// profit earned up to that night. If one of them were taken "as of today"
// while the others were historical (as cash used to be), the sheet could not
// balance and would not mean anything.
//
// For each kind of booking:
//   live       → sale - cost is profit; unpaid sale is a receivable, overpaid
//                is money owed back to the customer; unpaid cost is owed to
//                the airline / supplier, overpaid cost is a credit with them
//   cancelled  → what the customer's payments net to, less what the
//                supplier kept (and, for tickets, less tax still owed) is the
//                result of the cancellation; nothing is owed either way
// Tax on tickets is owed to the government, not the airline, and is shown as
// its own liability. Transfer fees are an expense.

const getBalanceSheet = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const businessId = req.businessId;
    const asOf = req.query.as_of || null;
    if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(String(asOf)))
      return response.error(res, "as_of must be a date (YYYY-MM-DD)", 400);

    const p = asOf ? [businessId, asOf] : [businessId];
    // A timestamp, seen as a date on the agency's calendar, on or before as_of.
    const upto = (col) =>
      asOf ? ` AND (${col} AT TIME ZONE '${TZ}')::DATE <= $2::DATE` : "";
    // A plain DATE column on or before as_of.
    const uptoDate = (col) => (asOf ? ` AND ${col} <= $2::DATE` : "");
    // Was this record cancelled by the end of as_of?
    const cancelledBy = (statusExpr, col) =>
      asOf
        ? `(${statusExpr} = 'cancelled' AND (COALESCE(${col}, created_at) AT TIME ZONE '${TZ}')::DATE <= $2::DATE)`
        : `(${statusExpr} = 'cancelled')`;

    // Payment rows per record, cut off at as_of. Deposit-funded rows count:
    // they settle the customer's debt even though no cash moved.
    const paidSub = (table, fk) =>
      `(SELECT ${fk} AS id, SUM(amount) AS paid FROM ${table}
         WHERE business_id = $1${upto("created_at")} GROUP BY ${fk})`;

    const [
      bizRes,
      ticketRes,
      unallocatedAirlineRes,
      serviceRes,
      agentPaidRes,
      taxPaidRes,
      depositRes,
      expenseRes,
      feeRes,
      openingItemsRes,
      accountsRes,
      looseRes,
    ] = await Promise.all([
      query(
        `SELECT name, opening_cash, fixed_assets, liabilities, owner_capital, financials_start
           FROM businesses WHERE id = $1`,
        [businessId],
      ),
      query(
        `WITH t AS (
           SELECT t.*,
                  ${cancelledBy("t.status::TEXT", "t.cancelled_at")} AS is_cancelled,
                  COALESCE(pay.paid, 0) AS paid_rows,
                  COALESCE(ap.paid, 0)  AS airline_rows
             FROM tickets t
             LEFT JOIN ${paidSub("ticket_payments", "ticket_id")} pay ON pay.id = t.id
             LEFT JOIN (SELECT ticket_id AS id, SUM(amount) AS paid FROM airline_payments
                         WHERE business_id = $1 AND ticket_id IS NOT NULL${upto("created_at")}
                         GROUP BY ticket_id) ap ON ap.id = t.id
            WHERE t.business_id = $1${upto("t.created_at")}
         )
         SELECT
           COALESCE(SUM(selling_price) FILTER (WHERE NOT is_cancelled), 0) AS sales,
           COALESCE(SUM(cost_price) FILTER (WHERE NOT is_cancelled), 0) AS cost,
           COALESCE(SUM(COALESCE(agent_commission, 0)) FILTER (WHERE NOT is_cancelled), 0) AS commission,
           COALESCE(SUM(GREATEST(selling_price - paid_rows, 0)) FILTER (WHERE NOT is_cancelled), 0) AS receivable,
           COALESCE(SUM(GREATEST(paid_rows - selling_price, 0)) FILTER (WHERE NOT is_cancelled), 0) AS customer_credit,
           COALESCE(SUM(GREATEST(cost_price - COALESCE(tax, 0), 0)) FILTER (WHERE NOT is_cancelled), 0) AS airline_cost,
           COALESCE(SUM(airline_rows) FILTER (WHERE NOT is_cancelled), 0) AS airline_paid,
           COALESCE(SUM(COALESCE(tax, 0)) FILTER (WHERE NOT is_cancelled), 0) AS tax_live,
           COALESCE(SUM(paid_rows) FILTER (WHERE is_cancelled), 0) AS cancelled_kept,
           COALESCE(SUM(GREATEST(COALESCE(tax, 0) - COALESCE(tax_refunded, 0), 0))
                    FILTER (WHERE is_cancelled), 0) AS cancelled_tax,
           COALESCE(SUM(airline_rows) FILTER (WHERE is_cancelled), 0) AS cancelled_airline
         FROM t`,
        p,
      ),
      query(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM airline_payments
          WHERE business_id = $1 AND ticket_id IS NULL AND opening_item_id IS NULL${upto("created_at")}`,
        p,
      ),
      // Visas, packages and cargo share one shape: a sale, a supplier cost,
      // customer payments and supplier payments.
      query(
        `WITH s AS (
           SELECT 'visa' AS kind, v.selling_price AS sales, COALESCE(v.cost_price, 0) AS cost,
                  ${cancelledBy("v.status::TEXT", "v.cancelled_at")} AS is_cancelled,
                  COALESCE(pay.paid, 0) AS paid_rows, COALESCE(sp.paid, 0) AS supplier_rows
             FROM visa_applications v
             LEFT JOIN ${paidSub("visa_payments", "visa_id")} pay ON pay.id = v.id
             LEFT JOIN ${paidSub("supplier_payments", "visa_id")} sp ON sp.id = v.id
            WHERE v.business_id = $1${upto("v.created_at")}
           UNION ALL
           SELECT 'package', pk.selling_price, COALESCE(pk.total_cost, 0),
                  ${cancelledBy("pk.status::TEXT", "pk.cancelled_at")},
                  COALESCE(pay.paid, 0), COALESCE(sp.paid, 0)
             FROM packages pk
             LEFT JOIN ${paidSub("package_payments", "package_id")} pay ON pay.id = pk.id
             LEFT JOIN ${paidSub("supplier_payments", "package_id")} sp ON sp.id = pk.id
            WHERE pk.business_id = $1${upto("pk.created_at")}
           UNION ALL
           SELECT 'cargo', cs.total_price,
                  CASE WHEN cs.profit_total IS NULL THEN 0
                       ELSE GREATEST(cs.total_price - cs.profit_total, 0) END,
                  ${cancelledBy("cs.cargo_status::TEXT", "cs.cancelled_at")},
                  COALESCE(pay.paid, 0), COALESCE(sp.paid, 0)
             FROM cargo_shipments cs
             LEFT JOIN ${paidSub("cargo_payments", "cargo_id")} pay ON pay.id = cs.id
             LEFT JOIN ${paidSub("supplier_payments", "cargo_id")} sp ON sp.id = cs.id
            WHERE cs.business_id = $1${upto("cs.created_at")}
         )
         SELECT kind,
           COALESCE(SUM(sales) FILTER (WHERE NOT is_cancelled), 0) AS sales,
           COALESCE(SUM(cost) FILTER (WHERE NOT is_cancelled), 0) AS cost,
           COALESCE(SUM(GREATEST(sales - paid_rows, 0)) FILTER (WHERE NOT is_cancelled), 0) AS receivable,
           COALESCE(SUM(GREATEST(paid_rows - sales, 0)) FILTER (WHERE NOT is_cancelled), 0) AS customer_credit,
           COALESCE(SUM(GREATEST(cost - supplier_rows, 0)) FILTER (WHERE NOT is_cancelled), 0) AS supplier_payable,
           COALESCE(SUM(GREATEST(supplier_rows - cost, 0)) FILTER (WHERE NOT is_cancelled), 0) AS supplier_credit,
           COALESCE(SUM(paid_rows - supplier_rows) FILTER (WHERE is_cancelled), 0) AS cancelled_net
         FROM s GROUP BY kind`,
        p,
      ),
      query(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM agent_payments WHERE business_id = $1${upto("created_at")}`,
        p,
      ),
      query(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM tax_payments WHERE business_id = $1${upto("paid_at")}`,
        p,
      ),
      query(
        `SELECT
           COALESCE((SELECT SUM(amount) FROM customer_deposits
                      WHERE business_id = $1${upto("created_at")}), 0)
         - COALESCE((SELECT SUM(amount) FROM deposit_applications
                      WHERE business_id = $1${upto("created_at")}), 0) AS held`,
        p,
      ),
      query(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM expenses WHERE business_id = $1${uptoDate("expense_date")}`,
        p,
      ),
      query(
        `SELECT COALESCE(SUM(COALESCE(fee, 0)), 0) AS total
           FROM account_transfers WHERE business_id = $1${upto("transferred_at")}`,
        p,
      ),
      query(
        `SELECT
           COALESCE(SUM(amount - COALESCE(paid, 0)) FILTER (WHERE balance_type = 'receivable'), 0) AS receivables,
           COALESCE(SUM(amount) FILTER (WHERE balance_type = 'receivable'), 0) AS receivables_gross,
           COALESCE(SUM(amount - COALESCE(paid, 0)) FILTER (WHERE balance_type = 'payable'), 0) AS payables,
           COALESCE(SUM(amount) FILTER (WHERE balance_type = 'payable'), 0) AS payables_gross
         FROM (
           SELECT o.*, COALESCE(SUM(p.amount), 0) AS paid
             FROM opening_balance_items o
             LEFT JOIN (
               SELECT opening_item_id, amount, created_at FROM opening_balance_payments
               UNION ALL
               SELECT opening_item_id, amount, created_at FROM airline_payments
                WHERE opening_item_id IS NOT NULL
             ) p ON p.opening_item_id = o.id${upto("p.created_at")}
            WHERE o.business_id = $1${uptoDate("o.entry_date")}
            GROUP BY o.id
         ) opening`,
        p,
      ),
      // Each account as it stood at the end of as_of: its opening balance (if
      // it had opened by then) plus every movement up to that night.
      query(
        `SELECT a.id AS account_id, a.name, a.kind, a.sort_order,
                COALESCE(a.is_cash_in_hand, FALSE) AS is_cash_in_hand,
                CASE WHEN ${asOf ? "a.opening_date IS NULL OR a.opening_date <= $2::DATE" : "TRUE"}
                     THEN a.opening_balance ELSE 0 END AS opening_balance,
                COALESCE(l.net, 0) AS movements
           FROM payment_accounts a
           LEFT JOIN (
             SELECT account_id,
                    SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END) AS net
               FROM v_cash_ledger
              WHERE business_id = $1 AND account_id IS NOT NULL${upto("occurred_at")}
              GROUP BY account_id
           ) l ON l.account_id = a.id
          WHERE a.business_id = $1
          ORDER BY COALESCE(a.is_cash_in_hand, FALSE) DESC, a.sort_order, a.name`,
        p,
      ),
      // Money received but not yet filed against an account is still money
      // the agency holds. Shown on its own line rather than hidden.
      query(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) AS net
           FROM v_cash_ledger
          WHERE business_id = $1 AND account_id IS NULL${upto("occurred_at")}`,
        p,
      ),
    ]);

    // Owners, and what each has put in and taken out by the end of as_of.
    const hasOwners = await hasTable("business_owners");
    const ownersRes = hasOwners
      ? await query(
          `SELECT ow.id, ow.name, ow.opening_capital, ow.ownership_pct,
                  ow.profit_share_pct, ow.is_active,
                  COALESCE(SUM(tx.amount) FILTER (WHERE tx.amount > 0), 0)  AS contributed,
                  COALESCE(-SUM(tx.amount) FILTER (WHERE tx.amount < 0), 0) AS withdrawn
             FROM business_owners ow
             LEFT JOIN owner_transactions tx
               ON tx.owner_id = ow.id${upto("tx.occurred_at")}
            WHERE ow.business_id = $1
            GROUP BY ow.id
            ORDER BY ow.opening_capital DESC, ow.name`,
          p,
        )
      : { rows: [] };

    const biz = bizRes.rows[0] || {};
    const t = ticketRes.rows[0];
    const svc = Object.fromEntries(serviceRes.rows.map((r) => [r.kind, r]));
    const sumSvc = (field) =>
      round2(
        ["visa", "package", "cargo"].reduce(
          (a, k) => a + n(svc[k]?.[field]),
          0,
        ),
      );

    // ── Assets ──────────────────────────────────────────────
    const accounts = accountsRes.rows.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      kind: a.kind,
      is_cash_in_hand: a.is_cash_in_hand,
      opening_balance: round2(a.opening_balance),
      balance: round2(n(a.opening_balance) + n(a.movements)),
    }));
    // Opening cash used to be typed on the business record and added on top
    // of the accounts. migration_v28 moves it into the Cash in Hand account;
    // anything still sitting here (an unmigrated database) is folded into
    // the same Cash in Hand line so it is never shown twice.
    const legacyOpeningCash = round2(biz.opening_cash);
    const unassignedCash = round2(looseRes.rows[0].net);
    const cashInHandAccount = accounts.find((a) => a.is_cash_in_hand);
    const cashInHand = round2(
      (cashInHandAccount ? cashInHandAccount.balance : 0) + legacyOpeningCash,
    );
    const otherAccounts = accounts.filter((a) => !a.is_cash_in_hand);
    const cash = round2(
      cashInHand +
        otherAccounts.reduce((s, a) => s + a.balance, 0) +
        unassignedCash,
    );
    const accountOpeningCash = round2(
      accounts.reduce((s, a) => s + a.opening_balance, 0),
    );

    const openingReceivables = round2(openingItemsRes.rows[0].receivables);
    const openingPayables = round2(openingItemsRes.rows[0].payables);
    const openingReceivablesGross = round2(
      openingItemsRes.rows[0].receivables_gross,
    );
    const openingPayablesGross = round2(openingItemsRes.rows[0].payables_gross);

    const tradeReceivables = round2(n(t.receivable) + sumSvc("receivable"));
    const receivables = round2(tradeReceivables + openingReceivables);

    const airlineNet = round2(
      n(t.airline_cost) -
        n(t.airline_paid) -
        n(unallocatedAirlineRes.rows[0].total),
    );
    const airlinePayable = round2(Math.max(airlineNet, 0));
    const airlineReceivable = round2(Math.max(-airlineNet, 0));
    const supplierPayable = sumSvc("supplier_payable");
    const supplierCredit = sumSvc("supplier_credit");

    const taxAccrued = round2(n(t.tax_live) + n(t.cancelled_tax));
    const taxNet = round2(taxAccrued - n(taxPaidRes.rows[0].total));
    const taxPayable = round2(Math.max(taxNet, 0));
    const taxCredit = round2(Math.max(-taxNet, 0));

    const commissionNet = round2(
      n(t.commission) - n(agentPaidRes.rows[0].total),
    );
    const commissionPayable = round2(Math.max(commissionNet, 0));
    const agentAdvances = round2(Math.max(-commissionNet, 0));

    const fixedAssets = round2(biz.fixed_assets);
    const totalAssets = round2(
      cash +
        receivables +
        airlineReceivable +
        supplierCredit +
        taxCredit +
        agentAdvances +
        fixedAssets,
    );

    // ── Liabilities ─────────────────────────────────────────
    const customerDeposits = round2(depositRes.rows[0].held);
    const customerCredits = round2(
      n(t.customer_credit) + sumSvc("customer_credit"),
    );
    const manualLiabilities = round2(biz.liabilities);
    const totalLiabilities = round2(
      airlinePayable +
        supplierPayable +
        taxPayable +
        commissionPayable +
        customerDeposits +
        customerCredits +
        openingPayables +
        manualLiabilities,
    );

    // ── Equity ──────────────────────────────────────────────
    const openingPosition = round2(
      legacyOpeningCash +
        accountOpeningCash +
        fixedAssets +
        openingReceivablesGross -
        manualLiabilities -
        openingPayablesGross,
    );
    // If the owner never entered a capital figure, the opening position is
    // the capital, so the sheet balances (Assets = Liabilities + Equity).
    const ownerCapital = n(biz.owner_capital)
      ? round2(biz.owner_capital)
      : openingPosition;
    const openingRetainedEarnings = round2(openingPosition - ownerCapital);

    const ticketProfit = round2(n(t.sales) - n(t.cost) - n(t.commission));
    const ticketCancellations = round2(
      n(t.cancelled_kept) - n(t.cancelled_tax) - n(t.cancelled_airline),
    );
    const serviceProfit = round2(sumSvc("sales") - sumSvc("cost"));
    const serviceCancellations = sumSvc("cancelled_net");
    const expenses = round2(expenseRes.rows[0].total);
    const bankFees = round2(feeRes.rows[0].total);
    const profitToDate = round2(
      ticketProfit +
        ticketCancellations +
        serviceProfit +
        serviceCancellations -
        expenses -
        bankFees,
    );
    // ── Owners ──────────────────────────────────────────────
    //
    // With owners registered, equity is shown owner by owner:
    //   opening capital + capital put in − drawings + profit-share % of profit
    // Anything the opening position holds beyond the owners' opening capital
    // is "retained earnings brought forward", and profit not covered by the
    // profit-share percentages stays unallocated. Every cent is accounted
    // for: the lines add up to exactly the same total equity as before.
    const owners = ownersRes.rows.map((o) => ({
      owner_id: o.id,
      name: o.name,
      is_active: o.is_active,
      ownership_pct: n(o.ownership_pct),
      profit_share_pct: n(o.profit_share_pct),
      opening_capital: round2(o.opening_capital),
      contributed: round2(o.contributed),
      withdrawn: round2(o.withdrawn),
      profit_share: round2((profitToDate * n(o.profit_share_pct)) / 100),
    }));
    owners.forEach((o) => {
      o.capital = round2(o.opening_capital + o.contributed);
      o.total = round2(o.capital - o.withdrawn + o.profit_share);
    });
    const ownersContributed = round2(
      owners.reduce((s, o) => s + o.contributed, 0),
    );
    const ownersWithdrawn = round2(owners.reduce((s, o) => s + o.withdrawn, 0));
    const hasOwnerRecords = owners.length > 0;

    let retainedEarnings;
    let totalEquity;
    let equityOwners = null;
    if (hasOwnerRecords) {
      const openingCapital = round2(
        owners.reduce((s, o) => s + o.opening_capital, 0),
      );
      const allocated = round2(owners.reduce((s, o) => s + o.profit_share, 0));
      const broughtForward = round2(openingPosition - openingCapital);
      const unallocated = round2(profitToDate - allocated);
      retainedEarnings = round2(broughtForward + unallocated);
      totalEquity = round2(
        owners.reduce((s, o) => s + o.total, 0) + broughtForward + unallocated,
      );
      equityOwners = {
        owners,
        opening_capital: openingCapital,
        contributed: ownersContributed,
        withdrawn: ownersWithdrawn,
        profit_allocated: allocated,
        retained_brought_forward: broughtForward,
        unallocated_profit: unallocated,
      };
    } else {
      retainedEarnings = round2(openingRetainedEarnings + profitToDate);
      totalEquity = round2(
        ownerCapital + retainedEarnings + ownersContributed - ownersWithdrawn,
      );
    }

    const difference = round2(totalAssets - (totalLiabilities + totalEquity));

    return response.success(res, {
      business_name: biz.name,
      as_of: asOf || new Date().toISOString().slice(0, 10),
      assets: {
        cash_and_bank: cash,
        // One Cash in Hand line: the business's Cash in Hand account.
        cash_in_hand: cashInHand,
        cash_in_hand_account_id: cashInHandAccount?.account_id || null,
        // The other accounts (banks, mobile money, merchant).
        accounts: otherAccounts,
        unassigned_cash: unassignedCash,
        accounts_receivable: receivables,
        trade_receivables: tradeReceivables,
        opening_receivables: openingReceivables,
        airline_receivable: airlineReceivable,
        supplier_credit: supplierCredit,
        tax_credit: taxCredit,
        agent_advances: agentAdvances,
        fixed_assets: fixedAssets,
        total: totalAssets,
      },
      liabilities: {
        payable_to_airlines: airlinePayable,
        payable_to_suppliers: supplierPayable,
        tax_payable: taxPayable,
        customer_deposits: customerDeposits,
        customer_credits: customerCredits,
        agent_commission_payable: commissionPayable,
        other_liabilities: manualLiabilities,
        opening_payables: openingPayables,
        total: totalLiabilities,
      },
      equity: {
        owner_capital: hasOwnerRecords
          ? round2(equityOwners.opening_capital + ownersContributed)
          : ownerCapital,
        retained_earnings: retainedEarnings,
        profit_to_date: profitToDate,
        // Present when owners are registered: one line per owner.
        by_owner: equityOwners,
        total: totalEquity,
      },
      total_liabilities_and_equity: round2(totalLiabilities + totalEquity),
      balanced: Math.abs(difference) < 0.01,
      difference,
      notes: [
        "Cash in hand is the business's Cash in Hand account, including the opening cash entered for it. Bank and mobile-money accounts are listed separately.",
        "Every figure is as at the end of the selected date on the agency's calendar, including cash.",
        "Tax collected on tickets is owed to the government and shown as Tax payable, not as money owed to airlines.",
        "Visa, package and cargo supplier costs stay payable until they are paid from the Suppliers page.",
        "Money a customer paid beyond the price is shown as a customer credit — it is owed back or can be applied later.",
        "Agent commission payable is what agents have earned but not been paid. Pay it from the Agents page.",
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

    // "Collected by method" reads the same ledger as the totals, so it covers
    // every kind of money in (tickets, visas, packages, cargo, deposits), not
    // ticket payments alone. The eight side queries that used to run here
    // were computed and never used, and have been removed.
    const mRange = dateRange(
      `(l.occurred_at AT TIME ZONE '${TZ}')::DATE`,
      from_date,
      to_date,
      2,
    );
    const methodRes = await query(
      `SELECT COALESCE(a.name, NULLIF(l.legacy_method, ''), 'Unassigned') AS method,
              COALESCE(SUM(l.amount), 0) AS total
         FROM v_cash_ledger l
         LEFT JOIN payment_accounts a ON a.id = l.account_id
        WHERE l.business_id = $1 AND l.direction = 'in'
          AND l.source NOT LIKE 'transfer%'${mRange.clause}
        GROUP BY 1 ORDER BY total DESC`,
      [businessId, ...mRange.params],
    );

    // ── One source of truth ──────────────────────────────────
    //
    // These figures used to be assembled by hand: ticket payments from the
    // payments table, cargo from the shipment's amount_paid column, and tax
    // payments not at all. That is why Cash Flow said 2,560 while the
    // Accounts page said 2,960 for the same trading — the Accounts page read
    // the ledger and this one didn't.
    //
    // The ledger holds every movement with the account it touched and the
    // moment it happened, and its total is what makes the account balances
    // reconcile. Everything below is that same ledger, grouped for display.
    const [money, bySource, daily] = await Promise.all([
      cashMovement(businessId, { from: from_date, to: to_date }),
      cashBySource(businessId, { from: from_date, to: to_date }),
      cashDaily(businessId, { from: from_date, to: to_date }),
    ]);

    const inOf = (src) =>
      round2(bySource.find((r) => r.source === src)?.collected || 0);
    const outOf = (src) =>
      round2(bySource.find((r) => r.source === src)?.paid_out || 0);

    return response.success(res, {
      period: { from: from_date || null, to: to_date || null },
      inflow: {
        ticket_payments: inOf("ticket"),
        cargo_payments: inOf("cargo"),
        visa_payments: inOf("visa"),
        package_payments: inOf("package"),
        deposits: inOf("deposit"),
        opening_receivables: inOf("opening_receivable"),
        owner_capital: inOf("owner_contribution"),
        // Money coming back from the other side of a payment.
        airline_refunds: inOf("airline"),
        supplier_refunds: inOf("supplier"),
        agent_refunds: inOf("agent"),
        total: money.collected,
        entries: money.entries,
        by_method: methodRes.rows.map((r) => ({
          method: r.method || "cash",
          total: round2(r.total),
        })),
      },
      outflow: {
        expenses: outOf("expense"),
        airline_settlements: outOf("airline"),
        agent_commission: outOf("agent"),
        tax: outOf("tax"),
        supplier_payments: outOf("supplier"),
        bank_fees: outOf("bank_fee"),
        owner_drawings: outOf("owner_withdrawal"),
        deposit_refunds: outOf("deposit"),
        // Money handed back to customers is an outflow like any other. It was
        // previously netted invisibly against the day's takings, so a day
        // with a large refund looked like a quiet day rather than a costly
        // one.
        refunds: round2(
          outOf("ticket") + outOf("cargo") + outOf("visa") + outOf("package"),
        ),
        total: money.paid_out,
      },
      net_cash_flow: money.net,
      daily: daily.map((r) => ({
        day: r.day,
        inflow: r.inflow,
        outflow: r.outflow,
        net: round2(r.inflow - r.outflow),
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/financials/receivables ──────────────────────────────────────────

const receivableRowsSql = `(
        SELECT r.business_id, r.source, r.source_id, r.party_name,
          r.party_contact, r.issued_at, r.total_amount, r.paid_amount,
          r.balance, r.payment_status::TEXT AS payment_status,
          NULL::TEXT AS reason, NULL::UUID AS customer_id
    FROM v_receivables r
  UNION ALL
  SELECT o.business_id,
         ('opening_' || o.service_type)::TEXT AS source,
         o.id AS source_id,
         c.name AS party_name,
         c.phone AS party_contact,
         o.entry_date::TIMESTAMPTZ AS issued_at,
         o.amount AS total_amount,
         COALESCE(p.paid, 0) AS paid_amount,
         o.amount - COALESCE(p.paid, 0) AS balance,
         'unpaid'::TEXT AS payment_status,
         o.reason,
         o.customer_id
    FROM opening_balance_items o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN (
      SELECT opening_item_id, SUM(amount) AS paid
        FROM opening_balance_payments GROUP BY opening_item_id
    ) p ON p.opening_item_id = o.id
   WHERE o.balance_type = 'receivable'
     AND o.amount > COALESCE(p.paid, 0)
)`;

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
           SELECT source_rows.*,
                  (CURRENT_DATE - source_rows.issued_at::DATE) AS age
             FROM ${receivableRowsSql} source_rows
            WHERE source_rows.business_id = $1
         ) r`,
        [businessId],
      ),
      query(
        `SELECT COUNT(*) FROM ${receivableRowsSql} r WHERE ${where}`,
        params,
      ),
      query(
        `SELECT r.*, (CURRENT_DATE - r.issued_at::DATE) AS age_days
        FROM ${receivableRowsSql} r
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
        totalPages: Math.ceil(
          parseInt(countRes.rows[0].count) / parseInt(limit),
        ),
      },
    });
  } catch (err) {
    next(err);
  }
};

const getOpeningItems = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const result = await query(
      `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
              a.name AS airline_name,
              COALESCE(p.paid, 0) AS paid_amount,
              o.amount - COALESCE(p.paid, 0) AS balance,
              u.name AS created_by_name
         FROM opening_balance_items o
         LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN airlines a ON a.id = o.airline_id
         LEFT JOIN users u ON u.id = o.created_by
         LEFT JOIN (
           SELECT opening_item_id, SUM(amount) AS paid
             FROM (
               SELECT opening_item_id, amount FROM opening_balance_payments
               UNION ALL
               SELECT opening_item_id, amount FROM airline_payments
                WHERE opening_item_id IS NOT NULL
             ) payments GROUP BY opening_item_id
         ) p ON p.opening_item_id = o.id
        WHERE o.business_id = $1
        ORDER BY o.entry_date DESC, o.created_at DESC`,
      [req.businessId],
    );
    return response.success(res, result.rows);
  } catch (err) {
    next(err);
  }
};

const collectOpeningReceivable = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const amount = round2(req.body.amount);
    const accountId = req.body.account_id;
    if (!Number.isFinite(amount) || amount <= 0)
      return response.error(res, "Amount must be greater than zero", 400);
    if (!accountId)
      return response.error(
        res,
        "Choose the account receiving this payment",
        400,
      );

    const payment = await withTransaction(async (client) => {
      const item = await client.query(
        `SELECT id, amount FROM opening_balance_items
          WHERE id = $1 AND business_id = $2 AND balance_type = 'receivable'
          FOR UPDATE`,
        [req.params.id, req.businessId],
      );
      if (!item.rows.length) {
        const err = new Error("Opening receivable not found");
        err.statusCode = 404;
        throw err;
      }
      const account = await client.query(
        `SELECT id FROM payment_accounts
          WHERE id = $1 AND business_id = $2 AND is_active = TRUE`,
        [accountId, req.businessId],
      );
      if (!account.rows.length) {
        const err = new Error(
          "Choose an active account belonging to this business",
        );
        err.statusCode = 400;
        throw err;
      }
      const paid = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM opening_balance_payments WHERE opening_item_id = $1`,
        [req.params.id],
      );
      const remaining = round2(
        Number(item.rows[0].amount) - Number(paid.rows[0].total),
      );
      if (amount > remaining + 0.001) {
        const err = new Error(
          `Amount exceeds the remaining balance ($${remaining.toFixed(2)})`,
        );
        err.statusCode = 400;
        throw err;
      }
      const result = await client.query(
        `INSERT INTO opening_balance_payments
           (business_id, opening_item_id, account_id, collected_by, amount, method, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          req.businessId,
          req.params.id,
          accountId,
          req.user.id,
          amount,
          req.body.method || "cash",
          req.body.note || null,
        ],
      );
      return result.rows[0];
    });
    return response.created(
      res,
      payment,
      "Opening receivable payment recorded",
    );
  } catch (err) {
    next(err);
  }
};

const createOpeningItem = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const {
      balance_type,
      customer_id,
      airline_id,
      service_type,
      reason,
      amount,
      entry_date,
    } = req.body;
    const value = Number(amount);
    const description = String(reason || "").trim();

    if (!["receivable", "payable"].includes(balance_type))
      return response.error(res, "Choose receivable or payable", 400);
    if (!Number.isFinite(value) || value <= 0)
      return response.error(res, "Amount must be greater than zero", 400);
    if (!description) return response.error(res, "A reason is required", 400);
    if (balance_type === "receivable") {
      if (!customer_id)
        return response.error(
          res,
          "Choose the customer who owes this balance",
          400,
        );
      if (
        !["ticket", "visa", "cargo", "package", "other"].includes(service_type)
      )
        return response.error(
          res,
          "Choose the service type for this receivable",
          400,
        );
      const customer = await query(
        `SELECT id FROM customers WHERE id = $1 AND business_id = $2`,
        [customer_id, req.businessId],
      );
      if (customer.rows.length === 0)
        return response.error(res, "Customer not found in this business", 404);
    } else if (airline_id) {
      const airline = await query(
        `SELECT id FROM airlines WHERE id = $1 AND business_id = $2`,
        [airline_id, req.businessId],
      );
      if (!airline.rows.length)
        return response.error(res, "Airline not found in this business", 404);
    }

    const result = await query(
      `INSERT INTO opening_balance_items
         (business_id, balance_type, customer_id, airline_id, service_type,
          reason, amount, entry_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::DATE, CURRENT_DATE), $9)
       RETURNING *`,
      [
        req.businessId,
        balance_type,
        balance_type === "receivable" ? customer_id : null,
        balance_type === "payable" ? airline_id || null : null,
        balance_type === "receivable" ? service_type : null,
        description,
        round2(value),
        entry_date || null,
        req.user.id,
      ],
    );
    return response.created(res, result.rows[0], "Opening balance recorded");
  } catch (err) {
    next(err);
  }
};

const updateOpeningItem = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const {
      customer_id,
      airline_id,
      service_type,
      reason,
      amount,
      entry_date,
    } = req.body;
    const value = Number(amount);
    const description = String(reason || "").trim();

    if (!Number.isFinite(value) || value <= 0)
      return response.error(res, "Amount must be greater than zero", 400);
    if (!description) return response.error(res, "A reason is required", 400);

    const result = await withTransaction(async (client) => {
      const itemResult = await client.query(
        `SELECT * FROM opening_balance_items
          WHERE id = $1 AND business_id = $2 FOR UPDATE`,
        [req.params.id, req.businessId],
      );
      const item = itemResult.rows[0];
      if (!item) return null;

      let paid = 0;
      if (item.balance_type === "receivable") {
        const payments = await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS paid
             FROM opening_balance_payments WHERE opening_item_id = $1`,
          [item.id],
        );
        paid = round2(payments.rows[0].paid);

        if (!customer_id)
          return {
            error: "Choose the customer who owes this balance",
            status: 400,
          };
        if (
          !["ticket", "visa", "cargo", "package", "other"].includes(
            service_type,
          )
        )
          return { error: "Choose a valid service type", status: 400 };
        if (value + 0.001 < paid)
          return {
            error: `Amount cannot be less than the $${paid.toFixed(2)} already collected`,
            status: 400,
          };
        if (paid > 0.001 && customer_id !== item.customer_id)
          return {
            error:
              "The customer cannot be changed after a payment has been collected",
            status: 409,
          };
        const customer = await client.query(
          `SELECT id FROM customers WHERE id = $1 AND business_id = $2`,
          [customer_id, req.businessId],
        );
        if (!customer.rows.length)
          return { error: "Customer not found in this business", status: 404 };
      } else if (airline_id) {
        const airline = await client.query(
          `SELECT id FROM airlines WHERE id = $1 AND business_id = $2`,
          [airline_id, req.businessId],
        );
        if (!airline.rows.length)
          return { error: "Airline not found in this business", status: 404 };
      }

      if (item.balance_type === "payable") {
        const payments = await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS paid
             FROM airline_payments WHERE opening_item_id = $1`,
          [item.id],
        );
        paid = round2(payments.rows[0].paid);
        if (value + 0.001 < paid)
          return {
            error: `Amount cannot be less than the $${paid.toFixed(2)} already paid`,
            status: 400,
          };
        if (paid > 0.001 && airline_id !== item.airline_id)
          return {
            error:
              "The airline cannot be changed after a payment has been made",
            status: 409,
          };
      }

      const updated = await client.query(
        `UPDATE opening_balance_items
            SET customer_id = $1,
                airline_id = $2,
                service_type = $3,
                reason = $4,
                amount = $5,
                entry_date = COALESCE($6::DATE, entry_date)
          WHERE id = $7 AND business_id = $8
          RETURNING *`,
        [
          item.balance_type === "receivable" ? customer_id : null,
          item.balance_type === "payable" ? airline_id || null : null,
          item.balance_type === "receivable" ? service_type : null,
          description,
          round2(value),
          entry_date || null,
          item.id,
          req.businessId,
        ],
      );
      return updated.rows[0];
    });

    if (!result) return response.notFound(res, "Opening balance not found");
    if (result.error) return response.error(res, result.error, result.status);
    return response.success(res, result, "Opening balance updated");
  } catch (err) {
    next(err);
  }
};

const deleteOpeningItem = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const reason = String(req.body?.reason || "").trim();
    if (!reason)
      return response.error(res, "A deletion reason is required", 400);

    const result = await withTransaction(async (client) => {
      const itemResult = await client.query(
        `SELECT * FROM opening_balance_items
          WHERE id = $1 AND business_id = $2 FOR UPDATE`,
        [req.params.id, req.businessId],
      );
      const item = itemResult.rows[0];
      if (!item) return null;

      let paid = 0;
      if (item.balance_type === "receivable") {
        const payments = await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS paid
             FROM opening_balance_payments WHERE opening_item_id = $1`,
          [item.id],
        );
        paid = round2(payments.rows[0].paid);
        if (paid > 0.001)
          return {
            error: `This receivable has $${paid.toFixed(2)} in collected payments and cannot be deleted`,
            status: 409,
          };
      } else if (item.balance_type === "payable") {
        const payments = await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS paid
             FROM airline_payments WHERE opening_item_id = $1`,
          [item.id],
        );
        paid = round2(payments.rows[0].paid);
        if (paid > 0.001)
          return {
            error: `This payable has $${paid.toFixed(2)} in settled payments and cannot be deleted`,
            status: 409,
          };
      }

      await client.query(
        `INSERT INTO opening_balance_deletion_audit
            (business_id, opening_item_id, balance_type, customer_id, airline_id,
            reason, amount, entry_date, deletion_reason, deleted_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          req.businessId,
          item.id,
          item.balance_type,
          item.customer_id,
          item.airline_id,
          item.reason,
          item.amount,
          item.entry_date,
          reason,
          req.user.id,
        ],
      );
      await client.query(
        `DELETE FROM opening_balance_items WHERE id = $1 AND business_id = $2`,
        [item.id, req.businessId],
      );
      return item.id;
    });

    if (!result) return response.notFound(res, "Opening balance not found");
    if (result.error) return response.error(res, result.error, result.status);
    return response.success(res, null, "Opening balance deleted and audited");
  } catch (err) {
    next(err);
  }
};

// ── Opening balances ─────────────────────────────────────────────────────────
//
// Opening cash lives in the business's Cash in Hand account (its opening
// balance), not on the business record. One place, so the balance sheet shows
// one Cash in Hand figure and the Accounts page agrees with it.

/** Find or create the business's one Cash in Hand account. */
const cashInHandAccount = async (client, businessId) => {
  await client.query(`SELECT id FROM businesses WHERE id = $1 FOR UPDATE`, [
    businessId,
  ]);

  const found = await client.query(
    `SELECT id
       FROM payment_accounts
      WHERE business_id = $1
        AND (is_cash_in_hand OR LOWER(name) = 'cash in hand' OR kind = 'cash')
      ORDER BY (LOWER(name) = 'cash in hand') DESC,
               is_cash_in_hand DESC,
               (kind = 'cash') DESC,
               is_active DESC, sort_order, created_at
      LIMIT 1
      FOR UPDATE`,
    [businessId],
  );

  if (found.rows.length) {
    const id = found.rows[0].id;
    await client.query(
      `UPDATE payment_accounts
          SET is_cash_in_hand = FALSE
        WHERE business_id = $1 AND is_cash_in_hand AND id <> $2`,
      [businessId, id],
    );
    const normalized = await client.query(
      `UPDATE payment_accounts
          SET name = 'Cash in Hand', kind = 'cash', is_cash_in_hand = TRUE,
              is_active = TRUE, updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, opening_balance`,
      [id],
    );
    if (normalized.rows[0]) return normalized.rows[0];
  }

  const created = await client.query(
    `INSERT INTO payment_accounts
       (business_id, name, kind, sort_order, is_cash_in_hand, notes)
     VALUES (
       $1, 'Cash in Hand', 'cash',
       COALESCE((SELECT MIN(sort_order) - 10 FROM payment_accounts WHERE business_id = $1), 0),
       TRUE, 'Created automatically for opening cash.'
     )
     RETURNING id, name, opening_balance`,
    [businessId],
  );
  if (!created.rows[0])
    throw new Error("Could not create the business Cash in Hand account");
  return created.rows[0];
};

const readOpeningBalances = async (run, businessId) => {
  const r = await run(
    `SELECT b.id, b.name, b.fixed_assets, b.liabilities, b.owner_capital,
            b.financials_start,
            COALESCE(a.opening_balance, 0) + COALESCE(b.opening_cash, 0) AS opening_cash,
            a.id AS cash_in_hand_account_id, a.name AS cash_in_hand_account
       FROM businesses b
       LEFT JOIN payment_accounts a
         ON a.business_id = b.id AND a.is_cash_in_hand
      WHERE b.id = $1`,
    [businessId],
  );
  return r.rows[0] || null;
};

// ── GET /api/financials/opening-balances ─────────────────────────────────────
const getOpeningBalances = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const row = await readOpeningBalances(query, req.businessId);
    if (!row) return response.notFound(res, "Business not found");
    return response.success(res, row);
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

    // Blank means "leave as it is"; anything else must be a number >= 0.
    const amountOrNull = (v, label) => {
      if (v === undefined || v === null || v === "") return null;
      const num = Number(v);
      if (!Number.isFinite(num) || num < 0) {
        const err = new Error(`${label} must be a number of zero or more`);
        err.statusCode = 400;
        err.expose = true;
        throw err;
      }
      return round2(num);
    };
    const cashValue = amountOrNull(opening_cash, "Cash in hand");
    const fixedValue = amountOrNull(fixed_assets, "Fixed assets");
    const liabilitiesValue = amountOrNull(liabilities, "Existing liabilities");
    const capitalValue = amountOrNull(owner_capital, "Owner's capital");

    const row = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE businesses SET
           fixed_assets     = COALESCE($1, fixed_assets),
           liabilities      = COALESCE($2, liabilities),
           owner_capital    = COALESCE($3, owner_capital),
           financials_start = COALESCE($4, financials_start)
         WHERE id = $5
         RETURNING id`,
        [
          fixedValue,
          liabilitiesValue,
          capitalValue,
          financials_start || null,
          req.businessId,
        ],
      );
      if (updated.rows.length === 0) return null;

      if (cashValue !== null) {
        const account = await cashInHandAccount(client, req.businessId);
        // Whatever was left on the old business-level field is replaced by
        // the figure entered now, so the opening cash is counted once.
        await client.query(
          `UPDATE payment_accounts
              SET opening_balance = $1, updated_at = NOW()
            WHERE id = $2`,
          [cashValue, account.id],
        );
        await client.query(
          `UPDATE businesses SET opening_cash = 0 WHERE id = $1`,
          [req.businessId],
        );
      }
      return readOpeningBalances(client.query.bind(client), req.businessId);
    });

    if (!row) return response.notFound(res, "Business not found");
    return response.success(res, row, "Opening balances updated");
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getProfitLoss,
  getBalanceSheet,
  getCashFlow,
  getReceivables,
  getOpeningItems,
  createOpeningItem,
  updateOpeningItem,
  deleteOpeningItem,
  collectOpeningReceivable,
  updateOpeningBalances,
  getOpeningBalances,
};
