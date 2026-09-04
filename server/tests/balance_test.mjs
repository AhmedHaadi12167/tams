// Cash & bank must be what the bank holds.
//
// The balance sheet used to derive cash by subtracting the cost price typed
// on every visa and package, as if the embassy had already been paid. One
// $1,900 visa fee therefore removed $1,900 from the agency's cash while the
// money sat untouched in Salaam Bank: the sheet read $130 where the Accounts
// page read $2,030. This pins cash to the ledger and checks the sheet still
// balances once suppliers, deposits and cargo costs are in play.
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
const accountC  = require(`${SERVER}/controllers/accountController.js`);
const supplierC = require(`${SERVER}/controllers/supplierController.js`);
const customerC = require(`${SERVER}/controllers/customerController.js`);

const biz  = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('Bal','bal@x.c') RETURNING id`)).rows[0].id;
await seedAccounts(pg, biz);
const user = (await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`, [biz])).rows[0].id;
const A = Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`, [biz])).rows.map(r => [r.name, r.id]));
const ctx = { businessId: biz, user: { id: user, role: "admin" } };
const mkRes = () => { const r = { code: 200, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); return r; };
const call = async (fn, req) => { const res = mkRes(); let err = null; await fn({ ...ctx, ...req }, res, e => err = e); if (err) throw err; return res; };

const sheet = async () => (await call(finC.getBalanceSheet, { query: {} })).body.data;
const accountsTotal = async () =>
  Number((await pg.query(`SELECT COALESCE(SUM(balance),0) s FROM v_account_balance WHERE business_id=$1`, [biz])).rows[0].s);

// ── The reported bug, reproduced ──────────────────────────────────────────
// A visa sold for 2,400 with a 1,900 embassy fee, paid for in full by the
// customer. Nothing has been sent to the embassy yet.
const visa = (await call(visaC.createVisa, { body: {
  applicant_name: "Ismail", destination_country: "UAE", visa_type: "tourist",
  cost_price: 1900, selling_price: 2400, amount_paid: 2400,
  account_id: A["Salaam Bank"],
} })).body.data;

const s1 = await sheet();
ck("cash is what the accounts hold, not a guess",
   m2(s1.assets.cash_and_bank) === m2(await accountsTotal()),
   `sheet ${m2(s1.assets.cash_and_bank)} vs accounts ${m2(await accountsTotal())}`);
ck("the 2,400 collected is all there",
   m2(s1.assets.cash_and_bank) === "2400.00", m2(s1.assets.cash_and_bank));
ck("the unpaid embassy fee is a liability, not missing cash",
   m2(s1.liabilities.payable_to_suppliers) === "1900.00",
   m2(s1.liabilities.payable_to_suppliers));
ck("and the sheet balances", m2(s1.difference) === "0.00", m2(s1.difference));

// ── Pay the embassy ───────────────────────────────────────────────────────
const owed = (await call(supplierC.getSupplierAccount, { params: { kind: "visa" }, query: {} })).body.data;
ck("the visa shows on the supplier page as owed",
   m2(owed.summary.total_owed) === "1900.00", m2(owed.summary.total_owed));

await call(supplierC.paySupplier, {
  params: { kind: "visa", id: visa.id },
  body: { amount: 900, account_id: A["Salaam Bank"] },
});

const s2 = await sheet();
ck("a part payment leaves the rest owed",
   m2(s2.liabilities.payable_to_suppliers) === "1000.00",
   m2(s2.liabilities.payable_to_suppliers));
ck("and it really left the bank",
   m2(s2.assets.cash_and_bank) === "1500.00", m2(s2.assets.cash_and_bank));
ck("cash still equals the accounts page",
   m2(s2.assets.cash_and_bank) === m2(await accountsTotal()));
ck("still balances after a part payment", m2(s2.difference) === "0.00", m2(s2.difference));

const over = await (async () => {
  const res = mkRes(); let err = null;
  await supplierC.paySupplier({ ...ctx, params: { kind: "visa", id: visa.id },
    body: { amount: 5000, account_id: A["Salaam Bank"] } }, res, e => err = e);
  return err ? { code: err.statusCode } : { code: res.code };
})();
ck("paying more than is owed is refused", over.code === 400, String(over.code));

// ── Cargo with a real carrier cost ────────────────────────────────────────
const cargo = (await call(cargoC.createCargo, { body: {
  sender_name: "Sender", receiver_name: "Receiver",
  from_city: "MGQ", to_city: "HGA",
  // $20 a kilo of which the agency keeps $6 — the way the price is
  // actually quoted. 10 kg therefore earns 60 and costs 140.
  weight_kg: 10, price_per_kg: 20, profit_per_kg: 6,
  amount_paid: 200, account_id: A["EVC"],
} })).body.data;

ck("the per-kilo margin becomes the shipment's margin",
   m2(cargo.profit_total) === "60.00", m2(cargo.profit_total));

const pl = (await call(finC.getProfitLoss, { query: {} })).body.data;
ck("cargo is no longer treated as pure profit",
   m2(pl.cost_of_sales.cargo_carriers) === "140.00",
   m2(pl.cost_of_sales.cargo_carriers));

const s3 = await sheet();
ck("the carrier's 140 is owed too",
   m2(s3.liabilities.payable_to_suppliers) === "1140.00",
   m2(s3.liabilities.payable_to_suppliers));
ck("still balances with cargo in play", m2(s3.difference) === "0.00", m2(s3.difference));

// ── A deposit from a customer who owes nothing ────────────────────────────
const cust = (await call(customerC.createCustomer, { body: {
  name: "Walk-in", phone: "0615000111",
} })).body.data;

const dup = await (async () => {
  const res = mkRes(); let err = null;
  await customerC.createCustomer({ ...ctx, body: { name: "Same person", phone: "+252 615 000 111" } }, res, e => err = e);
  return err ? { code: 500 } : { code: res.code };
})();
ck("the same phone number is not filed twice", dup.code === 409, String(dup.code));

await call(customerC.addDeposit, {
  params: { id: cust.id },
  body: { amount: 300, account_id: A["Cash"], note: "Holding for Umrah" },
});

const s4 = await sheet();
ck("a deposit is cash the agency holds",
   m2(s4.assets.cash_and_bank) === m2(await accountsTotal()),
   m2(s4.assets.cash_and_bank));
ck("and money it owes back, not revenue",
   m2(s4.liabilities.customer_deposits) === "300.00",
   m2(s4.liabilities.customer_deposits));
ck("a deposit earns nothing until it is used",
   m2((await call(finC.getProfitLoss, { query: {} })).body.data.revenue.gross_sales) ===
     m2(pl.revenue.gross_sales));
ck("still balances with a deposit held", m2(s4.difference) === "0.00", m2(s4.difference));

const tooMuchBack = await (async () => {
  const res = mkRes(); let err = null;
  await customerC.addDeposit({ ...ctx, params: { id: cust.id },
    body: { amount: -500, account_id: A["Cash"] } }, res, e => err = e);
  return err ? { code: err.statusCode } : { code: res.code };
})();
ck("handing back more than is held is refused", tooMuchBack.code === 400, String(tooMuchBack.code));

// ── Spending the deposit must move no cash ───────────────────────────────
//
// The $300 arrived when the deposit was taken and is already in the drawer.
// Applying it to a ticket changes what the agency owes, not where the money
// is. If it were recorded as an ordinary payment the same $300 would be
// counted twice and every balance it touched would inflate.
const cashBefore = await accountsTotal();

const tk = (await call(ticketC.createTicket, { body: {
  ticket_type: "LOCAL", passenger_name: "Walk-in", contact_number: "0615000111",
  customer_id: cust.id,
  from_city: "MGQ", to_city: "NBO", flight_date: "2027-02-01",
  airline_name: "Star Airline", cost_price: 100, selling_price: 250,
  amount_paid: 0, account_id: A["Cash"],
} })).body.data;

const used = (await call(customerC.applyDepositToBooking, {
  params: { id: cust.id },
  body: { kind: "ticket", record_id: tk.id },
})).body.data;

ck("only what the booking owed is taken from the deposit",
   m2(used.applied) === "250.00", m2(used.applied));
ck("the rest stays on deposit", m2(used.remaining) === "50.00", m2(used.remaining));

const paidTk = (await pg.query(`SELECT amount_paid, payment_status FROM tickets WHERE id=$1`, [tk.id])).rows[0];
ck("the ticket is now paid", m2(paidTk.amount_paid) === "250.00" && paidTk.payment_status === "paid",
   `${m2(paidTk.amount_paid)} ${paidTk.payment_status}`);

ck("and not one shilling moved between accounts",
   m2(await accountsTotal()) === m2(cashBefore),
   `${m2(await accountsTotal())} vs ${m2(cashBefore)}`);

const s5 = await sheet();
ck("cash on the sheet is unchanged too",
   m2(s5.assets.cash_and_bank) === m2(cashBefore), m2(s5.assets.cash_and_bank));
ck("the deposit liability fell by what was spent",
   m2(s5.liabilities.customer_deposits) === "50.00",
   m2(s5.liabilities.customer_deposits));
ck("and the sheet still balances", m2(s5.difference) === "0.00", m2(s5.difference));

// amount_paid has to equal the sum of the booking's payments, or the
// diagnostic that hunts for orphaned money starts reporting this ticket.
const sumPay = (await pg.query(
  `SELECT COALESCE(SUM(amount),0) s FROM ticket_payments WHERE ticket_id=$1`, [tk.id])).rows[0].s;
ck("the payment row exists, so amount_paid is not a lie",
   m2(sumPay) === "250.00", m2(sumPay));

// But it must not be in the cash ledger.
const inLedger = (await pg.query(
  `SELECT COUNT(*)::INT n FROM v_cash_ledger WHERE business_id=$1 AND source='ticket' AND source_id=$2`,
  [biz, tk.id])).rows[0].n;
ck("yet the cash ledger has never heard of it", inLedger === 0, String(inLedger));

const spentTwice = await (async () => {
  const res = mkRes(); let err = null;
  await customerC.applyDepositToBooking({ ...ctx, params: { id: cust.id },
    body: { kind: "ticket", record_id: tk.id } }, res, e => err = e);
  return err ? { code: err.statusCode } : { code: res.code };
})();
ck("a booking already paid takes nothing more", spentTwice.code === 400, String(spentTwice.code));

// ── A deposit must work on every service, not just flights ───────────────
const v2 = (await call(visaC.createVisa, { body: {
  applicant_name: "Walk-in", contact_number: "0615000111",
  destination_country: "Kenya", visa_type: "tourist",
  cost_price: 10, selling_price: 40, amount_paid: 0,
} })).body.data;

ck("a visa applicant is put on file automatically",
   Boolean(v2.customer_id), String(v2.customer_id));
ck("and recognised as the customer who already has a deposit",
   v2.customer_id === cust.id, `${v2.customer_id} vs ${cust.id}`);

const usedOnVisa = (await call(customerC.applyDepositToBooking, {
  params: { id: cust.id },
  body: { kind: "visa", record_id: v2.id },
})).body.data;
ck("the deposit pays for a visa too", m2(usedOnVisa.applied) === "40.00",
   m2(usedOnVisa.applied));

const cargo2 = (await call(cargoC.createCargo, { body: {
  sender_name: "Walk-in", sender_contact: "0615000111",
  receiver_name: "Someone", from_city: "MGQ", to_city: "HGA",
  weight_kg: 1, price_per_kg: 5, amount_paid: 0,
} })).body.data;
ck("a cargo sender is put on file too",
   cargo2.customer_id === cust.id, `${cargo2.customer_id} vs ${cust.id}`);

const cashStill = await accountsTotal();
const usedOnCargo = (await call(customerC.applyDepositToBooking, {
  params: { id: cust.id },
  body: { kind: "cargo", record_id: cargo2.id },
})).body.data;
ck("and pays for a shipment", m2(usedOnCargo.applied) === "5.00", m2(usedOnCargo.applied));
ck("none of which moved any cash",
   m2(await accountsTotal()) === m2(cashStill), m2(await accountsTotal()));

const sAll = await sheet();
ck("the sheet balances after spending on three kinds of booking",
   m2(sAll.difference) === "0.00", m2(sAll.difference));
ck("only the unspent remainder is still owed back",
   m2(sAll.liabilities.customer_deposits) === "5.00",
   m2(sAll.liabilities.customer_deposits));

// ── The list has to show what is being held ─────────────────────────────
const listed = (await call(customerC.getCustomers, { query: { search: "Walk-in" } }))
  .body.data.find((c) => c.id === cust.id);
ck("the customers list carries the remaining deposit",
   m2(listed.deposit_balance) === "5.00", m2(listed.deposit_balance));

// ── And the Accounts page agrees throughout ───────────────────────────────
const acc = (await call(accountC.getAccounts, { query: {} })).body.data;
const sFinal = await sheet();
ck("the Accounts page total is the balance sheet's cash",
   m2(await accountsTotal()) === m2(sFinal.assets.cash_and_bank),
   `${m2(await accountsTotal())} vs ${m2(sFinal.assets.cash_and_bank)}`);

console.log(`\nPASS (${pass.length})`); pass.forEach(p => console.log("  ✓ " + p));
if (fail.length) { console.log(`\nFAIL (${fail.length})`); fail.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
console.log("\nCash & bank is what the bank holds, and the sheet balances.");
