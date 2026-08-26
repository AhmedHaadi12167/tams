// The agency's four rules about cancelled tickets, checked against a real
// PostgreSQL and the real controllers:
//
//   1. The tax is not refundable — it survives the cancellation.
//   2. A refund and a write-off on the same ticket must both be visible.
//   3. Refund everything and the ticket's revenue must read zero.
//   4. Keep a fee and that fee must appear in the revenue column, matching
//      what the income statement already reports.
//
// Rules 3 and 4 are really one claim: the sum of the cancelled tickets'
// revenue equals the income statement's net from cancellations. If those two
// ever disagree, one of the screens is lying, and the last check here is the
// one that would catch it.
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const SERVER = "/sessions/awesome-festive-mccarthy/mnt/tams/server";
const pass = [], fail = [];
const ck = (n, ok, d = "") => (ok ? pass : fail).push(n + (d ? ` — ${d}` : ""));
const m2 = (v) => Number(v).toFixed(2);

const pg = await PGlite.create();
await pg.exec(`CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`);
const strip = (s) => s.replace(/CREATE EXTENSION[^;]*;/gi, "");
await pg.exec(strip(fs.readFileSync("cfg/schema.sql", "utf8")));

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

const ticketC = require(`${SERVER}/controllers/ticketController.js`);
const airlineC = require(`${SERVER}/controllers/airlineController.js`);
const taxC = require(`${SERVER}/controllers/taxController.js`);
const finC = require(`${SERVER}/controllers/financialsController.js`);

