// One document, one price, several passengers — and not a cent astray.
//
// A group ticket is quoted as a single combined price but stored as a row
// per passenger, so the division has to be exact: $1,000 across three
// travellers must come back as $1,000.00, not $999.99. This file books the
// real thing through the real controller and checks the money from both
// ends — the tickets add up to what was quoted, and the ledger saw the
// payment exactly once.
//
// It also guards the role split that makes the feature worth having:
// PASSENGERS travel, ONE CONTACT pays. Get that wrong and the balance is
// chased from the wrong person.
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
import { seedAccounts } from "./seed.mjs";
const require = createRequire(import.meta.url);
const SERVER = "/sessions/awesome-festive-mccarthy/mnt/tams/server";
const pass = [], fail = [];
const ck = (n, ok, d = "") => (ok ? pass : fail).push(n + (d ? ` — ${d}` : ""));
const m2 = (v) => Number(v).toFixed(2);

const pg = await PGlite.create();
await pg.exec(`CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`);
await pg.exec(fs.readFileSync("cfg/schema.sql", "utf8").replace(/CREATE EXTENSION[^;]*;/gi, ""));

const dbShim = {
  query: (t, p = []) => pg.query(t, p),
  withTransaction: async (fn) => {
    await pg.exec("BEGIN");
    try { const r = await fn({ query: (t, p = []) => pg.query(t, p) }); await pg.exec("COMMIT"); return r; }
    catch (e) { await pg.exec("ROLLBACK"); throw e; }
  },
};
const Module = require("module"); const orig = Module._resolveFilename;
const S = {
  __DB__: dbShim,
  __RPT__: { generateAirlinePDF: async () => Buffer.from(""), generatePDFReport: async () => Buffer.from(""), generateExcelReport: async () => Buffer.from(""), generateCustomerStatementPDF: async () => Buffer.from("") },
  __AI__: { extractTicketData: async () => ({}) },
  __MAIL__: { sendOTPEmail: async () => true },
};
Module._resolveFilename = function (r, p, ...rest) {
  if (typeof r === "string") {
    if (r.endsWith("config/db")) return "__DB__";
    if (r.endsWith("services/reportService")) return "__RPT__";
    if (r.endsWith("services/aiExtraction")) return "__AI__";
    if (r.endsWith("services/emailService")) return "__MAIL__";
  }
  return orig.call(this, r, p, ...rest);
};
for (const [id, exports] of Object.entries(S)) require.cache[id] = { id, filename: id, loaded: true, exports };

const ticketC   = require(`${SERVER}/controllers/ticketController.js`);
const customerC = require(`${SERVER}/controllers/customerController.js`);
const finC      = require(`${SERVER}/controllers/financialsController.js`);
const { splitAmount, sumsTo } = require(`${SERVER}/services/priceSplit.js`);

// ── The split, on its own ────────────────────────────────────────────────
//
// Checked before any database is involved, because everything below depends
// on it and a failure here would show up as an unexplainable cent later.
ck("an even split is even", splitAmount(1200, 3).join() === "400,400,400", splitAmount(1200, 3).join());
ck("$1,000 across 3 sums to exactly $1,000",
   sumsTo(splitAmount(1000, 3), 1000), splitAmount(1000, 3).join());
ck("and the spare cent goes to the first passenger",
   splitAmount(1000, 3).join() === "333.34,333.33,333.33", splitAmount(1000, 3).join());
ck("$0.01 across 3 does not invent money",
   sumsTo(splitAmount(0.01, 3), 0.01), splitAmount(0.01, 3).join());
ck("a refund divides like a charge",
   sumsTo(splitAmount(-1000, 3), -1000), splitAmount(-1000, 3).join());
ck("seven ways still balances", sumsTo(splitAmount(100, 7), 100), splitAmount(100, 7).join());
let allBalance = true;
for (let total = 1; total <= 300; total++)
  for (let n = 1; n <= 9; n++)
    if (!sumsTo(splitAmount(total / 7, n), total / 7)) allBalance = false;
ck("2,700 awkward divisions, every one exact", allBalance);

