/**
 * owners_journal_test.mjs
 *
 * Owners, the automatic journal and the Excel import, end to end.
 *
 * A month of trading goes through the real controllers — tickets with tax,
 * cancellations, visas, packages, deposits, expenses, transfers with fees,
 * opening balances imported from a spreadsheet, and owners putting capital
 * in and taking drawings out. Then:
 *
 *   - every journal event balances on its own; the trial balance balances
 *   - the journal and the balance sheet agree on cash, net assets, equity,
 *     profit, tax and deposits — two independent calculations, one answer
 *   - each owner's equity = capital + contributions − drawings + share
 *   - all of the above also holds as at an earlier date
 *
 *     cd server/tests && node owners_journal_test.mjs
 */

import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pass = [];
const fail = [];
const ck = (name, ok, detail = "") =>
  (ok ? pass : fail).push(name + (detail !== "" ? ` — ${detail}` : ""));
const m2 = (v) => Number(v).toFixed(2);

// ── Real Postgres ──────────────────────────────────────────────────────────
const pg = await PGlite.create();
await pg.exec(
  `CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`,
);
await pg.exec(
  fs
    .readFileSync(`${SERVER}/config/schema.sql`, "utf8")
    .replace(/CREATE EXTENSION[^;]*;/gi, ""),
);

// Transactions queue behind each other, like FOR UPDATE on the same row.
let chain = Promise.resolve();
const dbShim = {
  query: (t, p = []) => pg.query(t, p),
  withTransaction: (fn) => {
    const run = chain.then(async () => {
      await pg.exec("BEGIN");
      try {
        const r = await fn({ query: (t, p = []) => pg.query(t, p) });
        await pg.exec("COMMIT");
        return r;
      } catch (e) {
        await pg.exec("ROLLBACK");
        throw e;
      }
    });
    chain = run.catch(() => {});
    return run;
  },
};
const Module = require("module");
const orig = Module._resolveFilename;
const S = {
  __DB__: dbShim,
  __RPT__: {
    generateAirlinePDF: async () => Buffer.from(""),
    generatePDFReport: async () => Buffer.from(""),
    generateExcelReport: async () => Buffer.from(""),
    generateCustomerStatementPDF: async () => Buffer.from(""),
  },
  __AI__: { extractTicketData: async () => ({}) },
  __MAIL__: { sendOTPEmail: async () => true },
  // Upload handling and Excel are not what these tests are about, and
  // loading them from a slow disk takes minutes. The import is tested with
  // CSV, which the controller parses itself.
  __MULTER__: Object.assign(() => ({ single: () => (req, res, cb) => cb() }), { memoryStorage: () => ({}) }),
  __EXCEL__: { Workbook: class {} },
};
Module._resolveFilename = function (r, p, ...rest) {
  if (typeof r === "string") {
    if (r.endsWith("config/db")) return "__DB__";
    if (r.endsWith("services/reportService")) return "__RPT__";
    if (r.endsWith("services/aiExtraction")) return "__AI__";
    if (r.endsWith("services/emailService")) return "__MAIL__";
    if (r === "multer") return "__MULTER__";
    if (r === "exceljs") return "__EXCEL__";
  }
  return orig.call(this, r, p, ...rest);
};
for (const [id, exports] of Object.entries(S))
  require.cache[id] = { id, filename: id, loaded: true, exports };

const ticketC = require(`${SERVER}/controllers/ticketController.js`);
const airlineC = require(`${SERVER}/controllers/airlineController.js`);
const taxC = require(`${SERVER}/controllers/taxController.js`);
const finC = require(`${SERVER}/controllers/financialsController.js`);
const visaC = require(`${SERVER}/controllers/visaController.js`);
const pkgC = require(`${SERVER}/controllers/packageController.js`);
const custC = require(`${SERVER}/controllers/customerController.js`);
const accC = require(`${SERVER}/controllers/accountController.js`);
const supC = require(`${SERVER}/controllers/supplierController.js`);
const { cancelHandler } = require(`${SERVER}/services/serviceCancel.js`);
const ownerC = require(`${SERVER}/controllers/ownerController.js`);
const journalC = require(`${SERVER}/controllers/journalController.js`);
const importC = require(`${SERVER}/controllers/openingImportController.js`);
const expenseC = require(`${SERVER}/controllers/expenseController.js`);
const agentC = require(`${SERVER}/controllers/agentController.js`);

