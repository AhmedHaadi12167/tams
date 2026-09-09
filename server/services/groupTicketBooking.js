/**
 * groupTicketBooking.js — one document, one price, several passengers.
 *
 * A family of four flies to Nairobi on one itinerary at one combined price.
 * The agency is handed a single ticket document listing four names and four
 * ticket numbers, and one person pays for all of it.
 *
 * THE SHAPE OF THE PROBLEM
 *
 * Those are two different roles and the system has to keep them apart:
 *
 *   CONTACT    one person. Owes the money, appears on the statement, is
 *              chased for the balance. Stored as booked_by_customer_id.
 *   PASSENGER  everyone travelling. Each gets their own ticket row, because
 *              each can be cancelled, refunded, or have a passport that
 *              expires on their own. Stored as the ticket's customer_id.
 *
 * The contact is usually also the first passenger. That is not a special
 * case: they resolve to the same customer record, so the ticket's
 * customer_id and booked_by_customer_id are simply equal, and the statement
 * still lists the ticket exactly once.
 *
 * THE MONEY
 *
 * The price typed on the form is the price on the document — the combined
 * total, not the fare per head. It is divided here, in whole cents, so the
 * ticket rows add back up to the figure the customer was quoted. See
 * priceSplit.js for why that is harder than a division.
 *
 * Everything below happens in one transaction. A booking that creates three
 * of its four tickets and then hits a duplicate is worse than one that
 * fails: the agency is left with a group that does not match the document,
 * a balance that is wrong, and no signal that anything went missing.
 */

const { resolveOrCreateCustomer } = require("./customerLink");
const {
  splitBooking,
  allocateProRata,
  sumsTo,
  toCents,
} = require("./priceSplit");
const { cleanName } = require("./nameClean");
const { hasColumn, hasTable } = require("./schemaInfo");

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const nullIfBlank = (v) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

const fail = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = true;
  return err;
};

/**
 * Normalise whatever the form sent into a clean passenger list.
 *
 * Accepts either objects or bare strings, because a caller that only has
 * names should not have to wrap them. Blank rows are dropped rather than
 * rejected: the form always carries one empty row at the bottom for the next
 * name, and refusing to save because of it would be maddening.
 */
const normalisePassengers = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => (typeof p === "string" ? { passenger_name: p } : p || {}))
    .map((p) => ({
      // Titles are stripped here as well as during extraction, because a
      // name can also be typed by hand or edited on the form after the AI
      // has read it. "MRS SAHRO IBRAHIM MAALIN" and "SAHRO IBRAHIM MAALIN"
      // must be one customer and one duplicate-check, not two.
      passenger_name: (cleanName(p.passenger_name) || "").toUpperCase().trim(),
      ticket_reference: nullIfBlank(p.ticket_reference),
      passport_number: nullIfBlank(p.passport_number),
      nationality: nullIfBlank(p.nationality),
      date_of_birth: nullIfBlank(p.date_of_birth),
      passport_expiry_date: nullIfBlank(p.passport_expiry_date),
      visa_type: nullIfBlank(p.visa_type),
      visa_expiry_date: nullIfBlank(p.visa_expiry_date),
      contact_number: nullIfBlank(p.contact_number),
    }))
    .filter((p) => p.passenger_name);
};

/**
 * Create a booking group and one ticket per passenger.
 *
 * @param {object} client   pg client, already inside a transaction
 * @param {object} args
 * @param {string} args.businessId
 * @param {string} args.userId          who is making the booking
 * @param {Array}  args.passengers      normalised passenger list
 * @param {string} args.contactId       customer who owes the money
 * @param {object} args.flight          shared route/date/airline/type fields
 * @param {object} args.totals          combined base/tax/surcharge/cost/selling/commission
 * @param {number} args.paid            money collected now, for the whole booking
 * @param {string} args.method          payment method label
 * @param {string|null} args.accountId  which account it landed in
 * @param {string|null} args.agentId    commission agent, if any
 * @param {string|null} args.airlineId
 * @returns {Promise<{group: object|null, tickets: object[]}>}
 */
