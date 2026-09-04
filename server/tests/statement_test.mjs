// The customer statement has to show the deposit — without counting it twice.
//
// A deposit is the easiest number in this system to double-count. When it is
// spent, depositService writes a real payment row on the booking, so the
// money is already inside the invoice's "received" line. Add the deposit to
// that line as well and the invoice claims twice the money that ever arrived
// — the customer reads it, disputes it, and the agency has no answer.
//
// So the rule this file guards is arithmetic, not presentation:
//
//     sales − received = balance          (unchanged, deposit or not)
//     balance − held   = net due          (the deposit only nets off here)
//
// The worked example is the one the agency asked for: $400 handed over, $210
// spent, $190 still held.
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
const customerC = require(`${SERVER}/controllers/customerController.js`);

const biz  = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('Mubah','m@x.c') RETURNING id`)).rows[0].id;
await seedAccounts(pg, biz);
const user = (await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`, [biz])).rows[0].id;
const A = Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`, [biz])).rows.map(r => [r.name, r.id]));
const ctx = { businessId: biz, user: { id: user, role: "admin" } };
const mkRes = () => { const r = { code: 200, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); return r; };
const call = async (fn, req) => { const res = mkRes(); let err = null; await fn({ ...ctx, ...req }, res, e => err = e); if (err) throw err; return res; };

const statement = async (id) =>
  (await call(customerC.getCustomerStatement, { params: { id }, query: {} })).body.data;
const cashTotal = async () =>
  Number((await pg.query(`SELECT COALESCE(SUM(balance),0) s FROM v_account_balance WHERE business_id=$1`, [biz])).rows[0].s);

// ── A customer with nothing on deposit ────────────────────────────────────
//
// First, the case that must not change. Every invoice printed before today
// had three totals and no deposit line, and adding the feature must not
// alter a single figure on them.
const plain = (await call(customerC.createCustomer, { body: { name: "Plain", phone: "0611000001" } })).body.data;
await call(ticketC.createTicket, { body: {
  ticket_type: "INTERNATIONAL", passenger_name: "Plain", contact_number: "0611000001",
  customer_id: plain.id, from_city: "MGQ", to_city: "DXB", flight_date: "2027-03-01",
  airline_name: "Star Airline", cost_price: 300, selling_price: 500,
  amount_paid: 200, account_id: A["Cash"],
} });

const p1 = (await statement(plain.id)).summary;
ck("no deposit, no change: sales", m2(p1.total_amount) === "500.00", m2(p1.total_amount));
ck("no deposit, no change: received", m2(p1.total_paid) === "200.00", m2(p1.total_paid));
ck("no deposit, no change: balance", m2(p1.total_balance) === "300.00", m2(p1.total_balance));
ck("a customer with no deposit is shown holding nothing",
   m2(p1.deposit_held) === "0.00", m2(p1.deposit_held));
ck("and their net due is simply the balance",
   m2(p1.net_due) === m2(p1.total_balance), `${m2(p1.net_due)} vs ${m2(p1.total_balance)}`);

// ── The agency's worked example: 400 in, 210 used, 190 held ───────────────
const cust = (await call(customerC.createCustomer, { body: { name: "Nuur", phone: "0615000222" } })).body.data;

await call(customerC.addDeposit, {
  params: { id: cust.id },
  body: { amount: 400, account_id: A["Cash"], note: "Advance" },
});

const cashAfterDeposit = await cashTotal();

const tk = (await call(ticketC.createTicket, { body: {
  ticket_type: "LOCAL", passenger_name: "Nuur", contact_number: "0615000222",
  customer_id: cust.id, from_city: "MGQ", to_city: "HGA", flight_date: "2027-04-01",
  airline_name: "Star Airline", cost_price: 120, selling_price: 210,
  amount_paid: 0, account_id: A["Cash"],
} })).body.data;

const d0 = (await statement(cust.id)).summary;
ck("before it is spent, the whole deposit is held",
   m2(d0.deposit_held) === "400.00", m2(d0.deposit_held));
ck("and it already cancels out what is owed",
   m2(d0.net_due) === "-190.00", m2(d0.net_due));

const used = (await call(customerC.applyDepositToBooking, {
  params: { id: cust.id },
  body: { kind: "ticket", record_id: tk.id },
})).body.data;
ck("only what the ticket cost is taken", m2(used.applied) === "210.00", m2(used.applied));

const st = await statement(cust.id);
const s = st.summary;

ck("deposit received is reported in full", m2(s.deposit_taken) === "400.00", m2(s.deposit_taken));
ck("what has been spent is reported", m2(s.deposit_applied) === "210.00", m2(s.deposit_applied));
ck("and 190 is still held — the agency's example, exactly",
   m2(s.deposit_held) === "190.00", m2(s.deposit_held));

// THE DOUBLE-COUNT GUARD.
//
// The 210 must appear once, as a receipt against the ticket. If the deposit
// were also folded into "received", this would read 420 against a 210 sale.
ck("the spent deposit is counted once, not twice",
   m2(s.total_paid) === "210.00", m2(s.total_paid));
ck("the ticket is settled, so nothing is owed on it",
   m2(s.total_balance) === "0.00", m2(s.total_balance));
ck("sales − received = balance still holds with a deposit in play",
   m2(Number(s.total_amount) - Number(s.total_paid)) === m2(s.total_balance),
   `${m2(s.total_amount)} − ${m2(s.total_paid)} vs ${m2(s.total_balance)}`);
ck("balance − held = net due",
   m2(Number(s.total_balance) - Number(s.deposit_held)) === m2(s.net_due),
   m2(s.net_due));
ck("so the invoice says the agency owes 190 back, not that 190 is due",
   Number(s.net_due) === -190, m2(s.net_due));

ck("the statement carries the deposit block for the printer",
   st.deposit && m2(st.deposit.held) === "190.00", JSON.stringify(st.deposit));

// Spending a deposit moves no cash — the invoice's figures must not imply
// otherwise, and the accounts must not have moved.
ck("spending the deposit moved no money between accounts",
   m2(await cashTotal()) === m2(cashAfterDeposit),
   `${m2(await cashTotal())} vs ${m2(cashAfterDeposit)}`);
const inLedger = (await pg.query(
  `SELECT COUNT(*)::INT n FROM v_cash_ledger WHERE business_id=$1 AND source='ticket' AND source_id=$2`,
  [biz, tk.id])).rows[0].n;
ck("and the cash ledger never saw the applied deposit", inLedger === 0, String(inLedger));

// ── A second booking eats into the rest ───────────────────────────────────
const vs = (await call(visaC.createVisa, { body: {
  applicant_name: "Nuur", contact_number: "0615000222", customer_id: cust.id,
  destination_country: "Turkey", visa_type: "tourist",
  cost_price: 100, selling_price: 300, amount_paid: 0,
} })).body.data;

await call(customerC.applyDepositToBooking, {
  params: { id: cust.id }, body: { kind: "visa", record_id: vs.id },
});

const s2 = (await statement(cust.id)).summary;
ck("a deposit too small to settle a booking pays what it can",
   m2(s2.deposit_applied) === "400.00", m2(s2.deposit_applied));
ck("nothing is left on deposit", m2(s2.deposit_held) === "0.00", m2(s2.deposit_held));
ck("the visa is part-paid from it",
   m2(s2.total_paid) === "400.00", m2(s2.total_paid));
ck("and the customer now genuinely owes the shortfall",
   m2(s2.total_balance) === "110.00" && m2(s2.net_due) === "110.00",
   `${m2(s2.total_balance)} / ${m2(s2.net_due)}`);
ck("sales − received = balance, still",
   m2(Number(s2.total_amount) - Number(s2.total_paid)) === m2(s2.total_balance));

// ── A refunded deposit reduces what is held ──────────────────────────────
const other = (await call(customerC.createCustomer, { body: { name: "Faarax", phone: "0615000333" } })).body.data;
await call(customerC.addDeposit, { params: { id: other.id }, body: { amount: 250, account_id: A["Cash"] } });
await call(customerC.addDeposit, { params: { id: other.id }, body: { amount: -100, account_id: A["Cash"] } });

const s3 = (await statement(other.id)).summary;
ck("money handed back comes off the deposit",
   m2(s3.deposit_held) === "150.00", m2(s3.deposit_held));
ck("a customer holding a deposit and owing nothing is in credit",
   m2(s3.net_due) === "-150.00", m2(s3.net_due));

// ── Selecting some passengers must not lose the deposit ──────────────────
//
// A partial invoice recomputes its own totals in the browser. The deposit is
// a fact about the customer, not the ticked rows, so it has to survive that.
const partial = (await call(customerC.getCustomerStatement, {
  params: { id: cust.id }, query: { ticket_ids: "" },
})).body.data;
ck("a statement for none of the tickets still reports the deposit",
   m2(partial.summary.deposit_taken) === "400.00",
   m2(partial.summary.deposit_taken));

console.log(`\nPASS (${pass.length})`); pass.forEach(p => console.log("  ✓ " + p));
if (fail.length) { console.log(`\nFAIL (${fail.length})`); fail.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
console.log("\nThe deposit shows on the statement, and is counted exactly once.");
