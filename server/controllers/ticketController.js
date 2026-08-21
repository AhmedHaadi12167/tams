const { body, validationResult } = require("express-validator");
const { query, withTransaction } = require("../config/db");
const response = require("../utils/response");
const { extractTicketData } = require("../services/aiExtraction");
const {
  resolveAirline,
  findAirlineMatch,
  knownAirlineNames,
} = require("../services/airlineService");
const { hasColumn } = require("../services/schemaInfo");
const { resolveAgent } = require("../services/agentService");
const { phoneMatches } = require("../services/phoneMatch");

// Compute payment status from amounts
const calcPaymentStatus = (amountPaid, sellingPrice) => {
  const paid = parseFloat(amountPaid) || 0;
  const total = parseFloat(sellingPrice) || 0;
  if (paid <= 0) return "unpaid";
  if (paid >= total) return "paid";
  return "partial";
};

const ticketValidation = [
  body("ticket_type")
    .isIn(["LOCAL", "INTERNATIONAL"])
    .withMessage("ticket_type must be LOCAL or INTERNATIONAL"),
  body("passenger_name")
    .trim()
    .notEmpty()
    .withMessage("Passenger name is required"),
  body("from_city").trim().notEmpty().withMessage("Departure city is required"),
  body("to_city").trim().notEmpty().withMessage("Destination city is required"),
  body("flight_date")
    .isISO8601()
    .withMessage("Valid flight date required (YYYY-MM-DD)"),
  body("airline_name")
    .trim()
    .notEmpty()
    .withMessage("Airline name is required"),
  body("cost_price")
    .isFloat({ min: 0 })
    .withMessage("Cost price must be a positive number"),
  body("selling_price")
    .isFloat({ min: 0 })
    .withMessage("Selling price must be a positive number"),
  body("trip_type")
    .optional()
    .isIn(["one_way", "round_trip"])
    .withMessage("trip_type must be one_way or round_trip"),
  body("return_date")
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage("Valid return date required (YYYY-MM-DD)"),
  body("agent_commission")
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage("Commission must be a positive number"),
  body("amount_paid")
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage("Amount paid must be a positive number"),
];

/**
 * POST /api/tickets/extract
 */
