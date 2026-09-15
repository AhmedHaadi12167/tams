// The Dashboard and the income statement must report the same profit.
//
// Reproduces the exact trading Ahmed had on screen when the two pages
// disagreed: one ticket sold at 220 costing 210, one visa sold at 300
// costing 250, and one 30 shipment of which 20 went to the carrier.
//
//   Dashboard said   gross profit  $90
//   Financials said  gross profit  $70
//
// The difference was the carrier's 20: cargo contributed its full SALE to
// the dashboard's profit while visas and packages contributed their MARGIN.
// A parcel carried on a flight already booked costs nothing, so cargo was
// once pure profit — that stopped being true the day a per-kilo margin
// could be recorded, and one of the two pages never noticed.
//
// It also covers the second half of the same report: a customer who has
// only ever shipped a parcel or bought a visa showed "$0.00 — Settled"
// while owing money, because the customers list totalled tickets alone.
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
const visaC     = require(`${SERVER}/controllers/visaController.js`);
const cargoC    = require(`${SERVER}/controllers/cargoController.js`);
const finC      = require(`${SERVER}/controllers/financialsController.js`);
const reportC   = require(`${SERVER}/controllers/reportController.js`);
const customerC = require(`${SERVER}/controllers/customerController.js`);

const biz  = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('Mubah Travel','m@x.c') RETURNING id`)).rows[0].id;
await seedAccounts(pg, biz);
const user = (await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'Liibaan','l@x.c','h','admin') RETURNING id`, [biz])).rows[0].id;
const A = Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`, [biz])).rows.map(r => [r.name, r.id]));
const ctx = { businessId: biz, user: { id: user, role: "admin" } };
const mkRes = () => { const r = { code: 200, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); return r; };
const call = async (fn, req) => { const res = mkRes(); let err = null; await fn({ ...ctx, ...req }, res, e => err = e); if (err) throw err; return res; };

// ── The trading from the screenshots ─────────────────────────────────────
await call(ticketC.createTicket, { body: {
  ticket_type: "LOCAL", passenger_name: "PASSENGER ONE", contact_number: "610000001",
  from_city: "Mogadishu", to_city: "Laascaanood", flight_date: "2027-01-10",
  airline_name: "Star Airline", cost_price: 210, selling_price: 220,
  amount_paid: 0, account_id: A["Cash"],
} });

const visaCust = (await call(customerC.createCustomer, { body: {
  name: "AHMED AWIL", phone: "610481578",
} })).body.data;
await call(visaC.createVisa, { body: {
  applicant_name: "AHMED AWIL", contact_number: "610481578", customer_id: visaCust.id,
  destination_country: "Turkey", visa_type: "tourist",
  cost_price: 250, selling_price: 300, amount_paid: 0,
} });

const cargoCust = (await call(customerC.createCustomer, { body: {
  name: "HASSAN ALI", phone: "610848343",
} })).body.data;
await call(cargoC.createCargo, { body: {
  sender_name: "HASSAN ALI", sender_contact: "610848343", customer_id: cargoCust.id,
  receiver_name: "RECEIVER", from_city: "Mogadishu", to_city: "Hargeisa",
  // $30 of carriage sold, of which the agency keeps $10 — the other $20 is
  // the carrier's. 10 kg at $3/kg, keeping $1/kg.
  weight_kg: 10, price_per_kg: 3, profit_per_kg: 1,
  amount_paid: 0,
} });

// ── THE HEADLINE: the two pages must agree ───────────────────────────────
const pl = (await call(finC.getProfitLoss, { query: {} })).body.data;
const dash = (await call(reportC.getDashboard, { query: {} })).body.data;

ck("gross sales are the same on both pages",
   m2(dash.summary.gross_sales) === m2(pl.revenue.gross_sales),
   `dashboard ${m2(dash.summary.gross_sales)} vs financials ${m2(pl.revenue.gross_sales)}`);
ck("and so is gross profit — the bug that started this",
   m2(dash.summary.gross_profit) === m2(pl.gross_profit),
   `dashboard ${m2(dash.summary.gross_profit)} vs financials ${m2(pl.gross_profit)}`);
ck("sales are the $550 sold", m2(pl.revenue.gross_sales) === "550.00", m2(pl.revenue.gross_sales));
ck("profit is $70, not $90", m2(pl.gross_profit) === "70.00", m2(pl.gross_profit));
ck("the carrier's $20 is a cost, not earnings",
   m2(pl.cost_of_sales.cargo_carriers) === "20.00", m2(pl.cost_of_sales.cargo_carriers));

// The income statement's own arithmetic has to work on the page: the cost
// lines must add up to the total shown beneath them.
const lines =
  Number(pl.cost_of_sales.airline_tickets) +
  Number(pl.cost_of_sales.visa_fees) +
  Number(pl.cost_of_sales.package_suppliers) +
  Number(pl.cost_of_sales.cargo_carriers);
ck("every cost of sales line is reported, so they add to the total",
   m2(lines) === m2(pl.cost_of_sales.total),
   `lines ${m2(lines)} vs total ${m2(pl.cost_of_sales.total)}`);
ck("gross sales less cost of sales is gross profit",
   m2(Number(pl.revenue.gross_sales) - Number(pl.cost_of_sales.total)) === m2(pl.gross_profit));

// A shipment with no margin recorded stays pure profit, exactly as every
// shipment behaved before the field existed.
await call(cargoC.createCargo, { body: {
  sender_name: "OLD STYLE", receiver_name: "SOMEONE",
  from_city: "Mogadishu", to_city: "Kismayo",
  weight_kg: 5, price_per_kg: 4, amount_paid: 0,
} });
const pl2 = (await call(finC.getProfitLoss, { query: {} })).body.data;
const dash2 = (await call(reportC.getDashboard, { query: {} })).body.data;
ck("a shipment with no margin entered is still treated as all profit",
   m2(pl2.gross_profit) === m2(Number(pl.gross_profit) + 20),
   m2(pl2.gross_profit));
ck("and the two pages still agree after it",
   m2(dash2.summary.gross_profit) === m2(pl2.gross_profit),
   `${m2(dash2.summary.gross_profit)} vs ${m2(pl2.gross_profit)}`);

// ── The customers list ───────────────────────────────────────────────────
const list = (await call(customerC.getCustomers, { query: { limit: 100 } })).body.data;
const byName = (n) => list.find((c) => c.name.toUpperCase().includes(n));
const hassan = byName("HASSAN ALI");
const ahmed = byName("AHMED AWIL");

ck("a cargo-only customer is billed for the shipment",
   m2(hassan.total_billed) === "30.00", m2(hassan.total_billed));
ck("and owes it, rather than reading Settled",
   m2(hassan.balance) === "30.00", m2(hassan.balance));
ck("their shipment counts as a service, not '0 tickets'",
   Number(hassan.service_count) === 1, String(hassan.service_count));

ck("a visa-only customer is billed for the visa",
   m2(ahmed.total_billed) === "300.00", m2(ahmed.total_billed));
ck("and owes it", m2(ahmed.balance) === "300.00", m2(ahmed.balance));
ck("counted as one service", Number(ahmed.service_count) === 1, String(ahmed.service_count));

// Receivables across the customers list must equal what the agency is owed,
// counted straight from the four service tables. Compared against the
// database rather than a number typed into this file, so adding another
// booking to the fixtures above can never quietly invalidate the check.
const listRes = await call(customerC.getCustomers, { query: { limit: 100 } });
const owedByCustomers = listRes.body.data.reduce((a, c) => a + Number(c.balance), 0);
const owedOnServices = Number((await pg.query(`
  SELECT
    (SELECT COALESCE(SUM(selling_price - amount_paid),0) FROM tickets
      WHERE business_id=$1 AND status <> 'cancelled')
  + (SELECT COALESCE(SUM(selling_price - amount_paid),0) FROM visa_applications
      WHERE business_id=$1 AND status <> 'cancelled')
  + (SELECT COALESCE(SUM(selling_price - amount_paid),0) FROM packages
      WHERE business_id=$1 AND status <> 'cancelled')
  + (SELECT COALESCE(SUM(total_price - amount_paid),0) FROM cargo_shipments
      WHERE business_id=$1 AND cargo_status <> 'cancelled') AS owed`,
  [biz])).rows[0].owed);

ck("the list's receivables equal what is outstanding on every service",
   m2(owedByCustomers) === m2(owedOnServices),
   `customers ${m2(owedByCustomers)} vs services ${m2(owedOnServices)}`);
ck("and nothing is counted twice",
   m2(owedByCustomers) === m2(owedOnServices) && owedByCustomers > 0,
   m2(owedByCustomers));
ck("the page headline matches the rows beneath it",
   m2(listRes.body.meta.total_outstanding) === m2(owedByCustomers),
   `${m2(listRes.body.meta.total_outstanding)} vs ${m2(owedByCustomers)}`);

// ── And the statement shows what the balance is made of ──────────────────
const stmt = (await call(customerC.getCustomerStatement, {
  params: { id: cargoCust.id }, query: {} })).body.data;
ck("the cargo customer's statement lists the shipment",
   stmt.cargo.length === 1, String(stmt.cargo?.length));
ck("and its total matches what they are being chased for",
   m2(stmt.summary.total_balance) === m2(hassan.balance),
   `${m2(stmt.summary.total_balance)} vs ${m2(hassan.balance)}`);
ck("an invoice for them is not blank",
   m2(stmt.summary.total_amount) === "30.00", m2(stmt.summary.total_amount));

const sheet = (await call(finC.getBalanceSheet, { query: {} })).body.data;
ck("and the balance sheet still balances", m2(sheet.difference) === "0.00", m2(sheet.difference));

console.log(`\nPASS (${pass.length})`); pass.forEach(p => console.log("  ✓ " + p));
if (fail.length) { console.log(`\nFAIL (${fail.length})`); fail.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
console.log("\nOne set of figures, on every page.");
