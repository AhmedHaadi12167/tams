const { body, validationResult } = require("express-validator");
const { query, withTransaction } = require("../config/db");
const response = require("../utils/response");
const { extractTicketData } = require("../services/aiExtraction");
const { cleanName } = require("../services/nameClean");
const {
  resolveAirline,
  findAirlineMatch,
  knownAirlineNames,
} = require("../services/airlineService");
const { hasColumn } = require("../services/schemaInfo");
const { resolveAgent } = require("../services/agentService");
const { phoneMatches } = require("../services/phoneMatch");
const { resolveAccount, requireAccount } = require("../services/accountResolver");
const { uuidOrThrow } = require("../utils/sqlSafe");
const {
  createGroupedTickets,
  normalisePassengers,
} = require("../services/groupTicketBooking");
const { resolveOrCreateCustomer } = require("../services/customerLink");

// Compute payment status from amounts
const calcPaymentStatus = (amountPaid, sellingPrice) => {
  const paid = parseFloat(amountPaid) || 0;
  const total = parseFloat(sellingPrice) || 0;
  if (paid <= 0) return "unpaid";
  if (paid >= total) return "paid";
  return "partial";
};

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** "" and "   " both mean "not supplied" for an optional column. */
const nullIfBlank = (v) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

const ticketValidation = [
  body("ticket_type")
    .isIn(["LOCAL", "INTERNATIONAL"])
    .withMessage("ticket_type must be LOCAL or INTERNATIONAL"),
  // Optional. A booking is often taken over the phone with the document
  // details following later, and blocking the sale until then just teaches
  // staff to type something false into the box.
  body("passport_number").optional({ nullable: true }).trim(),
  // Required only when the booking is for one passenger. A group booking
  // sends passengers[] instead, and demanding a top-level name as well would
  // mean the form had to send the first passenger twice.
  body("passenger_name").custom((value, { req }) => {
    const list = req.body?.passengers;
    if (Array.isArray(list) && list.length > 0) return true;
    if (!String(value ?? "").trim())
      throw new Error("Passenger name is required");
    return true;
  }),
  body("passengers")
    .optional()
    .isArray()
    .withMessage("passengers must be a list"),
  body("passengers.*.passenger_name")
    .optional()
    .trim(),
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
      passport_number,
      nationality,
      date_of_birth,
      passport_expiry_date,
      visa_type,
      visa_expiry_date,
    } = req.body;

    const paid = parseFloat(amount_paid) || 0;
    const paymentStatus = calcPaymentStatus(paid, selling_price);
    const tripType = trip_type === "round_trip" ? "round_trip" : "one_way";
    const method = (payment_method || "cash").trim() || "cash";
    // Which account the money landed in. Resolved before the transaction so
    // a lookup failure can't leave a half-written booking behind.
    // Required only when money actually changed hands — a booking with
    // nothing paid yet has no movement to file.
    const accountId =
      paid > 0
        ? await requireAccount(req.body, businessId, null, "payment")
        : null;
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

    // Force uppercase on names, and drop any title in front of them. A
    // ticket printed "MR ABDIFATAH MOHAMED MOHAMUD" is the same man as the
    // customer already on file as "ABDIFATAH MOHAMED MOHAMUD"; stored with
    // the title he becomes a second customer, and his balance splits in two.
    const passenger_name = (
      cleanName(req.body.passenger_name) || ""
    ).toUpperCase().trim();

    // Resolve the typed airline to the agency's master row, so
    // "Star Airline" and "Star Airlines" don't become two carriers.
    const airline = await resolveAirline(req.body.airline_name, businessId);
    const airline_name = airline.name;

    // ── Group booking ──────────────────────────────────────────────────
    //
    // One document, one price, several travellers. Handed off whole rather
    // than woven into the single-ticket path below: that path is the one
    // every existing booking goes through, and the safest change to it is
    // none at all.
    const passengers = normalisePassengers(req.body.passengers);
    if (passengers.length > 0) {
      // Who owes the money. Named explicitly when the document has a
      // contact section, otherwise the person the booking is filed under.
      const contactId = await resolveOrCreateCustomer({
        businessId,
        customerId: booked_by_customer_id || customer_id || null,
        name: req.body.contact_name || passengers[0].passenger_name,
        phone: contact_number,
      });

      const result = await withTransaction((client) =>
        createGroupedTickets(client, {
          businessId,
          userId: req.user.id,
          passengers,
          contactId,
          flight: {
            ticket_type,
            from_city,
            to_city,
            flight_date,
            airline_name,
            ticket_reference: ticket_reference || null,
            contact_number: contact_number || null,
            source_file_url: source_file_url || null,
            trip_type: tripType,
            return_date: return_date || null,
          },
          totals: {
            base_price: base_price || 0,
            tax: tax || 0,
            surcharge: surcharge || 0,
            cost_price: cost_price || 0,
            selling_price: selling_price || 0,
            agent_commission: agent_commission || 0,
          },
          paid,
          method,
          accountId,
          agentId: commissionAgentId,
          airlineId: airline.id,
          groupType: req.body.group_type || "family",
          groupLabel: req.body.group_label || null,
          notes: req.body.notes || null,
        }),
      );

      const count = result.tickets.length;
      return response.created(
        res,
        { group: result.group, tickets: result.tickets, ticket: result.tickets[0] },
        count === 1
          ? "Ticket created successfully"
          : `${count} tickets created for this booking`,
      );
    }

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
          amount_paid, payment_status, booked_by_customer_id,
          passport_number, nationality, date_of_birth,
          passport_expiry_date, visa_type, visa_expiry_date
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
                  $24,$25,$26,$27,$28,$29)
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
          // Empty strings must become null: DATE columns reject "", and a
          // blank passport_number would satisfy the NOT NULL check while
          // meaning nothing.
          nullIfBlank(passport_number),
          nullIfBlank(nationality),
          nullIfBlank(date_of_birth),
          nullIfBlank(passport_expiry_date),
          nullIfBlank(visa_type),
          nullIfBlank(visa_expiry_date),
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
          `INSERT INTO ticket_payments (business_id, ticket_id, collected_by, amount, method, note, account_id)
           VALUES ($1, $2, $3, $4, $5, 'Initial payment at booking', $6)`,
          [businessId, result.rows[0].id, req.user.id, paid, method, accountId],
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
      passport_number,
      nationality,
      date_of_birth,
      passport_expiry_date,
      visa_type,
      visa_expiry_date,
    } = req.body;

    const tripType = trip_type === "round_trip" ? "round_trip" : "one_way";
    const paid = parseFloat(amount_paid) || 0;
    const paymentStatus = calcPaymentStatus(paid, selling_price);

    const airline = await resolveAirline(req.body.airline_name, req.businessId);
    const airline_name = airline.name;

    // What the customer had paid before this edit. Changing amount_paid
    // without writing a matching payment row would leave the ticket and the
    // ledger disagreeing — a drift that predates accounts but only becomes
    // visible now that balances are derived from the payment history.
    const priorPaid = (
      await query(
        `SELECT amount_paid FROM tickets WHERE id=$1 AND business_id=$2`,
        [req.params.id, req.businessId],
      )
    ).rows[0]?.amount_paid;

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
        booked_by_customer_id=COALESCE($20, booked_by_customer_id),
        passport_number=$23, nationality=$24, date_of_birth=$25,
        passport_expiry_date=$26, visa_type=$27, visa_expiry_date=$28
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
        nullIfBlank(passport_number),
        nullIfBlank(nationality),
        nullIfBlank(date_of_birth),
        nullIfBlank(passport_expiry_date),
        nullIfBlank(visa_type),
        nullIfBlank(visa_expiry_date),
      ],
    );

    if (result.rows.length === 0)
      return response.notFound(res, "Ticket not found");

    // Record the change in what has been paid as its own movement, so the
    // payment history still adds up to the ticket's amount_paid. A negative
    // delta is a correction or refund; both are real and both belong here.
    const paidDelta =
      Math.round((paid - (Number(priorPaid) || 0)) * 100) / 100;
    if (Math.abs(paidDelta) > 0.001) {
      await query(
        `INSERT INTO ticket_payments
           (business_id, ticket_id, collected_by, amount, method, note, account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          req.businessId,
          req.params.id,
          req.user.id,
          paidDelta,
          (req.body.payment_method || "cash").trim() || "cash",
          paidDelta > 0 ? "Further payment (edit)" : "Correction or refund (edit)",
          await requireAccount(req.body, req.businessId, null, "adjustment"),
        ],
      );
    }

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
        `INSERT INTO ticket_payments (business_id, ticket_id, collected_by, amount, method, note, account_id)
         VALUES ($1,$2,$3,$4,$5,$6, $7)`,
        [
          req.businessId,
          ticket.id,
          req.user.id,
          paid,
          method || "cash",
          note || null,
          await requireAccount(req.body, req.businessId, client, "payment"),
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
      `SELECT p.*, u.name AS collected_by_name, a.name AS account_name
       FROM ticket_payments p
       JOIN users u ON u.id = p.collected_by
       LEFT JOIN payment_accounts a ON a.id = p.account_id
       WHERE p.ticket_id = $1 AND p.business_id = $2
       ORDER BY p.created_at DESC`,
      [req.params.id, req.businessId],
    );
    return response.success(res, result.rows);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/tickets/:id/cancel
 *
 * Cancelling is up to three separate movements of money, and they are
 * independent:
 *
 *   refund_amount   goes back to the customer, out of an account
 *   the remainder   stays with the agency as the cancellation fee
 *   airline_refund  comes back from the airline, into an account
 *
 * Deleting the ticket instead would be simpler and quite wrong: the money
 * really did move, and a cancelled booking that vanishes takes its own
 * audit trail with it.
 */
const cancelTicket = async (req, res, next) => {
  try {
    const ticketRes = await query(
      `SELECT id, passenger_name, selling_price, amount_paid, cost_price,
              status, airline_id, tax
              ${(await hasColumn("tickets", "airline_paid")) ? ", airline_paid" : ""}
         FROM tickets WHERE id = $1 AND business_id = $2`,
      [uuidOrThrow(req.params.id, "ticket id"), req.businessId],
    );
    if (ticketRes.rows.length === 0)
      return response.notFound(res, "Ticket not found");

    const ticket = ticketRes.rows[0];
    if (ticket.status === "cancelled")
      return response.error(res, "This ticket is already cancelled", 400);

    const paid = round2(ticket.amount_paid);
    const airlinePaid = round2(ticket.airline_paid || 0);

    // Refunding nothing is valid — it means the agency keeps everything.
    const refund = round2(req.body.refund_amount);
    const airlineRefund = round2(req.body.airline_refund);

    if (refund < 0 || airlineRefund < 0)
      return response.error(res, "Refunds cannot be negative", 400);

    // The tax is not the agency's money to give back. It was collected on
    // the government's behalf and is owed whether or not anyone flies, so
    // it comes off what can be refunded. The exception is a flight the
    // airline cancels: the airline returns the tax with the fare, and the
    // agency passes it on owing nothing. That case has to be stated
    // explicitly, because doing it by accident means refunding money the
    // agency will still have to pay.
    const tax = round2(ticket.tax || 0);
    const taxReturnedByAirline =
      req.body.refund_tax === true || req.body.refund_tax === "true";
    const taxRefunded = taxReturnedByAirline ? tax : 0;
    const refundable = round2(Math.max(paid - (tax - taxRefunded), 0));

    if (refund > refundable + 0.001)
      return response.error(
        res,
        tax > 0 && !taxReturnedByAirline
          ? `You can't refund more than $${refundable.toFixed(2)}. The customer paid ` +
              `$${paid.toFixed(2)}, but $${tax.toFixed(2)} of it is government tax, ` +
              `which is not refundable. If the airline returned the tax as well, ` +
              `tick "the airline returned the tax" and the full amount can go back.`
          : `You can't refund more than the customer paid ($${paid.toFixed(2)})`,
        400,
      );
    if (airlineRefund > airlinePaid + 0.001)
      return response.error(
        res,
        `The airline can't return more than you paid them ($${airlinePaid.toFixed(2)})`,
        400,
      );

    // What the customer's payments now net to, after the refund.
    const kept = round2(paid - refund);

    // Some of what's kept isn't a fee. The refund is capped at the tax, so
    // the tax stays in the agency's hands whether it wants it or not, and
    // calling that a cancellation fee would book the government's money as
    // income. Only what's left over is actually earned.
    const taxRetained = taxReturnedByAirline ? 0 : round2(Math.min(tax, kept));
    const fee = round2(kept - taxRetained);

    // What the customer still owes on a journey that is not happening.
    // Chasing it is rarely worth anyone's time, so it can be written off
    // here — recorded, not quietly dropped, because a write-off is a real
    // loss and hiding it flatters the profit.
    const outstanding = round2(
      Math.max(Number(ticket.selling_price) - paid, 0),
    );
    const writeOff =
      req.body.write_off === true || req.body.write_off === "true"
        ? outstanding
        : 0;

    // Each leg is required only if that leg actually moves money. A
    // cancellation with no refund and no airline return moves nothing.
    const accountId =
      refund > 0.001
        ? await requireAccount(req.body, req.businessId, null, "refund")
        : null;
    const airlineAccountId =
      airlineRefund > 0.001
        ? await requireAccount(
            { account_id: req.body.airline_account_id || req.body.account_id },
            req.businessId,
            null,
            "airline refund",
          )
        : null;

    const result = await withTransaction(async (client) => {
      // 1. Money back to the customer, recorded as a negative payment so it
      //    sits in the same history as everything else they paid.
      if (refund > 0.001) {
        await client.query(
          `INSERT INTO ticket_payments
             (business_id, ticket_id, collected_by, amount, method, note, account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            req.businessId,
            ticket.id,
            req.user.id,
            -refund,
            (req.body.method || "cash").trim() || "cash",
            `Refund on cancellation${req.body.reason ? ` — ${req.body.reason}` : ""}`,
            accountId,
          ],
        );
      }

      // 2. Money back from the airline, as a negative airline payment.
      if (airlineRefund > 0.001 && ticket.airline_id) {
        await client.query(
          `INSERT INTO airline_payments
             (business_id, airline_id, ticket_id, paid_by, amount, method, reference, note, account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            req.businessId,
            ticket.airline_id,
            ticket.id,
            req.user.id,
            -airlineRefund,
            (req.body.method || "cash").trim() || "cash",
            req.body.reference || null,
            `Refund for cancelled ticket — ${ticket.passenger_name}`,
            airlineAccountId,
          ],
        );
      }

      // 3. The ticket itself. amount_paid becomes the fee retained, which is
      //    exactly what the customer's payments now net to.
      //
      //    The placeholders are numbered as the values are pushed rather
      //    than written out by hand. Two columns here are optional — they
      //    only exist once their migration has run — and hand-numbering a
      //    list that changes length is how $8 ends up meaning the business
      //    id in one branch and the ticket id in the other.
      const vals = [];
      const p = (v) => `$${vals.push(v)}`;

      // amount_paid becomes what the customer's payments net to, which
      // includes any tax being held. cancellation_fee is the earned part
      // only. $1 is both stored and compared, so it needs an explicit type —
      // Postgres cannot deduce one from two different uses.
      const keptParam = p(kept);
      const sets = [
        `status = 'cancelled'`,
        `amount_paid = ${keptParam}::NUMERIC`,
        `payment_status = CASE WHEN ${keptParam}::NUMERIC > 0 THEN 'paid'::payment_status
                               ELSE 'unpaid'::payment_status END`,
        `cancellation_fee = ${p(fee)}`,
        `written_off = ${p(writeOff)}`,
        `refunded_amount = ${p(refund)}`,
        `airline_refund = ${p(airlineRefund)}`,
        `cancelled_at = NOW()`,
        `cancel_reason = ${p(req.body.reason || null)}`,
        `cancelled_by = ${p(req.user.id)}`,
      ];
      if (await hasColumn("tickets", "airline_paid"))
        sets.push(`airline_paid = airline_paid - ${p(airlineRefund)}`);
      if (await hasColumn("tickets", "tax_refunded"))
        sets.push(`tax_refunded = ${p(taxRefunded)}`);

      const upd = await client.query(
        `UPDATE tickets SET ${sets.join(",\n                ")}
          WHERE id = ${p(ticket.id)} AND business_id = ${p(req.businessId)}
          RETURNING *`,
        vals,
      );

      return upd.rows[0];
    });

    const parts = [];
    if (refund > 0) parts.push(`$${refund.toFixed(2)} refunded`);
    if (fee > 0) parts.push(`$${fee.toFixed(2)} kept as a fee`);
    if (tax > 0)
      parts.push(
        taxRefunded > 0
          ? `$${tax.toFixed(2)} tax returned by the airline, so nothing is owed on it`
          : `$${tax.toFixed(2)} tax still owed to the government — not counted as a fee`,
      );
    if (writeOff > 0)
      parts.push(`$${writeOff.toFixed(2)} written off — the customer owes nothing`);

    return response.success(
      res,
      result,
      parts.length ? `Cancelled. ${parts.join(", ")}.` : "Ticket cancelled.",
    );
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
  cancelTicket,
  addPayment,
  getPayments,
};
