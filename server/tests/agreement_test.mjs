// Four screens, one question: "how much did we collect?"
//
// TAMS was answering it four different ways — Accounts 2,960, Cash Flow 2,560,
// Dashboard and Reports 2,550 — because three of them summed the amount_paid
// column off the booking rows and filtered it by the *booking* date, while
// only the Accounts page read the ledger. This pins them together.
//
// The scenario is the one the agency reported: a ticket sold yesterday, paid
// today. "Today" must show that money.
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
  __RPT__: { generateAirlinePDF: async () => Buffer.from(""), generatePDFReport: async () => Buffer.from(""), generateExcelReport: async () => Buffer.from("") },
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

const ticketC  = require(`${SERVER}/controllers/ticketController.js`);
const reportC  = require(`${SERVER}/controllers/reportController.js`);
const finC     = require(`${SERVER}/controllers/financialsController.js`);
const accountC = require(`${SERVER}/controllers/accountController.js`);

const biz  = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('Agr','agr@x.c') RETURNING id`)).rows[0].id;
await seedAccounts(pg, biz);
const user = (await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`, [biz])).rows[0].id;
const A = Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`, [biz])).rows.map(r => [r.name, r.id]));
const ctx = { businessId: biz, user: { id: user, role: "admin" } };
const mkRes = () => { const r = { code: 200, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); return r; };
const call = async (fn, req) => { const res = mkRes(); let err = null; await fn({ ...ctx, ...req }, res, e => err = e); if (err) throw err; return res; };

const today = (await pg.query(`SELECT CURRENT_DATE::TEXT d`)).rows[0].d;

// ── Sold yesterday, paid today ────────────────────────────────────────────
const t1 = (await call(ticketC.createTicket, { body: {
  ticket_type: "LOCAL", passenger_name: "Sold yesterday", contact_number: "061",
  from_city: "MGQ", to_city: "HGA", flight_date: "2026-11-01",
  airline_name: "Star Airline", cost_price: 200, selling_price: 500,
  amount_paid: 0, account_id: A["Cash"],
} })).body.data;

// Backdate the booking, leaving the payment to happen today.
await pg.query(`UPDATE tickets SET created_at = NOW() - INTERVAL '3 days' WHERE id=$1`, [t1.id]);

await call(ticketC.addPayment, { params: { id: t1.id },
  body: { amount: 100, account_id: A["Cash"], note: "collected today" } });

const dash = (await call(reportC.getDashboard, { query: { period: "today" } })).body.data;
ck("today's collection shows on today's dashboard",
   m2(dash.summary.collected_money) === "100.00", m2(dash.summary.collected_money));
ck("the dashboard reports the window it used",
   dash.period?.from === today && dash.period?.to === today,
   `${dash.period?.from}..${dash.period?.to}`);

// ── A booking made today, paid nothing, must not inflate today ────────────
const t2 = (await call(ticketC.createTicket, { body: {
  ticket_type: "LOCAL", passenger_name: "Booked today, unpaid", contact_number: "062",
  from_city: "MGQ", to_city: "BOS", flight_date: "2026-11-02",
  airline_name: "Jubba Airways", cost_price: 100, selling_price: 400,
  amount_paid: 0, account_id: A["Cash"],
} })).body.data;

const dash2 = (await call(reportC.getDashboard, { query: { period: "today" } })).body.data;
ck("an unpaid booking adds nothing to today's collections",
   m2(dash2.summary.collected_money) === "100.00", m2(dash2.summary.collected_money));
ck("but it does count as a booking made today",
   String(dash2.summary.total_tickets) === "1", String(dash2.summary.total_tickets));

// ── Outstanding is a balance, not a flow ──────────────────────────────────
// 400 owed on the ticket booked today + 400 still owed on the older one.
ck("outstanding covers every unpaid booking, not just this period's",
   m2(dash2.summary.unpaid_money) === "800.00", m2(dash2.summary.unpaid_money));

// ── Money on a cancelled ticket is still money received ───────────────────
await call(ticketC.cancelTicket, { params: { id: t1.id },
  body: { refund_amount: 0, airline_refund: 0, write_off: true } });

const dash3 = (await call(reportC.getDashboard, { query: { period: "today" } })).body.data;
ck("cancelling a ticket does not un-collect the cash it took",
   m2(dash3.summary.collected_money) === "100.00", m2(dash3.summary.collected_money));

// ── A visa sold weeks ago must not appear in today's figures ──────────────
//
// The visa and package queries carried no date filter at all, so every one
// ever recorded was counted into whatever period was selected. That is how a
// day with nothing booked reported $2,400 sold and $500 profit.
const visa = (await pg.query(
  `INSERT INTO visa_applications
     (business_id, created_by, applicant_name, destination_country, visa_type,
      cost_price, selling_price, amount_paid, payment_status)
   VALUES ($1,$2,'Old applicant','UAE','tourist',1900,2400,0,'unpaid')
   RETURNING id`, [biz, user])).rows[0].id;
await pg.query(`UPDATE visa_applications SET created_at = NOW() - INTERVAL '40 days' WHERE id=$1`, [visa]);

const dashToday = (await call(reportC.getDashboard, { query: { period: "today" } })).body.data;
ck("a visa sold 40 days ago is not today's sales",
   m2(dashToday.summary.gross_sales) === "400.00", m2(dashToday.summary.gross_sales));
ck("nor today's profit",
   m2(dashToday.summary.gross_profit) === "300.00", m2(dashToday.summary.gross_profit));

const dashMonth = (await call(reportC.getDashboard, { query: { period: "month" } })).body.data;
ck("and it is still outside a 30-day window",
   m2(dashMonth.summary.gross_sales) === "400.00", m2(dashMonth.summary.gross_sales));

const dashAll = (await call(reportC.getDashboard, { query: { period: "all" } })).body.data;
ck("but all-time counts it",
   m2(dashAll.summary.gross_sales) === "2800.00", m2(dashAll.summary.gross_sales));

// ── All four screens, same window, same number ────────────────────────────
const all      = (await call(reportC.getDashboard,   { query: { period: "all" } })).body.data;
const cashflow = (await call(finC.getCashFlow,       { query: {} })).body.data;
const reports  = (await call(reportC.getReportSummary, { query: {} })).body.data;
const accounts = (await call(accountC.getAccounts,   { query: {} })).body.data;

const figures = {
  dashboard: m2(all.summary.collected_money),
  cashflow: m2(cashflow.inflow.total),
  reports: m2(reports.summary.total_collected),
  accounts: m2(accounts.summary.collected),
};
const distinct = [...new Set(Object.values(figures))];
ck("Dashboard, Cash Flow, Reports and Accounts agree on money collected",
   distinct.length === 1, JSON.stringify(figures));

ck("and they agree on money paid out",
   m2(all.summary.paid_out) === m2(cashflow.outflow.total) &&
   m2(all.summary.paid_out) === m2(accounts.summary.paid_out),
   `${m2(all.summary.paid_out)} / ${m2(cashflow.outflow.total)} / ${m2(accounts.summary.paid_out)}`);

// ── Revenue means the same thing as it does on the income statement ───────
const pl = (await call(finC.getProfitLoss, { query: {} })).body.data;
ck("the dashboard's gross profit matches the income statement",
   m2(all.summary.gross_profit) === m2(pl.gross_profit),
   `dashboard ${m2(all.summary.gross_profit)} vs statement ${m2(pl.gross_profit)}`);
ck("and its gross sales matches too",
   m2(all.summary.gross_sales) === m2(pl.revenue.gross_sales),
   `dashboard ${m2(all.summary.gross_sales)} vs statement ${m2(pl.revenue.gross_sales)}`);

// ── The ledger still equals the account balances ──────────────────────────
const bal = Number((await pg.query(`SELECT COALESCE(SUM(balance),0) s FROM v_account_balance WHERE business_id=$1`, [biz])).rows[0].s);
ck("accounts still equal money in minus money out",
   m2(bal) === m2(Number(all.summary.collected_money) - Number(all.summary.paid_out)),
   `${m2(bal)} vs ${m2(Number(all.summary.collected_money) - Number(all.summary.paid_out))}`);

console.log(`\nPASS (${pass.length})`); pass.forEach(p => console.log("  ✓ " + p));
if (fail.length) { console.log(`\nFAIL (${fail.length})`); fail.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
console.log("\nEvery screen answers 'how much did we collect' the same way.");
