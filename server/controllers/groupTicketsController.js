/**
 * groupBookings.controller.js
 *
 * Handles group ticket bookings (family groups & company employees).
 * Each "group" creates one booking_groups record + N ticket records.
 *
 * Routes expected:
 *   POST   /api/group-bookings
 *   GET    /api/group-bookings
 *   GET    /api/group-bookings/:id          — full statement
 *   PUT    /api/group-bookings/:id          — update group meta
 *   DELETE /api/group-bookings/:id          — deletes group + its tickets
 */

const { body, validationResult } = require("express-validator");
const { query, withTransaction } = require("../config/db");
const response = require("../utils/response");
const { generateGroupBookingPDF } = require("../services/reportService");
const { resolveAirline } = require("../services/airlineService");

// ─── Validation ───────────────────────────────────────────────────────────────

const groupBookingValidation = [
  body("customer_id").isUUID().withMessage("Valid customer_id is required"),
  body("group_type")
    .isIn(["family", "company", "individual"])
    .withMessage("group_type must be family, company, or individual"),
  body("group_label").optional().trim(),
  body("tickets")
    .isArray({ min: 1 })
    .withMessage("At least one ticket is required"),
  body("tickets.*.passenger_name")
    .trim()
    .notEmpty()
    .withMessage("Each ticket requires a passenger_name"),
  body("tickets.*.ticket_type")
    .isIn(["LOCAL", "INTERNATIONAL"])
    .withMessage("ticket_type must be LOCAL or INTERNATIONAL"),
  body("tickets.*.from_city")
    .trim()
    .notEmpty()
    .withMessage("from_city is required"),
  body("tickets.*.to_city")
    .trim()
    .notEmpty()
    .withMessage("to_city is required"),
  body("tickets.*.flight_date")
    .isISO8601()
    .withMessage("Valid flight_date required (YYYY-MM-DD)"),
  body("tickets.*.airline_name")
    .trim()
    .notEmpty()
    .withMessage("airline_name is required"),
  body("tickets.*.cost_price")
    .isFloat({ min: 0 })
    .withMessage("cost_price must be a positive number"),
  body("tickets.*.selling_price")
    .isFloat({ min: 0 })
    .withMessage("selling_price must be a positive number"),
];

// ─── POST /api/group-bookings ─────────────────────────────────────────────────