const biz = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('Books','books@x.c') RETURNING id`)).rows[0].id;
const user = (await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`, [biz])).rows[0].id;
const ctx = { businessId: biz, user: { id: user, role: "admin" } };
const mkRes = () => {
  const r = { code: 200, body: null };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
};
const call = async (fn, req = {}) => {
  const res = mkRes();
  let err = null;
  await fn({ ...ctx, params: {}, query: {}, body: {}, ...req }, res, (e) => (err = e));
  if (err) { res.code = err.statusCode || 500; res.body = { message: err.message }; }
  return res;
};
const must = async (label, fn, req) => {
  const r = await call(fn, req);
  if (r.code >= 300) fail.push(`${label} failed: ${r.code} ${r.body?.message}`);
  return r.body?.data;
};
const CASH = (await pg.query(`SELECT id FROM payment_accounts WHERE business_id=$1 AND is_cash_in_hand`, [biz])).rows[0].id;
await must("opening cash", finC.updateOpeningBalances, { body: { opening_cash: 5000, fixed_assets: 1500 } });
const BANK = (await must("bank", accC.createAccount, { body: { name: "Premier Bank", kind: "bank", opening_balance: 20000 } })).id;
const EVC = (await must("evc", accC.createAccount, { body: { name: "EVC", kind: "mobile" } })).id;

// ── Owners ──────────────────────────────────────────────────────────────
const ahmed = await must("add Ahmed", ownerC.createOwner, { body: { name: "Ahmed", opening_capital: 1000, ownership_pct: 30, profit_share_pct: 30 } });
const liibaan = await must("add Liibaan", ownerC.createOwner, { body: { name: "Liibaan", opening_capital: 10000, ownership_pct: 70, profit_share_pct: 70 } });
let r = await call(ownerC.createOwner, { body: { name: "Extra", ownership_pct: 5 } });
ck("ownership can't exceed 100%", r.code === 400, r.body?.message);
r = await call(ownerC.createOwner, { body: { name: "ahmed" } });
ck("duplicate owner name refused", r.code === 409, r.body?.message);
await must("Ahmed capital in", ownerC.addOwnerTransaction, { params: { id: ahmed.id }, body: { kind: "contribution", amount: 2000, account_id: BANK } });
await must("Liibaan drawings", ownerC.addOwnerTransaction, { params: { id: liibaan.id }, body: { kind: "withdrawal", amount: 300, account_id: CASH } });
r = await call(ownerC.addOwnerTransaction, { params: { id: liibaan.id }, body: { kind: "withdrawal", amount: 999999, account_id: EVC } });
ck("drawings bigger than the account are refused", r.code === 400, r.body?.message);
r = await call(ownerC.deleteOwner, { params: { id: ahmed.id } });
ck("an owner with history can't be deleted", r.code === 409);

