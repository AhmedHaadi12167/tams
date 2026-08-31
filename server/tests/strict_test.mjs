// Money must never be recorded without an account, once accounts exist.
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
import { seedAccounts } from "./seed.mjs";
const require = createRequire(import.meta.url);
const SERVER = "/sessions/awesome-festive-mccarthy/mnt/tams/server";
const pass=[],fail=[]; const ck=(n,ok,d="")=>(ok?pass:fail).push(n+(d?` — ${d}`:""));

const pg = await PGlite.create();
await pg.exec(`CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`);
await pg.exec(fs.readFileSync("cfg/schema.sql","utf8").replace(/CREATE EXTENSION[^;]*;/gi,""));

const dbShim = { query:(t,p=[])=>pg.query(t,p),
  withTransaction: async(fn)=>{ await pg.exec("BEGIN"); try{ const r=await fn({query:(t,p=[])=>pg.query(t,p)}); await pg.exec("COMMIT"); return r;}catch(e){await pg.exec("ROLLBACK");throw e;} } };
const Module=require("module"); const orig=Module._resolveFilename;
const STUBS={__DB__:dbShim,__RPT__:{generateAirlinePDF:async()=>Buffer.from(""),generatePDFReport:async()=>Buffer.from(""),generateExcelReport:async()=>Buffer.from("")},__AI__:{extractTicketData:async()=>({})},__MAIL__:{sendOTPEmail:async()=>true}};
Module._resolveFilename=function(r,p,...rest){ if(typeof r==="string"){ if(r.endsWith("config/db"))return"__DB__"; if(r.endsWith("services/reportService"))return"__RPT__"; if(r.endsWith("services/aiExtraction"))return"__AI__"; if(r.endsWith("services/emailService"))return"__MAIL__"; } return orig.call(this,r,p,...rest); };
for(const [id,exports] of Object.entries(STUBS)) require.cache[id]={id,filename:id,loaded:true,exports};

const ticketC=require(`${SERVER}/controllers/ticketController.js`);
const expenseC=require(`${SERVER}/controllers/expenseController.js`);
const airlineC=require(`${SERVER}/controllers/airlineController.js`);

const biz=(await pg.query(`INSERT INTO businesses (name,email) VALUES ('E','e@x.c') RETURNING id`)).rows[0].id;
await seedAccounts(pg, biz);
const user=(await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`,[biz])).rows[0].id;
const A=Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`,[biz])).rows.map(r=>[r.name,r.id]));
const ctx={businessId:biz,user:{id:user,role:"admin"}};
const mkRes=()=>{const r={code:200,body:null};r.status=c=>(r.code=c,r);r.json=b=>(r.body=b,r);return r;};
const call=async(fn,req)=>{const res=mkRes();let err=null;await fn({...ctx,...req},res,e=>err=e);return {res,err};};

// A booking WITH money but NO account must be refused — this is the exact
// shape the stale client was sending.
const r1=await call(ticketC.createTicket,{body:{
  ticket_type:"LOCAL",passenger_name:"P",contact_number:"061",from_city:"A",to_city:"B",
  flight_date:"2026-09-01",airline_name:"Air",cost_price:10,selling_price:100,
  amount_paid:50, method:"cash" }});   // no account_id
ck("paid booking with no account is refused", !!r1.err && r1.err.statusCode===400, r1.err?.message?.slice(0,50));

// The same booking with an account goes through.
const r2=await call(ticketC.createTicket,{body:{
  ticket_type:"LOCAL",passenger_name:"P2",contact_number:"062",from_city:"A",to_city:"B",
  flight_date:"2026-09-01",airline_name:"Air",cost_price:10,selling_price:100,
  amount_paid:50, account_id:A["Salaam Bank"] }});
ck("same booking with an account succeeds", !r2.err && r2.res.code===201, r2.err?.message);

// A booking with NOTHING paid needs no account.
const r3=await call(ticketC.createTicket,{body:{
  ticket_type:"LOCAL",passenger_name:"P3",contact_number:"063",from_city:"A",to_city:"C",
  flight_date:"2026-09-01",airline_name:"Air",cost_price:10,selling_price:100,
  amount_paid:0 }});
ck("unpaid booking needs no account", !r3.err && r3.res.code===201, r3.err?.message);

// Expenses and airline payouts too.
const r4=await call(expenseC.createExpense,{body:{category:"rent",description:"R",amount:10}});
ck("expense with no account is refused", !!r4.err && r4.err.statusCode===400);

const airlineId=(await pg.query(`SELECT id FROM airlines WHERE business_id=$1 LIMIT 1`,[biz])).rows[0].id;
const r5=await call(airlineC.payAirline,{params:{id:airlineId},body:{amount:5,method:"cash"}});
ck("airline payment with no account is refused", !!r5.err && r5.err.statusCode===400);

// Nothing slipped into Cash while all that was happening.
const cash=(await pg.query(`SELECT COUNT(*)::int n FROM v_cash_ledger l JOIN payment_accounts a ON a.id=l.account_id WHERE l.business_id=$1 AND a.name='Cash'`,[biz])).rows[0].n;
ck("nothing was filed under Cash by guesswork", cash===0, `${cash} rows`);
const unassigned=(await pg.query(`SELECT COUNT(*)::int n FROM v_cash_ledger WHERE business_id=$1 AND account_id IS NULL`,[biz])).rows[0].n;
ck("nothing was left unassigned", unassigned===0, `${unassigned} rows`);

console.log(`\nPASS (${pass.length})`); pass.forEach(p=>console.log("  ✓ "+p));
if(fail.length){ console.log(`\nFAIL (${fail.length})`); fail.forEach(f=>console.log("  ✗ "+f)); process.exit(1); }
console.log("\nMoney can no longer be recorded without saying where it went.");
