/**
 * reconcile_test.mjs
 *
 * The real controllers, against a real PostgreSQL, doing a real day's trade.
 *
 * Everything else so far tested the SQL or the JavaScript in isolation. This
 * runs the actual request handlers — createTicket, addPayment, payAirline,
 * createExpense and the rest — against PGlite, then asks the one question the
 * whole feature exists to answer:
 *
 *     does the money the accounts say we hold match the money that
 *     actually came in and went out?
 */

import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { seedAccounts } from "./seed.mjs";

const require = createRequire(import.meta.url);
const SERVER = "/sessions/awesome-festive-mccarthy/mnt/tams/server";

const pass = [];
const fail = [];
const check = (n, ok, d = "") => (ok ? pass : fail).push(n + (d ? ` — ${d}` : ""));
const m2 = (v) => Number(v).toFixed(2);

// ── Real Postgres ──────────────────────────────────────────────────────────
const pg = await PGlite.create();
await pg.exec(
  `CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`,
);
const strip = (s) => s.replace(/CREATE EXTENSION[^;]*;/gi, "");
await pg.exec(strip(fs.readFileSync(`${SERVER}/config/schema.sql`, "utf8")));

// ── Point the controllers at it ────────────────────────────────────────────
// PGlite speaks the same query(text, params) shape as `pg`, so the swap is
// invisible to the controllers — they run exactly as they do in production.
const dbShim = {
  query: (text, params = []) => pg.query(text, params),
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
  pool: null,
};

const Module = require("module");

// Heavy modules that have nothing to do with money. pdfkit and exceljs alone
// are thousands of files, and reading them over the mounted filesystem takes
// longer than the whole test. Stubbing them keeps the run about the ledger.
const STUBS = {
  "__DB_SHIM__": dbShim,
  "__REPORT_STUB__": {
    generateAirlinePDF: async () => Buffer.from(""),
    generatePDFReport: async () => Buffer.from(""),
    generateExcelReport: async () => Buffer.from(""),
    generateGroupPDF: async () => Buffer.from(""),
  },
  "__AI_STUB__": { extractTicketData: async () => ({}) },
  "__MAIL_STUB__": { sendOTPEmail: async () => true },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (typeof request === "string") {
    if (request.endsWith("config/db")) return "__DB_SHIM__";
    if (request.endsWith("services/reportService")) return "__REPORT_STUB__";
    if (request.endsWith("services/aiExtraction")) return "__AI_STUB__";
    if (request.endsWith("services/emailService")) return "__MAIL_STUB__";
  }
  return origResolve.call(this, request, parent, ...rest);
};
for (const [id, exports] of Object.entries(STUBS)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const load = (p) => require(path.join(SERVER, p));

const ticketC = load("controllers/ticketController.js");
const cargoC = load("controllers/cargoController.js");
const visaC = load("controllers/visaController.js");
const expenseC = load("controllers/expenseController.js");
const airlineC = load("controllers/airlineController.js");
const accountC = load("controllers/accountController.js");

// ── Fixtures ───────────────────────────────────────────────────────────────
const biz = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('Ecos','e@x.c') RETURNING id`)).rows[0].id;
await seedAccounts(pg, biz);
const user = (await pg.query(
  `INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'Ahmed','a@x.c','h','admin') RETURNING id`,
  [biz])).rows[0].id;

const acc = Object.fromEntries(
  (await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`, [biz])).rows.map((r) => [r.name, r.id]),
);
check("a new business is seeded with 11 accounts", Object.keys(acc).length === 11, `${Object.keys(acc).length}`);

const ctx = { businessId: biz, user: { id: user, role: "admin" } };
const mkRes = () => {
  const r = { code: 200, body: null };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
};
let _step = 0;
const call = async (fn, req) => {
  console.error(`  .. [${++_step}] ${fn.name || "handler"}`);
  const res = mkRes();
  let err = null;
  await fn({ ...ctx, ...req }, res, (e) => (err = e));
  if (err) throw err;
  return res;
};

