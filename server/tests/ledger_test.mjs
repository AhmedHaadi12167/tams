/**
 * ledger_test.mjs
 *
 * Runs schema.sql + every migration against a real PostgreSQL (PGlite, WASM),
 * then feeds it a full day of an agency's trading and checks that the ledger,
 * the account balances and the financial statements all tell the same story.
 *
 * The point is not that the SQL parses. It is that the arithmetic is right.
 */

import { PGlite } from "@electric-sql/pglite";
import fs from "fs";

const CFG = "./cfg";
const pass = [];
const fail = [];
const check = (name, ok, detail = "") =>
  (ok ? pass : fail).push(name + (detail ? ` — ${detail}` : ""));

const money = (v) => Number(v).toFixed(2);

const db = await PGlite.create();

// Report a setup failure as one readable line instead of a page of WASM stack.
process.on("uncaughtException", (e) => {
  console.log("\nHARNESS ERROR: " + e.message);
  if (e.query) console.log("  query: " + String(e.query).replace(/\s+/g, " ").slice(0, 160));
  report();
});

// PGlite has no uuid-ossp, but Postgres 13+ ships gen_random_uuid().
// Shim the name so schema.sql runs unmodified.
await db.exec(`
  CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid
  LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';
`);

const strip = (sql) =>
  sql.replace(/CREATE EXTENSION[^;]*;/gi, "").replace(/^﻿/, "");

// ── Build the database exactly as production would ─────────────────────────
try {
  await db.exec(strip(fs.readFileSync(`${CFG}/schema.sql`, "utf8")));
  check("schema.sql applies", true);
} catch (e) {
  check("schema.sql applies", false, e.message);
  report();
}

for (const v of [10, 11]) {
  try {
    await db.exec(strip(fs.readFileSync(`${CFG}/migration_v${v}.sql`, "utf8")));
    check(`migration_v${v} applies`, true);
  } catch (e) {
    check(`migration_v${v} applies`, false, e.message);
  }
}

// Re-running a migration must be harmless — people do it by accident.
try {
  await db.exec(strip(fs.readFileSync(`${CFG}/migration_v11.sql`, "utf8")));
  check("migration_v11 is safely re-runnable", true);
} catch (e) {
  check("migration_v11 is safely re-runnable", false, e.message);
}

// ── A business, a user, and the seeded accounts ────────────────────────────
const biz = (
  await db.query(
    `INSERT INTO businesses (name, email) VALUES ('Ecos Travel','a@b.c') RETURNING id`,
  )
).rows[0].id;

// The seed loop runs over businesses that existed when the migration ran, so
// a business created afterwards needs the accounts too. This is the bug this
// test is here to catch.
const seeded = (
  await db.query(`SELECT COUNT(*) n FROM payment_accounts WHERE business_id=$1`, [biz])
).rows[0].n;
check(
  "accounts exist for a business created AFTER the migration",
  Number(seeded) === 11,
  `found ${seeded}, expected 11`,
);

if (Number(seeded) !== 11) {
  // Seed by hand so the remaining checks can still run and report.
  for (const [name, kind, i] of [
    ["Cash", "cash", 0], ["Premier Bank", "bank", 10], ["Salaam Bank", "bank", 20],
    ["Amal Bank", "bank", 30], ["MyBank", "bank", 40], ["Dahabshiil Bank", "bank", 50],
    ["IBS Bank", "bank", 60], ["SOMBANK", "bank", 70], ["Merchant", "merchant", 80],
    ["EVC", "mobile", 90], ["EDahab", "mobile", 100],
  ]) {
    await db.query(
      `INSERT INTO payment_accounts (business_id,name,kind,sort_order)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [biz, name, kind, i],
    );
  }
}

const user = (
  await db.query(
    `INSERT INTO users (business_id,name,email,password_hash,role)
     VALUES ($1,'Ahmed','ahmed@x.com','h','admin') RETURNING id`,
    [biz],
  )
).rows[0].id;

const acc = {};
for (const r of (
  await db.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`, [biz])
).rows) {
  acc[r.name] = r.id;
}

const customer = (
  await db.query(
    `INSERT INTO customers (business_id,name,phone) VALUES ($1,'Ayaan Ali','0612345678') RETURNING id`,
    [biz],
  )
).rows[0].id;

const airline = (
  await db.query(
    `INSERT INTO airlines (business_id,name,match_key) VALUES ($1,'Turkish Airlines','turkishairline') RETURNING id`,
    [biz],
  )
).rows[0].id;

const agent = (
  await db.query(
    `INSERT INTO agents (business_id,name,phone) VALUES ($1,'Hassan','0615555555') RETURNING id`,
    [biz],
  )
).rows[0].id;

