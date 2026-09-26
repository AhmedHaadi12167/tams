import { PGlite } from "@electric-sql/pglite";
import fs from "fs";

const db = await PGlite.create();
const strip = (sql) =>
  sql.replace(/CREATE EXTENSION[^;]*;/gi, "").replace(/^\uFEFF/, "");

await db.exec(`
  CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid
  LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';
`);
await db.exec(strip(fs.readFileSync("../config/schema.sql", "utf8")));
await db.exec(strip(fs.readFileSync("../config/migration_v24.sql", "utf8")));
await db.exec(strip(fs.readFileSync("../config/migration_v24.sql", "utf8")));

const business = (
  await db.query(
    `INSERT INTO businesses (name, email) VALUES ('Opening Test', 'opening@test.invalid') RETURNING id`,
  )
).rows[0].id;
const accounts = (
  await db.query(
    `INSERT INTO payment_accounts (business_id, name, opening_balance)
     VALUES ($1, 'Cash', 100), ($1, 'Bank', 0) RETURNING id, name`,
    [business],
  )
).rows;
const cash = accounts.find((account) => account.name === "Cash").id;
const bank = accounts.find((account) => account.name === "Bank").id;
const customer = (
  await db.query(
    `INSERT INTO customers (business_id, name, phone)
     VALUES ($1, 'Opening Customer', '0610000000') RETURNING id`,
    [business],
  )
).rows[0].id;

await db.query(
  `INSERT INTO account_transfers
     (business_id, from_account_id, to_account_id, amount, fee)
   VALUES ($1, $2, $3, 60, 0)`,
  [business, cash, bank],
);

let overdraftRejected = false;
try {
  await db.query(
    `INSERT INTO account_transfers
       (business_id, from_account_id, to_account_id, amount, fee)
     VALUES ($1, $2, $3, 41, 0)`,
    [business, cash, bank],
  );
} catch (error) {
  overdraftRejected = error.constraint === "chk_account_balance_nonnegative";
}

const balances = (
  await db.query(
    `SELECT name, balance FROM v_account_balance WHERE business_id = $1 ORDER BY name`,
    [business],
  )
).rows;
if (!overdraftRejected)
  throw new Error("Overdrawn account transfer was accepted");
if (
  Number(balances.find((account) => account.name === "Cash").balance) !== 40
) {
  throw new Error("Rejected transfer changed the source account balance");
}

const openingItem = (
  await db.query(
    `INSERT INTO opening_balance_items
       (business_id, balance_type, customer_id, service_type, reason, amount)
     VALUES ($1, 'receivable', $2, 'ticket', 'Prior unpaid ticket', 25)
     RETURNING id`,
    [business, customer],
  )
).rows[0].id;
const openingPayment = (
  await db.query(
    `INSERT INTO opening_balance_payments
       (business_id, opening_item_id, account_id, amount, method)
     VALUES ($1, $2, $3, 10, 'cash') RETURNING id`,
    [business, openingItem, cash],
  )
).rows[0].id;
const openingCash = (
  await db.query(
    `SELECT balance FROM v_account_balance WHERE account_id = $1`,
    [cash],
  )
).rows[0].balance;
const openingLedgerRows = (
  await db.query(
    `SELECT COUNT(*)::INT AS count FROM v_cash_ledger
      WHERE source = 'opening_receivable' AND source_id = $1`,
    [openingItem],
  )
).rows[0].count;
if (Number(openingCash) !== 50 || Number(openingLedgerRows) !== 1) {
  throw new Error(
    "Opening receivable collection did not create one cash movement",
  );
}

await db.query(
  `INSERT INTO account_transfers
     (business_id, from_account_id, to_account_id, amount, fee)
   VALUES ($1, $2, $3, 45, 0)`,
  [business, cash, bank],
);
let receiptDeletionRejected = false;
try {
  await db.query(`DELETE FROM opening_balance_payments WHERE id = $1`, [
    openingPayment,
  ]);
} catch (error) {
  receiptDeletionRejected =
    error.constraint === "chk_account_balance_nonnegative";
}
if (!receiptDeletionRejected) {
  throw new Error("Deleting a receipt was allowed to overdraw its account");
}

let openingReductionRejected = false;
try {
  await db.query(
    `UPDATE payment_accounts SET opening_balance = 0 WHERE id = $1`,
    [cash],
  );
} catch (error) {
  openingReductionRejected =
    error.constraint === "chk_account_balance_nonnegative";
}
if (!openingReductionRejected) {
  throw new Error(
    "Opening balance edit was allowed to make the account negative",
  );
}

console.log(
  "PASS: migration is repeatable and account balances cannot go below zero",
);
await db.close();
