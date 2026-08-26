/**
 * refund_test.mjs
 *
 * Cancelling a ticket moves money in two directions at once — out to the
 * customer, back in from the airline — while a third amount stays put as a
 * fee. This checks that after all that, the accounts still hold exactly what
 * came in minus what went out, and that the fee survives into the accounts
 * as income rather than quietly disappearing with the cancelled sale.
 */

import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);
const SERVER = "/sessions/awesome-festive-mccarthy/mnt/tams/server";

const pass = [];
const fail = [];
const ck = (n, ok, d = "") => (ok ? pass : fail).push(n + (d ? ` — ${d}` : ""));
const m2 = (v) => Number(v).toFixed(2);

const pg = await PGlite.create();
await pg.exec(
  `CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`,
);
await pg.exec(
  fs.readFileSync("cfg/schema.sql", "utf8").replace(/CREATE EXTENSION[^;]*;/gi, ""),
);

const dbShim = {
  query: (t, p = []) => pg.query(t, p),
  withTransaction: async (fn) => {
    await pg.exec("BEGIN");
    try {
      const r = await fn({ query: (t, p = []) => pg.query(t, p) });
      await pg.exec("COMMIT");
      return r;
    } catch (e) {
      await pg.exec("ROLLBACK");
      throw e;
    }
  },
};

const Module = require("module");
const STUBS = {
  __DB_SHIM__: dbShim,
  __REPORT_STUB__: {
    generateAirlinePDF: async () => Buffer.from(""),
    generatePDFReport: async () => Buffer.from(""),
    generateExcelReport: async () => Buffer.from(""),
  },
  __AI_STUB__: { extractTicketData: async () => ({}) },
  __MAIL_STUB__: { sendOTPEmail: async () => true },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (typeof req === "string") {
    if (req.endsWith("config/db")) return "__DB_SHIM__";
    if (req.endsWith("services/reportService")) return "__REPORT_STUB__";
    if (req.endsWith("services/aiExtraction")) return "__AI_STUB__";
    if (req.endsWith("services/emailService")) return "__MAIL_STUB__";
  }
  return origResolve.call(this, req, parent, ...rest);
};
for (const [id, exports] of Object.entries(STUBS))
  require.cache[id] = { id, filename: id, loaded: true, exports };

const ticketC = require(`${SERVER}/controllers/ticketController.js`);
const airlineC = require(`${SERVER}/controllers/airlineController.js`);
const accountC = require(`${SERVER}/controllers/accountController.js`);
const financialsC = require(`${SERVER}/controllers/financialsController.js`);

const biz = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('E','e@x.c') RETURNING id`)).rows[0].id;
const user = (await pg.query(
  `INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`, [biz])).rows[0].id;
const A = Object.fromEntries(
  (await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`, [biz])).rows.map((r) => [r.name, r.id]));

const ctx = { businessId: biz, user: { id: user, role: "admin" } };
const mkRes = () => { const r = { code: 200, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); return r; };
const call = async (fn, req) => { const res = mkRes(); let err = null; await fn({ ...ctx, ...req }, res, e => (err = e)); if (err) throw err; return res; };

// ── Sell a ticket: 500, costs 400, customer pays all 500 into Cash ─────────
const t = await call(ticketC.createTicket, {
  body: {
    ticket_type: "LOCAL", passenger_name: "Ayaan", contact_number: "0611",
    from_city: "MGQ", to_city: "HGA", flight_date: "2026-09-01",
    airline_name: "Star Air", cost_price: 400, selling_price: 500,
    amount_paid: 500, account_id: A["Cash"],
  },
});
const ticketId = t.body.data.id;
ck("ticket sold", t.code === 201);

// Pay the airline its 400 out of Premier Bank
const airlineId = (await pg.query(`SELECT id FROM airlines WHERE business_id=$1 LIMIT 1`, [biz])).rows[0].id;
await call(airlineC.payAirline, {
  params: { id: airlineId },
  body: { amount: 400, account_id: A["Premier Bank"] },
});

const before = Number((await pg.query(
  `SELECT COALESCE(SUM(balance),0) s FROM v_account_balance WHERE business_id=$1`, [biz])).rows[0].s);
ck("before cancelling, accounts hold 100", m2(before) === "100.00", m2(before));

// ── Cancel: refund 350, keep 150; airline returns 300 ──────────────────────
const c = await call(ticketC.cancelTicket, {
  params: { id: ticketId },
  body: {
    refund_amount: 350, airline_refund: 300,
    account_id: A["Cash"], airline_account_id: A["Premier Bank"],
    reason: "Passenger changed plans",
  },
});
ck("cancel succeeded", c.code === 200, `HTTP ${c.code}`);

