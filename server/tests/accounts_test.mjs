// Removing the built-in accounts must not remove any money.
//
// migration_v21 stops seeding eleven accounts into every new business and
// deletes the ones nobody used. The danger is obvious: an account that has
// taken money is what the ledger and every balance point at, and deleting one
// would either fail loudly on a foreign key or, far worse, take the history
// with it. This proves the line is drawn in the right place.
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

// Build the database as it was *before* v21, so the migration has something
// real to act on: a business with the full set of eleven seeded accounts.
const schema = fs.readFileSync("cfg/schema.sql", "utf8");
const preV21 = schema.slice(0, schema.indexOf("-- migration_v21 — the agency names its own accounts") - 62);
await pg.exec(strip(preV21));

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
const accountC = require(`${SERVER}/controllers/accountController.js`);

const biz  = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('Old','old@x.c') RETURNING id`)).rows[0].id;
const user = (await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`, [biz])).rows[0].id;
const ctx = { businessId: biz, user: { id: user, role: "admin" } };
const mkRes = () => { const r = { code: 200, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); return r; };
const call = async (fn, req) => { const res = mkRes(); let err = null; await fn({ ...ctx, ...req }, res, e => err = e); if (err) throw err; return res; };

const A = Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`, [biz])).rows.map(r => [r.name, r.id]));
ck("the old seeding really did create eleven accounts",
   Object.keys(A).length === 11, String(Object.keys(A).length));

// Give three of them a reason to survive: one holds money, one holds an
// opening balance, one has merely been renamed.
await call(ticketC.createTicket, { body: {
  ticket_type: "LOCAL", passenger_name: "Paid in cash", contact_number: "061",
  from_city: "MGQ", to_city: "HGA", flight_date: "2026-12-01",
  airline_name: "Star Airline", cost_price: 200, selling_price: 500,
  amount_paid: 300, account_id: A["Cash"],
} });
await pg.query(`UPDATE payment_accounts SET opening_balance = 250 WHERE id=$1`, [A["Salaam Bank"]]);
await pg.query(`UPDATE payment_accounts SET name = 'Premier — 3010166' WHERE id=$1`, [A["Premier Bank"]]);

const before = (await call(accountC.getAccounts, { query: {} })).body.data;
const cashBefore = m2(before.accounts.find(a => a.account_id === A["Cash"]).balance);
const totalBefore = m2(before.summary.collected);

// ── Run the migration ─────────────────────────────────────────────────────
await pg.exec(strip(fs.readFileSync("cfg/migration_v21.sql", "utf8")));

const after = Object.fromEntries((await pg.query(
  `SELECT id, name FROM payment_accounts WHERE business_id=$1`, [biz])).rows.map(r => [r.name, r.id]));

ck("an account holding money survives", Boolean(after["Cash"]));
ck("an account with an opening balance survives", Boolean(after["Salaam Bank"]));
ck("a renamed account survives even though it was never used",
   Boolean(after["Premier — 3010166"]));
ck("the eight untouched ones are gone",
   Object.keys(after).length === 3, Object.keys(after).join(", "));

// ── Nothing about the money changed ───────────────────────────────────────
const afterData = (await call(accountC.getAccounts, { query: {} })).body.data;
ck("the cash balance is untouched",
   m2(afterData.accounts.find(a => a.account_id === A["Cash"]).balance) === cashBefore,
   `${m2(afterData.accounts.find(a => a.account_id === A["Cash"]).balance)} vs ${cashBefore}`);
ck("total collected is untouched",
   m2(afterData.summary.collected) === totalBefore,
   `${m2(afterData.summary.collected)} vs ${totalBefore}`);

const led = await pg.query(
  `SELECT COUNT(*)::INT n FROM v_cash_ledger WHERE business_id=$1`, [biz]);
ck("the ledger still has its movements", led.rows[0].n > 0, String(led.rows[0].n));

const orphans = await pg.query(
  `SELECT COUNT(*)::INT n FROM ticket_payments p
    WHERE p.account_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM payment_accounts a WHERE a.id = p.account_id)`);
ck("no payment was left pointing at a deleted account",
   orphans.rows[0].n === 0, String(orphans.rows[0].n));

// ── A new agency starts empty ─────────────────────────────────────────────
const biz2  = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('New','new@x.c') RETURNING id`)).rows[0].id;
const user2 = (await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'B','b@x.c','h','admin') RETURNING id`, [biz2])).rows[0].id;
const n2 = await pg.query(`SELECT COUNT(*)::INT n FROM payment_accounts WHERE business_id=$1`, [biz2]);
ck("a business created after the migration gets no accounts",
   n2.rows[0].n === 0, String(n2.rows[0].n));

// ── And cannot record money until it makes one ────────────────────────────
const ctx2 = { businessId: biz2, user: { id: user2, role: "admin" } };
const call2 = async (fn, req) => {
  const res = mkRes(); let err = null;
  await fn({ ...ctx2, ...req }, res, e => err = e);
  if (err) return { code: err.statusCode || 500, message: err.message };
  return { code: res.code, message: res.body?.message };
};

const blocked = await call2(ticketC.createTicket, { body: {
  ticket_type: "LOCAL", passenger_name: "Too early", contact_number: "063",
  from_city: "MGQ", to_city: "NBO", flight_date: "2026-12-02",
  airline_name: "Daallo", cost_price: 100, selling_price: 200, amount_paid: 150,
} });
ck("taking money with no account is refused, not filed nowhere",
   blocked.code === 400 && /Add a payment account/i.test(blocked.message || ""),
   `${blocked.code}: ${(blocked.message || "").slice(0, 60)}`);

// A booking that moves no money is still fine — nothing to misfile.
const free = await call2(ticketC.createTicket, { body: {
  ticket_type: "LOCAL", passenger_name: "Nothing paid yet", contact_number: "064",
  from_city: "MGQ", to_city: "NBO", flight_date: "2026-12-03",
  airline_name: "Daallo", cost_price: 100, selling_price: 200, amount_paid: 0,
} });
ck("but a booking with no payment still goes through",
   free.code === 201 || free.code === 200, String(free.code));

// ── Then the agency makes its own ─────────────────────────────────────────
const made = await call(accountC.createAccount, {
  businessId: biz2, user: { id: user2, role: "admin" },
  body: { name: "Salaam Bank — 220133", kind: "bank", opening_balance: 0 },
});
ck("an agency can create its own account", made.code === 201 || made.code === 200,
   String(made.code));

const mine = await pg.query(
  `SELECT name FROM payment_accounts WHERE business_id=$1`, [biz2]);
ck("and it is the only one they have",
   mine.rows.length === 1 && mine.rows[0].name === "Salaam Bank — 220133",
   mine.rows.map(r => r.name).join(", "));

console.log(`\nPASS (${pass.length})`); pass.forEach(p => console.log("  ✓ " + p));
if (fail.length) { console.log(`\nFAIL (${fail.length})`); fail.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
console.log("\nThe built-in accounts are gone; every account holding money is untouched.");
