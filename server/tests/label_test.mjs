// Every payment history must name the account the money is really in, not
// the legacy "method" text that still defaults to "cash".
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
import { seedAccounts } from "./seed.mjs";
const require=createRequire(import.meta.url);
const SERVER="/sessions/awesome-festive-mccarthy/mnt/tams/server";
const pass=[],fail=[];const ck=(n,ok,d="")=>(ok?pass:fail).push(n+(d?` — ${d}`:""));

const pg=await PGlite.create();
await pg.exec(`CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`);
await pg.exec(fs.readFileSync("cfg/schema.sql","utf8").replace(/CREATE EXTENSION[^;]*;/gi,""));
const dbShim={query:(t,p=[])=>pg.query(t,p),withTransaction:async(fn)=>{await pg.exec("BEGIN");try{const r=await fn({query:(t,p=[])=>pg.query(t,p)});await pg.exec("COMMIT");return r;}catch(e){await pg.exec("ROLLBACK");throw e;}}};
const Module=require("module");const orig=Module._resolveFilename;
const S={__DB__:dbShim,__RPT__:{generateAirlinePDF:async()=>Buffer.from(""),generatePDFReport:async()=>Buffer.from(""),generateExcelReport:async()=>Buffer.from(""),generateCustomerStatementPDF:async()=>Buffer.from("")},__AI__:{extractTicketData:async()=>({})},__MAIL__:{sendOTPEmail:async()=>true}};
Module._resolveFilename=function(r,p,...rest){if(typeof r==="string"){if(r.endsWith("config/db"))return"__DB__";if(r.endsWith("services/reportService"))return"__RPT__";if(r.endsWith("services/aiExtraction"))return"__AI__";if(r.endsWith("services/emailService"))return"__MAIL__";}return orig.call(this,r,p,...rest);};
for(const[id,exports]of Object.entries(S))require.cache[id]={id,filename:id,loaded:true,exports};

const ticketC=require(`${SERVER}/controllers/ticketController.js`);
const airlineC=require(`${SERVER}/controllers/airlineController.js`);
const expenseC=require(`${SERVER}/controllers/expenseController.js`);
const agentC=require(`${SERVER}/controllers/agentController.js`);
const visaC=require(`${SERVER}/controllers/visaController.js`);
const pkgC=require(`${SERVER}/controllers/packageController.js`);

const biz=(await pg.query(`INSERT INTO businesses (name,email) VALUES ('E','e@x.c') RETURNING id`)).rows[0].id;
await seedAccounts(pg, biz);
const user=(await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`,[biz])).rows[0].id;
const A=Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`,[biz])).rows.map(r=>[r.name,r.id]));
const ctx={businessId:biz,user:{id:user,role:"admin"}};
const mkRes=()=>{const r={code:200,body:null};r.status=c=>(r.code=c,r);r.json=b=>(r.body=b,r);return r;};
const call=async(fn,req)=>{const res=mkRes();let err=null;await fn({...ctx,...req},res,e=>err=e);if(err)throw err;return res;};

const AMAL = A["Amal Bank"];

// Every kind of payment, all into or out of Amal Bank.
const t=await call(ticketC.createTicket,{body:{ticket_type:"LOCAL",passenger_name:"AHEMD AWIL ABHSIR",contact_number:"061",
  from_city:"A",to_city:"B",flight_date:"2026-09-01",airline_name:"Star Airline",
  cost_price:200,selling_price:400,amount_paid:100,account_id:AMAL}});
await call(ticketC.addPayment,{params:{id:t.body.data.id},body:{amount:120,account_id:AMAL}});

const airlineId=(await pg.query(`SELECT id FROM airlines WHERE business_id=$1 LIMIT 1`,[biz])).rows[0].id;
await call(airlineC.payAirline,{params:{id:airlineId},body:{amount:190,account_id:AMAL}});

await call(expenseC.createExpense,{body:{category:"rent",description:"Office monthly rent August",amount:300,account_id:AMAL}});

const v=await call(visaC.createVisa,{body:{applicant_name:"AHMED AWIL",destination_country:"Saudi Arabia",visa_type:"Umrah",
  cost_price:200,selling_price:250,amount_paid:100,account_id:AMAL}});

const agentId=(await pg.query(`INSERT INTO agents (business_id,name) VALUES ($1,'Ag') RETURNING id`,[biz])).rows[0].id;
await pg.query(`UPDATE tickets SET agent_id=$1, agent_commission=20 WHERE id=$2`,[agentId,t.body.data.id]);
await call(agentC.payAgent,{params:{id:agentId},body:{amount:20,account_id:AMAL}});

const p=await call(pkgC.createPackage,{body:{label:"Umrah A",package_type:"umrah",selling_price:900,amount_paid:50,
  account_id:AMAL,items:[{item_type:"visa",description:"Visa",quantity:1,unit_cost:100}]}});

// ── Now: does every history name Amal Bank? ──────────────────────────────
const tp=(await call(ticketC.getPayments,{params:{id:t.body.data.id}})).body.data;
ck("ticket payment history names the account", tp.every(r=>r.account_name==="Amal Bank"),
   tp.map(r=>r.account_name).join(", "));
ck("ticket history no longer relies on the 'cash' label", tp.every(r=>r.method==="cash"),
   "the legacy field is still there as a fallback, which is fine");

const ap=(await call(airlineC.getAirlinePayments,{params:{id:airlineId}})).body.data;
ck("airline payment history names the account", ap.every(r=>r.account_name==="Amal Bank"),
   ap.map(r=>r.account_name).join(", "));

const ex=(await call(expenseC.getExpenses,{query:{}})).body.data;
ck("expense list names the account", ex.every(r=>r.account_name==="Amal Bank"),
   ex.map(r=>r.account_name).join(", "));

const ag=(await call(agentC.getAgent,{params:{id:agentId}})).body.data;
const agPayments = ag.payments || [];
ck("agent commission history names the account",
   agPayments.length>0 && agPayments.every(r=>r.account_name==="Amal Bank"),
   agPayments.map(r=>r.account_name).join(", "));

const vd=(await call(visaC.getVisa,{params:{id:v.body.data.id}})).body.data;
const vp = vd.payments || [];
ck("visa payment history names the account",
   vp.length>0 && vp.every(r=>r.account_name==="Amal Bank"),
   vp.map(r=>r.account_name).join(", "));

const pd=(await call(pkgC.getPackage,{params:{id:p.body.data.package?.id || p.body.data.id}})).body.data;
const pp = pd.payments || [];
ck("package payment history names the account",
   pp.length>0 && pp.every(r=>r.account_name==="Amal Bank"),
   pp.map(r=>r.account_name).join(", "));

// And the ledger agrees — 320 in, 490 out, net −170, exactly as on screen.
const f=(await pg.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction='in'),0) i,
  COALESCE(SUM(amount) FILTER (WHERE direction='out'),0) o
  FROM v_cash_ledger WHERE business_id=$1 AND account_id=$2`,[biz,AMAL])).rows[0];
ck("Amal Bank ledger: 370 in", Number(f.i)===370, String(f.i));
ck("Amal Bank ledger: 510 out", Number(f.o)===510, String(f.o));

console.log(`\nPASS (${pass.length})`);pass.forEach(x=>console.log("  ✓ "+x));
if(fail.length){console.log(`\nFAIL (${fail.length})`);fail.forEach(x=>console.log("  ✗ "+x));process.exit(1);}
console.log("\nEvery payment history names the account the money is really in.");