// ── A day of trading, through the real handlers ────────────────────────────
// Ticket: sells 500, costs 400, customer pays 300 into EVC at booking
const t1 = await call(ticketC.createTicket, {
  body: {
    ticket_type: "INTERNATIONAL", passenger_name: "Ayaan Ali", contact_number: "0612345678",
    from_city: "Mogadishu", to_city: "Istanbul", flight_date: "2026-09-01",
    airline_name: "Turkish Airlines", cost_price: 400, selling_price: 500,
    amount_paid: 300, payment_method: "evc", account_id: acc["EVC"],
    passport_number: "A123456",
  },
});
check("ticket booked through the real controller", t1.code === 201, `HTTP ${t1.code}`);
const ticketId = t1.body?.data?.id;

// Customer returns and pays the remaining 200 in cash
await call(ticketC.addPayment, {
  params: { id: ticketId },
  body: { amount: 200, method: "cash", account_id: acc["Cash"] },
});

// Cargo: 80 collected into EDahab
const c1 = await call(cargoC.createCargo, {
  body: {
    item_description: "Clothes", weight_kg: 8, price_per_kg: 10,
    sender_name: "Omar", receiver_name: "Faduma",
    from_city: "Mogadishu", to_city: "Hargeisa",
    amount_paid: 80, payment_method: "edahab", account_id: acc["EDahab"],
  },
});
check("cargo booked with a payment record", c1.code === 201, `HTTP ${c1.code}`);
const cargoId = c1.body?.data?.id;

// Visa: 150 into Salaam Bank
const v1 = await call(visaC.createVisa, {
  body: {
    applicant_name: "Ayaan Ali", destination_country: "Turkey", visa_type: "Tourist",
    cost_price: 100, selling_price: 150, amount_paid: 150,
    payment_method: "bank", account_id: acc["Salaam Bank"],
  },
});
check("visa recorded", v1.code === 201, `HTTP ${v1.code}`);

// Expense: 60 rent out of Premier Bank
const e1 = await call(expenseC.createExpense, {
  body: {
    category: "rent", description: "Office rent", amount: 60,
    payment_method: "bank", account_id: acc["Premier Bank"],
  },
});
check("expense recorded", e1.code === 201, `HTTP ${e1.code}`);

// Pay the airline 400 out of Premier Bank
const airlineId = (await pg.query(`SELECT id FROM airlines WHERE business_id=$1 LIMIT 1`, [biz])).rows[0]?.id;
if (airlineId) {
  const a1 = await call(airlineC.payAirline, {
    params: { id: airlineId },
    body: { amount: 400, method: "bank", account_id: acc["Premier Bank"] },
  });
  check("airline settled", a1.code === 200 || a1.code === 201, `HTTP ${a1.code}`);
}

// Transfer 100 EVC -> Premier Bank with a 2 fee
const tr = await call(accountC.createTransfer, {
  body: { from_account_id: acc["EVC"], to_account_id: acc["Premier Bank"], amount: 100, fee: 2 },
});
check("transfer recorded", tr.code === 201, `HTTP ${tr.code}`);

// ── Editing must not break the books ───────────────────────────────────────
// Correct the cargo downward: 80 -> 50. The 30 difference must appear.
await call(cargoC.updateCargo, {
  params: { id: cargoId },
  body: {
    item_description: "Clothes", weight_kg: 8, price_per_kg: 10,
    sender_name: "Omar", receiver_name: "Faduma",
    from_city: "Mogadishu", to_city: "Hargeisa",
    amount_paid: 50, payment_method: "edahab", account_id: acc["EDahab"],
  },
});

const edahab = Number(
  (await pg.query(`SELECT balance FROM v_account_balance WHERE account_id=$1`, [acc["EDahab"]])).rows[0].balance,
);
check("a downward correction moves the balance", m2(edahab) === "50.00", `EDahab ${m2(edahab)}`);

