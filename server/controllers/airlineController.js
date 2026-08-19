/**
 * airlineController.js
 *
 * Airline performance reporting — which carriers the agency sells most,
 * what they earn per carrier, and who flew on them.
 */

const { query, withTransaction } = require("../config/db");
const response = require("../utils/response");
const { generateAirlinePDF } = require("../services/reportService");
const {
  matchKey,
  cleanName,
  airlinesTableExists,
  aliasTableExists,
  findAirlineMatch,
} = require("../services/airlineService");

const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

/**
 * Shared filter builder for airline queries.
 * Filters on booking date (created_at) by default; pass date_basis=flight
 * to filter on flight_date instead.
 */
const buildFilters = (req, startIdx = 2) => {
  const {
    from_date,
    to_date,
    ticket_type,
    airline_name,
    date_basis = "booked",
  } = req.query;

  const dateCol = date_basis === "flight" ? "t.flight_date" : "t.created_at::DATE";
  const conditions = ["t.business_id = $1", "t.status <> 'cancelled'"];
  const params = [];
  let pi = startIdx;

  if (from_date) {
    conditions.push(`${dateCol} >= $${pi}`);
    params.push(from_date);
    pi++;
  }
  if (to_date) {
    conditions.push(`${dateCol} <= $${pi}`);
    params.push(to_date);
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
  // Agents only ever see their own bookings
  if (req.user.role === "agent") {
    conditions.push(`t.created_by = $${pi}`);
    params.push(req.user.id);
    pi++;
  }

  return { where: conditions.join(" AND "), params, nextIdx: pi };
};

/**
 * GET /api/airlines
 * Every airline the agency has sold, ranked, with totals.
 * Also returns a plain name list for filter dropdowns.
 */
const getAirlines = async (req, res, next) => {
  try {
    const businessId = req.businessId;
    const { where, params } = buildFilters(req);

    const [rankedRes, allNamesRes, totalsRes] = await Promise.all([
      query(
        `SELECT
           t.airline_name,
           COUNT(*)                                                       AS tickets,
           COUNT(*) FILTER (WHERE t.ticket_type = 'LOCAL')                AS local_tickets,
           COUNT(*) FILTER (WHERE t.ticket_type = 'INTERNATIONAL')        AS international_tickets,
           COUNT(DISTINCT t.passenger_name)                               AS passengers,
           COUNT(DISTINCT (t.from_city || ' → ' || t.to_city))            AS routes,
           COALESCE(SUM(t.selling_price), 0)                              AS total_sales,
           COALESCE(SUM(t.cost_price), 0)                                 AS total_cost,
           COALESCE(SUM(t.revenue), 0)                                    AS total_revenue,
           COALESCE(SUM(t.amount_paid), 0)                                AS total_collected,
           COALESCE(SUM(t.selling_price - t.amount_paid), 0)              AS total_balance,
           COUNT(*) FILTER (WHERE t.payment_status <> 'paid')             AS unpaid_tickets,
           MAX(t.flight_date)                                             AS last_flight_date
         FROM tickets t
         WHERE ${where}
         GROUP BY t.airline_name
         ORDER BY tickets DESC, total_revenue DESC`,
        [businessId, ...params],
      ),
      // Master list when it exists, otherwise the distinct names on tickets
      // so the page still works before migration_v5 has been run.
      (await airlinesTableExists())
        ? query(
            `SELECT name AS airline_name FROM airlines WHERE business_id = $1
             UNION
             SELECT DISTINCT t.airline_name FROM tickets t
              WHERE t.business_id = $1 AND t.airline_name IS NOT NULL
             ORDER BY 1`,
            [businessId],
          )
        : query(
            `SELECT DISTINCT airline_name FROM tickets
             WHERE business_id = $1 AND airline_name IS NOT NULL
             ORDER BY airline_name`,
            [businessId],
          ),
      query(
        `SELECT
           COUNT(*)                             AS tickets,
           COUNT(DISTINCT t.airline_name)       AS airlines,
           COALESCE(SUM(t.selling_price), 0)    AS total_sales,
           COALESCE(SUM(t.revenue), 0)          AS total_revenue
         FROM tickets t WHERE ${where}`,
        [businessId, ...params],
      ),
    ]);

    const totals = totalsRes.rows[0];

    return response.success(res, {
      airlines: rankedRes.rows.map((r) => ({
        airline_name: r.airline_name,
        tickets: parseInt(r.tickets),
        local_tickets: parseInt(r.local_tickets),
        international_tickets: parseInt(r.international_tickets),
        passengers: parseInt(r.passengers),
        routes: parseInt(r.routes),
        total_sales: round2(r.total_sales),
        total_cost: round2(r.total_cost),
        total_revenue: round2(r.total_revenue),
        total_collected: round2(r.total_collected),
        total_balance: round2(r.total_balance),
        unpaid_tickets: parseInt(r.unpaid_tickets),
        last_flight_date: r.last_flight_date,
      })),
      airline_names: allNamesRes.rows.map((r) => r.airline_name),
      totals: {
        tickets: parseInt(totals.tickets),
        airlines: parseInt(totals.airlines),
        total_sales: round2(totals.total_sales),
        total_revenue: round2(totals.total_revenue),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/airlines/:name/passengers
 * Every passenger flown on one airline, with route and money detail.
 */
const getAirlinePassengers = async (req, res, next) => {
  try {
    const businessId = req.businessId;
    const airlineName = decodeURIComponent(req.params.name);
    const { page = 1, limit = 50 } = req.query;

    // Force the airline filter onto the request
    req.query.airline_name = airlineName;
    const { where, params, nextIdx } = buildFilters(req);
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [countRes, summaryRes, routesRes, listRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM tickets t WHERE ${where}`, [
        businessId,
        ...params,
      ]),
      query(
        `SELECT
           COUNT(*)                                            AS tickets,
           COUNT(DISTINCT t.passenger_name)                    AS passengers,
           COALESCE(SUM(t.selling_price), 0)                   AS total_sales,
           COALESCE(SUM(t.cost_price), 0)                      AS total_cost,
           COALESCE(SUM(t.revenue), 0)                          AS total_revenue,
           COALESCE(SUM(t.amount_paid), 0)                     AS total_collected,
           COALESCE(SUM(t.selling_price - t.amount_paid), 0)   AS total_balance
         FROM tickets t WHERE ${where}`,
        [businessId, ...params],
      ),
      query(
        `SELECT
           t.from_city, t.to_city,
           t.from_city || ' → ' || t.to_city   AS route,
           COUNT(*)                            AS tickets,
           COALESCE(SUM(t.revenue), 0)         AS revenue
         FROM tickets t WHERE ${where}
         GROUP BY t.from_city, t.to_city
         ORDER BY tickets DESC LIMIT 15`,
        [businessId, ...params],
      ),
      query(
        `SELECT
           t.id, t.passenger_name, t.contact_number, t.passport_number,
           t.ticket_type, t.trip_type, t.status, t.payment_status,
           t.from_city, t.to_city, t.flight_date, t.return_date,
           t.ticket_reference, t.cost_price, t.selling_price,
           t.agent_commission, t.revenue, t.amount_paid,
           (t.selling_price - t.amount_paid) AS balance,
           t.created_at AS booked_date,
           u.name AS agent_name,
           c.phone AS customer_phone
         FROM tickets t
         LEFT JOIN users u     ON u.id = t.created_by
         LEFT JOIN customers c ON c.id = t.customer_id
         WHERE ${where}
         ORDER BY t.flight_date DESC, t.created_at DESC
         LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
        [businessId, ...params, parseInt(limit), offset],
      ),
    ]);

    const total = parseInt(countRes.rows[0].count);
    if (total === 0) {
      return response.success(res, {
        airline_name: airlineName,
        summary: {
          tickets: 0,
          passengers: 0,
          total_sales: 0,
          total_cost: 0,
          total_revenue: 0,
          total_collected: 0,
          total_balance: 0,
        },
        routes: [],
        passengers: [],
        meta: { page: 1, limit: parseInt(limit), total: 0, totalPages: 0 },
      });
    }

    const s = summaryRes.rows[0];
    return response.success(res, {
      airline_name: airlineName,
      summary: {
        tickets: parseInt(s.tickets),
        passengers: parseInt(s.passengers),
        total_sales: round2(s.total_sales),
        total_cost: round2(s.total_cost),
        total_revenue: round2(s.total_revenue),
        total_collected: round2(s.total_collected),
        total_balance: round2(s.total_balance),
      },
      routes: routesRes.rows.map((r) => ({
        route: r.route,
        from_city: r.from_city,
        to_city: r.to_city,
        tickets: parseInt(r.tickets),
        revenue: round2(r.revenue),
      })),
      passengers: listRes.rows,
      meta: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/airlines/:name/pdf
 * Printable passenger manifest / revenue sheet for one airline.
 */
const exportAirlinePDF = async (req, res, next) => {
  try {
    const businessId = req.businessId;
    const airlineName = decodeURIComponent(req.params.name);
    req.query.airline_name = airlineName;
    const { where, params } = buildFilters(req);

    const [summaryRes, listRes, routesRes] = await Promise.all([
      query(
        `SELECT
           COUNT(*) AS tickets,
           COUNT(DISTINCT t.passenger_name) AS passengers,
           COALESCE(SUM(t.selling_price), 0) AS total_sales,
           COALESCE(SUM(t.cost_price), 0) AS total_cost,
           COALESCE(SUM(t.revenue), 0) AS total_revenue,
           COALESCE(SUM(t.amount_paid), 0) AS total_collected,
           COALESCE(SUM(t.selling_price - t.amount_paid), 0) AS total_balance
         FROM tickets t WHERE ${where}`,
        [businessId, ...params],
      ),
      query(
        `SELECT t.passenger_name, t.contact_number, t.from_city, t.to_city,
                t.flight_date, t.return_date, t.trip_type, t.ticket_type,
                t.ticket_reference, t.selling_price, t.amount_paid,
                (t.selling_price - t.amount_paid) AS balance,
                t.revenue, t.payment_status, u.name AS agent_name
         FROM tickets t
         LEFT JOIN users u ON u.id = t.created_by
         WHERE ${where}
         ORDER BY t.flight_date DESC`,
        [businessId, ...params],
      ),
      query(
        `SELECT t.from_city || ' → ' || t.to_city AS route,
                COUNT(*) AS tickets,
                COALESCE(SUM(t.revenue), 0) AS revenue
         FROM tickets t WHERE ${where}
         GROUP BY 1 ORDER BY tickets DESC LIMIT 15`,
        [businessId, ...params],
      ),
    ]);

    generateAirlinePDF(
      res,
      {
        airline_name: airlineName,
        summary: summaryRes.rows[0],
        passengers: listRes.rows,
        routes: routesRes.rows,
      },
      { from: req.query.from_date, to: req.query.to_date },
    );
  } catch (err) {
    next(err);
  }
};

// ─── Master list management ──────────────────────────────────────────────────

/**
 * GET /api/airlines-list
 * The agency's master airline list — powers the ticket form autocomplete.
 */
const listAirlines = async (req, res, next) => {
  try {
    if (!(await airlinesTableExists())) {
      // Pre-migration: build the autocomplete from what's already on tickets
      const fallback = await query(
        `SELECT DISTINCT airline_name AS name FROM tickets
         WHERE business_id = $1 AND airline_name IS NOT NULL
         ORDER BY name`,
        [req.businessId],
      );
      return response.success(
        res,
        fallback.rows.map((r) => ({ id: null, name: r.name, ticket_count: 0 })),
      );
    }

    const result = await query(
      `SELECT a.id, a.name, a.match_key, a.iata_code, a.country, a.is_active,
              (SELECT COUNT(*) FROM tickets t
                WHERE t.airline_id = a.id AND t.status <> 'cancelled') AS ticket_count
       FROM airlines a
       WHERE a.business_id = $1
       ORDER BY a.name`,
      [req.businessId],
    );
    return response.success(res, result.rows);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/airlines-list/duplicates
 * Near-matches the automatic rule didn't catch — same first word, or one
 * name contained in another. Surfaced so the user can merge deliberately.
 */
const findDuplicates = async (req, res, next) => {
  try {
    if (!(await airlinesTableExists())) return response.success(res, []);

    const result = await query(
      `SELECT a.id, a.name, a.match_key,
              (SELECT COUNT(*) FROM tickets t WHERE t.airline_id = a.id) AS ticket_count
       FROM airlines a WHERE a.business_id = $1 ORDER BY a.name`,
      [req.businessId],
    );
    const rows = result.rows;
    const pairs = [];

    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i];
        const b = rows[j];
        const ka = a.match_key || "";
        const kb = b.match_key || "";
        if (!ka || !kb) continue;

        let reason = null;
        if (ka === kb) reason = "identical after normalising";
        else if (ka.startsWith(kb) || kb.startsWith(ka))
          reason = "one name starts with the other";
        else if (ka.slice(0, 4) === kb.slice(0, 4) && ka.length > 3)
          reason = "first four letters match";

        if (reason) pairs.push({ a, b, reason });
      }
    }

    return response.success(res, pairs);
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/airlines-list/:id
 * Rename a carrier. All its tickets adopt the new spelling.
 */
const updateAirline = async (req, res, next) => {
  try {
    const name = cleanName(req.body.name);
    if (!name) return response.error(res, "Airline name is required", 422);
    const key = matchKey(name);

    const clash = await query(
      `SELECT id FROM airlines
       WHERE business_id = $1 AND match_key = $2 AND id <> $3 LIMIT 1`,
      [req.businessId, key, req.params.id],
    );
    if (clash.rows.length > 0) {
      return response.error(
        res,
        "Another airline already uses that name. Merge them instead.",
        409,
      );
    }

    const updated = await withTransaction(async (client) => {
      const r = await client.query(
        `UPDATE airlines SET name = $1, match_key = $2,
                iata_code = COALESCE($3, iata_code),
                country   = COALESCE($4, country),
                is_active = COALESCE($5, is_active)
         WHERE id = $6 AND business_id = $7 RETURNING *`,
        [
          name,
          key,
          req.body.iata_code || null,
          req.body.country || null,
          req.body.is_active ?? null,
          req.params.id,
          req.businessId,
        ],
      );
      if (r.rows.length === 0) return null;

      await client.query(
        `UPDATE tickets SET airline_name = $1
         WHERE airline_id = $2 AND business_id = $3`,
        [name, req.params.id, req.businessId],
      );
      return r.rows[0];
    });

    if (!updated) return response.notFound(res, "Airline not found");
    return response.success(res, updated, "Airline renamed");
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/airlines-list/merge   { from_id, into_id }
 * Re-points every ticket from one airline onto another, then deletes the
 * empty one. Ticket history is untouched — only the carrier changes.
 */
const mergeAirlines = async (req, res, next) => {
  try {
    const { from_id, into_id } = req.body;
    if (!from_id || !into_id)
      return response.error(res, "Both from_id and into_id are required", 400);
    if (from_id === into_id)
      return response.error(res, "Cannot merge an airline into itself", 400);

    const found = await query(
      `SELECT id, name FROM airlines WHERE business_id = $1 AND id IN ($2, $3)`,
      [req.businessId, from_id, into_id],
    );
    if (found.rows.length !== 2)
      return response.notFound(res, "One or both airlines were not found");

    const target = found.rows.find((r) => r.id === into_id);
    const source = found.rows.find((r) => r.id === from_id);

    const moved = await withTransaction(async (client) => {
      const r = await client.query(
        `UPDATE tickets SET airline_id = $1, airline_name = $2
         WHERE airline_id = $3 AND business_id = $4`,
        [into_id, target.name, from_id, req.businessId],
      );
      // Any ticket still carrying the old spelling but no link
      await client.query(
        `UPDATE tickets SET airline_id = $1, airline_name = $2
         WHERE business_id = $3 AND airline_id IS NULL AND LOWER(airline_name) = LOWER($4)`,
        [into_id, target.name, req.businessId, source.name],
      );
      await client.query(
        `UPDATE booking_groups SET airline_name = $1
         WHERE business_id = $2 AND LOWER(airline_name) = LOWER($3)`,
        [target.name, req.businessId, source.name],
      );
      await client.query(
        `DELETE FROM airlines WHERE id = $1 AND business_id = $2`,
        [from_id, req.businessId],
      );
      return r.rowCount;
    });

    return response.success(
      res,
      { moved_tickets: moved, into: target.name, removed: source.name },
      `Merged "${source.name}" into "${target.name}" — ${moved} ticket${moved === 1 ? "" : "s"} moved`,
    );
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/airlines-list/:id — only when nothing references it.
 */
const deleteAirline = async (req, res, next) => {
  try {
    const inUse = await query(
      `SELECT COUNT(*) FROM tickets WHERE airline_id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (parseInt(inUse.rows[0].count) > 0) {
      return response.error(
        res,
        `This airline is used by ${inUse.rows[0].count} ticket(s). Merge it into another airline instead of deleting.`,
        409,
      );
    }
    const r = await query(
      `DELETE FROM airlines WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.id, req.businessId],
    );
    if (r.rows.length === 0) return response.notFound(res, "Airline not found");
    return response.success(res, null, "Airline deleted");
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/airlines-list/lookup?name=...
 * Does this name match a registered carrier? Used by the ticket form to
 * show "Matched to Star Airline" or "New airline" as the agent types.
 */
const lookupAirline = async (req, res, next) => {
  try {
    const match = await findAirlineMatch(req.query.name, req.businessId);
    return response.success(res, {
      matched: match.matched,
      via: match.via,
      airline: match.airline,
      resolved_name: match.name,
      suggestions: match.suggestions,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Aliases ─────────────────────────────────────────────────────────────────

const ALIAS_MIGRATION_MSG =
  "Aliases need a database update. Run migration_v6.sql.";

/** GET /api/airlines-list/:id/aliases */
const getAliases = async (req, res, next) => {
  try {
    if (!(await aliasTableExists())) return response.success(res, []);
    const r = await query(
      `SELECT id, alias, match_key, created_at FROM airline_aliases
       WHERE airline_id = $1 AND business_id = $2 ORDER BY alias`,
      [req.params.id, req.businessId],
    );
    return response.success(res, r.rows);
  } catch (err) {
    next(err);
  }
};

/** POST /api/airlines-list/:id/aliases   { alias } */
const addAlias = async (req, res, next) => {
  try {
    if (!(await aliasTableExists()))
      return response.error(res, ALIAS_MIGRATION_MSG, 503);

    const alias = cleanName(req.body.alias);
    if (!alias) return response.error(res, "Alias is required", 422);
    const key = matchKey(alias);
    if (!key) return response.error(res, "That alias has no letters or digits", 422);

    const airline = await query(
      `SELECT id, name, match_key FROM airlines WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (airline.rows.length === 0)
      return response.notFound(res, "Airline not found");

    if (airline.rows[0].match_key === key) {
      return response.error(
        res,
        "That's already this airline's name — no alias needed.",
        409,
      );
    }

    // An alias must not shadow a different airline's actual name
    const clash = await query(
      `SELECT name FROM airlines WHERE business_id = $1 AND match_key = $2 LIMIT 1`,
      [req.businessId, key],
    );
    if (clash.rows.length > 0) {
      return response.error(
        res,
        `"${alias}" is already the name of another airline (${clash.rows[0].name}). Merge them instead.`,
        409,
      );
    }

    const taken = await query(
      `SELECT al.alias, a.name FROM airline_aliases al
       JOIN airlines a ON a.id = al.airline_id
       WHERE al.business_id = $1 AND al.match_key = $2 LIMIT 1`,
      [req.businessId, key],
    );
    if (taken.rows.length > 0) {
      return response.error(
        res,
        `"${alias}" already points to ${taken.rows[0].name}.`,
        409,
      );
    }

    const inserted = await query(
      `INSERT INTO airline_aliases (business_id, airline_id, alias, match_key)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.businessId, req.params.id, alias, key],
    );
    return response.created(
      res,
      inserted.rows[0],
      `"${alias}" now resolves to ${airline.rows[0].name}`,
    );
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/airlines-list/aliases/:aliasId */
const deleteAlias = async (req, res, next) => {
  try {
    if (!(await aliasTableExists()))
      return response.error(res, ALIAS_MIGRATION_MSG, 503);
    const r = await query(
      `DELETE FROM airline_aliases WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.aliasId, req.businessId],
    );
    if (r.rows.length === 0) return response.notFound(res, "Alias not found");
    return response.success(res, null, "Alias removed");
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAirlines,
  getAirlinePassengers,
  exportAirlinePDF,
  listAirlines,
  findDuplicates,
  updateAirline,
  mergeAirlines,
  deleteAirline,
  lookupAirline,
  getAliases,
  addAlias,
  deleteAlias,
};