// ── A month of trading ──────────────────────────────────────────────────
let phone = 610000;
const book = async (o) => must("ticket " + o.passenger_name, ticketC.createTicket, { body: { ticket_type: "LOCAL", contact_number: "06" + phone++, from_city: "MGQ", to_city: "NBO", flight_date: "2026-12-01", account_id: CASH, ...o } });
const airlineId = async (name) => (await pg.query(`SELECT id FROM airlines WHERE business_id=$1 AND name=$2`, [biz, name])).rows[0].id;
const t1 = await book({ passenger_name: "ALI", airline_name: "Daallo", cost_price: 400, tax: 60, selling_price: 520, amount_paid: 300 });
await must("pay rest", ticketC.addPayment, { params: { id: t1.id }, body: { amount: 220, account_id: EVC } });
await book({ passenger_name: "HODAN", airline_name: "Daallo", cost_price: 300, tax: 40, selling_price: 380, amount_paid: 100, agent_commission: 15, agent_name: "Guled", agent_phone: "0619" });
await must("pay airline", airlineC.payAirline, { params: { id: await airlineId("Daallo") }, body: { amount: 500, account_id: BANK } });
await must("pay tax", taxC.payTax, { body: { amount: 60, account_id: BANK } });
const t3 = await book({ passenger_name: "CANCEL ME", airline_name: "Jubba", cost_price: 250, tax: 50, selling_price: 320, amount_paid: 320 });
await must("pay jubba", airlineC.payAirline, { params: { id: await airlineId("Jubba") }, body: { account_id: BANK } });
await must("cancel t3", ticketC.cancelTicket, { params: { id: t3.id }, body: { refund_amount: 100, account_id: CASH, airline_refund: 120, airline_account_id: BANK } });
const t4 = await book({ passenger_name: "SHORT", airline_name: "Jubba", cost_price: 200, tax: 80, selling_price: 260, amount_paid: 30 });
await must("cancel t4", ticketC.cancelTicket, { params: { id: t4.id }, body: { refund_amount: 0 } });
const v1 = await must("visa", visaC.createVisa, { body: { applicant_name: "SAHRA", destination_country: "UAE", cost_price: 150, selling_price: 230, amount_paid: 230, account_id: EVC } });
await must("pay embassy", supC.paySupplier, { params: { kind: "visa", id: v1.id }, body: { account_id: BANK } });
const v2 = await must("visa2", visaC.createVisa, { body: { applicant_name: "DEEQA", destination_country: "KSA", cost_price: 100, selling_price: 160, amount_paid: 160, account_id: CASH } });
await must("pay embassy2", supC.paySupplier, { params: { kind: "visa", id: v2.id }, body: { account_id: BANK } });
await must("cancel visa2", cancelHandler("visa"), { params: { id: v2.id }, body: { refund_amount: 60, account_id: CASH, supplier_refund: 40, supplier_account_id: BANK } });
await must("package", pkgC.createPackage, { body: { label: "Umrah", package_type: "umrah", selling_price: 1200, amount_paid: 500, account_id: BANK, items: [{ item_type: "hotel", description: "Hotel", cost: 700 }] } });
const cust = (await pg.query(`INSERT INTO customers (business_id,name,phone) VALUES ($1,'DEPOSITOR','0615000000') RETURNING id`, [biz])).rows[0].id;
await must("deposit", custC.addDeposit, { params: { id: cust }, body: { amount: 400, account_id: CASH } });
const t5 = await book({ passenger_name: "DEPOSITOR", customer_id: cust, airline_name: "Daallo", cost_price: 150, selling_price: 210, amount_paid: 0 });
await must("apply deposit", custC.applyDepositToBooking, { params: { id: cust }, body: { kind: "ticket", record_id: t5.id, amount: 210 } });
await must("expense", expenseC.createExpense, { body: { category: "rent", description: "Office rent", amount: 450, account_id: BANK } });
await must("transfer", accC.createTransfer, { body: { from_account_id: BANK, to_account_id: EVC, amount: 1000, fee: 12 } });
const agentId = (await pg.query(`SELECT id FROM agents WHERE business_id=$1 LIMIT 1`, [biz])).rows[0]?.id;
ck("agent created from the booking", !!agentId);
if (agentId) await must("pay agent", agentC.payAgent, { params: { id: agentId }, body: { amount: 15, account_id: CASH } });