const cargoPaid = Number(
  (await pg.query(`SELECT amount_paid FROM cargo_shipments WHERE id=$1`, [cargoId])).rows[0].amount_paid,
);
const cargoLedger = Number(
  (await pg.query(`SELECT COALESCE(SUM(amount),0) s FROM cargo_payments WHERE cargo_id=$1`, [cargoId])).rows[0].s,
);
check(
  "the shipment and its payment history agree after an edit",
  m2(cargoPaid) === m2(cargoLedger),
  `shipment ${m2(cargoPaid)} vs payments ${m2(cargoLedger)}`,
);

// ── The reconciliation ─────────────────────────────────────────────────────
const balances = (await pg.query(
  `SELECT name, balance FROM v_account_balance WHERE business_id=$1 ORDER BY name`, [biz])).rows;
const sumBal = balances.reduce((s, r) => s + Number(r.balance), 0);

const flow = (await pg.query(
  `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='in'),0) tin,
          COALESCE(SUM(amount) FILTER (WHERE direction='out'),0) tout
     FROM v_cash_ledger WHERE business_id=$1 AND account_id IS NOT NULL`, [biz])).rows[0];
const net = Number(flow.tin) - Number(flow.tout);

check("accounts total equals money in minus money out", m2(sumBal) === m2(net), `${m2(sumBal)} vs ${m2(net)}`);

// Hand-computed: in  = 300 + 200 + 80 + 150      = 730
//                out = 60 + 400 + (100+2) transfer out, +100 transfer in
//                cargo correction −30
const expectedHeld = 300 + 200 + 80 + 150 - 30 - 60 - 400 - 2;
check("the total held matches a hand calculation", m2(sumBal) === m2(expectedHeld), `${m2(sumBal)} vs ${m2(expectedHeld)}`);

// ── The API a person actually sees ─────────────────────────────────────────
const listed = await call(accountC.getAccounts, { query: {} });
const apiTotal = listed.body.data.summary.total_balance;
check("the accounts screen agrees with the database", m2(apiTotal) === m2(sumBal), `API ${m2(apiTotal)} vs DB ${m2(sumBal)}`);

const ledger = await call(accountC.getLedger, { query: { limit: 200 } });
const rows = ledger.body.data.movements;
check("the ledger lists every movement", rows.length >= 9, `${rows.length} rows`);
check("every movement says who it was with", rows.every((r) => r.party));
check("every movement says when", rows.every((r) => r.occurred_at));
check("every movement names its account or is flagged unassigned",
  rows.every((r) => r.account_name || r.account_id === null));

const led = ledger.body.data.totals;
check("ledger totals match the balances",
  m2(Number(led.total_in) - Number(led.total_out)) === m2(sumBal),
  `ledger net ${m2(Number(led.total_in) - Number(led.total_out))} vs balances ${m2(sumBal)}`);

// Filtering by one account must reproduce that account's own balance
const evcLedger = await call(accountC.getLedger, { query: { account_id: acc["EVC"], limit: 200 } });
const evcNet = Number(evcLedger.body.data.totals.total_in) - Number(evcLedger.body.data.totals.total_out);
const evcBal = Number(balances.find((b) => b.name === "EVC").balance);
check("filtering the ledger by account reproduces its balance", m2(evcNet) === m2(evcBal), `${m2(evcNet)} vs ${m2(evcBal)}`);

console.log(`\nPASS (${pass.length})`);
pass.forEach((p) => console.log("  ✓ " + p));
if (fail.length) {
  console.log(`\nFAIL (${fail.length})`);
  fail.forEach((f) => console.log("  ✗ " + f));
  console.log("\nbalances:", balances.map((b) => `${b.name}=${m2(b.balance)}`).join("  "));
  process.exit(1);
}
console.log(`\nAll ${pass.length} checks passed — real controllers, real PostgreSQL.`);