const extractFromFile = async (req, res, next) => {
  try {
    if (!req.file) return response.error(res, "No file uploaded", 400);

    // Show the model the carriers this agency already uses, so it returns
    // the registered spelling rather than whatever the PDF happens to print.
    const known = await knownAirlineNames(req.businessId);

    const extracted = await extractTicketData(
      req.file.path,
      req.file.mimetype,
      known,
    );

    // Snap the result to the registry now, not silently at save time, so the
    // agent can see whether this is a known carrier before creating anything.
    const match = await findAirlineMatch(extracted.airline_name, req.businessId);
    if (match.matched) extracted.airline_name = match.name;

    return response.success(
      res,
      {
        extracted,
        source_file_url: req.file.filename,
        airline_match: {
          matched: match.matched,
          via: match.via,
          airline_id: match.airline?.id || null,
          suggestions: match.suggestions,
          registry_ready: known.length > 0,
        },
      },
      "Data extracted successfully",
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/tickets
 */
const createTicket = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const businessId = req.businessId;
    const {
      ticket_type,
      contact_number,
      from_city,
      to_city,
      flight_date,
      ticket_reference,
      cost_price,
      selling_price,
      base_price,
      tax,
      surcharge,
      source_file_url,
      customer_id,
      trip_type,
      return_date,
      agent_commission,
      amount_paid,
      payment_method,
      booked_by_customer_id,
    } = req.body;

    const paid = parseFloat(amount_paid) || 0;
    const paymentStatus = calcPaymentStatus(paid, selling_price);
    const tripType = trip_type === "round_trip" ? "round_trip" : "one_way";
    const method = (payment_method || "cash").trim() || "cash";
    // Commission agent — created inline from the name/phone typed on the
    // booking form, so nobody has to visit the Agents page first.
    let commissionAgentId = null;
    if (
      (parseFloat(agent_commission) || 0) > 0 &&
      (await hasColumn("tickets", "agent_id"))
    ) {
      const agent = await resolveAgent(req.body, businessId);
      commissionAgentId = agent.id;
    }

    // Force uppercase on names
    const passenger_name = req.body.passenger_name?.toUpperCase().trim();

    // Resolve the typed airline to the agency's master row, so
    // "Star Airline" and "Star Airlines" don't become two carriers.
    const airline = await resolveAirline(req.body.airline_name, businessId);
    const airline_name = airline.name;

    // ── Duplicate check ──────────────────────────────────────
    const duplicate = await query(
      `SELECT id FROM tickets
       WHERE business_id = $1
         AND LOWER(passenger_name) = LOWER($2)
         AND flight_date = $3
         AND LOWER(airline_name) = LOWER($4)
         AND LOWER(from_city) = LOWER($5)
         AND LOWER(to_city) = LOWER($6)
         AND status != 'cancelled'
       LIMIT 1`,
      [
        businessId,
        passenger_name,
        flight_date,
        airline_name,
        from_city,
        to_city,
      ],
    );

    if (duplicate.rows.length > 0) {
      return response.error(
        res,
        `Duplicate ticket! A ticket for "${passenger_name}" on ${airline_name} (${from_city} → ${to_city}) on ${flight_date} already exists.`,
        409,
      );
    }

    // Upsert customer — phone number wins: if a customer already has this
    // phone, the ticket goes to that customer (no duplicates)
    let finalCustomerId = customer_id || null;
    if (!finalCustomerId && contact_number) {
      // Match on the national number, so '0612345678' and '+252 61 234 5678'
      // land on the same customer instead of creating a second record.
      const digits = String(contact_number).replace(/[^0-9]/g, "");
      const byPhone = digits
        ? await query(
            `SELECT id FROM customers
             WHERE business_id = $1 AND ${phoneMatches("phone", 2)} LIMIT 1`,
            [businessId, digits],
          )
        : { rows: [] };
      if (byPhone.rows.length > 0) finalCustomerId = byPhone.rows[0].id;
    }
    if (!finalCustomerId && passenger_name) {
      const existing = await query(
        `SELECT id FROM customers WHERE business_id = $1 AND name ILIKE $2 LIMIT 1`,
        [businessId, passenger_name],
      );
      if (existing.rows.length > 0) {
        finalCustomerId = existing.rows[0].id;
      } else {
        const newCustomer = await query(
          `INSERT INTO customers (business_id, name, phone) VALUES ($1, $2, $3) RETURNING id`,
          [businessId, passenger_name, contact_number || null],
        );
        finalCustomerId = newCustomer.rows[0].id;
      }
    }

    const ticket = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO tickets (
          business_id, customer_id, created_by, ticket_type,
          passenger_name, contact_number, from_city, to_city,
          flight_date, airline_name, ticket_reference,
          cost_price, selling_price,
          base_price, tax, surcharge,
          source_file_url,
          trip_type, return_date, agent_commission,
          amount_paid, payment_status, booked_by_customer_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        RETURNING *`,
        [
          businessId,
          finalCustomerId,
          req.user.id,
          ticket_type,
          passenger_name,
          contact_number || null,
          from_city,
          to_city,
          flight_date,
          airline_name,
          ticket_reference || null,
          cost_price,
          selling_price,
          base_price || null,
          tax || null,
          surcharge || null,
          source_file_url || null,
          tripType,
          tripType === "round_trip" ? return_date || null : null,
          parseFloat(agent_commission) || 0,
          paid,
          paymentStatus,
          booked_by_customer_id || null,
        ],
      );

      // Link to the airline master row. Separate statement so the insert
      // above still works before migration_v5 adds the column.
      if (airline.id) {
        await client.query(`UPDATE tickets SET airline_id = $1 WHERE id = $2`, [
          airline.id,
          result.rows[0].id,
        ]);
        result.rows[0].airline_id = airline.id;
      }

      // Commission agent — column arrives with migration_v8
      if (commissionAgentId) {
        await client.query(`UPDATE tickets SET agent_id = $1 WHERE id = $2`, [
          commissionAgentId,
          result.rows[0].id,
        ]);
        result.rows[0].agent_id = commissionAgentId;
      }

      // Log the initial collection so the payment history is complete
      if (paid > 0) {
        await client.query(
          `INSERT INTO ticket_payments (business_id, ticket_id, collected_by, amount, method, note)
           VALUES ($1, $2, $3, $4, $5, 'Initial payment at booking')`,
          [businessId, result.rows[0].id, req.user.id, paid, method],
        );
      }

      return result.rows[0];
    });

    return response.created(res, ticket, "Ticket created successfully");
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/tickets
 */
const getTickets = async (req, res, next) => {
  try {
    const businessId = req.businessId;
    const {
      page = 1,
      limit = 20,
      search = "",
      ticket_type,
      status,
      payment_status,
      from_date,
      to_date,
      agent_id,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [businessId];
    const conditions = ["t.business_id = $1"];
    let pi = 2;

    if (search) {
      // Text search across passenger, reference and route.
      const textMatch = `(t.passenger_name ILIKE $${pi} OR t.ticket_reference ILIKE $${pi} OR t.from_city ILIKE $${pi} OR t.to_city ILIKE $${pi})`;
      params.push(`%${search}%`);
      pi++;

      // Phone search. The same person is written as '+252 61 234 5678',
      // '252612345678' and '0612345678' — as digit strings none of those
      // contains the others, so a plain substring match misses. Comparing
      // the last nine digits ignores the country code and the trunk zero,
      // while the substring test still supports partial numbers.
      const digits = String(search).replace(/[^0-9]/g, "");
      if (digits.length >= 3) {
        const phoneMatch = `(${phoneMatches("t.contact_number", pi)}
          OR EXISTS (
            SELECT 1 FROM customers pc
            WHERE pc.business_id = t.business_id
              AND (pc.id = t.customer_id OR pc.id = t.booked_by_customer_id)
              AND ${phoneMatches("pc.phone", pi)}
          )
        )`;
        params.push(digits);
        pi++;
        conditions.push(`(${textMatch} OR ${phoneMatch})`);
      } else {
        conditions.push(textMatch);
      }
    }
    if (ticket_type) {
      conditions.push(`t.ticket_type = $${pi}`);
      params.push(ticket_type);
      pi++;
    }
    if (status) {
      conditions.push(`t.status = $${pi}`);
      params.push(status);
      pi++;
    }
    if (payment_status) {
      conditions.push(`t.payment_status = $${pi}`);
      params.push(payment_status);
      pi++;
    }
    if (from_date) {
      conditions.push(`t.flight_date >= $${pi}`);
      params.push(from_date);
      pi++;
    }
    if (to_date) {
      conditions.push(`t.flight_date <= $${pi}`);
      params.push(to_date);
      pi++;
    }
    // If agent, only show their own tickets
    if (req.user.role === "agent") {
      conditions.push(`t.created_by = $${pi}`);
      params.push(req.user.id);
      pi++;
    } else if (agent_id) {
      conditions.push(`t.created_by = $${pi}`);
      params.push(agent_id);
      pi++;
    }

    const where = conditions.join(" AND ");

    // The commission agent's details only exist after migration v8
    const withAgents = await hasColumn("tickets", "agent_id");
    const agentCols = withAgents
      ? ", ag.name AS agent_name_commission, ag.phone AS agent_phone"
      : "";
    const agentJoin = withAgents ? " LEFT JOIN agents ag ON ag.id = t.agent_id" : "";

    const countResult = await query(
      `SELECT COUNT(*) FROM tickets t WHERE ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count);

    const dataResult = await query(
      `SELECT t.*, u.name AS agent_name,
              COALESCE(t.contact_number, c.phone) AS display_phone,
              c.phone AS customer_phone${agentCols}
       FROM tickets t
       LEFT JOIN users u     ON u.id = t.created_by
       LEFT JOIN customers c ON c.id = t.customer_id${agentJoin}
       WHERE ${where} ORDER BY t.created_at DESC
       LIMIT $${pi} OFFSET $${pi + 1}`,
      [...params, parseInt(limit), offset],
    );

    return response.paginated(res, dataResult.rows, page, limit, total);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/tickets/manifest?when=tomorrow|today|date&date=YYYY-MM-DD
 *
 * Who is flying, and how to reach them. Departures only — a return leg
 * on the same date is a different journey and would double-count the
 * passenger on the call list.
 */
const getManifest = async (req, res, next) => {
  try {
    const { when = "tomorrow", date, include_returns } = req.query;

    let target;
    if (when === "today") target = "CURRENT_DATE";
    else if (when === "tomorrow") target = "CURRENT_DATE + 1";
    else target = null;

    const params = [req.businessId];
    let pi = 2;
    let dateClause;

    if (target) {
      dateClause = `t.flight_date = ${target}`;
    } else {
      if (!date) return response.error(res, "A date is required", 400);
      dateClause = `t.flight_date = $${pi}`;
      params.push(date);
      pi++;
    }

    // Optionally also list people whose RETURN leg is that day
    let returnClause = "";
    if (include_returns === "true" || include_returns === "1") {
      returnClause = target
        ? ` OR t.return_date = ${target}`
        : ` OR t.return_date = $${pi - 1}`;
    }

    const conditions = [
      "t.business_id = $1",
      "t.status <> 'cancelled'",
      `(${dateClause}${returnClause})`,
    ];
    if (req.user.role === "agent") {
      conditions.push(`t.created_by = $${pi}`);
      params.push(req.user.id);
      pi++;
    }

    const where = conditions.join(" AND ");

    const [rowsRes, summaryRes] = await Promise.all([
      query(
        `SELECT t.id, t.passenger_name, t.ticket_type, t.trip_type,
                t.from_city, t.to_city, t.flight_date, t.return_date,
                t.airline_name, t.ticket_reference, t.passport_number,
                t.selling_price, t.amount_paid,
                (t.selling_price - t.amount_paid) AS balance,
                t.payment_status,
                COALESCE(NULLIF(TRIM(t.contact_number), ''), c.phone) AS phone,
                u.name AS booked_by
         FROM tickets t
         LEFT JOIN customers c ON c.id = t.customer_id
         LEFT JOIN users u     ON u.id = t.created_by
         WHERE ${where}
         ORDER BY t.airline_name, t.flight_date, t.passenger_name`,
        params,
      ),
      query(
        `SELECT COUNT(*) AS passengers,
                COUNT(DISTINCT t.airline_name) AS airlines,
                COUNT(*) FILTER (WHERE t.payment_status <> 'paid') AS unpaid,
                COALESCE(SUM(t.selling_price - t.amount_paid), 0) AS balance_due,
                COUNT(*) FILTER (WHERE COALESCE(NULLIF(TRIM(t.contact_number), ''),
                                 (SELECT phone FROM customers c2 WHERE c2.id = t.customer_id)) IS NULL)
                  AS missing_phone
         FROM tickets t WHERE ${where}`,
        params,
      ),
    ]);

    const s = summaryRes.rows[0];
    return response.success(res, {
      when,
      flight_date:
        when === "date" ? date : null,
      passengers: rowsRes.rows,
      summary: {
        passengers: parseInt(s.passengers),
        airlines: parseInt(s.airlines),
        unpaid: parseInt(s.unpaid),
        balance_due: Math.round(Number(s.balance_due) * 100) / 100,
        missing_phone: parseInt(s.missing_phone),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/tickets/:id
 */
const getTicket = async (req, res, next) => {
  try {
    const withAgents = await hasColumn("tickets", "agent_id");
    const result = await query(
      `SELECT t.*, u.name AS agent_name${
        withAgents ? ", ag.name AS agent_name_commission, ag.phone AS agent_phone" : ""
      }
       FROM tickets t
       LEFT JOIN users u ON u.id = t.created_by${
         withAgents ? " LEFT JOIN agents ag ON ag.id = t.agent_id" : ""
       }
       WHERE t.id = $1 AND t.business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Ticket not found");
    return response.success(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/tickets/:id
 */
const updateTicket = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const {
      ticket_type,
      passenger_name,
      contact_number,
      from_city,
      to_city,
      flight_date,
      ticket_reference,
      cost_price,
      selling_price,
      base_price,
      tax,
      surcharge,
      status,
      trip_type,
      return_date,
      agent_commission,
      amount_paid,
      booked_by_customer_id,
    } = req.body;

    const tripType = trip_type === "round_trip" ? "round_trip" : "one_way";
    const paid = parseFloat(amount_paid) || 0;
    const paymentStatus = calcPaymentStatus(paid, selling_price);

    const airline = await resolveAirline(req.body.airline_name, req.businessId);
    const airline_name = airline.name;

    const result = await query(
      `UPDATE tickets SET
        ticket_type=$1, passenger_name=$2, contact_number=$3,
        from_city=$4, to_city=$5, flight_date=$6,
        airline_name=$7, ticket_reference=$8,
        cost_price=$9, selling_price=$10,
        base_price=$11, tax=$12, surcharge=$13,
        status=COALESCE($14::ticket_status, status),
        trip_type=$15, return_date=$16,
        agent_commission=$17,
        amount_paid=$18, payment_status=$19,
        booked_by_customer_id=COALESCE($20, booked_by_customer_id)
       WHERE id=$21 AND business_id=$22 RETURNING *`,
      [
        ticket_type,
        passenger_name,
        contact_number || null,
        from_city,
        to_city,
        flight_date,
        airline_name,
        ticket_reference || null,
        cost_price,
        selling_price,
        base_price || null,
        tax || null,
        surcharge || null,
        status || null,
        tripType,
        tripType === "round_trip" ? return_date || null : null,
        parseFloat(agent_commission) || 0,
        paid,
        paymentStatus,
        booked_by_customer_id || null,
        req.params.id,
        req.businessId,
      ],
    );

    if (result.rows.length === 0)
      return response.notFound(res, "Ticket not found");

    if (airline.id) {
      await query(`UPDATE tickets SET airline_id = $1 WHERE id = $2`, [
        airline.id,
        req.params.id,
      ]);
      result.rows[0].airline_id = airline.id;
    }

    if (await hasColumn("tickets", "agent_id")) {
      const wantsCommission = (parseFloat(agent_commission) || 0) > 0;
      const agent = wantsCommission
        ? await resolveAgent(req.body, req.businessId)
        : { id: null };
      await query(
        `UPDATE tickets SET agent_id = $1 WHERE id = $2 AND business_id = $3`,
        [agent.id, req.params.id, req.businessId],
      );
      result.rows[0].agent_id = agent.id;
    }

    return response.success(res, result.rows[0], "Ticket updated successfully");
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/tickets/:id
 */
const deleteTicket = async (req, res, next) => {
  try {
    const result = await query(
      `DELETE FROM tickets WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.id, req.businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Ticket not found");
    return response.success(res, null, "Ticket deleted successfully");
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/tickets/:id/payments
 * Any authenticated user (admin, agent, accountant) can collect money.
 */
const addPayment = async (req, res, next) => {
  try {
    const { amount, method, note } = req.body;
    const paid = parseFloat(amount);
    if (!paid || paid <= 0)
      return response.error(res, "Amount must be greater than 0", 400);

    const ticketRes = await query(
      `SELECT id, selling_price, amount_paid FROM tickets
       WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (ticketRes.rows.length === 0)
      return response.notFound(res, "Ticket not found");

    const ticket = ticketRes.rows[0];
    const balance =
      parseFloat(ticket.selling_price) - parseFloat(ticket.amount_paid);
    if (paid > balance + 0.001)
      return response.error(
        res,
        `Amount exceeds the remaining balance ($${balance.toFixed(2)})`,
        400,
      );

    const updated = await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO ticket_payments (business_id, ticket_id, collected_by, amount, method, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          req.businessId,
          ticket.id,
          req.user.id,
          paid,
          method || "cash",
          note || null,
        ],
      );
      const newPaid = parseFloat(ticket.amount_paid) + paid;
      const result = await client.query(
        `UPDATE tickets SET amount_paid = $1, payment_status = $2
         WHERE id = $3 RETURNING *`,
        [
          newPaid,
          calcPaymentStatus(newPaid, ticket.selling_price),
          ticket.id,
        ],
      );
      return result.rows[0];
    });

    return response.created(res, updated, "Payment collected successfully");
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/tickets/:id/payments
 */
const getPayments = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT p.*, u.name AS collected_by_name
       FROM ticket_payments p
       JOIN users u ON u.id = p.collected_by
       WHERE p.ticket_id = $1 AND p.business_id = $2
       ORDER BY p.created_at DESC`,
      [req.params.id, req.businessId],
    );
    return response.success(res, result.rows);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  extractFromFile,
  createTicket,
  ticketValidation,
  getTickets,
  getManifest,
  getTicket,
  updateTicket,
  deleteTicket,
  addPayment,
  getPayments,
};
