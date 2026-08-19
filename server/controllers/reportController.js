const { query } = require("../config/db");
const response = require("../utils/response");
const {
  generatePDFReport,
  generateExcelReport,
} = require("../services/reportService");

/**
 * GET /api/reports/dashboard
 * Works for both super_admin (all businesses) and regular users (scoped)
 */
const getDashboard = async (req, res, next) => {
  try {
    const isSuperAdmin = req.user.role === "super_admin";
    const businessId = req.businessId;
    const { period = "month" } = req.query;

    let tFilter = "";
    let cFilter = "";
    // Matching window immediately before the selected one, so the KPI cards
    // can show a real period-over-period change instead of a decorative one.
    let tPrevFilter = null;
    let cPrevFilter = null;

    if (period === "today") {
      tFilter = "AND DATE(t.created_at) = CURRENT_DATE";
      cFilter = "AND DATE(cs.created_at) = CURRENT_DATE";
      tPrevFilter = "AND DATE(t.created_at) = CURRENT_DATE - 1";
      cPrevFilter = "AND DATE(cs.created_at) = CURRENT_DATE - 1";
    } else if (period === "week") {
      tFilter = "AND t.created_at >= NOW() - INTERVAL '7 days'";
      cFilter = "AND cs.created_at >= NOW() - INTERVAL '7 days'";
      tPrevFilter =
        "AND t.created_at >= NOW() - INTERVAL '14 days' AND t.created_at < NOW() - INTERVAL '7 days'";
      cPrevFilter =
        "AND cs.created_at >= NOW() - INTERVAL '14 days' AND cs.created_at < NOW() - INTERVAL '7 days'";
    } else if (period === "month") {
      tFilter = "AND t.created_at >= NOW() - INTERVAL '30 days'";
      cFilter = "AND cs.created_at >= NOW() - INTERVAL '30 days'";
      tPrevFilter =
        "AND t.created_at >= NOW() - INTERVAL '60 days' AND t.created_at < NOW() - INTERVAL '30 days'";
      cPrevFilter =
        "AND cs.created_at >= NOW() - INTERVAL '60 days' AND cs.created_at < NOW() - INTERVAL '30 days'";
    }

    // % change vs the previous window. null when there's no basis to compare.
    const pctChange = (now, before) => {
      const a = parseFloat(now) || 0;
      const b = parseFloat(before) || 0;
      if (!tPrevFilter) return null;
      if (b === 0) return a === 0 ? 0 : null;
      return Math.round(((a - b) / b) * 1000) / 10;
    };

    // Super admin = no business filter, regular = scoped
    const tWhere = isSuperAdmin
      ? `1=1 ${tFilter}`
      : `t.business_id = '${businessId}' ${tFilter}`;
    const cWhere = isSuperAdmin
      ? `1=1 ${cFilter}`
      : `cs.business_id = '${businessId}' ${cFilter}`;

    if (isSuperAdmin) {
      // ── SUPER ADMIN DASHBOARD ──────────────────────────────
      const [
        platformSummary,
        ticketSummary,
        cargoSummary,
        chartResult,
        topBusinesses,
        cargoStatusRes,
        recentTickets,
        recentCargo,
        prevPlatformRes,
      ] = await Promise.all([
        // Platform-wide counts
        query(`
          SELECT
            (SELECT COUNT(*) FROM businesses WHERE status = 'active') AS active_businesses,
            (SELECT COUNT(*) FROM businesses) AS total_businesses,
            (SELECT COUNT(*) FROM users WHERE role != 'super_admin') AS total_users,
            (SELECT COUNT(*) FROM tickets) AS total_tickets,
            (SELECT COALESCE(SUM(revenue), 0) FROM tickets WHERE status != 'cancelled') AS total_ticket_revenue,
            (SELECT COUNT(*) FROM cargo_shipments) AS total_cargo,
            (SELECT COALESCE(SUM(total_price), 0) FROM cargo_shipments) AS total_cargo_revenue,
            (SELECT COUNT(*) FROM tickets WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())) AS tickets_this_month,
            (SELECT COUNT(*) FROM cargo_shipments WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())) AS cargo_this_month
        `),
        // Ticket breakdown
        query(`
          SELECT
            COUNT(*) AS total_tickets,
            COALESCE(SUM(t.revenue), 0) AS ticket_revenue,
            COUNT(*) FILTER (WHERE t.ticket_type = 'LOCAL') AS local_tickets,
            COUNT(*) FILTER (WHERE t.ticket_type = 'INTERNATIONAL') AS international_tickets,
            COUNT(*) FILTER (WHERE t.status = 'cancelled') AS cancelled_tickets,
            COUNT(*) FILTER (WHERE t.payment_status != 'paid') AS unpaid_tickets,
            COALESCE(SUM(t.selling_price - t.amount_paid) FILTER (WHERE t.payment_status != 'paid'), 0) AS unpaid_money,
            COALESCE(SUM(t.amount_paid), 0) AS collected_money,
            COALESCE(SUM(t.agent_commission), 0) AS total_commission
          FROM tickets t WHERE t.status != 'cancelled' ${tFilter}
        `),
        // Cargo breakdown
        query(`
          SELECT
            COUNT(*) AS total_shipments,
            COALESCE(SUM(cs.total_price), 0) AS cargo_revenue,
            COUNT(*) FILTER (WHERE cs.cargo_status = 'pending') AS pending_cargo,
            COUNT(*) FILTER (WHERE cs.cargo_status = 'delivered') AS delivered_cargo,
            COUNT(*) FILTER (WHERE cs.payment_status != 'paid') AS unpaid_cargo
          FROM cargo_shipments cs WHERE 1=1 ${cFilter}
        `),
        // 30-day chart (all businesses combined)
        query(`
          SELECT DATE_TRUNC('day', t.created_at)::DATE AS date,
                 COUNT(*) AS tickets, COALESCE(SUM(t.revenue), 0) AS revenue
          FROM tickets t
          WHERE t.created_at >= NOW() - INTERVAL '30 days' AND t.status != 'cancelled'
          GROUP BY 1 ORDER BY 1
        `),
        // Top businesses by tickets this month
        query(`
          SELECT b.name AS business_name,
                 COUNT(t.id) AS tickets_this_month,
                 COALESCE(SUM(t.revenue), 0) AS revenue_this_month,
                 (SELECT COUNT(*) FROM cargo_shipments cs
                  WHERE cs.business_id = b.id
                  AND DATE_TRUNC('month', cs.created_at) = DATE_TRUNC('month', NOW())) AS cargo_this_month
          FROM businesses b
          LEFT JOIN tickets t ON t.business_id = b.id
            AND DATE_TRUNC('month', t.created_at) = DATE_TRUNC('month', NOW())
            AND t.status != 'cancelled'
          WHERE b.status = 'active'
          GROUP BY b.id, b.name
          ORDER BY tickets_this_month DESC
          LIMIT 8
        `),
        // Cargo status breakdown
        query(
          `SELECT cargo_status, COUNT(*) AS count FROM cargo_shipments GROUP BY cargo_status`,
        ),
        // Recent tickets across all businesses
        query(`
          SELECT t.passenger_name, t.from_city, t.to_city, t.airline_name,
                 t.selling_price, t.revenue, b.name AS business_name, t.created_at
          FROM tickets t
          JOIN businesses b ON b.id = t.business_id
          ORDER BY t.created_at DESC LIMIT 5
        `),
        // Recent cargo across all businesses
        query(`
          SELECT cs.tracking_number, cs.item_description, cs.from_city, cs.to_city,
                 cs.total_price, cs.cargo_status, b.name AS business_name, cs.created_at
          FROM cargo_shipments cs
          JOIN businesses b ON b.id = cs.business_id
          ORDER BY cs.created_at DESC LIMIT 5
        `),
        tPrevFilter
          ? query(`
              SELECT
                (SELECT COUNT(*) FROM tickets t
                  WHERE t.status != 'cancelled' ${tPrevFilter}) AS total_tickets,
                (SELECT COALESCE(SUM(t.revenue), 0) FROM tickets t
                  WHERE t.status != 'cancelled' ${tPrevFilter}) AS ticket_revenue,
                (SELECT COALESCE(SUM(t.amount_paid), 0) FROM tickets t
                  WHERE t.status != 'cancelled' ${tPrevFilter}) AS collected_money,
                (SELECT COALESCE(SUM(t.selling_price - t.amount_paid), 0) FROM tickets t
                  WHERE t.status != 'cancelled' AND t.payment_status != 'paid' ${tPrevFilter}) AS unpaid_money,
                (SELECT COALESCE(SUM(cs.total_price), 0) FROM cargo_shipments cs
                  WHERE 1=1 ${cPrevFilter}) AS cargo_revenue
            `)
          : Promise.resolve({ rows: [{}] }),
      ]);

      const ps = platformSummary.rows[0];
      const ts = ticketSummary.rows[0];
      const cs = cargoSummary.rows[0];

      return response.success(res, {
        isSuperAdmin: true,
        summary: {
          // Platform
          active_businesses: ps.active_businesses,
          total_businesses: ps.total_businesses,
          total_users: ps.total_users,
          tickets_this_month: ps.tickets_this_month,
          cargo_this_month: ps.cargo_this_month,
          // Tickets (period filtered)
          total_tickets: ts.total_tickets,
          ticket_revenue: ts.ticket_revenue,
          local_tickets: ts.local_tickets,
          international_tickets: ts.international_tickets,
          cancelled_tickets: ts.cancelled_tickets,
          unpaid_tickets: ts.unpaid_tickets,
          unpaid_money: ts.unpaid_money,
          collected_money: ts.collected_money,
          total_commission: ts.total_commission,
          // Cargo (period filtered)
          total_shipments: cs.total_shipments,
          cargo_revenue: cs.cargo_revenue,
          pending_cargo: cs.pending_cargo,
          delivered_cargo: cs.delivered_cargo,
          unpaid_cargo: cs.unpaid_cargo,
          // Combined
          total_revenue: (
            parseFloat(ts.ticket_revenue) + parseFloat(cs.cargo_revenue)
          ).toFixed(2),
          // All-time totals
          all_time_ticket_revenue: ps.total_ticket_revenue,
          all_time_cargo_revenue: ps.total_cargo_revenue,
        },
        deltas: {
          total_revenue: pctChange(
            parseFloat(ts.ticket_revenue) + parseFloat(cs.cargo_revenue),
            parseFloat(prevPlatformRes.rows[0].ticket_revenue || 0) +
              parseFloat(prevPlatformRes.rows[0].cargo_revenue || 0),
          ),
          total_tickets: pctChange(
            ts.total_tickets,
            prevPlatformRes.rows[0].total_tickets,
          ),
          unpaid_money: pctChange(
            ts.unpaid_money,
            prevPlatformRes.rows[0].unpaid_money,
          ),
          collected_money: pctChange(
            ts.collected_money,
            prevPlatformRes.rows[0].collected_money,
          ),
        },
        chart: chartResult.rows,
        topBusinesses: topBusinesses.rows,
        cargoStatus: cargoStatusRes.rows,
        recentTickets: recentTickets.rows,
        recentCargo: recentCargo.rows,
      });
    } else {
      // ── REGULAR BUSINESS DASHBOARD ─────────────────────────
      // If agent, scope all ticket stats to their own tickets only
      const agentFilter =
        req.user.role === "agent" ? `AND t.created_by = '${req.user.id}'` : "";

      const [
        ticketSummary,
        cargoSummary,
        chartResult,
        agentResult,
        routeResult,
        cargoStatusRes,
        airlineResult,
        recentResult,
        prevTicketRes,
        prevCargoRes,
      ] = await Promise.all([
        query(
          `SELECT COUNT(*) AS total_tickets,
            COALESCE(SUM(t.revenue), 0) AS ticket_revenue,
            COUNT(*) FILTER (WHERE t.ticket_type = 'LOCAL') AS local_tickets,
            COUNT(*) FILTER (WHERE t.ticket_type = 'INTERNATIONAL') AS international_tickets,
            COUNT(*) FILTER (WHERE t.status = 'cancelled') AS cancelled_tickets,
            COUNT(*) FILTER (WHERE t.payment_status != 'paid') AS unpaid_tickets,
            COALESCE(SUM(t.selling_price - t.amount_paid) FILTER (WHERE t.payment_status != 'paid'), 0) AS unpaid_money,
            COALESCE(SUM(t.amount_paid), 0) AS collected_money,
            COALESCE(SUM(t.agent_commission), 0) AS total_commission
           FROM tickets t WHERE t.business_id = $1 AND t.status != 'cancelled' ${tFilter} ${agentFilter}`,
          [businessId],
        ),
        query(
          `SELECT COUNT(*) AS total_shipments,
            COALESCE(SUM(cs.total_price), 0) AS cargo_revenue,
            COUNT(*) FILTER (WHERE cs.cargo_status = 'pending') AS pending_cargo,
            COUNT(*) FILTER (WHERE cs.cargo_status = 'delivered') AS delivered_cargo,
            COUNT(*) FILTER (WHERE cs.payment_status != 'paid') AS unpaid_cargo
           FROM cargo_shipments cs WHERE cs.business_id = $1 ${cFilter}`,
          [businessId],
        ),
        query(
          `SELECT DATE_TRUNC('day', t.created_at)::DATE AS date,
                  COUNT(*) AS tickets, COALESCE(SUM(t.revenue), 0) AS revenue
           FROM tickets t
           WHERE t.business_id = $1 AND t.created_at >= NOW() - INTERVAL '30 days' AND t.status != 'cancelled' ${agentFilter}
           GROUP BY 1 ORDER BY 1`,
          [businessId],
        ),
        query(
          `SELECT u.name AS agent_name, COUNT(t.id) AS total_tickets,
                  COALESCE(SUM(t.revenue), 0) AS total_revenue
           FROM tickets t JOIN users u ON u.id = t.created_by
           WHERE t.business_id = $1 AND t.status != 'cancelled' ${tFilter}
           GROUP BY u.id, u.name ORDER BY total_revenue DESC LIMIT 10`,
          [businessId],
        ),
        query(
          `SELECT t.from_city || ' → ' || t.to_city AS route, COUNT(*) AS bookings
           FROM tickets t
           WHERE t.business_id = $1 AND t.status != 'cancelled' ${tFilter} ${agentFilter}
           GROUP BY 1 ORDER BY bookings DESC LIMIT 10`,
          [businessId],
        ),
        query(
          `SELECT cargo_status, COUNT(*) AS count
           FROM cargo_shipments WHERE business_id = $1 GROUP BY cargo_status`,
          [businessId],
        ),
        query(
          `SELECT t.airline_name, COUNT(*) AS tickets,
                  COALESCE(SUM(t.revenue), 0) AS revenue
           FROM tickets t
           WHERE t.business_id = $1 AND t.status != 'cancelled' ${tFilter} ${agentFilter}
           GROUP BY t.airline_name ORDER BY tickets DESC LIMIT 8`,
          [businessId],
        ),
        query(
          `SELECT t.id, t.passenger_name, t.from_city, t.to_city, t.airline_name,
                  t.selling_price, t.amount_paid, t.payment_status,
                  t.flight_date, t.created_at, u.name AS agent_name
           FROM tickets t
           LEFT JOIN users u ON u.id = t.created_by
           WHERE t.business_id = $1 AND t.status != 'cancelled' ${agentFilter}
           ORDER BY t.created_at DESC LIMIT 6`,
          [businessId],
        ),
        tPrevFilter
          ? query(
              `SELECT COUNT(*) AS total_tickets,
                COALESCE(SUM(t.revenue), 0) AS ticket_revenue,
                COALESCE(SUM(t.amount_paid), 0) AS collected_money,
                COALESCE(SUM(t.selling_price - t.amount_paid) FILTER (WHERE t.payment_status != 'paid'), 0) AS unpaid_money
               FROM tickets t
               WHERE t.business_id = $1 AND t.status != 'cancelled' ${tPrevFilter} ${agentFilter}`,
              [businessId],
            )
          : Promise.resolve({ rows: [{}] }),
        cPrevFilter
          ? query(
              `SELECT COALESCE(SUM(cs.total_price), 0) AS cargo_revenue
               FROM cargo_shipments cs
               WHERE cs.business_id = $1 ${cPrevFilter}`,
              [businessId],
            )
          : Promise.resolve({ rows: [{}] }),
      ]);

      const ts = ticketSummary.rows[0];
      const cs = cargoSummary.rows[0];
      return response.success(res, {
        isSuperAdmin: false,
        userRole: req.user.role,
        summary: {
          total_tickets: ts.total_tickets,
          ticket_revenue: ts.ticket_revenue,
          local_tickets: ts.local_tickets,
          international_tickets: ts.international_tickets,
          cancelled_tickets: ts.cancelled_tickets,
          unpaid_tickets: ts.unpaid_tickets,
          unpaid_money: ts.unpaid_money,
          collected_money: ts.collected_money,
          total_commission: ts.total_commission,
          total_shipments: cs.total_shipments,
          cargo_revenue: cs.cargo_revenue,
          pending_cargo: cs.pending_cargo,
          delivered_cargo: cs.delivered_cargo,
          unpaid_cargo: cs.unpaid_cargo,
          total_revenue: (
            parseFloat(ts.ticket_revenue) + parseFloat(cs.cargo_revenue)
          ).toFixed(2),
        },
        deltas: {
          total_revenue: pctChange(
            parseFloat(ts.ticket_revenue) + parseFloat(cs.cargo_revenue),
            parseFloat(prevTicketRes.rows[0].ticket_revenue || 0) +
              parseFloat(prevCargoRes.rows[0].cargo_revenue || 0),
          ),
          total_tickets: pctChange(
            ts.total_tickets,
            prevTicketRes.rows[0].total_tickets,
          ),
          unpaid_money: pctChange(
            ts.unpaid_money,
            prevTicketRes.rows[0].unpaid_money,
          ),
          collected_money: pctChange(
            ts.collected_money,
            prevTicketRes.rows[0].collected_money,
          ),
        },
        chart: chartResult.rows,
        agentPerformance: req.user.role === "agent" ? [] : agentResult.rows,
        topRoutes: routeResult.rows,
        topAirlines: airlineResult.rows,
        cargoStatus: cargoStatusRes.rows,
        recentTickets: recentResult.rows,
      });
    }
  } catch (err) {
    next(err);
  }
};
/**
 * GET /api/reports/tickets
 */
