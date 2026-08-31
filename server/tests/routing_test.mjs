/**
 * routing_test.mjs
 *
 * One question, asked of every path money can take:
 *
 *     when the user picks an account, does the money land in THAT account?
 *
 * Every case deliberately picks a non-Cash account, because "everything ends
 * up in Cash" is the failure being hunted — and a test that used Cash would
 * pass whether the account was honoured or ignored.
 */

import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
import { seedAccounts } from "./seed.mjs";

const require = createRequire(import.meta.url);
const SERVER = "/sessions/awesome-festive-mccarthy/mnt/tams/server";

const pass = [];
const fail = [];
const ck = (n, ok, d = "") => (ok ? pass : fail).push(n + (d ? ` — ${d}` : ""));

const pg = await PGlite.create();
await pg.exec(
  `CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`,
);
await pg.exec(fs.readFileSync("cfg/schema.sql", "utf8").replace(/CREATE EXTENSION[^;]*;/gi, ""));

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
    generateGroupPDF: async () => Buffer.from(""),
  },
  __AI_STUB__: { extractTicketData: async () => ({}) },
  __MAIL_STUB__: { sendOTPEmail: async () => true },
};
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (typeof req === "string") {
    if (req.endsWith("config/db")) return "__DB_SHIM__";
    if (req.endsWith("services/reportService")) return "__REPORT_STUB__";
    if (req.endsWith("services/aiExtraction")) return "__AI_STUB__";
    if (req.endsWith("services/emailService")) return "__MAIL_STUB__";
  }
  return orig.call(this, req, parent, ...rest);
};
for (const [id, exports] of Object.entries(STUBS))
  require.cache[id] = { id, filename: id, loaded: true, exports };

const ticketC = require(`${SERVER}/controllers/ticketController.js`);
const cargoC = require(`${SERVER}/controllers/cargoController.js`);
const visaC = require(`${SERVER}/controllers/visaController.js`);
const pkgC = require(`${SERVER}/controllers/packageController.js`);
const airlineC = require(`${SERVER}/controllers/airlineController.js`);
const agentC = require(`${SERVER}/controllers/agentController.js`);
const expenseC = require(`${SERVER}/controllers/expenseController.js`);

const biz = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('E','e@x.c') RETURNING id`)).rows[0].id;
await seedAccounts(pg, biz);
const user = (await pg.query(
  `INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`, [biz])).rows[0].id;
const A = Object.fromEntries(
  (await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`, [biz])).rows.map(r => [r.name, r.id]));

const ctx = { businessId: biz, user: { id: user, role: "admin" } };
const mkRes = () => { const r = { code: 200, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); return r; };
const call = async (fn, req) => {
  const res = mkRes(); let err = null;
  await fn({ ...ctx, ...req }, res, e => (err = e));
  if (err) throw err;
  return res;
};

/** Where did the newest movement of this source actually land? */
const landedOn = async (source) => {
  const r = await pg.query(
    `SELECT a.name
       FROM v_cash_ledger l
       LEFT JOIN payment_accounts a ON a.id = l.account_id
      WHERE l.business_id=$1 AND l.source=$2
      ORDER BY l.occurred_at DESC, l.movement_id DESC LIMIT 1`,
    [biz, source],
  );
  return r.rows[0]?.name ?? "(unassigned)";
};

// ── Money IN ───────────────────────────────────────────────────────────────

// 1. Ticket booked with an initial payment into Salaam Bank
const t = await call(ticketC.createTicket, {
  body: {
    ticket_type: "LOCAL", passenger_name: "P1", contact_number: "0611",
    from_city: "A", to_city: "B", flight_date: "2026-09-01",
    airline_name: "Star Air", cost_price: 100, selling_price: 500,
    amount_paid: 100, method: "cash", account_id: A["Salaam Bank"],
  },
});
const ticketId = t.body.data.id;
ck("ticket booking payment -> Salaam Bank", (await landedOn("ticket")) === "Salaam Bank", await landedOn("ticket"));

// 2. Later ticket payment into Amal Bank
await call(ticketC.addPayment, {
  params: { id: ticketId },
  body: { amount: 50, method: "cash", account_id: A["Amal Bank"] },
});
ck("later ticket payment -> Amal Bank", (await landedOn("ticket")) === "Amal Bank", await landedOn("ticket"));

// 3. Cargo into EVC
const cg = await call(cargoC.createCargo, {
  body: {
    sender_name: "S", receiver_name: "R", from_city: "A", to_city: "B",
    weight_kg: 5, price_per_kg: 10, amount_paid: 20,
    method: "cash", account_id: A["EVC"],
  },
});
ck("cargo payment -> EVC", (await landedOn("cargo")) === "EVC", await landedOn("cargo"));

