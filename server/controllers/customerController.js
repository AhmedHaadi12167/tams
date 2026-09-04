const { body, validationResult } = require("express-validator");
const { query, withTransaction } = require("../config/db");
const response = require("../utils/response");
const { generateCustomerStatementPDF } = require("../services/reportService");
const { hasTable, hasColumn } = require("../services/schemaInfo");
const { phoneMatches, digitsOf } = require("../services/phoneMatch");
const { uuidOrThrow } = require("../utils/sqlSafe");
const { requireAccount } = require("../services/accountResolver");
const { applyDeposit, depositBalance } = require("../services/depositService");

/**
 * The agency's own details, for the head and foot of an invoice.
 *
 * Returns a usable object even when the row is missing or the columns
 * haven't been migrated in. An invoice with no logo is a plain invoice; an
 * invoice that fails to generate is a member of staff on the phone.
 */
const fetchBusiness = async (businessId) => {
  if (!businessId) return null;
  try {
    const withWebsite = await hasColumn("businesses", "website");
    const r = await query(
      `SELECT id, name, email, phone, address, logo_url${
        withWebsite ? ", website" : ", NULL::TEXT AS website"
      }
         FROM businesses WHERE id = $1`,
      [businessId],
    );
    return r.rows[0] || null;
  } catch {
    return null;
  }
};

/**
 * Where a customer can send money — the strip printed at the foot of an
 * invoice.
 *
 * Every ACTIVE account except cash, whether or not anyone has got round to
 * filling in its number yet. An earlier version required a number and
 * quietly printed nothing at all on a fresh install, which reads as a
 * broken invoice rather than as an unfinished setup — and the account name
 * and icon alone still tell a customer "we accept Premier Bank".
 *
 * Cash is excluded in two ways, by kind and by name, so a seeded Cash
 * account that someone later retyped as another kind still can't reach the
 * page. Telling someone to pay cash on a document whose whole job is to say
 * how to transfer money is noise at best.
 *
 * Inactive accounts are excluded for the same reason they are hidden from
 * payment forms: they are closed, and printing a closed account sends a
 * customer's money somewhere nobody is watching.
 *
 * The optional columns are selected as literal NULLs when the migration
 * that adds them hasn't run, so the shape handed to the renderer never
 * changes and neither document needs to know which migrations exist.
 */
const fetchPaymentMethods = async (businessId) => {
  if (!businessId) return [];
  try {
    if (!(await hasTable("payment_accounts"))) return [];

    const col = async (name, expr) =>
      (await hasColumn("payment_accounts", name))
        ? expr
        : `NULL::TEXT AS ${name}`;

    const selects = [
      await col("account_number", "NULLIF(TRIM(account_number), '') AS account_number"),
      await col("account_holder", "NULLIF(TRIM(account_holder), '') AS account_holder"),
      await col("icon_url", "NULLIF(TRIM(icon_url), '') AS icon_url"),
    ];

    const r = await query(
      `SELECT name, kind, ${selects.join(", ")}
         FROM payment_accounts
        WHERE business_id = $1
          AND is_active
          AND kind <> 'cash'
          AND LOWER(TRIM(name)) <> 'cash'
        ORDER BY sort_order, name`,
      [businessId],
    );
    return r.rows;
  } catch {
    return [];
  }
};

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * The deposit side of a statement: money handed over before there was a
 * booking to put it against.
 *
 * Three numbers, and the difference between them is the whole point:
 *
 *   taken    every deposit movement, refunds included as negatives
 *   applied  how much of it has since been spent on bookings
 *   held     what is left — the agency's debt to this customer
 *
 * `applied` is deliberately NOT added to the invoice's "received" line. When
 * a deposit is spent, depositService writes a real payment row against the
 * booking, so that money is already inside total_paid. Counting it a second
 * time here would print an invoice claiming more money than ever arrived,
 * which is the exact class of double-count this system has spent the week
 * removing.
 *
 * `held` is floored at zero. A deposit cannot be overspent; a negative would
 * quietly become a credit nobody granted.
 *
 * Returns zeros when the tables aren't there, so an agency that has not run
 * migration v22/v23 still gets its invoices, just without a deposit line.
 */
