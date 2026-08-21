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
const { hasTable, hasColumn } = require("../services/schemaInfo");

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

    const [rankedRes, allNamesRes, totalsRes, accountRes] = await Promise.all([
      // Airline view is a PAYABLES view: what we owe the carrier, not what
      // the customer owes us. Customer-side money lives in Reports.
      query(
        `SELECT
           t.airline_name,
           MAX(t.airline_id::TEXT)                                        AS airline_id,
           COUNT(*)                                                       AS tickets,
           COUNT(*) FILTER (WHERE t.ticket_type = 'LOCAL')                AS local_tickets,
           COUNT(*) FILTER (WHERE t.ticket_type = 'INTERNATIONAL')        AS international_tickets,
           COUNT(DISTINCT t.passenger_name)                               AS passengers,
           COUNT(DISTINCT (t.from_city || ' → ' || t.to_city))            AS routes,
           COALESCE(SUM(t.cost_price), 0)                                 AS total_cost,
           MAX(t.flight_date)                                             AS last_flight_date
         FROM tickets t
         WHERE ${where}
         GROUP BY t.airline_name
         ORDER BY total_cost DESC, tickets DESC`,
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
           COALESCE(SUM(t.cost_price), 0)       AS total_cost
         FROM tickets t WHERE ${where}`,
        [businessId, ...params],
      ),
      // Account balances are all-time by nature — a settlement isn't tied
      // to the date range you happen to be looking at.
      (await accountTableExists())
        ? query(
            `SELECT airline_id, airline_name, total_cost, total_paid, balance
             FROM v_airline_account WHERE business_id = $1`,
            [businessId],
          )
        : Promise.resolve({ rows: [] }),
    ]);

    const totals = totalsRes.rows[0];
    const accByName = new Map(
      accountRes.rows.map((a) => [String(a.airline_name).toLowerCase(), a]),
    );

    const airlines = rankedRes.rows.map((r) => {
      const acc = accByName.get(String(r.airline_name).toLowerCase());
      return {
        airline_name: r.airline_name,
        airline_id: r.airline_id || acc?.airline_id || null,
        tickets: parseInt(r.tickets),
        local_tickets: parseInt(r.local_tickets),
        international_tickets: parseInt(r.international_tickets),
        passengers: parseInt(r.passengers),
        routes: parseInt(r.routes),
        total_cost: round2(r.total_cost),
        last_flight_date: r.last_flight_date,
        // account (all-time)
        account_cost: acc ? round2(acc.total_cost) : null,
        account_paid: acc ? round2(acc.total_paid) : null,
        account_balance: acc ? round2(acc.balance) : null,
      };
    });

    const accountTotals = accountRes.rows.reduce(
      (a, r) => ({
        total_cost: a.total_cost + Number(r.total_cost || 0),
        total_paid: a.total_paid + Number(r.total_paid || 0),
        total_balance: a.total_balance + Number(r.balance || 0),
        airlines_owing: a.airlines_owing + (Number(r.balance || 0) > 0 ? 1 : 0),
      }),
      { total_cost: 0, total_paid: 0, total_balance: 0, airlines_owing: 0 },
    );

    return response.success(res, {
      airlines,
      airline_names: allNamesRes.rows.map((r) => r.airline_name),
      totals: {
        tickets: parseInt(totals.tickets),
        airlines: parseInt(totals.airlines),
        total_cost: round2(totals.total_cost),
      },
      account: {
        total_cost: round2(accountTotals.total_cost),
        total_paid: round2(accountTotals.total_paid),
        total_balance: round2(accountTotals.total_balance),
        airlines_owing: accountTotals.airlines_owing,
        available: accountRes.rows.length > 0 || (await accountTableExists()),
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

    // Settlement columns only exist after migration v9
    const perTicket = await hasColumn("tickets", "airline_paid");
    const settleCols = perTicket
      ? "t.airline_paid, (t.cost_price - t.airline_paid) AS airline_balance,"
      : "0::NUMERIC AS airline_paid, t.cost_price AS airline_balance,";

    const [countRes, summaryRes, routesRes, listRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM tickets t WHERE ${where}`, [
        businessId,
        ...params,
      ]),
      query(
        `SELECT
           COUNT(*)                          AS tickets,
           COUNT(DISTINCT t.passenger_name)  AS passengers,
           COALESCE(SUM(t.cost_price), 0)    AS total_cost,
           ${perTicket
             ? `COALESCE(SUM(t.airline_paid), 0) AS cost_paid,
                COALESCE(SUM(t.cost_price - t.airline_paid), 0) AS cost_unpaid,
                COUNT(*) FILTER (WHERE t.cost_price > t.airline_paid) AS unsettled`
             : `0::NUMERIC AS cost_paid, COALESCE(SUM(t.cost_price), 0) AS cost_unpaid,
                COUNT(*) AS unsettled`}
         FROM tickets t WHERE ${where}`,
        [businessId, ...params],
      ),
      query(
        `SELECT
           t.from_city, t.to_city,
           t.from_city || ' → ' || t.to_city   AS route,
           COUNT(*)                            AS tickets,
           COALESCE(SUM(t.cost_price), 0)      AS cost
         FROM tickets t WHERE ${where}
         GROUP BY t.from_city, t.to_city
         ORDER BY tickets DESC LIMIT 15`,
        [businessId, ...params],
      ),
      query(
        `SELECT
           t.id, t.passenger_name, t.contact_number, t.passport_number,
           t.ticket_type, t.trip_type, t.status,
           t.from_city, t.to_city, t.flight_date, t.return_date,
           t.ticket_reference, t.cost_price,
           ${settleCols}
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
          tickets: 0, passengers: 0, total_cost: 0,
          cost_paid: 0, cost_unpaid: 0, unsettled: 0,
          per_ticket_settlement: perTicket,
        },
        account: null,
        routes: [],
        passengers: [],
        meta: { page: 1, limit: parseInt(limit), total: 0, totalPages: 0 },
      });
    }

    const s = summaryRes.rows[0];

    // All-time account for this carrier, so the Pay button has a balance
    let account = null;
    if (await accountTableExists()) {
      const accRes = await query(
        `SELECT airline_id, total_cost, total_paid, balance
         FROM v_airline_account
         WHERE business_id = $1 AND LOWER(airline_name) = LOWER($2)`,
        [businessId, airlineName],
      );
      if (accRes.rows.length > 0) {
        account = {
          airline_id: accRes.rows[0].airline_id,
          total_cost: round2(accRes.rows[0].total_cost),
          total_paid: round2(accRes.rows[0].total_paid),
          balance: round2(accRes.rows[0].balance),
        };
      }
    }

    return response.success(res, {
      airline_name: airlineName,
      summary: {
        tickets: parseInt(s.tickets),
        passengers: parseInt(s.passengers),
        total_cost: round2(s.total_cost),
        cost_paid: round2(s.cost_paid),
        cost_unpaid: round2(s.cost_unpaid),
        unsettled: parseInt(s.unsettled),
        per_ticket_settlement: perTicket,
      },
      account,
      routes: routesRes.rows.map((r) => ({
        route: r.route,
        from_city: r.from_city,
        to_city: r.to_city,
        tickets: parseInt(r.tickets),
        cost: round2(r.cost),
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
           COALESCE(SUM(t.cost_price), 0) AS total_cost
         FROM tickets t WHERE ${where}`,
        [businessId, ...params],
      ),
      query(
        `SELECT t.passenger_name, t.contact_number, t.from_city, t.to_city,
                t.flight_date, t.return_date, t.trip_type, t.ticket_type,
                t.ticket_reference, t.cost_price, u.name AS agent_name
         FROM tickets t
         LEFT JOIN users u ON u.id = t.created_by
         WHERE ${where}
         ORDER BY t.flight_date DESC`,
        [businessId, ...params],
      ),
      query(
        `SELECT t.from_city || ' → ' || t.to_city AS route,
                COUNT(*) AS tickets,
                COALESCE(SUM(t.cost_price), 0) AS cost
         FROM tickets t WHERE ${where}
         GROUP BY 1 ORDER BY tickets DESC LIMIT 15`,
        [businessId, ...params],
      ),
    ]);

    let account = null;
    if (await accountTableExists()) {
      const accRes = await query(
        `SELECT total_cost, total_paid, balance FROM v_airline_account
         WHERE business_id = $1 AND LOWER(airline_name) = LOWER($2)`,
        [businessId, airlineName],
      );
      account = accRes.rows[0] || null;
    }

    generateAirlinePDF(
      res,
      {
        airline_name: airlineName,
        summary: summaryRes.rows[0],
        account,
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

// ─── Payables: what the agency owes each carrier ─────────────────────────────

const accountTableExists = () => hasTable("airline_payments");

const PAYABLES_MIGRATION_MSG =
  "Airline payments need a database update. Run migration_v8.sql.";

/**
 * GET /api/airlines/payables
 * Running account per carrier: cost owed, settled, balance.
 */
const getPayables = async (req, res, next) => {
  try {
    if (!(await accountTableExists()))
      return response.error(res, PAYABLES_MIGRATION_MSG, 503);

    const { only_due } = req.query;
    const having = only_due === "true" || only_due === "1" ? "WHERE balance > 0" : "";

    const [rowsRes, totalsRes] = await Promise.all([
      query(
        `SELECT * FROM v_airline_account
         WHERE business_id = $1 ${having ? "AND balance > 0" : ""}
         ORDER BY balance DESC, airline_name`,
        [req.businessId],
      ),
      query(
        `SELECT
           COALESCE(SUM(total_cost), 0)  AS total_cost,
           COALESCE(SUM(total_paid), 0)  AS total_paid,
           COALESCE(SUM(balance), 0)     AS total_balance,
           COUNT(*) FILTER (WHERE balance > 0) AS airlines_owing
         FROM v_airline_account WHERE business_id = $1`,
        [req.businessId],
      ),
    ]);

    const t = totalsRes.rows[0];
    return response.success(res, {
      airlines: rowsRes.rows.map((r) => ({
        ...r,
        ticket_count: parseInt(r.ticket_count),
        total_cost: round2(r.total_cost),
        total_paid: round2(r.total_paid),
        balance: round2(r.balance),
      })),
      totals: {
        total_cost: round2(t.total_cost),
        total_paid: round2(t.total_paid),
        total_balance: round2(t.total_balance),
        airlines_owing: parseInt(t.airlines_owing),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/airlines/:id/payments   { amount, method, reference, note }
 * Settle any amount against a carrier. Omit amount to clear the balance.
 */
const payAirline = async (req, res, next) => {
  try {
    if (!(await accountTableExists()))
      return response.error(res, PAYABLES_MIGRATION_MSG, 503);

    const acc = await query(
      `SELECT airline_name, balance FROM v_airline_account
       WHERE airline_id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (acc.rows.length === 0)
      return response.notFound(res, "Airline not found");

    const balance = round2(acc.rows[0].balance);
    // No amount given means "settle the whole balance"
    const amount =
      req.body.amount === undefined || req.body.amount === null || req.body.amount === ""
        ? balance
        : round2(req.body.amount);

    if (!(amount > 0))
      return response.error(res, "Amount must be greater than 0", 400);
    if (balance <= 0)
      return response.error(
        res,
        `Nothing outstanding for ${acc.rows[0].airline_name}.`,
        400,
      );
    if (amount > balance + 0.001)
      return response.error(
        res,
        `Amount exceeds the outstanding balance ($${balance.toFixed(2)}).`,
        400,
      );

    // Spread the payment over the oldest unsettled tickets, so the account
    // balance and the per-passenger balances can never disagree.
    const result = await withTransaction(async (client) => {
      const perTicket = await hasColumn("tickets", "airline_paid");
      const rows = [];
      let remaining = amount;

      if (perTicket) {
        const open = await client.query(
          `SELECT id, cost_price, airline_paid
           FROM tickets
           WHERE business_id = $1 AND airline_id = $2 AND status <> 'cancelled'
             AND cost_price > airline_paid
           ORDER BY created_at`,
          [req.businessId, req.params.id],
        );

        for (const t of open.rows) {
          if (remaining <= 0.001) break;
          const owed = round2(Number(t.cost_price) - Number(t.airline_paid));
          const take = Math.min(remaining, owed);
          if (take <= 0) continue;

          await client.query(
            `UPDATE tickets SET airline_paid = airline_paid + $1 WHERE id = $2`,
            [take, t.id],
          );
          const ins = await client.query(
            `INSERT INTO airline_payments
               (business_id, airline_id, ticket_id, paid_by, amount, method, reference, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [
              req.businessId, req.params.id, t.id, req.user.id, take,
              req.body.method || "cash", req.body.reference || null,
              req.body.note || null,
            ],
          );
          rows.push(ins.rows[0]);
          remaining = round2(remaining - take);
        }
      }

      // Anything left over (or the pre-v9 case) is recorded unallocated
      if (remaining > 0.001 || rows.length === 0) {
        const ins = await client.query(
          `INSERT INTO airline_payments
             (business_id, airline_id, paid_by, amount, method, reference, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            req.businessId, req.params.id, req.user.id,
            rows.length === 0 ? amount : remaining,
            req.body.method || "cash", req.body.reference || null,
            req.body.note || null,
          ],
        );
        rows.push(ins.rows[0]);
      }
      return rows;
    });

    const after = await query(
      `SELECT balance FROM v_airline_account WHERE airline_id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );

    return response.created(
      res,
      {
        payments: result,
        tickets_settled: result.filter((r) => r.ticket_id).length,
        balance: round2(after.rows[0].balance),
      },
      `Paid $${amount.toFixed(2)} to ${acc.rows[0].airline_name}`,
    );
  } catch (err) {
    next(err);
  }
};

/** GET /api/airlines/:id/payments — settlement history */
const getAirlinePayments = async (req, res, next) => {
  try {
    if (!(await accountTableExists())) return response.success(res, []);
    const r = await query(
      `SELECT p.*, u.name AS paid_by_name
       FROM airline_payments p
       JOIN users u ON u.id = p.paid_by
       WHERE p.airline_id = $1 AND p.business_id = $2
       ORDER BY p.created_at DESC`,
      [req.params.id, req.businessId],
    );
    return response.success(res, r.rows);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/airlines/tickets/pay   { ticket_ids: [...], method, reference, note }
 *
 * Settle the airline cost of specific passengers. Each ticket gets its own
 * payment row, so the account balance and the per-ticket balances stay equal.
 */
const payTickets = async (req, res, next) => {
  try {
    if (!(await accountTableExists()))
      return response.error(res, PAYABLES_MIGRATION_MSG, 503);
    if (!(await hasColumn("tickets", "airline_paid"))) {
      return response.error(
        res,
        "Paying individual passengers needs a database update. Run migration_v9.sql.",
        503,
      );
    }

    const ids = Array.isArray(req.body.ticket_ids)
      ? req.body.ticket_ids.filter(Boolean)
      : [];
    if (ids.length === 0)
      return response.error(res, "Select at least one passenger", 400);

    const open = await query(
      `SELECT id, passenger_name, airline_id, cost_price, airline_paid
       FROM tickets
       WHERE business_id = $1 AND id = ANY($2::uuid[]) AND status <> 'cancelled'`,
      [req.businessId, ids],
    );
    if (open.rows.length === 0)
      return response.notFound(res, "No matching tickets found");

    const payable = open.rows.filter(
      (t) => t.airline_id && Number(t.cost_price) - Number(t.airline_paid) > 0.001,
    );
    if (payable.length === 0)
      return response.error(
        res,
        "Those passengers are already settled with the airline.",
        400,
      );

    // A single amount, when given, is split across the chosen passengers
    const requested =
      req.body.amount === undefined || req.body.amount === null || req.body.amount === ""
        ? null
        : round2(req.body.amount);
    const totalOwed = round2(
      payable.reduce(
        (a, t) => a + (Number(t.cost_price) - Number(t.airline_paid)),
        0,
      ),
    );
    if (requested !== null && requested > totalOwed + 0.001) {
      return response.error(
        res,
        `Amount exceeds what those passengers owe ($${totalOwed.toFixed(2)}).`,
        400,
      );
    }

    const result = await withTransaction(async (client) => {
      let remaining = requested === null ? totalOwed : requested;
      const rows = [];

      for (const t of payable) {
        if (remaining <= 0.001) break;
        const owed = round2(Number(t.cost_price) - Number(t.airline_paid));
        const take = round2(Math.min(remaining, owed));
        if (take <= 0) continue;

        await client.query(
          `UPDATE tickets SET airline_paid = airline_paid + $1 WHERE id = $2`,
          [take, t.id],
        );
        const ins = await client.query(
          `INSERT INTO airline_payments
             (business_id, airline_id, ticket_id, paid_by, amount, method, reference, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            req.businessId, t.airline_id, t.id, req.user.id, take,
            req.body.method || "cash", req.body.reference || null,
            req.body.note || `Settled ${t.passenger_name}`,
          ],
        );
        rows.push({ ...ins.rows[0], passenger_name: t.passenger_name });
        remaining = round2(remaining - take);
      }
      return rows;
    });

    const paid = round2(result.reduce((a, r) => a + Number(r.amount), 0));
    return response.created(
      res,
      { payments: result, tickets_settled: result.length, total_paid: paid },
      `Paid $${paid.toFixed(2)} for ${result.length} passenger${result.length === 1 ? "" : "s"}`,
    );
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/airlines/payments/:paymentId — undo a mistaken settlement */
const deleteAirlinePayment = async (req, res, next) => {
  try {
    if (!(await accountTableExists()))
      return response.error(res, PAYABLES_MIGRATION_MSG, 503);
    const reversed = await withTransaction(async (client) => {
      const r = await client.query(
        `DELETE FROM airline_payments WHERE id = $1 AND business_id = $2
         RETURNING id, ticket_id, amount`,
        [req.params.paymentId, req.businessId],
      );
      if (r.rows.length === 0) return null;

      // Put the money back on the ticket it was allocated to
      const row = r.rows[0];
      if (row.ticket_id && (await hasColumn("tickets", "airline_paid"))) {
        await client.query(
          `UPDATE tickets
           SET airline_paid = GREATEST(airline_paid - $1, 0)
           WHERE id = $2 AND business_id = $3`,
          [row.amount, row.ticket_id, req.businessId],
        );
      }
      return row;
    });

    if (!reversed) return response.notFound(res, "Payment not found");
    return response.success(res, null, "Payment reversed");
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
  getPayables,
  payAirline,
  payTickets,
  getAirlinePayments,
  deleteAirlinePayment,
};
