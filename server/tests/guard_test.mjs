// The two fragilities, tested directly.
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const SERVER = "/sessions/awesome-festive-mccarthy/mnt/tams/server";
const pass=[],fail=[]; const ck=(n,ok,d="")=>(ok?pass:fail).push(n+(d?` — ${d}`:""));

const pg = await PGlite.create();
await pg.exec(`CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`);
const full = fs.readFileSync("cfg/schema.sql","utf8").replace(/CREATE EXTENSION[^;]*;/gi,"");

const dbShim = { query:(t,p=[])=>pg.query(t,p), withTransaction: async(fn)=>fn({query:(t,p=[])=>pg.query(t,p)}) };
const Module=require("module"); const orig=Module._resolveFilename;
Module._resolveFilename=function(r,parent,...rest){ if(typeof r==="string"&&r.endsWith("config/db")) return "__DB__"; return orig.call(this,r,parent,...rest); };
require.cache["__DB__"]={id:"__DB__",filename:"__DB__",loaded:true,exports:dbShim};

// ── 1. A negative schema answer must not be cached forever ────────────────
const { hasTable } = require(`${SERVER}/services/schemaInfo.js`);
const before = await hasTable("payment_accounts");
ck("table reported missing before it exists", before === false, String(before));

await pg.exec(full); // "run the migration" while the server is up

const immediately = await hasTable("payment_accounts");
ck("still cached as missing straight after (expected)", immediately === false);

await new Promise(r => setTimeout(r, 15500)); // let the short negative TTL lapse
const later = await hasTable("payment_accounts");
ck("picks the table up without a restart", later === true,
   later ? "" : "still false — a migration would need a restart to take effect");

// ── 2. An account id from another agency must be refused, not guessed ─────
const { resolveAccount } = require(`${SERVER}/services/accountResolver.js`);
const bizA=(await pg.query(`INSERT INTO businesses (name,email) VALUES ('A','a@x.c') RETURNING id`)).rows[0].id;
const bizB=(await pg.query(`INSERT INTO businesses (name,email) VALUES ('B','b@x.c') RETURNING id`)).rows[0].id;
const theirs=(await pg.query(`SELECT id FROM payment_accounts WHERE business_id=$1 AND name='Premier Bank'`,[bizB])).rows[0].id;

let refused=false, msg="";
try { await resolveAccount({ account_id: theirs, method: "cash" }, bizA); }
catch(e){ refused=true; msg=e.message; }
ck("another agency's account is refused, not silently swapped for Cash", refused, msg.slice(0,60));

// No account_id must resolve to nothing at all. Matching on the label is what
// filed money into the account *named* Cash whenever the old `method` field
// said "cash", regardless of what the user actually picked — so the fallback
// is gone on purpose. Unassigned is recoverable; silently wrong is not.
const fellBack = await resolveAccount({ method: "Cash" }, bizA);
ck("no account_id does NOT get guessed from the label", fellBack === null,
   fellBack === null ? "" : `guessed account ${fellBack}`);

console.log(`\nPASS (${pass.length})`); pass.forEach(p=>console.log("  ✓ "+p));
if(fail.length){ console.log(`\nFAIL (${fail.length})`); fail.forEach(f=>console.log("  ✗ "+f)); process.exit(1); }
console.log("\nBoth fragilities are closed.");