const fetchDeposit = async (customerId, businessId) => {
  const empty = { taken: 0, applied: 0, held: 0 };
  try {
    if (!(await hasTable("customer_deposits"))) return empty;

    const taken = round2(
      (
        await query(
          `SELECT COALESCE(SUM(amount), 0) AS t
             FROM customer_deposits WHERE business_id = $1 AND customer_id = $2`,
          [businessId, customerId],
        )
      ).rows[0].t,
    );

    const applied = (await hasTable("deposit_applications"))
      ? round2(
          (
            await query(
              `SELECT COALESCE(SUM(amount), 0) AS t
                 FROM deposit_applications
                WHERE business_id = $1 AND customer_id = $2`,
              [businessId, customerId],
            )
          ).rows[0].t,
        )
      : 0;

    return { taken, applied, held: Math.max(round2(taken - applied), 0) };
  } catch {
    return empty;
  }
};

/**
 * Shared query: everything a customer owes / has paid.
 * Includes tickets they are the passenger on AND tickets they
 * booked for family members / friends (booked_by_customer_id).
 */
const fetchStatementData = async (
  customerId,
  businessId,
  ticketIds = null,
  visaIds = null,
  packageIds = null,
) => {
  const customerResult = await query(
    `SELECT * FROM customers WHERE id = $1 AND business_id = $2`,
    [customerId, businessId],
  );
  if (customerResult.rows.length === 0) return null;
  const customerName = customerResult.rows[0].name || "";

  // A ticket is "for himself" when he is the passenger — matched either by
  // customer link or by passenger name (covers duplicate customer records).
  const ticketsResult = await query(
    `SELECT t.id, t.passenger_name, t.contact_number, t.ticket_type,
            t.from_city, t.to_city, t.flight_date, t.return_date, t.trip_type,
            t.airline_name, t.ticket_reference, t.status,
            t.selling_price, t.amount_paid,
            (t.selling_price - t.amount_paid) AS balance,
            t.payment_status, t.created_at AS booked_date,
            u.name AS agent_name,
            (t.customer_id = $1 OR LOWER(TRIM(t.passenger_name)) = LOWER(TRIM($3))) AS is_self
     FROM tickets t
     LEFT JOIN users u ON u.id = t.created_by
     WHERE t.business_id = $2
       AND (t.customer_id = $1 OR t.booked_by_customer_id = $1)
       AND t.status != 'cancelled'
     ORDER BY t.created_at DESC`,
    [customerId, businessId, customerName],
  );

  const paymentsResult = await query(
    `SELECT p.amount, p.method, p.note, p.created_at, p.ticket_id,
            u.name AS collected_by_name, t.passenger_name,
            a.name AS account_name
     FROM ticket_payments p
     JOIN users u ON u.id = p.collected_by
     JOIN tickets t ON t.id = p.ticket_id
     LEFT JOIN payment_accounts a ON a.id = p.account_id
     WHERE p.business_id = $2
       AND (t.customer_id = $1 OR t.booked_by_customer_id = $1)
     ORDER BY p.created_at DESC`,
    [customerId, businessId],
  );

  // Visa services and packages the customer also owes on. Both are optional
  // features, so a database without them simply returns nothing.
  const [visaResult, packageResult] = await Promise.all([
    (await hasTable("visa_applications"))
      ? query(
          `SELECT v.id, v.applicant_name, v.destination_country, v.visa_type,
                  v.reference, v.applied_date, v.status,
                  v.cost_price, v.selling_price, v.revenue, v.amount_paid,
                  (v.selling_price - v.amount_paid) AS balance,
                  v.payment_status, v.created_at AS issued_date,
                  u.name AS created_by_name
           FROM visa_applications v
           LEFT JOIN users u ON u.id = v.created_by
           WHERE v.business_id = $2
             AND v.status <> 'cancelled'
             AND (v.customer_id = $1
                  OR LOWER(TRIM(v.applicant_name)) = LOWER(TRIM($3)))
           ORDER BY v.created_at DESC`,
          [customerId, businessId, customerName],
        )
      : Promise.resolve({ rows: [] }),
    (await hasTable("packages"))
      ? query(
          `SELECT p.id, p.label, p.package_type, p.lead_name, p.pilgrim_count,
                  p.departure_date, p.status,
                  p.total_cost, p.selling_price, p.revenue, p.amount_paid,
                  (p.selling_price - p.amount_paid) AS balance,
                  p.payment_status, p.created_at AS issued_date,
                  u.name AS created_by_name
           FROM packages p
           LEFT JOIN users u ON u.id = p.created_by
           WHERE p.business_id = $2
             AND p.status <> 'cancelled'
             AND (p.customer_id = $1
                  OR LOWER(TRIM(COALESCE(p.lead_name, ''))) = LOWER(TRIM($3)))
           ORDER BY p.created_at DESC`,
          [customerId, businessId, customerName],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  // A customer may want an invoice for only some passengers — say three of
  // the seven they booked. Everything below is scoped to that selection.
  const allTickets = ticketsResult.rows;
  const allVisas = visaResult.rows;
  const allPackages = packageResult.rows;

  // A selection of [] means "none of this kind"; null means "all of them"
  const pick = (rows, ids) => {
    if (!Array.isArray(ids)) return rows;
    const keep = new Set(ids.map(String));
    return rows.filter((r) => keep.has(String(r.id)));
  };

  const tickets = pick(allTickets, ticketIds);
  const visas = pick(allVisas, visaIds);
  const packages = pick(allPackages, packageIds);

  const partial =
    Array.isArray(ticketIds) || Array.isArray(visaIds) || Array.isArray(packageIds);

  const visibleIds = new Set(tickets.map((t) => String(t.id)));
  const payments = Array.isArray(ticketIds)
    ? paymentsResult.rows.filter((p) => visibleIds.has(String(p.ticket_id)))
    : paymentsResult.rows;

  const sum = (rows) =>
    rows.reduce(
      (acc, r) => {
        acc.total_amount += parseFloat(r.selling_price) || 0;
        acc.total_paid += parseFloat(r.amount_paid) || 0;
        acc.total_balance += parseFloat(r.balance) || 0;
        return acc;
      },
      { total_amount: 0, total_paid: 0, total_balance: 0 },
    );

  const tTot = sum(tickets);
  const vTot = sum(visas);
  const pTot = sum(packages);
  const totals = {
    total_amount: tTot.total_amount + vTot.total_amount + pTot.total_amount,
    total_paid: tTot.total_paid + vTot.total_paid + pTot.total_paid,
    total_balance: tTot.total_balance + vTot.total_balance + pTot.total_balance,
  };

  const money = (v) => Number(v || 0).toFixed(2);

  // Branding and payment instructions. Fetched together because neither can
  // fail the statement — both resolve to a safe empty value — and running
  // them in parallel keeps the extra work off the response time.
  const [business, paymentMethods, deposit] = await Promise.all([
    fetchBusiness(businessId),
    fetchPaymentMethods(businessId),
    fetchDeposit(customerId, businessId),
  ]);

  // What the agency is holding for this customer, set against what this
  // invoice says they owe. See fetchDeposit for why `held` is not added to
  // "received": the part of the deposit already spent is inside total_paid
  // through the booking's own payment rows, and adding it again would make
  // the invoice claim twice the money that actually changed hands.
  const netDue = round2(totals.total_balance - deposit.held);

  return {
    business,
    payment_methods: paymentMethods,
    deposit,
    customer: customerResult.rows[0],
    tickets,
    visas,
    packages,
    payments,
    selection: {
      partial,
      selected_count: tickets.length + visas.length + packages.length,
      available_count:
        allTickets.length + allVisas.length + allPackages.length,
    },
    breakdown: {
      tickets: {
        count: tickets.length,
        total: money(tTot.total_amount),
        paid: money(tTot.total_paid),
        balance: money(tTot.total_balance),
      },
      visas: {
        count: visas.length,
        total: money(vTot.total_amount),
        paid: money(vTot.total_paid),
        balance: money(vTot.total_balance),
      },
      packages: {
        count: packages.length,
        total: money(pTot.total_amount),
        paid: money(pTot.total_paid),
        balance: money(pTot.total_balance),
      },
    },
    summary: {
      ticket_count: tickets.length,
      visa_count: visas.length,
      package_count: packages.length,
      item_count: tickets.length + visas.length + packages.length,
      total_amount: money(totals.total_amount),
      total_paid: money(totals.total_paid),
      total_balance: money(totals.total_balance),
      // Deposit still unspent, and what the customer owes once it is taken
      // into account. Negative net_due means the agency owes *them*.
      deposit_taken: money(deposit.taken),
      deposit_applied: money(deposit.applied),
      deposit_held: money(deposit.held),
      net_due: money(netDue),
    },
  };
};

/** Accepts ?ticket_ids=a,b,c or repeated ?ticket_ids=a&ticket_ids=b */
const parseTicketIds = (raw) => {
  if (raw === undefined) return null;              // absent -> everything
  if (raw === "" || raw === null) return [];       // present but empty -> none
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list.map((s) => String(s).trim()).filter(Boolean);
};

/**
 * GET /api/customers/:id/statement
 */
const getCustomerStatement = async (req, res, next) => {
  try {
    const data = await fetchStatementData(
      req.params.id,
      req.businessId,
      parseTicketIds(req.query.ticket_ids),
      parseTicketIds(req.query.visa_ids),
      parseTicketIds(req.query.package_ids),
    );
    if (!data) return response.notFound(res, "Customer not found");
    return response.success(res, data);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/customers/:id/statement/pdf
 */
const exportCustomerStatementPDF = async (req, res, next) => {
  try {
    const data = await fetchStatementData(
      req.params.id,
      req.businessId,
      parseTicketIds(req.query.ticket_ids),
      parseTicketIds(req.query.visa_ids),
      parseTicketIds(req.query.package_ids),
    );
    if (!data) return response.notFound(res, "Customer not found");
    // Who produced the document. It signs the invoice, which is what turns
    // a printout into something a customer can query with a named person.
    generateCustomerStatementPDF(res, {
      ...data,
      // A4 by default, A5 on request. Anything else is treated as A4 rather
      // than refused: a mistyped paper size should not stop someone getting
      // their invoice.
      page_size:
        String(req.query.size || "").toUpperCase() === "A5" ? "A5" : "A4",
      prepared_by: req.user?.name || null,
      // The job title if the person has one, the access level if not. A
      // customer reading "Operations Director" learns who signed their
      // invoice; "admin" tells them only what the software lets that person
      // click, which is nobody's business but the agency's.
      prepared_by_role: req.user?.title || req.user?.role || null,
    });
  } catch (err) {
    next(err);
  }
};

/** Run a query only if its table exists, so an un-migrated database still
 *  renders the profile instead of 500ing on a missing relation. */
const optionalRows = async (table, sql, params) =>
  (await hasTable(table)) ? query(sql, params) : { rows: [] };

const customerValidation = [
  body("name").trim().notEmpty().withMessage("Customer name is required"),
  // checkFalsy, not bare optional(). A form always sends every field, so an
  // untouched email box arrives as "" — and "" is present, so bare
  // optional() ran isEmail() against it and failed with a bare "Validation
  // failed" naming nothing. Every optional text field on this form has the
  // same hazard.
  body("email").optional({ checkFalsy: true }).isEmail().withMessage("Valid email required"),
  body("phone").optional({ checkFalsy: true }).trim().isLength({ max: 50 }),
  body("passport_number").optional({ checkFalsy: true }).trim().isLength({ max: 100 }),
  body("nationality").optional({ checkFalsy: true }).trim().isLength({ max: 100 }),
  body("customer_type").optional({ checkFalsy: true }).isIn(["individual", "company"])
    .withMessage("Type must be individual or company"),
  body("company_name").optional({ checkFalsy: true }).trim().isLength({ max: 255 }),
];

/**
 * POST /api/customers
 *
 * A customer created deliberately, before there is anything to sell them.
 *
 * Until now a customer could only appear as a side effect of a booking, so
 * the walk-in who wants to be on file, or the company account being set up
 * before the first trip, had no way in. Worse, the only way to create one
 * was to book something you then had to delete.
 *
 * The phone number is what people search by, so a duplicate is worth
 * catching here rather than leaving two half-histories for the same person.
 */
const createCustomer = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const {
      name,
      phone,
      email,
      passport_number,
      nationality,
      customer_type,
      company_name,
      date_of_birth,
    } = req.body;

    const clean = (v) => {
      const t = String(v ?? "").trim();
      return t === "" ? null : t;
    };

    // Same-number check, done the way the search does it, so "0618344223"
    // and "+252 61 834 4223" count as the same person.
    if (clean(phone)) {
      const existing = await query(
        `SELECT id, name, phone FROM customers
          WHERE business_id = $1 AND COALESCE(phone, '') <> ''`,
        [req.businessId],
      );
      // phoneMatches() builds a SQL fragment — it returns a string, which is
      // truthy for every row, so using it as a comparison flagged the first
      // customer in the table as a duplicate of everybody. samePhone() is the
      // in-memory one.
      //
      // And samePhone is deliberately loose, because it backs a search box
      // where typing the last four digits should find someone. Loose is wrong
      // for "is this the same person": it would refuse to create a customer
      // whose number merely contains another's. Duplicate detection compares
      // the national number, or the whole thing when it is too short to have
      // one.
      const sameNumber = (a, b) => {
        const x = digitsOf(a);
        const y = digitsOf(b);
        if (!x || !y) return false;
        return x.length >= 9 && y.length >= 9
          ? x.slice(-9) === y.slice(-9)
          : x === y;
      };

      const match = existing.rows.find((c) => sameNumber(c.phone, phone));
      if (match)
        return response.error(
          res,
          `${match.name} (${match.phone}) is already on file with this number. ` +
            `Open that record instead of creating a second one.`,
          409,
        );
    }

    const result = await query(
      `INSERT INTO customers
         (business_id, name, phone, email, passport_number, nationality,
          customer_type, company_name, date_of_birth)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'individual'),$8,$9)
       RETURNING *`,
      [
        req.businessId,
        String(name).trim(),
        clean(phone),
        clean(email),
        clean(passport_number),
        clean(nationality),
        clean(customer_type),
        clean(company_name),
        clean(date_of_birth),
      ],
    );

    return response.created(res, result.rows[0], "Customer added");
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/customers/:id/deposit
 *
 * Take money from a customer who owes nothing yet.
 *
 * The agency has not earned this. It is cash in hand and a debt owed back
 * until it is applied to a booking or returned, which is why it lands in
 * customer_deposits and shows on the balance sheet as a liability rather
 * than as revenue. Recording it as a payment against an unrelated ticket —
 * the only thing possible before — made that ticket's balance wrong and
 * quietly turned a deposit into income.
 *
 * A negative amount hands it back.
 */
const addDeposit = async (req, res, next) => {
  try {
    if (!(await hasTable("customer_deposits")))
      return response.error(
        res,
        "Taking a deposit needs a database update. Ask your administrator to run migration_v22.sql.",
        503,
      );

    const amount = Math.round((Number(req.body.amount) || 0) * 100) / 100;
    if (!amount)
      return response.error(res, "Enter an amount", 400);

    const customer = await query(
      `SELECT id, name FROM customers WHERE id = $1 AND business_id = $2`,
      [uuidOrThrow(req.params.id, "customer id"), req.businessId],
    );
    if (customer.rows.length === 0)
      return response.notFound(res, "Customer not found");

    // Giving money back can't exceed what is being held, or the customer
    // ends up owing the agency a deposit, which is not a thing.
    if (amount < 0) {
      const held = await query(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM customer_deposits WHERE business_id = $1 AND customer_id = $2`,
        [req.businessId, req.params.id],
      );
      const balance = Math.round(Number(held.rows[0].total) * 100) / 100;
      if (Math.abs(amount) > balance + 0.001)
        return response.error(
          res,
          `Only $${balance.toFixed(2)} is being held for ${customer.rows[0].name}.`,
          400,
        );
    }

    const accountId = await requireAccount(
      req.body,
      req.businessId,
      null,
      amount > 0 ? "deposit" : "deposit refund",
    );

    const result = await query(
      `INSERT INTO customer_deposits
         (business_id, customer_id, amount, account_id, collected_by, method, reference, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        req.businessId,
        req.params.id,
        amount,
        accountId,
        req.user.id,
        (req.body.method || "cash").trim() || "cash",
        req.body.reference || null,
        req.body.note || null,
      ],
    );

    return response.created(
      res,
      result.rows[0],
      amount > 0
        ? `$${amount.toFixed(2)} held for ${customer.rows[0].name}`
        : `$${Math.abs(amount).toFixed(2)} returned to ${customer.rows[0].name}`,
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/customers/:id/deposits
 * What is being held, and every movement behind it.
 */
const getDeposits = async (req, res, next) => {
  try {
    if (!(await hasTable("customer_deposits")))
      return response.success(res, { balance: 0, movements: [] });

    const id = uuidOrThrow(req.params.id, "customer id");
    const rows = await query(
      `SELECT d.id, d.amount, d.method, d.reference, d.note, d.created_at,
              a.name AS account_name, u.name AS collected_by_name
         FROM customer_deposits d
         LEFT JOIN payment_accounts a ON a.id = d.account_id
         LEFT JOIN users u            ON u.id = d.collected_by
        WHERE d.business_id = $1 AND d.customer_id = $2
        ORDER BY d.created_at DESC`,
      [req.businessId, id],
    );

    // Taken, less spent. The movements list shows the money coming in; the
    // applications show where it went, so the balance is never a number the
    // customer has to take on trust.
    const applied = (await hasTable("deposit_applications"))
      ? await query(
          `SELECT a.id, a.amount, a.created_at, a.note,
                  COALESCE(t.passenger_name, v.applicant_name, pk.label,
                           cs.tracking_number, 'Booking') AS applied_to
             FROM deposit_applications a
             LEFT JOIN tickets t           ON t.id  = a.ticket_id
             LEFT JOIN visa_applications v ON v.id  = a.visa_id
             LEFT JOIN packages pk         ON pk.id = a.package_id
             LEFT JOIN cargo_shipments cs  ON cs.id = a.cargo_id
            WHERE a.business_id = $1 AND a.customer_id = $2
            ORDER BY a.created_at DESC`,
          [req.businessId, id],
        )
      : { rows: [] };

    const taken =
      Math.round(rows.rows.reduce((a, r) => a + Number(r.amount), 0) * 100) / 100;
    const spent =
      Math.round(applied.rows.reduce((a, r) => a + Number(r.amount), 0) * 100) / 100;
    const balance = Math.round((taken - spent) * 100) / 100;

    return response.success(res, {
      balance,
      taken,
      applied: spent,
      movements: rows.rows,
      applications: applied.rows,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/customers/:id/deposit/apply
 *
 * Spend a customer's deposit on one of their bookings.
 *
 * No cash moves — see services/depositService.js for why that is the whole
 * point. The booking becomes paid, the agency stops owing the money back,
 * and every account balance stays exactly where it was.
 */
const applyDepositToBooking = async (req, res, next) => {
  try {
    if (!(await hasTable("deposit_applications")))
      return response.error(
        res,
        "Using a deposit needs a database update. Ask your administrator to run migration_v23.sql.",
        503,
      );

    const customerId = uuidOrThrow(req.params.id, "customer id");
    const { kind, record_id, amount } = req.body;
    if (!kind || !record_id)
      return response.error(res, "Say which booking to apply it to", 400);

    const result = await withTransaction(async (client) =>
      applyDeposit(client, {
        businessId: req.businessId,
        customerId,
        userId: req.user.id,
        kind,
        recordId: record_id,
        amount,
      }),
    );

    if (result.applied <= 0)
      return response.error(
        res,
        result.outstanding <= 0
          ? "That booking is already paid in full."
          : "There is no deposit left to use.",
        400,
      );

    return response.success(
      res,
      result,
      `$${result.applied.toFixed(2)} of deposit used. ` +
        (result.remaining > 0
          ? `$${result.remaining.toFixed(2)} still held.`
          : "Nothing left on deposit."),
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/customers
 */
const getCustomers = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = "",
      only_due,
      sort = "recent",
    } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.businessId];
    let pi = 2;
    const conditions = ["c.business_id = $1"];

    if (search) {
      const textMatch = `(c.name ILIKE $${pi} OR c.passport_number ILIKE $${pi} OR c.phone ILIKE $${pi})`;
      params.push(`%${search}%`);
      pi++;

      // Phone numbers are written many ways — match on the national number
      const digits = String(search).replace(/[^0-9]/g, "");
      if (digits.length >= 3) {
        conditions.push(`(${textMatch} OR ${phoneMatches("c.phone", pi)})`);
        params.push(digits);
        pi++;
      } else {
        conditions.push(textMatch);
      }
    }

    // What each customer still owes — on their own tickets and on any they
    // booked for someone else. Matches the statement page's definition.
    // Zero on a database that hasn't run migration_v23, so the list keeps
    // working rather than 500ing on a missing table.
    const depositExpr = (await hasTable("deposit_applications"))
      ? `GREATEST(
           COALESCE((SELECT SUM(d.amount) FROM customer_deposits d
                      WHERE d.customer_id = c.id AND d.business_id = c.business_id), 0)
         - COALESCE((SELECT SUM(a.amount) FROM deposit_applications a
                      WHERE a.customer_id = c.id AND a.business_id = c.business_id), 0),
           0)`
      : "0";

    const balanceExpr = `(
      SELECT COALESCE(SUM(t.selling_price - t.amount_paid), 0)
      FROM tickets t
      WHERE (t.customer_id = c.id OR t.booked_by_customer_id = c.id)
        AND t.business_id = c.business_id
        AND t.status != 'cancelled'
    )`;

    if (only_due === "true" || only_due === "1") {
      conditions.push(`${balanceExpr} > 0`);
    }

    const whereClause = conditions.join(" AND ");

    const orderBy =
      sort === "balance"
        ? "balance DESC, c.created_at DESC"
        : sort === "name"
          ? "c.name ASC"
          : "c.created_at DESC";

    const [countResult, dataResult, totalsResult] = await Promise.all([
      query(`SELECT COUNT(*) FROM customers c WHERE ${whereClause}`, params),
      query(
        `SELECT c.*,
          (SELECT COUNT(*) FROM tickets t
           WHERE (t.customer_id = c.id OR t.booked_by_customer_id = c.id)
             AND t.business_id = c.business_id
             AND t.status != 'cancelled') AS ticket_count,
          ${balanceExpr} AS balance,
          (SELECT COALESCE(SUM(t.selling_price), 0) FROM tickets t
           WHERE (t.customer_id = c.id OR t.booked_by_customer_id = c.id)
             AND t.business_id = c.business_id
             AND t.status != 'cancelled') AS total_billed,
          (SELECT COALESCE(SUM(t.amount_paid), 0) FROM tickets t
           WHERE (t.customer_id = c.id OR t.booked_by_customer_id = c.id)
             AND t.business_id = c.business_id
             AND t.status != 'cancelled') AS total_paid,
          -- What the agency is still holding for them: deposits taken, less
          -- whatever has already been spent on their bookings. Shown beside
          -- the balance because the two answer the same question from
          -- opposite sides — a customer owing $50 while $190 of their money
          -- sits in the drawer is not a customer to chase.
          ${depositExpr} AS deposit_balance
         FROM customers c
         WHERE ${whereClause}
         ORDER BY ${orderBy}
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, parseInt(limit), offset],
      ),
      // Totals across the whole filtered set, not just this page
      query(
        `SELECT
           COUNT(*) FILTER (WHERE ${balanceExpr} > 0) AS customers_owing,
           COALESCE(SUM(${balanceExpr}), 0)           AS total_outstanding
         FROM customers c WHERE ${whereClause}`,
        params,
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const t = totalsResult.rows[0];

    return response.success(
      res,
      dataResult.rows,
      `${t.customers_owing} customer(s) owing $${Number(t.total_outstanding).toFixed(2)}`,
      200,
      {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
        customers_owing: parseInt(t.customers_owing),
        total_outstanding: Number(t.total_outstanding).toFixed(2),
      },
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/customers/:id
 */
const getCustomer = async (req, res, next) => {
  try {
    const customerResult = await query(
      `SELECT * FROM customers WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (customerResult.rows.length === 0)
      return response.notFound(res, "Customer not found");

    // Everything the customer has bought, not only their flights.
    //
    // The profile listed tickets alone, which meant a deposit could only be
    // spent on a ticket — a customer holding $300 against an Umrah package
    // had no way to use it, and their statement told half the story.
    const p = [req.params.id, req.businessId];
    const [ticketsResult, visasResult, packagesResult, cargoResult] =
      await Promise.all([
        query(
          `SELECT id, ticket_type, from_city, to_city, flight_date, airline_name,
                  selling_price, amount_paid, revenue, status, created_at
             FROM tickets WHERE customer_id = $1 AND business_id = $2
            ORDER BY created_at DESC`,
          p,
        ),
        optionalRows(
          "visa_applications",
          `SELECT id, applicant_name, destination_country, visa_type,
                  selling_price, amount_paid, revenue, status::TEXT AS status, created_at
             FROM visa_applications WHERE customer_id = $1 AND business_id = $2
            ORDER BY created_at DESC`,
          p,
        ),
        optionalRows(
          "packages",
          `SELECT id, label, package_type::TEXT AS package_type, pilgrim_count,
                  selling_price, amount_paid, revenue, status::TEXT AS status, created_at
             FROM packages WHERE customer_id = $1 AND business_id = $2
            ORDER BY created_at DESC`,
          p,
        ),
        (await hasColumn("cargo_shipments", "customer_id"))
          ? query(
              `SELECT id, tracking_number, item_description, from_city, to_city,
                      total_price AS selling_price, amount_paid,
                      cargo_status::TEXT AS status, created_at
                 FROM cargo_shipments WHERE customer_id = $1 AND business_id = $2
                ORDER BY created_at DESC`,
              p,
            )
          : { rows: [] },
      ]);

    return response.success(res, {
      customer: customerResult.rows[0],
      tickets: ticketsResult.rows,
      visas: visasResult.rows,
      packages: packagesResult.rows,
      cargo: cargoResult.rows,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/customers/:id
 */
const updateCustomer = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const { phone, email, passport_number, date_of_birth, nationality } =
      req.body;
    const name = req.body.name?.toUpperCase().trim();
    const result = await query(
      `UPDATE customers SET name=$1, phone=$2, email=$3, passport_number=$4, date_of_birth=$5, nationality=$6
       WHERE id=$7 AND business_id=$8 RETURNING *`,
      [
        name,
        phone || null,
        email || null,
        passport_number || null,
        date_of_birth || null,
        nationality || null,
        req.params.id,
        req.businessId,
      ],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Customer not found");
    return response.success(res, result.rows[0], "Customer updated");
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/customers/:id
 */
const deleteCustomer = async (req, res, next) => {
  try {
    const result = await query(
      `DELETE FROM customers WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.id, req.businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Customer not found");
    return response.success(res, null, "Customer deleted");
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createCustomer,
  addDeposit,
  getDeposits,
  applyDepositToBooking,
  getCustomers,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  customerValidation,
  getCustomerStatement,
  exportCustomerStatementPDF,
};