const biz = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('R','r@x.c') RETURNING id`)).rows[0].id;
const user = (await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`, [biz])).rows[0].id;
const A = Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`, [biz])).rows.map((r) => [r.name, r.id]));
const ctx = { businessId: biz, user: { id: user, role: "admin" } };
const mkRes = () => { const r = { code: 200, body: null }; r.status = (c) => ((r.code = c), r); r.json = (b) => ((r.body = b), r); return r; };
const call = async (fn, req) => { const res = mkRes(); let err = null; await fn({ ...ctx, ...req }, res, (e) => (err = e)); if (err) throw err; return res; };

const book = async (o) =>
  (await call(ticketC.createTicket, {
    body: { ticket_type: "LOCAL", contact_number: "061", from_city: "MGQ", to_city: "NBO",
            flight_date: "2026-10-01", account_id: A["Cash"], ...o },
  })).body.data;

// Settle an airline in full so there is something for it to refund later.
const payAirline = async (name) => {
  const id = (await pg.query(`SELECT id FROM airlines WHERE business_id=$1 AND name=$2`, [biz, name])).rows[0].id;
  await call(airlineC.payAirline, { params: { id }, body: { account_id: A["Premier Bank"] } });
  return id;
};

const ticket = async (id) => (await pg.query(`SELECT * FROM tickets WHERE id=$1`, [id])).rows[0];

// ── Rule 1 + 3: refund everything refundable, keep nothing ─────────────────
// Cost 500 of which 80 is government tax. Sold for 700, paid in full.
const t1 = await book({ passenger_name: "Fully refunded", airline_name: "Star Airline",
                        cost_price: 500, tax: 80, selling_price: 700, amount_paid: 700 });
await payAirline("Star Airline");

let refused;
try {
  refused = await call(ticketC.cancelTicket, { params: { id: t1.id },
    body: { refund_amount: 700, airline_refund: 420, account_id: A["Cash"], airline_account_id: A["Cash"] } });
} catch (e) { refused = { code: 500, body: { message: e.message } }; }
ck("refunding the tax as well is refused", refused.code === 400,
   refused.body?.message?.slice(0, 70));

await call(ticketC.cancelTicket, { params: { id: t1.id },
  body: { refund_amount: 620, airline_refund: 420, account_id: A["Cash"], airline_account_id: A["Cash"] } });

const T1 = await ticket(t1.id);
ck("the refundable 620 went back", m2(T1.refunded_amount) === "620.00", m2(T1.refunded_amount));
ck("refunding everything leaves no revenue", m2(T1.revenue) === "0.00", m2(T1.revenue));

const tax1 = (await call(taxC.getTaxAccount, { query: {} })).body.data.summary;
ck("the tax survives the cancellation", m2(tax1.tax_owed) === "80.00", m2(tax1.tax_owed));
ck("the tax kept back is not counted as a cancellation fee",
   m2(T1.cancellation_fee) === "0.00", m2(T1.cancellation_fee));

// ── Rule 4: a fee kept is revenue ─────────────────────────────────────────
const t2 = await book({ passenger_name: "Fee kept", airline_name: "Jubba Airways",
                        cost_price: 200, selling_price: 300, amount_paid: 300 });
await payAirline("Jubba Airways");
await call(ticketC.cancelTicket, { params: { id: t2.id },
  body: { refund_amount: 250, airline_refund: 200, account_id: A["EVC"], airline_account_id: A["EVC"] } });

const T2 = await ticket(t2.id);
ck("the 50 kept shows as the ticket's revenue", m2(T2.revenue) === "50.00", m2(T2.revenue));

// ── Rule 2: refunded AND written off, both visible ────────────────────────
const t3 = await book({ passenger_name: "Part refund, rest written off", airline_name: "Daallo",
                        cost_price: 100, selling_price: 400, amount_paid: 200 });
await call(ticketC.cancelTicket, { params: { id: t3.id },
  body: { refund_amount: 50, airline_refund: 0, write_off: true, account_id: A["Cash"] } });

const T3 = await ticket(t3.id);
ck("the part refund is recorded", m2(T3.refunded_amount) === "50.00", m2(T3.refunded_amount));
ck("the balance written off is recorded alongside it",
   m2(T3.written_off) === "200.00", m2(T3.written_off));
ck("both are non-zero on the same ticket, so the screen can show both",
   Number(T3.refunded_amount) > 0 && Number(T3.written_off) > 0);
ck("nothing was paid to the airline, so nothing was lost there",
   m2(T3.revenue) === "150.00", m2(T3.revenue));

// ── Rule 1, the exception: the airline gave the tax back too ──────────────
const t4 = await book({ passenger_name: "Airline cancelled the flight", airline_name: "Turkish",
                        cost_price: 300, tax: 60, selling_price: 400, amount_paid: 400 });
await payAirline("Turkish");
await call(ticketC.cancelTicket, { params: { id: t4.id },
  body: { refund_amount: 400, airline_refund: 240, refund_tax: true,
          account_id: A["Cash"], airline_account_id: A["Cash"] } });

const T4 = await ticket(t4.id);
ck("the returned tax is recorded", m2(T4.tax_refunded) === "60.00", m2(T4.tax_refunded));
const tax2 = (await call(taxC.getTaxAccount, { query: {} })).body.data.summary;
ck("a tax the airline returned is no longer owed",
   m2(tax2.tax_owed) === "80.00", `owed ${m2(tax2.tax_owed)}, expected only ticket 1's 80`);

// ── The reported bug: cancelling a ticket you never paid for ─────────────
// Customer paid 60 of a 170 ticket, the agency had not paid the 160 fare.
// Refund the 60, forgive the 110. The airline cannot return money it was
// never sent, so the agency is out nothing and the revenue is zero — it read
// -160 before, because the whole fare was treated as lost.
const t5 = await book({ passenger_name: "Never paid the airline", airline_name: "Freedom Airline",
                        cost_price: 160, selling_price: 170, amount_paid: 60 });
await call(ticketC.cancelTicket, { params: { id: t5.id },
  body: { refund_amount: 60, airline_refund: 0, write_off: true, account_id: A["Cash"] } });

const T5 = await ticket(t5.id);
ck("a ticket the airline was never paid for loses nothing",
   m2(T5.revenue) === "0.00", m2(T5.revenue));
ck("the 110 balance was forgiven", m2(T5.written_off) === "110.00", m2(T5.written_off));

