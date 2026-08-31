// The ledger must page correctly: no movement shown twice, none skipped, and
// the totals covering the whole filtered set rather than the visible page.
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
await pg.exec(fs.readFileSync("cfg/schema.sql","utf8").replace(/CREATE EXTENSION[^;]*;/gi,""));
const dbShim = { query:(t,p=[])=>pg.query(t,p), withTransaction: async(fn)=>{await pg.exec("BEGIN");try{const r=await fn({query:(t,p=[])=>pg.query(t,p)});await pg.exec("COMMIT");return r;}catch(e){await pg.exec("ROLLBACK");throw e;}} };
const Module=require("module"); const orig=Module._resolveFilename;
const S={__DB__:dbShim,__RPT__:{generateAirlinePDF:async()=>Buffer.from(""),generatePDFReport:async()=>Buffer.from(""),generateExcelReport:async()=>Buffer.from("")},__AI__:{extractTicketData:async()=>({})},__MAIL__:{sendOTPEmail:async()=>true}};
Module._resolveFilename=function(r,p,...rest){if(typeof r==="string"){if(r.endsWith("config/db"))return"__DB__";if(r.endsWith("services/reportService"))return"__RPT__";if(r.endsWith("services/aiExtraction"))return"__AI__";if(r.endsWith("services/emailService"))return"__MAIL__";}return orig.call(this,r,p,...rest);};
for(const[id,exports]of Object.entries(S))require.cache[id]={id,filename:id,loaded:true,exports};

const ticketC=require(`${SERVER}/controllers/ticketController.js`);
const accountC=require(`${SERVER}/controllers/accountController.js`);

const biz=(await pg.query(`INSERT INTO businesses (name,email) VALUES ('P','p@x.c') RETURNING id`)).rows[0].id;
await seedAccounts(pg,biz);
const user=(await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`,[biz])).rows[0].id;
const A=Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`,[biz])).rows.map(r=>[r.name,r.id]));
const ctx={businessId:biz,user:{id:user,role:"admin"}};
const mkRes=()=>{const r={code:200,body:null};r.status=c=>(r.code=c,r);r.json=b=>(r.body=b,r);return r;};
const call=async(fn,req)=>{const res=mkRes();let err=null;await fn({...ctx,...req},res,e=>err=e);if(err)throw err;return res;};

// 57 collections into one account — enough for three pages of 25.
const t=(await call(ticketC.createTicket,{body:{ticket_type:"LOCAL",passenger_name:"Payer",contact_number:"061",
  from_city:"MGQ",to_city:"NBO",flight_date:"2027-01-01",airline_name:"Star Airline",
  cost_price:100,selling_price:6000,amount_paid:0,account_id:A["Cash"]}})).body.data;
for (let i=0;i<57;i++)
  await call(ticketC.addPayment,{params:{id:t.id},body:{amount:10,account_id:A["Cash"],note:`p${i}`}});

const pageOf=async(page,limit)=> (await call(accountC.getLedger,{query:{account_id:A["Cash"],page,limit}})).body;

const p1=await pageOf(1,25), p2=await pageOf(2,25), p3=await pageOf(3,25);
ck("the total is reported, not just the page", p1.meta.total===57, String(p1.meta.total));
ck("three pages at 25 a page", p1.meta.totalPages===3, String(p1.meta.totalPages));
ck("full pages are full", p1.data.movements.length===25 && p2.data.movements.length===25,
   `${p1.data.movements.length}/${p2.data.movements.length}`);
ck("the last page holds the remainder", p3.data.movements.length===7, String(p3.data.movements.length));

const all=[...p1.data.movements,...p2.data.movements,...p3.data.movements].map(m=>m.movement_id);
ck("no movement appears on two pages", new Set(all).size===57, String(new Set(all).size));

const one=await pageOf(1,100);
ck("asking for them all returns them all", one.data.movements.length===57, String(one.data.movements.length));
ck("every id from the paged walk is in the full list",
   new Set(one.data.movements.map(m=>m.movement_id)).size===new Set(all).size);

ck("totals cover the whole set, not the page",
   m2(p1.data.totals.total_in)==="570.00" && m2(p3.data.totals.total_in)==="570.00",
   `${m2(p1.data.totals.total_in)} / ${m2(p3.data.totals.total_in)}`);

const past=await pageOf(9,25);
ck("a page past the end is empty rather than an error",
   past.data.movements.length===0 && past.meta.total===57);

console.log(`\nPASS (${pass.length})`);pass.forEach(p=>console.log("  ✓ "+p));
if(fail.length){console.log(`\nFAIL (${fail.length})`);fail.forEach(f=>console.log("  ✗ "+f));process.exit(1);}
console.log("\nThe ledger pages cleanly and the totals stay honest.");