const getReportTickets = async (req, res, next) => {
  try {
    const {
      from_date,
      to_date,
      ticket_type,
      airline_name,
      agent_id,
      page = 1,
      limit = 50,
    } = req.query;
    const businessId = req.businessId;
    const params = [businessId];
    const conditions = ["t.business_id = $1"];
    let pi = 2;

    if (from_date) {
      conditions.push(`t.created_at >= $${pi}`);
      params.push(from_date);
      pi++;
    }
    if (to_date) {
      conditions.push(`t.created_at <= $${pi}`);
      params.push(to_date + " 23:59:59");
      pi++;
    }
    if (ticket_type) {
      conditions.push(`t.ticket_type = $${pi}`);
      params.push(ticket_type);
      pi++;
    }
    if (airline_name) {
      conditions.push(`LOWER(t.airline_name) = LOWER($${pi})`);
      params.push(airline_name);
      pi++;
    }
    if (agent_id) {
      conditions.push(`t.created_by = $${pi}`);
      params.push(agent_id);
      pi++;
    }

    const where = conditions.join(" AND ");
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [countRes, dataRes] = await Promise.all([
      query(
        `SELECT COUNT(*),
                COALESCE(SUM(t.revenue) FILTER (WHERE t.status != 'cancelled'), 0) AS total_revenue,
                COALESCE(SUM(t.amount_paid) FILTER (WHERE t.status != 'cancelled'), 0) AS total_collected,
                COALESCE(SUM(t.selling_price - t.amount_paid) FILTER (WHERE t.status != 'cancelled'), 0) AS total_balance
         FROM tickets t WHERE ${where}`,
        params,
      ),
      query(
        `SELECT t.*, u.name AS agent_name FROM tickets t LEFT JOIN users u ON u.id = t.created_by WHERE ${where} ORDER BY t.created_at DESC LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, parseInt(limit), offset],
      ),
    ]);

    const c = countRes.rows[0];
    return response.paginated(
      res,
      dataRes.rows,
      page,
      limit,
      parseInt(c.count),
      `Revenue: $${Number(c.total_revenue).toFixed(2)} · Collected: $${Number(c.total_collected).toFixed(2)} · Balance: $${Number(c.total_balance).toFixed(2)}`,
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/reports/summary
 * Totals + airline breakdown for the report filters
 */
const getReportSummary = async (req, res, next) => {
  try {
    const { from_date, to_date, ticket_type, airline_name } = req.query;
    const businessId = req.businessId;
    const params = [businessId];
    const conditions = ["t.business_id = $1"];
    let pi = 2;

    if (from_date) {
      conditions.push(`t.created_at >= $${pi}`);
      params.push(from_date);
      pi++;
    }
    if (to_date) {
      conditions.push(`t.created_at <= $${pi}`);
      params.push(to_date + " 23:59:59");
      pi++;
    }
    if (ticket_type) {
      conditions.push(`t.ticket_type = $${pi}`);
      params.push(ticket_type);
      pi++;
    }
    if (airline_name) {
      conditions.push(`LOWER(t.airline_name) = LOWER($${pi})`);
      params.push(airline_name);
      pi++;
    }
    const where = conditions.join(" AND ");

    const [summaryRes, airlinesRes] = await Promise.all([
      query(
        `SELECT COUNT(*) FILTER (WHERE t.status != 'cancelled') AS total_tickets,
                COALESCE(SUM(t.revenue) FILTER (WHERE t.status != 'cancelled'), 0) AS total_revenue,
                COALESCE(SUM(t.amount_paid) FILTER (WHERE t.status != 'cancelled'), 0) AS total_collected,
                COALESCE(SUM(t.selling_price - t.amount_paid) FILTER (WHERE t.status != 'cancelled'), 0) AS total_balance,
                COUNT(*) FILTER (WHERE t.status != 'cancelled' AND t.payment_status != 'paid') AS unpaid_tickets
         FROM tickets t WHERE ${where}`,
        params,
      ),
      query(
        `SELECT t.airline_name,
                COUNT(*) AS tickets,
                COALESCE(SUM(t.selling_price), 0) AS total_sales,
                COALESCE(SUM(t.revenue), 0) AS total_revenue
         FROM tickets t
         WHERE ${where} AND t.status != 'cancelled'
         GROUP BY t.airline_name
         ORDER BY tickets DESC, total_revenue DESC`,
        params,
      ),
    ]);

    return response.success(res, {
      summary: summaryRes.rows[0],
      airlines: airlinesRes.rows,
      topAirline: airlinesRes.rows[0] || null,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/reports/export/pdf
 */
const exportPDF = async (req, res, next) => {
  try {
    const { from_date, to_date, ticket_type, airline_name } = req.query;
    const businessId = req.businessId;
    const params = [businessId];
    const conditions = ["t.business_id = $1"];
    let pi = 2;

    if (from_date) {
      conditions.push(`t.created_at >= $${pi}`);
      params.push(from_date);
      pi++;
    }
    if (to_date) {
      conditions.push(`t.created_at <= $${pi}`);
      params.push(to_date + " 23:59:59");
      pi++;
    }
    if (ticket_type) {
      conditions.push(`t.ticket_type = $${pi}`);
      params.push(ticket_type);
      pi++;
    }
    if (airline_name) {
      conditions.push(`LOWER(t.airline_name) = LOWER($${pi})`);
      params.push(airline_name);
      pi++;
    }

    const where = conditions.join(" AND ");
    const [summaryRes, ticketsRes, airlinesRes] = await Promise.all([
      query(
        `SELECT COUNT(*) AS total_tickets, COALESCE(SUM(t.revenue), 0) AS total_revenue,
              COALESCE(SUM(t.amount_paid), 0) AS total_collected,
              COALESCE(SUM(t.selling_price - t.amount_paid), 0) AS total_balance,
              COUNT(*) FILTER (WHERE t.ticket_type='LOCAL') AS local_tickets,
              COUNT(*) FILTER (WHERE t.ticket_type='INTERNATIONAL') AS international_tickets
             FROM tickets t WHERE ${where}`,
        params,
      ),
      query(
        `SELECT t.*, u.name AS agent_name FROM tickets t LEFT JOIN users u ON u.id = t.created_by WHERE ${where} ORDER BY t.created_at DESC`,
        params,
      ),
      query(
        `SELECT t.airline_name, COUNT(*) AS tickets,
                COALESCE(SUM(t.selling_price), 0) AS total_sales,
                COALESCE(SUM(t.revenue), 0) AS total_revenue
         FROM tickets t WHERE ${where} AND t.status != 'cancelled'
         GROUP BY t.airline_name ORDER BY tickets DESC`,
        params,
      ),
    ]);

    generatePDFReport(
      res,
      {
        summary: summaryRes.rows[0],
        tickets: ticketsRes.rows,
        airlines: airlinesRes.rows,
      },
      { from: from_date, to: to_date },
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/reports/export/excel
 */
const exportExcel = async (req, res, next) => {
  try {
    const { from_date, to_date, ticket_type, airline_name } = req.query;
    const businessId = req.businessId;
    const params = [businessId];
    const conditions = ["t.business_id = $1"];
    let pi = 2;

    if (from_date) {
      conditions.push(`t.created_at >= $${pi}`);
      params.push(from_date);
      pi++;
    }
    if (to_date) {
      conditions.push(`t.created_at <= $${pi}`);
      params.push(to_date + " 23:59:59");
      pi++;
    }
    if (ticket_type) {
      conditions.push(`t.ticket_type = $${pi}`);
      params.push(ticket_type);
      pi++;
    }
    if (airline_name) {
      conditions.push(`LOWER(t.airline_name) = LOWER($${pi})`);
      params.push(airline_name);
      pi++;
    }

    const where = conditions.join(" AND ");
    const [summaryRes, ticketsRes, agentRes, cargoRes, airlinesRes] =
      await Promise.all([
        query(
          `SELECT COUNT(*) AS total_tickets, COALESCE(SUM(t.revenue), 0) AS total_revenue,
              COALESCE(SUM(t.amount_paid), 0) AS total_collected,
              COALESCE(SUM(t.selling_price - t.amount_paid), 0) AS total_balance,
              COUNT(*) FILTER (WHERE t.ticket_type='LOCAL') AS local_tickets,
              COUNT(*) FILTER (WHERE t.ticket_type='INTERNATIONAL') AS international_tickets
             FROM tickets t WHERE ${where}`,
          params,
        ),
      query(
        `SELECT t.*, u.name AS agent_name FROM tickets t LEFT JOIN users u ON u.id = t.created_by WHERE ${where} ORDER BY t.created_at DESC`,
        params,
      ),
      query(
        `SELECT u.name AS agent_name, COUNT(*) AS total_tickets, SUM(t.revenue) AS total_revenue
             FROM tickets t JOIN users u ON u.id = t.created_by WHERE ${where} GROUP BY u.id, u.name ORDER BY total_revenue DESC`,
        params,
      ),
      query(
        `SELECT * FROM cargo_shipments WHERE business_id = $1 ORDER BY created_at DESC`,
        [businessId],
      ),
      query(
        `SELECT t.airline_name, COUNT(*) AS tickets,
                COALESCE(SUM(t.selling_price), 0) AS total_sales,
                COALESCE(SUM(t.revenue), 0) AS total_revenue
         FROM tickets t WHERE ${where} AND t.status != 'cancelled'
         GROUP BY t.airline_name ORDER BY tickets DESC`,
        params,
      ),
    ]);

    await generateExcelReport(
      res,
      {
        summary: summaryRes.rows[0],
        tickets: ticketsRes.rows,
        agentPerformance: agentRes.rows,
        cargo: cargoRes.rows,
        airlines: airlinesRes.rows,
      },
      { from: from_date, to: to_date },
    );
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getDashboard,
  getReportTickets,
  getReportSummary,
  exportPDF,
  exportExcel,
};