// 4. Visa into IBS Bank
const v = await call(visaC.createVisa, {
  body: {
    applicant_name: "V", destination_country: "Turkey", visa_type: "T",
    cost_price: 50, selling_price: 100, amount_paid: 30,
    payment_method: "cash", account_id: A["IBS Bank"],
  },
});
ck("visa payment -> IBS Bank", (await landedOn("visa")) === "IBS Bank", await landedOn("visa"));

// 5. Later visa payment into EDahab
await call(visaC.addVisaPayment, {
  params: { id: v.body.data.id },
  body: { amount: 20, method: "cash", account_id: A["EDahab"] },
});
ck("later visa payment -> EDahab", (await landedOn("visa")) === "EDahab", await landedOn("visa"));

// 6. Package into MyBank
const p = await call(pkgC.createPackage, {
  body: {
    label: "Umrah A", package_type: "umrah", selling_price: 1000, amount_paid: 100,
    payment_method: "cash", account_id: A["MyBank"],
    items: [{ item_type: "visa", description: "Visa", quantity: 1, unit_cost: 50 }],
  },
});
ck("package payment -> MyBank", (await landedOn("package")) === "MyBank", await landedOn("package"));

// ── Money OUT ──────────────────────────────────────────────────────────────

const airlineId = (await pg.query(`SELECT id FROM airlines WHERE business_id=$1 LIMIT 1`, [biz])).rows[0].id;

// 7. Pay the airline from Premier Bank
await call(airlineC.payAirline, {
  params: { id: airlineId },
  body: { amount: 40, method: "cash", account_id: A["Premier Bank"] },
});
ck("airline payment -> Premier Bank", (await landedOn("airline")) === "Premier Bank", await landedOn("airline"));

// 8. Agent commission from Dahabshiil Bank
const agentId = (await pg.query(
  `INSERT INTO agents (business_id,name) VALUES ($1,'Ag') RETURNING id`, [biz])).rows[0].id;
await pg.query(`UPDATE tickets SET agent_id=$1, agent_commission=10 WHERE id=$2`, [agentId, ticketId]);
await call(agentC.payAgent, {
  params: { id: agentId },
  body: { amount: 10, method: "cash", account_id: A["Dahabshiil Bank"] },
});
ck("agent commission -> Dahabshiil Bank", (await landedOn("agent")) === "Dahabshiil Bank", await landedOn("agent"));

// 9. Expense from SOMBANK
await call(expenseC.createExpense, {
  body: {
    category: "rent", description: "Rent", amount: 25,
    payment_method: "cash", account_id: A["SOMBANK"],
  },
});
ck("expense -> SOMBANK", (await landedOn("expense")) === "SOMBANK", await landedOn("expense"));

// ── The trap: method text must never beat an explicit account ──────────────
// Every call above sent method:"cash" alongside the chosen account. If any
// landed in Cash, the label is overriding the choice.
const inCash = await pg.query(
  `SELECT COUNT(*)::int n FROM v_cash_ledger l
     JOIN payment_accounts a ON a.id=l.account_id
    WHERE l.business_id=$1 AND a.name='Cash'`, [biz]);
ck("nothing leaked into Cash despite method:'cash'", inCash.rows[0].n === 0, `${inCash.rows[0].n} rows in Cash`);

const unassigned = await pg.query(
  `SELECT COUNT(*)::int n FROM v_cash_ledger WHERE business_id=$1 AND account_id IS NULL`, [biz]);
ck("nothing was left unassigned", unassigned.rows[0].n === 0, `${unassigned.rows[0].n} unassigned`);

console.log(`\nPASS (${pass.length})`);
pass.forEach(p => console.log("  ✓ " + p));
if (fail.length) {
  console.log(`\nFAIL (${fail.length})`);
  fail.forEach(f => console.log("  ✗ " + f));
  const all = await pg.query(
    `SELECT l.source, l.direction, l.amount, COALESCE(a.name,'(unassigned)') acct
       FROM v_cash_ledger l LEFT JOIN payment_accounts a ON a.id=l.account_id
      WHERE l.business_id=$1 ORDER BY l.source`, [biz]);
  console.log("\nwhere everything actually went:");
  all.rows.forEach(r => console.log(`  ${r.source.padEnd(10)} ${r.direction.padEnd(4)} ${String(r.amount).padStart(8)}  ${r.acct}`));
  process.exit(1);
}
console.log(`\nAll ${pass.length} money-routing checks passed.`);