const tk = (await pg.query(`SELECT * FROM tickets WHERE id=$1`, [ticketId])).rows[0];
ck("ticket marked cancelled", tk.status === "cancelled", tk.status);
ck("fee recorded as 150", m2(tk.cancellation_fee) === "150.00", m2(tk.cancellation_fee));
ck("refund recorded as 350", m2(tk.refunded_amount) === "350.00", m2(tk.refunded_amount));
ck("amount_paid now equals the fee kept", m2(tk.amount_paid) === "150.00", m2(tk.amount_paid));

// Payment rows must still add up to what the ticket says
const rows = Number((await pg.query(
  `SELECT COALESCE(SUM(amount),0) s FROM ticket_payments WHERE ticket_id=$1`, [ticketId])).rows[0].s);
ck("payment history matches the ticket", m2(rows) === m2(tk.amount_paid), `${m2(rows)} vs ${m2(tk.amount_paid)}`);

// ── Balances ───────────────────────────────────────────────────────────────
const bal = Object.fromEntries((await pg.query(
  `SELECT name, balance FROM v_account_balance WHERE business_id=$1`, [biz])).rows.map(r => [r.name, Number(r.balance)]));
ck("Cash: 500 in, 350 refunded out = 150", m2(bal["Cash"]) === "150.00", m2(bal["Cash"]));
ck("Premier Bank: 400 out, 300 back = −100", m2(bal["Premier Bank"]) === "-100.00", m2(bal["Premier Bank"]));

const after = Object.values(bal).reduce((a, b) => a + b, 0);
ck("accounts now hold 50", m2(after) === "50.00", m2(after));

// The identity that must always hold
const flow = (await pg.query(
  `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='in'),0) tin,
          COALESCE(SUM(amount) FILTER (WHERE direction='out'),0) tout
     FROM v_cash_ledger WHERE business_id=$1 AND account_id IS NOT NULL`, [biz])).rows[0];
ck("balances still equal money in minus money out",
   m2(after) === m2(Number(flow.tin) - Number(flow.tout)),
   `${m2(after)} vs ${m2(Number(flow.tin) - Number(flow.tout))}`);

// ── The ledger must read correctly, not show negatives ─────────────────────
const led = (await pg.query(
  `SELECT source, direction, amount FROM v_cash_ledger WHERE business_id=$1 ORDER BY source, direction`, [biz])).rows;
ck("no negative amounts anywhere in the ledger", led.every(r => Number(r.amount) > 0));
ck("the customer refund shows as money OUT",
   led.some(r => r.source === "ticket" && r.direction === "out" && m2(r.amount) === "350.00"));
ck("the airline refund shows as money IN",
   led.some(r => r.source === "airline" && r.direction === "in" && m2(r.amount) === "300.00"));

// ── Reporting ──────────────────────────────────────────────────────────────
const pl = await call(financialsC.getProfitLoss, { query: {} });
const d = pl.body.data;
ck("cancelled sale removed from gross sales", m2(d.revenue.ticket_sales) === "0.00", m2(d.revenue.ticket_sales));
ck("fee kept appears as other income", m2(d.cancellations.fees_kept) === "150.00", m2(d.cancellations.fees_kept));
// A 150 fee kept, less the 100 of fare the airline never returned, so the
// cancellation earned 50. This read 150 before the unrecovered fare was
// counted — the books looked better for losing money. 50 is also exactly
// what the accounts hold, which is the check that matters.
ck("net profit nets the fee against the fare lost", m2(d.net_profit) === "50.00", m2(d.net_profit));
ck("net profit equals what the accounts actually hold", m2(d.net_profit) === m2(after), `${m2(d.net_profit)} vs ${m2(after)}`);

// ── Guards ─────────────────────────────────────────────────────────────────
let blocked = false;
try {
  await call(ticketC.cancelTicket, { params: { id: ticketId }, body: { refund_amount: 10 } });
} catch { blocked = true; }
const second = await call(ticketC.cancelTicket, { params: { id: ticketId }, body: { refund_amount: 10 } }).catch(() => ({ code: 400 }));
ck("cancelling twice is refused", blocked || second.code === 400);

const acc = await call(accountC.getAccounts, { query: {} });
ck("accounts screen agrees with the database",
   m2(acc.body.data.summary.total_balance) === m2(after),
   `${m2(acc.body.data.summary.total_balance)} vs ${m2(after)}`);

console.log(`\nPASS (${pass.length})`);
pass.forEach(p => console.log("  ✓ " + p));
if (fail.length) {
  console.log(`\nFAIL (${fail.length})`);
  fail.forEach(f => console.log("  ✗ " + f));
  console.log("\nbalances:", Object.entries(bal).map(([k, v]) => `${k}=${m2(v)}`).join("  "));
  process.exit(1);
}
console.log(`\nAll ${pass.length} refund checks passed — real controllers, real PostgreSQL.`);