// ── A day of trading ───────────────────────────────────────────────────────
// Ticket sold for 500, cost 400, customer pays 300 into EVC then 200 into Cash
const ticket = (
  await db.query(
    `INSERT INTO tickets (business_id,customer_id,created_by,ticket_type,passenger_name,
       from_city,to_city,flight_date,airline_name,airline_id,cost_price,selling_price,
       amount_paid,payment_status,passport_number)
     VALUES ($1,$2,$3,'INTERNATIONAL','Ayaan Ali','Mogadishu','Istanbul','2026-09-01',
       'Turkish Airlines',$4,400,500,500,'paid','A123') RETURNING id`,
    [biz, customer, user, airline],
  )
).rows[0].id;

await db.query(
  `INSERT INTO ticket_payments (business_id,ticket_id,collected_by,amount,method,account_id)
   VALUES ($1,$2,$3,300,'evc',$4), ($1,$2,$3,200,'cash',$5)`,
  [biz, ticket, user, acc["EVC"], acc["Cash"]],
);

// Visa: fee 150 collected into Salaam Bank
const visa = (
  await db.query(
    `INSERT INTO visa_applications (business_id,created_by,applicant_name,
       destination_country,visa_type,cost_price,selling_price,amount_paid,status)
     VALUES ($1,$2,'Ayaan Ali','Turkey','Tourist',100,150,150,'applied') RETURNING id`,
    [biz, user],
  )
).rows[0].id;
await db.query(
  `INSERT INTO visa_payments (business_id,visa_id,collected_by,amount,method,account_id)
   VALUES ($1,$2,$3,150,'bank',$4)`,
  [biz, visa, user, acc["Salaam Bank"]],
);

// Cargo: 80 collected into EDahab
const cargo = (
  await db.query(
    `INSERT INTO cargo_shipments (business_id,created_by,sender_name,receiver_name,
       item_description,from_city,to_city,weight_kg,price_per_kg,amount_paid,payment_status)
     VALUES ($1,$2,'Omar','Faduma','Clothes','Mogadishu','Hargeisa',8,10,80,'paid') RETURNING id`,
    [biz, user],
  )
).rows[0].id;
await db.query(
  `INSERT INTO cargo_payments (business_id,cargo_id,collected_by,amount,method,account_id)
   VALUES ($1,$2,$3,80,'edahab',$4)`,
  [biz, cargo, user, acc["EDahab"]],
);

// Money out: pay the airline 400 from Premier Bank
await db.query(
  `INSERT INTO airline_payments (business_id,airline_id,ticket_id,amount,method,account_id,paid_by)
   VALUES ($1,$2,$3,400,'bank',$4,$5)`,
  [biz, airline, ticket, acc["Premier Bank"], user],
);

// Money out: agent commission 25 from Cash
await db.query(
  `INSERT INTO agent_payments (business_id,agent_id,amount,method,account_id,paid_by)
   VALUES ($1,$2,25,'cash',$3,$4)`,
  [biz, agent, acc["Cash"], user],
);

// Money out: office rent 60 from Premier Bank
await db.query(
  `INSERT INTO expenses (business_id,created_by,category,description,amount,payment_method,account_id)
   VALUES ($1,$2,'rent','Office rent',60,'bank',$3)`,
  [biz, user, acc["Premier Bank"]],
);

// Transfer: 100 from EVC to Premier Bank, 2 fee
await db.query(
  `INSERT INTO account_transfers (business_id,from_account_id,to_account_id,amount,fee,created_by)
   VALUES ($1,$2,$3,100,2,$4)`,
  [biz, acc["EVC"], acc["Premier Bank"], user],
);

// ── What the balances should be, worked out by hand ────────────────────────
const expected = {
  Cash: 200 - 25,                 // ticket payment in, agent commission out
  EVC: 300 - 100 - 2,             // ticket payment in, transfer + fee out
  "Salaam Bank": 150,             // visa fee
  EDahab: 80,                     // cargo
  "Premier Bank": 100 - 400 - 60, // transfer in, airline + rent out
  MyBank: 0,
};

const balances = Object.fromEntries(
  (
    await db.query(`SELECT name, balance FROM v_account_balance WHERE business_id=$1`, [biz])
  ).rows.map((r) => [r.name, Number(r.balance)]),
);

for (const [name, want] of Object.entries(expected)) {
  check(
    `balance: ${name}`,
    money(balances[name]) === money(want),
    `got ${money(balances[name])}, expected ${money(want)}`,
  );
}