const freedom = (await pg.query(
  `SELECT total_cost, total_paid, balance FROM v_airline_account
    WHERE business_id=$1 AND airline_name='Freedom Airline'`, [biz])).rows[0];
ck("and the airline is not left owed for a seat nobody took",
   m2(freedom.balance) === "0.00",
   `cost ${m2(freedom.total_cost)}, paid ${m2(freedom.total_paid)}, balance ${m2(freedom.balance)}`);

// ── Rule 2, second half: retained tax is not a fee ────────────────────────
// Cost 100 of which 10 is tax, sold for 200, paid in full, airline unpaid.
// Refunding the maximum leaves exactly the tax in hand — which is held, not
// earned, and must not show up as a cancellation fee.
const t6 = await book({ passenger_name: "Only the tax left", airline_name: "Halla",
                        cost_price: 100, tax: 10, selling_price: 200, amount_paid: 200 });
await call(ticketC.cancelTicket, { params: { id: t6.id },
  body: { refund_amount: 190, airline_refund: 0, account_id: A["Cash"] } });

const T6 = await ticket(t6.id);
ck("the tax held back is not booked as a fee",
   m2(T6.cancellation_fee) === "0.00", m2(T6.cancellation_fee));
ck("the money kept is still recorded in full",
   m2(T6.amount_paid) === "10.00", m2(T6.amount_paid));
ck("so the ticket earned nothing", m2(T6.revenue) === "0.00", m2(T6.revenue));

// ── The two screens have to agree ─────────────────────────────────────────
const pl = (await call(finC.getProfitLoss, { query: {} })).body.data;
const sumRevenue = (await pg.query(
  `SELECT COALESCE(SUM(revenue),0) s FROM tickets WHERE business_id=$1 AND status='cancelled'`, [biz],
)).rows[0].s;

ck("net from cancellations equals the sum of the cancelled tickets' revenue",
   m2(pl.cancellations.net) === m2(sumRevenue),
   `statement ${m2(pl.cancellations.net)} vs tickets ${m2(sumRevenue)}`);

ck("written-off balances are reported but not subtracted twice",
   m2(pl.cancellations.written_off) === "310.00" &&
   m2(pl.cancellations.net) === m2(Number(pl.cancellations.fees_kept) - Number(pl.cancellations.unrecovered_cost)),
   `written off ${m2(pl.cancellations.written_off)}`);

ck("the tax still owed is disclosed on the statement",
   m2(pl.tax.collected) === "90.00", m2(pl.tax.collected));
ck("no cancellation booked a fare the agency never paid",
   m2(pl.cancellations.unrecovered_cost) === "0.00",
   m2(pl.cancellations.unrecovered_cost));

// ── And the money still adds up ───────────────────────────────────────────
const bal = Number((await pg.query(`SELECT COALESCE(SUM(balance),0) s FROM v_account_balance WHERE business_id=$1`, [biz])).rows[0].s);
const flow = (await pg.query(
  `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='in'),0) i,
          COALESCE(SUM(amount) FILTER (WHERE direction='out'),0) o
     FROM v_cash_ledger WHERE business_id=$1 AND account_id IS NOT NULL`, [biz])).rows[0];
ck("accounts still equal money in minus money out",
   m2(bal) === m2(Number(flow.i) - Number(flow.o)), `${m2(bal)} vs ${m2(Number(flow.i) - Number(flow.o))}`);

// ── An older migration must not undo the newer one ────────────────────────
for (const old of ["migration_v15.sql", "migration_v17.sql"])
  await pg.exec(strip(fs.readFileSync(`cfg/${old}`, "utf8")));
const tax3 = (await call(taxC.getTaxAccount, { query: {} })).body.data.summary;
ck("re-running v15 does not forgive the cancelled ticket's tax",
   m2(tax3.tax_owed) === "90.00", m2(tax3.tax_owed));

console.log(`\nPASS (${pass.length})`); pass.forEach((p) => console.log("  ✓ " + p));
if (fail.length) { console.log(`\nFAIL (${fail.length})`); fail.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("\nAll four rules hold, and the tickets and the income statement agree.");