const createGroupedTickets = async (
  client,
  {
    businessId,
    userId,
    passengers,
    contactId,
    flight,
    totals,
    paid = 0,
    method = "cash",
    accountId = null,
    agentId = null,
    airlineId = null,
    groupType = "family",
    groupLabel = null,
    notes = null,
  },
) => {
  const n = passengers.length;
  if (n === 0) throw fail("At least one passenger is required");

  // ── Divide the combined price ──────────────────────────────────────────
  const shares = splitBooking(totals, n);

  // Belt and braces. splitAmounts is tested, but this is the one error that
  // would be invisible afterwards — a booking quietly worth a cent less than
  // the invoice — so it is checked again against real data every time.
  for (const key of Object.keys(shares[0])) {
    if (!sumsTo(shares.map((s) => s[key]), totals[key] || 0)) {
      throw fail(
        `Internal error splitting ${key} across ${n} passengers — booking refused rather than stored wrong.`,
        500,
      );
    }
  }

  const totalSelling = round2(totals.selling_price);
  if (toCents(paid) > toCents(totalSelling)) {
    throw fail(
      `Paid ($${round2(paid).toFixed(2)}) is more than the booking total ` +
        `($${totalSelling.toFixed(2)}). Reduce the payment or raise the price.`,
    );
  }

  // ── The group header ───────────────────────────────────────────────────
  //
  // Optional: an installation whose database predates booking_groups still
  // gets its tickets, just without the header that ties them together.
  let group = null;
  const canGroup =
    (await hasTable("booking_groups")) &&
    (await hasColumn("tickets", "booking_group_id"));

  if (canGroup && n > 1) {
    const label =
      groupLabel ||
      `${passengers[0].passenger_name} +${n - 1} — ${flight.flight_date || "group"}`;
    const res = await client.query(
      `INSERT INTO booking_groups (
         business_id, created_by, customer_id, group_type, group_label,
         from_city, to_city, flight_date, airline_name, notes,
         total_cost_price, total_selling_price, ticket_count
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        businessId,
        userId,
        contactId,
        groupType,
        label,
        flight.from_city,
        flight.to_city,
        flight.flight_date,
        flight.airline_name,
        notes,
        round2(totals.cost_price),
        totalSelling,
        n,
      ],
    );
    group = res.rows[0];
  }

  // ── One ticket per passenger ───────────────────────────────────────────
  const tickets = [];

  for (let i = 0; i < n; i++) {
    const p = passengers[i];
    const share = shares[i];

    // A duplicate is checked inside the transaction, so it also catches the
    // same name typed twice in this very booking — the first insert is
    // already visible to the second check.
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
        p.passenger_name,
        flight.flight_date,
        flight.airline_name,
        flight.from_city,
        flight.to_city,
      ],
    );
    if (dup.rows.length > 0) {
      throw fail(
        `"${p.passenger_name}" already has a ticket on ${flight.airline_name} ` +
          `(${flight.from_city} → ${flight.to_city}) on ${flight.flight_date}. ` +
          `Nothing was saved — remove the duplicate passenger and try again.`,
        409,
      );
    }

    // The traveller's own customer record. Matched by name when they have no
    // number of their own, which is how the lead passenger lands on the same
    // record as the contact rather than becoming a second copy of them.
    const passengerId = await resolveOrCreateCustomer({
      businessId,
      name: p.passenger_name,
      phone: p.contact_number,
      client,
    });

    const res = await client.query(
      `INSERT INTO tickets (
         business_id, customer_id, created_by, ticket_type,
         passenger_name, contact_number, from_city, to_city,
         flight_date, airline_name, ticket_reference,
         cost_price, selling_price, base_price, tax, surcharge,
         source_file_url, trip_type, return_date, agent_commission,
         amount_paid, payment_status, booked_by_customer_id,
         passport_number, nationality, date_of_birth,
         passport_expiry_date, visa_type, visa_expiry_date
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                 $21,$22,$23,$24,$25,$26,$27,$28,$29)
       RETURNING *`,
      [
        businessId,
        passengerId,
        userId,
        flight.ticket_type,
        p.passenger_name,
        // The contact's number goes on every ticket: it is the number to
        // ring about this seat, and for a child or an elderly parent it is
        // the only number there is.
        p.contact_number || flight.contact_number || null,
        flight.from_city,
        flight.to_city,
        flight.flight_date,
        flight.airline_name,
        p.ticket_reference || flight.ticket_reference || null,
        share.cost_price,
        share.selling_price,
        share.base_price,
        share.tax,
        share.surcharge,
        flight.source_file_url,
        flight.trip_type,
        flight.trip_type === "round_trip" ? flight.return_date : null,
        share.agent_commission,
        0, // payments are allocated below, so amount_paid is never a guess
        "unpaid",
        contactId,
        p.passport_number,
        p.nationality,
        p.date_of_birth,
        p.passport_expiry_date,
        p.visa_type,
        p.visa_expiry_date,
      ],
    );
    const ticket = res.rows[0];

    if (group) {
      await client.query(
        `UPDATE tickets SET booking_group_id = $1 WHERE id = $2`,
        [group.id, ticket.id],
      );
      ticket.booking_group_id = group.id;
    }
    if (airlineId) {
      await client.query(`UPDATE tickets SET airline_id = $1 WHERE id = $2`, [
        airlineId,
        ticket.id,
      ]);
      ticket.airline_id = airlineId;
    }
    if (agentId) {
      await client.query(`UPDATE tickets SET agent_id = $1 WHERE id = $2`, [
        agentId,
        ticket.id,
      ]);
      ticket.agent_id = agentId;
    }

    tickets.push(ticket);
  }

  // ── Allocate what was actually paid ────────────────────────────────────
  //
  // Spread across the seats in proportion to their price, not poured into
  // them one at a time. $345 against two $175 seats settles both at $172.50
  // rather than marking one traveller paid and the other $5 short — the
  // money was handed over for the booking, and an ordering the customer
  // never chose should not decide which passenger looks unpaid.
  const paidCents = toCents(paid);
  const allocation = allocateProRata(
    paidCents,
    tickets.map((t) => toCents(t.selling_price)),
  );

  if (allocation.reduce((a, c) => a + c, 0) !== paidCents) {
    throw fail(
      `Internal error allocating $${round2(paid).toFixed(2)} across ${n} tickets — booking refused rather than stored wrong.`,
      500,
    );
  }

  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    const pay = allocation[i];
    if (pay <= 0) continue;
    const price = toCents(ticket.selling_price);

    const updated = await client.query(
      `UPDATE tickets SET amount_paid = $1, payment_status = $2
        WHERE id = $3 RETURNING *`,
      [pay / 100, pay >= price ? "paid" : "partial", ticket.id],
    );
    Object.assign(ticket, updated.rows[0]);

    await client.query(
      `INSERT INTO ticket_payments
         (business_id, ticket_id, collected_by, amount, method, note, account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        businessId,
        ticket.id,
        userId,
        pay / 100,
        method,
        tickets.length > 1
          ? "Initial payment at booking (share of group payment)"
          : "Initial payment at booking",
        accountId,
      ],
    );
  }

  return { group, tickets };
};

module.exports = { createGroupedTickets, normalisePassengers };