// ── The identity that matters ──────────────────────────────────────────────
// Sum of all account balances must equal (everything in − everything out).
const totals = (
  await db.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='in'),0)  AS tin,
            COALESCE(SUM(amount) FILTER (WHERE direction='out'),0) AS tout
       FROM v_cash_ledger WHERE business_id=$1`,
    [biz],
  )
).rows[0];

const sumBalances = Object.values(balances).reduce((a, b) => a + b, 0);
const netFlow = Number(totals.tin) - Number(totals.tout);
check(
  "sum of balances equals total in minus total out",
  money(sumBalances) === money(netFlow),
  `balances ${money(sumBalances)} vs flow ${money(netFlow)}`,
);

// A transfer must not change the money the business holds. 100 moved, 2 lost
// to the fee, so the net effect across all accounts is exactly −2.
check(
  "a transfer changes the total only by its fee",
  money(sumBalances) === money(200 + 300 + 150 + 80 - 400 - 25 - 60 - 2),
  `total held ${money(sumBalances)}`,
);

// ── The ledger must be able to say who and when ────────────────────────────
const led = (
  await db.query(
    `SELECT source, direction, amount, party, occurred_at
       FROM v_cash_ledger WHERE business_id=$1 ORDER BY source`,
    [biz],
  )
).rows;

check("ledger has a row per movement", led.length === 9, `${led.length} rows (7 real + 2 transfer legs)`);
check("every row names a counterparty", led.every((r) => r.party && r.party.length > 0));
check("every row has a timestamp", led.every((r) => r.occurred_at));
check(
  "customer name reaches the ledger",
  led.some((r) => r.source === "ticket" && r.party === "Ayaan Ali"),
);
check(
  "airline name reaches the ledger",
  led.some((r) => r.source === "airline" && r.party === "Turkish Airlines"),
);
check(
  "transfer shows both directions",
  led.some((r) => r.source === "transfer_in") && led.some((r) => r.source === "transfer_out"),
);

// ── Unassigned money must be visible, not silently dropped ─────────────────
await db.query(
  `INSERT INTO ticket_payments (business_id,ticket_id,collected_by,amount,method,account_id)
   VALUES ($1,$2,$3,45,'other',NULL)`,
  [biz, ticket, user],
);
const unassigned = (
  await db.query(
    `SELECT COALESCE(SUM(amount),0) s FROM v_cash_ledger
      WHERE business_id=$1 AND account_id IS NULL`,
    [biz],
  )
).rows[0].s;
const balancesAfter = (
  await db.query(`SELECT COALESCE(SUM(balance),0) s FROM v_account_balance WHERE business_id=$1`, [biz])
).rows[0].s;
check("money with no account appears in the ledger", money(unassigned) === "45.00", `${money(unassigned)}`);
check(
  "money with no account is excluded from balances",
  money(balancesAfter) === money(sumBalances),
  "balances must not move until it is assigned",
);

// ── An account holding transactions cannot be deleted ──────────────────────
let deleteBlocked = false;
try {
  await db.query(`DELETE FROM payment_accounts WHERE id=$1`, [acc["Cash"]]);
} catch {
  deleteBlocked = true;
}
check("deleting an account with history is refused", deleteBlocked);

// ── Transfers to self are impossible ───────────────────────────────────────
let selfBlocked = false;
try {
  await db.query(
    `INSERT INTO account_transfers (business_id,from_account_id,to_account_id,amount)
     VALUES ($1,$2,$2,50)`,
    [biz, acc["Cash"]],
  );
} catch {
  selfBlocked = true;
}
check("a transfer to the same account is refused", selfBlocked);

// ── Opening balance flows through ──────────────────────────────────────────
await db.query(`UPDATE payment_accounts SET opening_balance=1000 WHERE id=$1`, [acc["MyBank"]]);
const myBank = (
  await db.query(`SELECT balance FROM v_account_balance WHERE id_check=1`, []).catch(() => null)
) || (await db.query(`SELECT balance FROM v_account_balance WHERE account_id=$1`, [acc["MyBank"]]));
check(
  "opening balance is included in the balance",
  money(myBank.rows[0].balance) === "1000.00",
  `got ${money(myBank.rows[0].balance)}`,
);

report();

function report() {
  console.log(`\nPASS (${pass.length})`);
  pass.forEach((p) => console.log("  ✓ " + p));
  if (fail.length) {
    console.log(`\nFAIL (${fail.length})`);
    fail.forEach((f) => console.log("  ✗ " + f));
    process.exit(1);
  }
  console.log(`\nAll ${pass.length} checks passed against real PostgreSQL.`);
  process.exit(0);
}