// ── Opening balances imported from a spreadsheet ─────────────────────────
const known = (await pg.query(`INSERT INTO customers (business_id,name,phone) VALUES ($1,'FARAH ADEN','0612223344') RETURNING id`, [biz])).rows[0].id;
const csv = (rows) => Buffer.from(rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n"));
const buf = csv([
  ["Customer name", "Phone", "Service", "Amount", "Date", "Reason"],
  ["Farah Aden", "+252 61 222 3344", "tickets", "350", "2026-08-31", "Old ticket balance"],
  ["NEW PERSON", "0619998877", "visa", "$1,200.50", "31/08/2026", "Visa balance"],
  ["", "", "", "90", "", "No name"],
  ["Bad Amount", "", "", "abc", "", ""],
]);
const preview = await importC.buildPreview(biz, "receivable", { buffer: buf, originalname: "old.csv", mimetype: "text/csv" });
const byRow = Object.fromEntries(preview.rows.map((x) => [x.row, x]));
ck("import: phone in another format matches the exact customer", byRow[2].match === "matched" && byRow[2].party_id === known, `${byRow[2].match} via ${byRow[2].via}`);
ck("import: service names are normalised", byRow[2].service_type === "ticket" && byRow[3].service_type === "visa");
ck("import: amounts with $ and commas are read", byRow[3].amount === 1200.5, String(byRow[3].amount));
ck("import: day-first dates are read", byRow[3].entry_date === "2026-08-31", byRow[3].entry_date);
ck("import: an unknown customer is flagged as new", byRow[3].match === "new");
ck("import: rows with no name or a bad amount are errors", byRow[4].match === "error" && byRow[5].match === "error");
r = await call(importC.commitImport, { body: { type: "receivable", rows: [byRow[2], byRow[3]].map((x) => ({ ...x, party_id: x.party_id || null })) } });
ck("import: commit records the rows", r.code === 201, r.body?.message);
const again = await importC.buildPreview(biz, "receivable", { buffer: buf, originalname: "old.csv" });
ck("import: importing the same file again is flagged as duplicate", again.rows.find((x) => x.row === 2).duplicate);
const newCust = (await pg.query(`SELECT id FROM customers WHERE business_id=$1 AND name='NEW PERSON'`, [biz])).rows;
ck("import: the new customer was created once", newCust.length === 1);

const apCsv = csv([["Airline", "Amount", "Date", "Reason"], ["DAALLO", "800", "2026-08-31", "Old unpaid tickets"]]);
const prev2 = await importC.buildPreview(biz, "payable", { buffer: apCsv, originalname: "ap.csv" });
ck("import: airline matched by name regardless of case", prev2.rows[0].match === "matched" && prev2.rows[0].party_id === (await airlineId("Daallo")), prev2.rows[0].match);
await must("commit payable", importC.commitImport, { body: { type: "payable", rows: prev2.rows } });
const oi = (await pg.query(`SELECT id FROM opening_balance_items WHERE business_id=$1 AND customer_id=$2`, [biz, known])).rows[0].id;
await must("collect opening", finC.collectOpeningReceivable, { params: { id: oi }, body: { amount: 150, account_id: EVC } });
await must("pay airline incl opening", airlineC.payAirline, { params: { id: await airlineId("Daallo") }, body: { amount: 700, account_id: BANK } });

// ── The checks ────────────────────────────────────────────────────────────
const reconcile = async (label, asOf) => {
  const q = asOf ? { as_of: asOf } : {};
  const bs = (await call(finC.getBalanceSheet, { query: q })).body.data;
  const tb = (await call(journalC.getTrialBalance, { query: q })).body.data;
  ck(`${label}: balance sheet balances`, m2(bs.difference) === "0.00", m2(bs.difference));
  ck(`${label}: trial balance balances`, tb.totals.balanced, `${m2(tb.totals.debit)} vs ${m2(tb.totals.credit)}`);
  const row = (c) => tb.rows.find((x) => x.code === c);
  ck(`${label}: journal cash = balance sheet cash`, m2(row("1000").balance) === m2(bs.assets.cash_and_bank), `${m2(row("1000").balance)} vs ${m2(bs.assets.cash_and_bank)}`);
  const net = tb.summary.assets - tb.summary.liabilities;
  ck(`${label}: journal net assets = balance sheet net assets`, m2(net) === m2(bs.assets.total - bs.liabilities.total), `${m2(net)} vs ${m2(bs.assets.total - bs.liabilities.total)}`);
  ck(`${label}: journal equity + profit = balance sheet equity`, m2(tb.summary.equity + tb.summary.net_profit) === m2(bs.equity.total), `${m2(tb.summary.equity + tb.summary.net_profit)} vs ${m2(bs.equity.total)}`);
  ck(`${label}: journal profit = balance sheet profit`, m2(tb.summary.net_profit) === m2(bs.equity.profit_to_date), `${m2(tb.summary.net_profit)} vs ${m2(bs.equity.profit_to_date)}`);
  ck(`${label}: journal tax payable = balance sheet`, m2(row("2300").balance) === m2(bs.liabilities.tax_payable - bs.assets.tax_credit));
  ck(`${label}: journal deposits = balance sheet`, m2(row("2200").balance) === m2(bs.liabilities.customer_deposits));
  return { bs, tb };
};

const { bs } = await reconcile("today");

// Every event balances on its own.
const unbalanced = (await pg.query(
  `SELECT source, source_id, entry_at, SUM(amount) s FROM v_journal WHERE business_id=$1
    GROUP BY 1,2,3 HAVING ROUND(SUM(amount),2) <> 0`, [biz])).rows;
ck("every journal event balances on its own", unbalanced.length === 0, JSON.stringify(unbalanced.slice(0, 3)));

// Owners.
const eq = bs.equity.by_owner;
ck("the balance sheet shows one line per owner", eq && eq.owners.length === 2);
const A = eq.owners.find((o) => o.name === "Ahmed");
const L = eq.owners.find((o) => o.name === "Liibaan");
ck("Ahmed's capital = opening + capital in", m2(A.capital) === "3000.00", m2(A.capital));
ck("Liibaan's drawings are shown", m2(L.withdrawn) === "300.00", m2(L.withdrawn));
ck("profit is split 30/70", m2(A.profit_share) === m2(Math.round(bs.equity.profit_to_date * 30) / 100) && m2(L.profit_share) === m2(Math.round(bs.equity.profit_to_date * 70) / 100),
  `${m2(A.profit_share)} / ${m2(L.profit_share)} of ${m2(bs.equity.profit_to_date)}`);
ck("owner lines + brought forward + unallocated = total equity",
  m2(eq.owners.reduce((s, o) => s + o.total, 0) + eq.retained_brought_forward + eq.unallocated_profit) === m2(bs.equity.total));
const cap = (await pg.query(`SELECT -SUM(amount) s FROM v_journal WHERE business_id=$1 AND code='3000' AND party_id=$2`, [biz, ahmed.id])).rows[0].s;
ck("the journal's capital account for Ahmed agrees", m2(cap) === m2(A.capital), `${m2(cap)} vs ${m2(A.capital)}`);

// The general ledger's running balance ends where the trial balance does.
const gl = (await call(journalC.getGeneralLedger, { query: { code: "1000", limit: 500 } })).body.data;
ck("general ledger closing balance = trial balance", m2(gl.closing_balance) === m2(bs.assets.cash_and_bank), `${m2(gl.closing_balance)} vs ${m2(bs.assets.cash_and_bank)}`);
const glBank = (await call(journalC.getGeneralLedger, { query: { code: "1000", party_id: BANK, limit: 500 } })).body.data;
const bankBal = (await pg.query(`SELECT balance FROM v_account_balance WHERE account_id=$1`, [BANK])).rows[0].balance;
ck("ledger for one bank account = Accounts page", m2(glBank.closing_balance) === m2(bankBal), `${m2(glBank.closing_balance)} vs ${m2(bankBal)}`);
const jr = (await call(journalC.getJournal, { query: { limit: 5 } })).body.data;
ck("journal lists events with their lines", jr.entries.length === 5 && jr.entries.every((e) => e.lines.length >= 2 && m2(e.lines.reduce((s, l) => s + l.debit - l.credit, 0)) === "0.00"));

// Cash flow: every line is listed, so the parts add up to the totals.
const cf = (await call(finC.getCashFlow)).body.data;
const sumParts = (o) => Object.entries(o).filter(([k, v]) => typeof v === "number" && !["total", "entries"].includes(k)).reduce((s, [, v]) => s + v, 0);
ck("cash flow: money-in lines add up to total in", m2(sumParts(cf.inflow)) === m2(cf.inflow.total), `${m2(sumParts(cf.inflow))} vs ${m2(cf.inflow.total)}`);
ck("cash flow: money-out lines add up to total out", m2(sumParts(cf.outflow)) === m2(cf.outflow.total), `${m2(sumParts(cf.outflow))} vs ${m2(cf.outflow.total)}`);
ck("cash flow: net = change in cash", m2(cf.net_cash_flow) === m2(bs.assets.cash_and_bank - 5000 - 20000), `${m2(cf.net_cash_flow)} vs ${m2(bs.assets.cash_and_bank - 25000)}`);

// Everything again, as at an earlier date.
await pg.query(`UPDATE owner_transactions SET occurred_at = NOW() - INTERVAL '20 days' WHERE amount > 0`);
await pg.query(`UPDATE tickets SET created_at = NOW() - INTERVAL '20 days' WHERE passenger_name = 'ALI'`);
await pg.query(`UPDATE ticket_payments SET created_at = NOW() - INTERVAL '20 days' WHERE ticket_id = $1`, [t1.id]);
const d10 = (await pg.query(`SELECT ((NOW() AT TIME ZONE 'Africa/Mogadishu') - INTERVAL '10 days')::DATE::TEXT AS d`)).rows[0].d;
await reconcile("ten days ago", d10);
await reconcile("today, after back-dating", null);

console.log(`\nPASS (${pass.length})`);
pass.forEach((x) => console.log("  ✓ " + x));
if (fail.length) {
  console.log(`\nFAIL (${fail.length})`);
  fail.forEach((x) => console.log("  ✗ " + x));
  process.exit(1);
}
console.log(`\nAll ${pass.length} checks passed: the journal and the balance sheet agree to the cent.`);