const createGroupBooking = async (req, res, next) => {
  let duplicateError = null;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const businessId = req.businessId || req.user.business_id;
    const createdBy = req.user.id;

    const {
      customer_id,
      group_type,
      group_label,
      from_city,
      to_city,
      flight_date,
      airline_name,
      notes,
      tickets,
      amount_paid, // group-level payment from the customer/company who booked
    } = req.body;

    const groupPaid = Math.max(parseFloat(amount_paid) || 0, 0);

    // ── Verify customer before opening transaction ────────────────────────────
    const customerCheck = await query(
      `SELECT id, customer_type, name, company_name
       FROM customers WHERE id = $1 AND business_id = $2`,
      [customer_id, businessId],
    );
    if (customerCheck.rows.length === 0) {
      return response.error(res, "Customer not found", 404);
    }
    const customer = customerCheck.rows[0];

    // ── Compute totals ────────────────────────────────────────────────────────
    const totalCost = tickets.reduce((s, t) => s + parseFloat(t.cost_price), 0);
    const totalSelling = tickets.reduce(
      (s, t) => s + parseFloat(t.selling_price),
      0,
    );

    // ── Run everything inside withTransaction ────────────────────────────────
    // withTransaction handles BEGIN / COMMIT / ROLLBACK and client.release()
    // It re-throws on error, so the catch below picks it up.
    // We use a custom error class to pass a 409 duplicate message out cleanly.
    const { group, insertedTickets } = await withTransaction(async (client) => {
      // Canonical airline for the group header
      const groupAirline = airline_name
        ? (await resolveAirline(airline_name, businessId, client)).name
        : null;

      // Create booking_group
      const groupResult = await client.query(
        `INSERT INTO booking_groups (
           business_id, created_by, customer_id, group_type,
           group_label, from_city, to_city, flight_date, airline_name,
           notes, total_cost_price, total_selling_price, ticket_count
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          businessId,
          createdBy,
          customer_id,
          group_type,
          group_label ||
            `${customer.company_name || customer.name} — ${flight_date || "Group"}`,
          from_city || null,
          to_city || null,
          flight_date || null,
          groupAirline,
          notes || null,
          totalCost,
          totalSelling,
          tickets.length,
        ],
      );

      const group = groupResult.rows[0];
      const insertedTickets = [];

      for (const t of tickets) {
        const passengerName = t.passenger_name.toUpperCase().trim();

        // Canonical airline for this passenger's ticket
        const airline = await resolveAirline(t.airline_name, businessId, client);
        t.airline_name = airline.name;

        // Duplicate check
        const dup = await client.query(
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
            passengerName,
            t.flight_date,
            t.airline_name,
            t.from_city,
            t.to_city,
          ],
        );

        if (dup.rows.length > 0) {
          // Store the message and throw to trigger ROLLBACK inside withTransaction
          duplicateError = `Duplicate ticket detected for "${passengerName}" on ${t.airline_name} (${t.from_city} → ${t.to_city}) on ${t.flight_date}. Entire group booking has been cancelled.`;
          throw new Error("DUPLICATE");
        }

        // Upsert passenger as a customer record — match by phone first
        let passengerId = null;
        if (t.contact_number) {
          const byPhone = await client.query(
            `SELECT id FROM customers WHERE business_id = $1 AND phone = $2 LIMIT 1`,
            [businessId, t.contact_number.trim()],
          );
          if (byPhone.rows.length > 0) passengerId = byPhone.rows[0].id;
        }
        const existing = passengerId
          ? { rows: [{ id: passengerId }] }
          : await client.query(
              `SELECT id FROM customers WHERE business_id = $1 AND name ILIKE $2 LIMIT 1`,
              [businessId, passengerName],
            );
        if (existing.rows.length > 0) {
          passengerId = existing.rows[0].id;
        } else {
          const newCust = await client.query(
            `INSERT INTO customers (business_id, name, phone) VALUES ($1,$2,$3) RETURNING id`,
            [businessId, passengerName, t.contact_number || null],
          );
          passengerId = newCust.rows[0].id;
        }

        const tripType = t.return_date ? "round_trip" : "one_way";
        const ticketResult = await client.query(
          `INSERT INTO tickets (
             business_id, customer_id, created_by, booking_group_id,
             ticket_type, passenger_name, contact_number,
             from_city, to_city, flight_date, airline_name, ticket_reference,
             cost_price, selling_price,
             base_price, tax, surcharge,
             passport_number, nationality, visa_type,
             source_file_url,
             trip_type, return_date, booked_by_customer_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
           RETURNING *`,
          [
            businessId,
            passengerId,
            createdBy,
            group.id,
            t.ticket_type,
            passengerName,
            t.contact_number || null,
            t.from_city,
            t.to_city,
            t.flight_date,
            t.airline_name,
            t.ticket_reference || null,
            t.cost_price,
            t.selling_price,
            t.base_price || null,
            t.tax || null,
            t.surcharge || null,
            t.passport_number || null,
            t.nationality || null,
            t.visa_type || null,
            t.source_file_url || null,
            tripType,
            t.return_date || null,
            customer_id,
          ],
        );

        // Separate statement so this still works before migration_v5
        if (airline.id) {
          await client.query(
            `UPDATE tickets SET airline_id = $1 WHERE id = $2`,
            [airline.id, ticketResult.rows[0].id],
          );
          ticketResult.rows[0].airline_id = airline.id;
        }

        insertedTickets.push(ticketResult.rows[0]);
      }

      // ── Allocate the group payment across tickets (oldest first) ──────────
      if (groupPaid > 0) {
        let remaining = groupPaid;
        for (const ticket of insertedTickets) {
          if (remaining <= 0) break;
          const price = parseFloat(ticket.selling_price) || 0;
          const pay = Math.min(remaining, price);
          if (pay <= 0) continue;

          const status = pay >= price ? "paid" : "partial";
          const updated = await client.query(
            `UPDATE tickets SET amount_paid = $1, payment_status = $2
             WHERE id = $3 RETURNING *`,
            [pay, status, ticket.id],
          );
          Object.assign(ticket, updated.rows[0]);

          await client.query(
            `INSERT INTO ticket_payments (business_id, ticket_id, collected_by, amount, method, note)
             VALUES ($1, $2, $3, $4, 'cash', 'Group booking payment')`,
            [businessId, ticket.id, createdBy, pay],
          );
          remaining -= pay;
        }
      }

      return { group, insertedTickets };
    });

    return response.created(
      res,
      { group, tickets: insertedTickets },
      "Group booking created successfully",
    );
  } catch (err) {
    // Duplicate error thrown inside withTransaction — already rolled back
    if (err.message === "DUPLICATE" && duplicateError) {
      return response.error(res, duplicateError, 409);
    }
    next(err);
  }
};

// ─── GET /api/group-bookings ──────────────────────────────────────────────────

const getGroupBookings = async (req, res, next) => {
  try {
    const businessId = req.businessId || req.user.business_id;
    const {
      page = 1,
      limit = 20,
      search = "",
      group_type,
      customer_id,
      from_date,
      to_date,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [businessId];
    const conditions = ["bg.business_id = $1"];
    let pi = 2;

    if (search) {
      conditions.push(
        `(bg.group_label ILIKE $${pi} OR c.name ILIKE $${pi} OR c.company_name ILIKE $${pi})`,
      );
      params.push(`%${search}%`);
      pi++;
    }
    if (group_type) {
      conditions.push(`bg.group_type = $${pi}`);
      params.push(group_type);
      pi++;
    }
    if (customer_id) {
      conditions.push(`bg.customer_id = $${pi}`);
      params.push(customer_id);
      pi++;
    }
    if (from_date) {
      conditions.push(`bg.flight_date >= $${pi}`);
      params.push(from_date);
      pi++;
    }
    if (to_date) {
      conditions.push(`bg.flight_date <= $${pi}`);
      params.push(to_date);
      pi++;
    }

    const where = conditions.join(" AND ");

    const countResult = await query(
      `SELECT COUNT(*) FROM booking_groups bg
       JOIN customers c ON c.id = bg.customer_id
       WHERE ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count);

    const dataResult = await query(
      `SELECT
         bg.*,
         COALESCE(c.company_name, c.name) AS customer_display_name,
         c.customer_type,
         c.phone AS customer_phone,
         u.name AS created_by_name
       FROM booking_groups bg
       JOIN customers c ON c.id = bg.customer_id
       JOIN users u     ON u.id = bg.created_by
       WHERE ${where}
       ORDER BY bg.created_at DESC
       LIMIT $${pi} OFFSET $${pi + 1}`,
      [...params, parseInt(limit), offset],
    );

    return response.paginated(res, dataResult.rows, page, limit, total);
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/group-bookings/:id ─────────────────────────────────────────────

const getGroupBooking = async (req, res, next) => {
  try {
    const businessId = req.businessId || req.user.business_id;
    const result = await query(
      `SELECT * FROM v_group_booking_statement
       WHERE group_id = $1 AND business_id = $2`,
      [req.params.id, businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Group booking not found");
    return response.success(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/group-bookings/:id/pdf ─────────────────────────────────────────

const exportGroupBookingPDF = async (req, res, next) => {
  try {
    const businessId = req.businessId || req.user.business_id;
    const result = await query(
      `SELECT * FROM v_group_booking_statement
       WHERE group_id = $1 AND business_id = $2`,
      [req.params.id, businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Group booking not found");
    generateGroupBookingPDF(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/group-bookings/:id ──────────────────────────────────────────────

const updateGroupBooking = async (req, res, next) => {
  try {
    const {
      group_label,
      notes,
      from_city,
      to_city,
      flight_date,
      airline_name,
    } = req.body;
    const businessId = req.businessId || req.user.business_id;

    const result = await query(
      `UPDATE booking_groups SET
         group_label  = COALESCE($1, group_label),
         notes        = COALESCE($2, notes),
         from_city    = COALESCE($3, from_city),
         to_city      = COALESCE($4, to_city),
         flight_date  = COALESCE($5, flight_date),
         airline_name = COALESCE($6, airline_name)
       WHERE id = $7 AND business_id = $8 RETURNING *`,
      [
        group_label || null,
        notes || null,
        from_city || null,
        to_city || null,
        flight_date || null,
        airline_name || null,
        req.params.id,
        businessId,
      ],
    );

    if (result.rows.length === 0)
      return response.notFound(res, "Group booking not found");
    return response.success(
      res,
      result.rows[0],
      "Group booking updated successfully",
    );
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/group-bookings/:id ──────────────────────────────────────────

const deleteGroupBooking = async (req, res, next) => {
  try {
    const businessId = req.businessId || req.user.business_id;
    // Tickets will SET NULL on booking_group_id (per schema FK), then we delete the group
    const result = await query(
      `DELETE FROM booking_groups WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.id, businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Group booking not found");
    return response.success(res, null, "Group booking deleted successfully");
  } catch (err) {
    next(err);
  }
};

module.exports = {
  groupBookingValidation,
  createGroupBooking,
  getGroupBookings,
  getGroupBooking,
  exportGroupBookingPDF,
  updateGroupBooking,
  deleteGroupBooking,
};
