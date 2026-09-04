/**
 * The upgrade path a real installation actually takes: a database built by
 * the older migrations, then each new one applied in order. This is the case
 * that broke — schema.sql alone never exercises it, because it already has
 * the final view.
 */
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
const strip=(s)=>s.replace(/CREATE EXTENSION[^;]*;/gi,"");
const read=(f)=>strip(fs.readFileSync("cfg/"+f,"utf8"));

const db=await PGlite.create();
await db.exec(`CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`);

// Build a database the OLD way: base tables, then v8 and v9 which created
// the original v_airline_account with its own column list.
const full = read("schema.sql");
// take everything up to the accounts section — that is the pre-v11 schema
const cut = full.indexOf("-- Accounts, ledger, refunds, cargo, cancellations, tax");
const base = full.slice(0, full.lastIndexOf("-- "+"=".repeat(60), cut));
await db.exec(base);
console.log("  base schema (pre-v11) applied");

const cols = async () => (await db.query(
  `SELECT column_name FROM information_schema.columns
    WHERE table_name='v_airline_account' ORDER BY ordinal_position`)).rows.map(r=>r.column_name);
console.log("  starting columns:", (await cols()).join(", "));

for (const f of ["migration_v10.sql","migration_v11.sql","migration_v12.sql",
                 "migration_v13.sql","migration_v14.sql","migration_v15.sql",
                 "migration_v16.sql","migration_v17.sql","migration_v18.sql",
                 "migration_v19.sql","migration_v20.sql","migration_v21.sql",
                 "migration_v22.sql","migration_v23.sql"]) {
  try { await db.exec(read(f)); console.log("  OK   " + f); }
  catch (e) { console.log("  FAIL " + f + "\n       " + e.message); try{await db.exec("ROLLBACK;")}catch{}; process.exit(1); }
}
console.log("  final columns:", (await cols()).join(", "));

// And re-running the last two, in both orders, must stay safe.
for (const f of ["migration_v14.sql","migration_v15.sql","migration_v14.sql",
                 "migration_v17.sql","migration_v16.sql","migration_v17.sql","migration_v18.sql",
                 "migration_v19.sql","migration_v20.sql","migration_v21.sql",
                 "migration_v22.sql","migration_v23.sql"]) {
  try { await db.exec(read(f)); console.log("  re-run OK   " + f); }
  catch (e) { console.log("  re-run FAIL " + f + " — " + e.message); process.exit(1); }
}
const finalCols = await cols();
if (!finalCols.includes("total_tax")) {
  console.log("  ✗ re-running v14 undid the tax fix");
  process.exit(1);
}
console.log("  ✓ tax fix survived re-running the older migration");
console.log("\nThe upgrade path works from an older database.");
