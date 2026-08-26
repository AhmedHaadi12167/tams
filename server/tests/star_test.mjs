// Ahmed's exact screen: one Star Airline ticket, cost 210 of which 10 is tax,
// 200 already paid. Every figure on the page must agree.
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
const require=createRequire(import.meta.url);
const SERVER="/sessions/awesome-festive-mccarthy/mnt/tams/server";
const pass=[],fail=[];const ck=(n,ok,d="")=>(ok?pass:fail).push(n+(d?` — ${d}`:""));
const m2=v=>Number(v).toFixed(2);

const pg=await PGlite.create();
await pg.exec(`CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`);
await pg.exec(fs.readFileSync("cfg/schema.sql","utf8").replace(/CREATE EXTENSION[^;]*;/gi,""));
const dbShim={query:(t,p=[])=>pg.query(t,p),withTransaction:async(fn)=>{await pg.exec("BEGIN");try{const r=await fn({query:(t,p=[])=>pg.query(t,p)});await pg.exec("COMMIT");return r;}catch(e){await pg.exec("ROLLBACK");throw e;}}};
const Module=require("module");const orig=Module._resolveFilename;
const S={__DB__:dbShim,__RPT__:{generateAirlinePDF:async()=>Buffer.from("")},__AI__:{extractTicketData:async()=>({})},__MAIL__:{sendOTPEmail:async()=>true}};
Module._resolveFilename=function(r,p,...rest){if(typeof r==="string"){if(r.endsWith("config/db"))return"__DB__";if(r.endsWith("services/reportService"))return"__RPT__";if(r.endsWith("services/aiExtraction"))return"__AI__";if(r.endsWith("services/emailService"))return"__MAIL__";}return orig.call(this,r,p,...rest);};
for(const[id,exports]of Object.entries(S))require.cache[id]={id,filename:id,loaded:true,exports};

const ticketC=require(`${SERVER}/controllers/ticketController.js`);
const airlineC=require(`${SERVER}/controllers/airlineController.js`);
const taxC=require(`${SERVER}/controllers/taxController.js`);

const biz=(await pg.query(`INSERT INTO businesses (name,email) VALUES ('Mubah','m@x.c') RETURNING id`)).rows[0].id;
const user=(await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'Mohamed','m@x.c','h','admin') RETURNING id`,[biz])).rows[0].id;
const A=Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`,[biz])).rows.map(r=>[r.name,r.id]));
const ctx={businessId:biz,user:{id:user,role:"admin"}};
const mkRes=()=>{const r={code:200,body:null};r.status=c=>(r.code=c,r);r.json=b=>(r.body=b,r);return r;};
const call=async(fn,req)=>{const res=mkRes();let err=null;await fn({...ctx,...req},res,e=>err=e);if(err)throw err;return res;};

// The ticket exactly as on screen.
await call(ticketC.createTicket,{body:{ticket_type:"LOCAL",passenger_name:"AHMED AWIL",contact_number:"610481578",
  from_city:"Mogadishu",to_city:"Laascaanood",flight_date:"2026-08-26",airline_name:"Star Airline",
  cost_price:210,tax:10,selling_price:250,amount_paid:250,account_id:A["Cash"]}});

const airlineId=(await pg.query(`SELECT id FROM airlines WHERE business_id=$1 LIMIT 1`,[biz])).rows[0].id;
await call(airlineC.payAirline,{params:{id:airlineId},body:{amount:200,account_id:A["Premier Bank"]}});

// ── Header tiles ──────────────────────────────────────────────────────────
const list=(await call(airlineC.getAirlines,{query:{}})).body.data;
const row=list.airlines[0];
ck("COST (PERIOD) nets off the tax", m2(row.total_cost)==="200.00", m2(row.total_cost));
ck("OWED ALL TIME is 200", m2(row.account_cost)==="200.00", m2(row.account_cost));
ck("PAID TO AIRLINE is 200", m2(row.account_paid)==="200.00", m2(row.account_paid));
ck("BALANCE OWED is zero", m2(row.account_balance)==="0.00", m2(row.account_balance));

// ── The passenger row, which disagreed before ────────────────────────────
const pax=(await call(airlineC.getAirlinePassengers,{params:{name:"Star Airline"},query:{}})).body.data;
const p=pax.passengers[0];
ck("passenger AIRLINE COST shows 200, not 210", m2(p.cost_price)==="200.00", m2(p.cost_price));
ck("passenger PAID shows 200", m2(p.airline_paid)==="200.00", m2(p.airline_paid));
ck("passenger OWED is zero, not 10", m2(p.airline_balance)==="0.00", m2(p.airline_balance));
ck("the fare actually paid out is still visible", m2(p.fare_paid_out)==="210.00", m2(p.fare_paid_out));
ck("the tax on the ticket is visible", m2(p.tax)==="10.00", m2(p.tax));
ck("nothing is reported unsettled", Number(pax.summary?.unsettled ?? 0)===0, String(pax.summary?.unsettled));

// ── The tax is owed once, to the government ──────────────────────────────
const tax=(await call(taxC.getTaxAccount,{query:{}})).body.data;
ck("tax owed is the 10, counted once", m2(tax.summary.tax_owed)==="10.00", m2(tax.summary.tax_owed));

// ── And settling per-passenger must not overpay ──────────────────────────
const t2=await call(ticketC.createTicket,{body:{ticket_type:"LOCAL",passenger_name:"P2",contact_number:"612",
  from_city:"A",to_city:"B",flight_date:"2026-09-01",airline_name:"Star Airline",
  cost_price:110,tax:10,selling_price:150,amount_paid:150,account_id:A["Cash"]}});
await call(airlineC.payTickets,{body:{ticket_ids:[t2.body.data.id],account_id:A["Premier Bank"]}});
const paid2=(await pg.query(`SELECT airline_paid FROM tickets WHERE id=$1`,[t2.body.data.id])).rows[0].airline_paid;
ck("settling one passenger pays 100, not 110", m2(paid2)==="100.00", m2(paid2));
const bal2=(await pg.query(`SELECT balance FROM v_airline_account WHERE airline_id=$1`,[airlineId])).rows[0].balance;
ck("airline balance still zero after settling", m2(bal2)==="0.00", m2(bal2));

console.log(`\nPASS (${pass.length})`);pass.forEach(x=>console.log("  ✓ "+x));
if(fail.length){console.log(`\nFAIL (${fail.length})`);fail.forEach(x=>console.log("  ✗ "+x));process.exit(1);}
console.log("\nEvery figure on the airline page agrees, and tax is counted once.");