const biz  = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('Mubah','m@x.c') RETURNING id`)).rows[0].id;
await seedAccounts(pg, biz);
const user = (await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`, [biz])).rows[0].id;
const A = Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`, [biz])).rows.map(r => [r.name, r.id]));
const ctx = { businessId: biz, user: { id: user, role: "admin" } };
const mkRes = () => { const r = { code: 200, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); return r; };
const call = async (fn, req) => { const res = mkRes(); let err = null; await fn({ ...ctx, ...req }, res, e => err = e); if (err) throw err; return res; };
const attempt = async (fn, req) => {
  const res = mkRes(); let err = null;
  await fn({ ...ctx, ...req }, res, (e) => (err = e));
  return err ? { code: err.statusCode || 500, message: err.message } : { code: res.code, body: res.body };
};
const cashTotal = async () =>
  Number((await pg.query(`SELECT COALESCE(SUM(balance),0) s FROM v_account_balance WHERE business_id=$1`, [biz])).rows[0].s);

// ── The booking from the document ────────────────────────────────────────
//
// The real one Ahmed sent: one contact (ABDIFATAH, 612225088), two
// passengers, each with their own ticket number. Priced at an awkward
// $1,000 so the division cannot come out clean by luck.
const booking = (await call(ticketC.createTicket, { body: {
  ticket_type: "INTERNATIONAL",
  contact_name: "ABDIFATAH MOHAMED MOHAMUD",
  contact_number: "612225088",
  passengers: [
    { passenger_name: "MR ABDIFATAH MOHAMED MOHAMUD", ticket_reference: "KMUMGQ-16226-000011" },
    { passenger_name: "MRS SAHRO IBRAHIM MAALIN",     ticket_reference: "KMUMGQ-16226-000010" },
    { passenger_name: "AMINA ABDIFATAH MOHAMED",      ticket_reference: "KMUMGQ-16226-000012" },
  ],
  from_city: "MGQ", to_city: "NBO", flight_date: "2027-05-01",
  airline_name: "Star Airline",
  base_price: 700, tax: 200, surcharge: 100,
  cost_price: 900, selling_price: 1000,
  amount_paid: 500, account_id: A["Salaam Bank"],
} })).body.data;

const T = booking.tickets;
ck("three passengers become three tickets", T.length === 3, String(T.length));
ck("and one group header ties them together",
   Boolean(booking.group) && booking.group.ticket_count === 3,
   JSON.stringify(booking.group && booking.group.ticket_count));

// THE HEADLINE CHECK. The tickets must add back up to the quoted price.
const sum = (k) => T.reduce((a, t) => a + Number(t[k]), 0);
ck("the three tickets sell for exactly the $1,000 quoted",
   m2(sum("selling_price")) === "1000.00", m2(sum("selling_price")));
ck("and cost exactly the $900 quoted", m2(sum("cost_price")) === "900.00", m2(sum("cost_price")));
ck("base, tax and surcharge each add up too",
   m2(sum("base_price")) === "700.00" && m2(sum("tax")) === "200.00" && m2(sum("surcharge")) === "100.00",
   `${m2(sum("base_price"))}/${m2(sum("tax"))}/${m2(sum("surcharge"))}`);
// $1,000 across three cannot be even, so somebody carries the spare cents.
// What matters is that the difference is cents rather than dollars, and that
// it is visible on the ticket instead of being quietly dropped.
const shares = T.map((t) => Number(t.selling_price));
ck("no passenger is more than three cents from an even share",
   shares.every((s) => Math.abs(s - 1000 / 3) <= 0.03),
   shares.map((s) => s.toFixed(2)).join());
// The one that bit on the first run: splitting each column separately made
// every column add up while leaving passenger 1 with a base+tax+surcharge
// of 333.35 against a selling price of 333.34 — a ticket that contradicted
// itself, and two different answers if it were ever refunded.
ck("every ticket's own arithmetic still holds",
   T.every((t) => m2(Number(t.base_price) + Number(t.tax) + Number(t.surcharge)) === m2(t.selling_price)),
   T.map((t) => `${m2(t.base_price)}+${m2(t.tax)}+${m2(t.surcharge)}=${m2(t.selling_price)}`).join(" "));
ck("and its cost is still base plus tax",
   T.every((t) => m2(Number(t.base_price) + Number(t.tax)) === m2(t.cost_price)),
   T.map((t) => m2(t.cost_price)).join());

// ── Titles must not create a second customer ─────────────────────────────
const people = (await pg.query(
  `SELECT name FROM customers WHERE business_id=$1 ORDER BY name`, [biz])).rows.map(r => r.name);
ck("'MR ABDIFATAH' and the contact are one customer, not two",
   people.filter((p) => p.toUpperCase().includes("ABDIFATAH MOHAMED MOHAMUD")).length === 1,
   people.join(" | "));
ck("no customer is stored with a title still on the front",
   !people.some((p) => /^(MR|MRS|MS|MISS)\b/i.test(p)), people.join(" | "));

// ── Passengers travel, the contact pays ──────────────────────────────────
const contactId = booking.group.customer_id;
ck("every ticket is billed to the one contact",
   T.every((t) => t.booked_by_customer_id === contactId));
ck("but each ticket belongs to its own passenger",
   new Set(T.map((t) => t.customer_id)).size === 3,
   String(new Set(T.map((t) => t.customer_id)).size));
ck("each passenger keeps their own ticket number",
   new Set(T.map((t) => t.ticket_reference)).size === 3,
   T.map((t) => t.ticket_reference).join());

// ── The money, from the other end ────────────────────────────────────────
ck("$500 collected is $500 in the bank", m2(await cashTotal()) === "500.00", m2(await cashTotal()));
const paidSum = T.reduce((a, t) => a + Number(t.amount_paid), 0);
ck("the tickets between them acknowledge all $500", m2(paidSum) === "500.00", m2(paidSum));
const ledger = (await pg.query(
  `SELECT COALESCE(SUM(amount),0) s, COUNT(*)::INT n FROM v_cash_ledger
    WHERE business_id=$1 AND source='ticket'`, [biz])).rows[0];
ck("the cash ledger counts it once, not once per passenger",
   m2(ledger.s) === "500.00", `${m2(ledger.s)} over ${ledger.n} rows`);
// The shortfall belongs to the booking, not to whichever passenger happened
// to be typed last. Settling seat by seat marked one traveller paid and left
// another looking like a defaulter over an ordering the customer never chose.
ck("the shortfall is shared, not dumped on the last passenger",
   T.every((t) => t.payment_status === "partial"),
   T.map((t) => `${m2(t.amount_paid)}/${m2(t.selling_price)}`).join(" "));
const ratios = T.map((t) => Number(t.amount_paid) / Number(t.selling_price));
ck("every seat is paid to the same proportion, within a cent",
   Math.max(...ratios) - Math.min(...ratios) < 0.0001,
   ratios.map((r) => (r * 100).toFixed(2) + "%").join(" "));

// ── One ticket, one debtor ───────────────────────────────────────────────
//
// The bug from the screenshot: a $5 shortfall on a family booking showed up
// under the passenger AND under the contact paying for her, so the agency's
// receivables read double the money it was actually owed.
const listRes = await call(customerC.getCustomers, { query: { limit: 100 } });
const list = listRes.body.data;
const byName = (n) => list.find((c) => c.name.toUpperCase().includes(n));
const abdi = byName("ABDIFATAH MOHAMED MOHAMUD");
const sahro = byName("SAHRO");

ck("the contact carries the whole balance",
   m2(abdi.balance) === "500.00", m2(abdi.balance));
ck("the passenger who is not paying owes nothing",
   m2(sahro.balance) === "0.00", m2(sahro.balance));
ck("and is not billed for a seat somebody else bought",
   m2(sahro.total_billed) === "0.00", m2(sahro.total_billed));
ck("but her ticket still shows on her row",
   Number(sahro.ticket_count) === 1, String(sahro.ticket_count));
ck("with the payer named, so the row is an answer and not a puzzle",
   Number(sahro.guest_ticket_count) === 1 &&
     String(sahro.billed_to_name).toUpperCase().includes("ABDIFATAH"),
   `${sahro.guest_ticket_count} / ${sahro.billed_to_name}`);

// THE HEADLINE. Summed across every customer, the agency's receivables must
// equal the money actually owed — once.
const owedAcrossCustomers = list.reduce((a, c) => a + Number(c.balance), 0);
const owedOnTickets = Number((await pg.query(
  `SELECT COALESCE(SUM(selling_price - amount_paid),0) s FROM tickets
    WHERE business_id=$1 AND status <> 'cancelled'`, [biz])).rows[0].s);
ck("total receivables are not double-counted",
   m2(owedAcrossCustomers) === m2(owedOnTickets),
   `customers ${m2(owedAcrossCustomers)} vs tickets ${m2(owedOnTickets)}`);
ck("and the list's own headline figure agrees",
   m2(listRes.body.meta.total_outstanding) === m2(owedOnTickets),
   `${m2(listRes.body.meta.total_outstanding)} vs ${m2(owedOnTickets)}`);

// A passenger who owes nothing must not be dragged into the chase list.
const dueOnly = (await call(customerC.getCustomers, { query: { only_due: "true", limit: 100 } }))
  .body.data.map((c) => c.name.toUpperCase());
ck("the 'owing' filter leaves the non-paying passenger out",
   !dueOnly.some((n) => n.includes("SAHRO")), dueOnly.join(" | "));

// ── And her statement must not invoice her for it ────────────────────────
const hers = (await call(customerC.getCustomerStatement, {
  params: { id: sahro.id }, query: {} })).body.data;
ck("her statement still lists the flight she is on",
   hers.tickets.length === 1, String(hers.tickets.length));
ck("marked as billed to someone else",
   hers.tickets[0].billed_to_me === false, String(hers.tickets[0].billed_to_me));
ck("and her invoice asks her for nothing",
   m2(hers.summary.total_balance) === "0.00" &&
     m2(hers.summary.total_amount) === "0.00",
   `${m2(hers.summary.total_amount)} / ${m2(hers.summary.total_balance)}`);

// ── The contact's statement carries the whole group ──────────────────────
const stmt = (await call(customerC.getCustomerStatement, {
  params: { id: contactId }, query: {} })).body.data;
ck("the contact's statement lists all three passengers",
   stmt.tickets.length === 3, String(stmt.tickets.length));
ck("and shows them owing the $500 balance",
   m2(stmt.summary.total_balance) === "500.00", m2(stmt.summary.total_balance));
ck("the statement's sales equal the quoted price",
   m2(stmt.summary.total_amount) === "1000.00", m2(stmt.summary.total_amount));

// ── The income statement agrees ──────────────────────────────────────────
const pl = (await call(finC.getProfitLoss, { query: {} })).body.data;
ck("gross sales are the one price quoted, not three roundings",
   m2(pl.revenue.gross_sales) === "1000.00", m2(pl.revenue.gross_sales));
const sheet = (await call(finC.getBalanceSheet, { query: {} })).body.data;
ck("and the balance sheet balances", m2(sheet.difference) === "0.00", m2(sheet.difference));

// ── A duplicate must take the whole booking down ─────────────────────────
const before = (await pg.query(`SELECT COUNT(*)::INT n FROM tickets WHERE business_id=$1`, [biz])).rows[0].n;
const groupsBefore = (await pg.query(`SELECT COUNT(*)::INT n FROM booking_groups WHERE business_id=$1`, [biz])).rows[0].n;
const dup = await attempt(ticketC.createTicket, { body: {
  ticket_type: "INTERNATIONAL", contact_name: "NEW PERSON", contact_number: "615777888",
  passengers: [
    { passenger_name: "BRAND NEW TRAVELLER" },
    { passenger_name: "SAHRO IBRAHIM MAALIN" }, // already flying this route
  ],
  from_city: "MGQ", to_city: "NBO", flight_date: "2027-05-01",
  airline_name: "Star Airline", cost_price: 100, selling_price: 200,
} });
ck("a duplicate passenger is refused", dup.code === 409, `${dup.code} ${dup.message || ""}`);
const after = (await pg.query(`SELECT COUNT(*)::INT n FROM tickets WHERE business_id=$1`, [biz])).rows[0].n;
const groupsAfter = (await pg.query(`SELECT COUNT(*)::INT n FROM booking_groups WHERE business_id=$1`, [biz])).rows[0].n;
ck("and the traveller booked before it is rolled back too", after === before, `${before} → ${after}`);
ck("leaving no orphan group behind", groupsAfter === groupsBefore, `${groupsBefore} → ${groupsAfter}`);

// ── Overpaying is refused rather than quietly dropped ────────────────────
const over = await attempt(ticketC.createTicket, { body: {
  ticket_type: "LOCAL", contact_name: "OVER PAYER", contact_number: "615999000",
  passengers: [{ passenger_name: "OVER ONE" }, { passenger_name: "OVER TWO" }],
  from_city: "MGQ", to_city: "HGA", flight_date: "2027-06-01",
  airline_name: "Star Airline", cost_price: 100, selling_price: 200,
  amount_paid: 500, account_id: A["Cash"],
} });
ck("paying more than the booking costs is refused", over.code === 400, `${over.code} ${over.message || ""}`);
ck("and no money was banked on the way",
   m2(await cashTotal()) === "500.00", m2(await cashTotal()));

// ── One passenger through the new path behaves like the old one ──────────
const single = (await call(ticketC.createTicket, { body: {
  ticket_type: "LOCAL", contact_name: "SOLO FLYER", contact_number: "615111222",
  passengers: [{ passenger_name: "SOLO FLYER", ticket_reference: "SOLO-1" }],
  from_city: "MGQ", to_city: "KIS", flight_date: "2027-07-01",
  airline_name: "Star Airline", cost_price: 80, selling_price: 120,
  amount_paid: 120, account_id: A["Cash"],
} })).body.data;
ck("a single passenger needs no group header", single.group === null, JSON.stringify(single.group));
ck("and their one ticket carries the whole price",
   m2(single.tickets[0].selling_price) === "120.00", m2(single.tickets[0].selling_price));
ck("paid in full at booking", single.tickets[0].payment_status === "paid", single.tickets[0].payment_status);

// ── The old single-ticket path is untouched ──────────────────────────────
const classic = (await call(ticketC.createTicket, { body: {
  ticket_type: "LOCAL", passenger_name: "CLASSIC BOOKING", contact_number: "615333444",
  from_city: "MGQ", to_city: "GLK", flight_date: "2027-08-01",
  airline_name: "Star Airline", cost_price: 50, selling_price: 90,
  amount_paid: 40, account_id: A["Cash"],
} })).body.data;
ck("a booking with no passengers[] still saves exactly as before",
   m2(classic.selling_price) === "90.00" && classic.payment_status === "partial",
   `${m2(classic.selling_price)} ${classic.payment_status}`);
// ── The validation rules themselves ──────────────────────────────────────
//
// Run through the real express-validator chains rather than the controller,
// because the controller alone never sees them — the rules are middleware,
// and skipping them here is how a broken rule ships unnoticed.
const { validationResult } = require("express-validator");
const validate = async (body) => {
  const req = { body, query: {}, params: {}, headers: {}, cookies: {} };
  for (const chain of ticketC.ticketValidation) await chain.run(req);
  return validationResult(req).array().map((e) => e.msg);
};

const base = {
  ticket_type: "LOCAL", from_city: "MGQ", to_city: "GLK",
  flight_date: "2027-08-02", airline_name: "Star Airline",
  cost_price: 1, selling_price: 1,
};
ck("a passenger name is still required when there is no list",
   (await validate({ ...base })).includes("Passenger name is required"));
ck("but a passengers list satisfies it on its own",
   !(await validate({ ...base, passengers: [{ passenger_name: "SOMEONE" }] }))
     .includes("Passenger name is required"));
ck("an empty passengers list does not count as a passenger",
   (await validate({ ...base, passengers: [] }))
     .includes("Passenger name is required"));
ck("passengers must be a list, not a name typed into the wrong box",
   (await validate({ ...base, passengers: "ALI" })).includes("passengers must be a list"));

const finalSheet = (await call(finC.getBalanceSheet, { query: {} })).body.data;
ck("the sheet still balances after everything above",
   m2(finalSheet.difference) === "0.00", m2(finalSheet.difference));

console.log(`\nPASS (${pass.length})`); pass.forEach(p => console.log("  ✓ " + p));
if (fail.length) { console.log(`\nFAIL (${fail.length})`); fail.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
console.log("\nOne price, several passengers, and the tickets add back up to it.");
