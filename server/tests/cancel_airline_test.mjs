// Reproduce Ahmed's −$150 and prove it nets to zero, with the loss visible.
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const SERVER = "/sessions/awesome-festive-mccarthy/mnt/tams/server";
const pass=[],fail=[]; const ck=(n,ok,d="")=>(ok?pass:fail).push(n+(d?` — ${d}`:""));
const m2=v=>Number(v).toFixed(2);

const pg = await PGlite.create();
await pg.exec(`CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`);
await pg.exec(fs.readFileSync("cfg/schema.sql","utf8").replace(/CREATE EXTENSION[^;]*;/gi,""));

const dbShim={query:(t,p=[])=>pg.query(t,p),withTransaction:async(fn)=>{await pg.exec("BEGIN");try{const r=await fn({query:(t,p=[])=>pg.query(t,p)});await pg.exec("COMMIT");return r;}catch(e){await pg.exec("ROLLBACK");throw e;}}};
const Module=require("module");const orig=Module._resolveFilename;
const S={__DB__:dbShim,__RPT__:{generateAirlinePDF:async()=>Buffer.from(""),generatePDFReport:async()=>Buffer.from(""),generateExcelReport:async()=>Buffer.from("")},__AI__:{extractTicketData:async()=>({})},__MAIL__:{sendOTPEmail:async()=>true}};
Module._resolveFilename=function(r,p,...rest){if(typeof r==="string"){if(r.endsWith("config/db"))return"__DB__";if(r.endsWith("services/reportService"))return"__RPT__";if(r.endsWith("services/aiExtraction"))return"__AI__";if(r.endsWith("services/emailService"))return"__MAIL__";}return orig.call(this,r,p,...rest);};
for(const[id,exports]of Object.entries(S))require.cache[id]={id,filename:id,loaded:true,exports};

const ticketC=require(`${SERVER}/controllers/ticketController.js`);
const airlineC=require(`${SERVER}/controllers/airlineController.js`);
const finC=require(`${SERVER}/controllers/financialsController.js`);

const biz=(await pg.query(`INSERT INTO businesses (name,email) VALUES ('E','e@x.c') RETURNING id`)).rows[0].id;
const user=(await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`,[biz])).rows[0].id;
const A=Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`,[biz])).rows.map(r=>[r.name,r.id]));
const ctx={businessId:biz,user:{id:user,role:"admin"}};
const mkRes=()=>{const r={code:200,body:null};r.status=c=>(r.code=c,r);r.json=b=>(r.body=b,r);return r;};
const call=async(fn,req)=>{const res=mkRes();let err=null;await fn({...ctx,...req},res,e=>err=e);if(err)throw err;return res;};

// Ticket costing 150, sold for 200, customer pays in full. Pay the airline 150.
const t=await call(ticketC.createTicket,{body:{ticket_type:"LOCAL",passenger_name:"P",contact_number:"061",
  from_city:"A",to_city:"B",flight_date:"2026-09-01",airline_name:"Star Airline",
  cost_price:150,selling_price:200,amount_paid:200,account_id:A["Cash"]}});
const airlineId=(await pg.query(`SELECT id FROM airlines WHERE business_id=$1 LIMIT 1`,[biz])).rows[0].id;
await call(airlineC.payAirline,{params:{id:airlineId},body:{amount:150,account_id:A["Premier Bank"]}});

const b1=(await pg.query(`SELECT balance FROM v_airline_account WHERE airline_id=$1`,[airlineId])).rows[0].balance;
ck("before cancelling, the airline is square", m2(b1)==="0.00", m2(b1));

// Cancel: refund the customer 200, airline refunds nothing.
await call(ticketC.cancelTicket,{params:{id:t.body.data.id},
  body:{refund_amount:200,airline_refund:0,account_id:A["Cash"]}});

const b2=(await pg.query(`SELECT balance, total_cost, total_paid FROM v_airline_account WHERE airline_id=$1`,[airlineId])).rows[0];
ck("airline balance is NOT negative after a cancellation",
   Number(b2.balance)===0, `balance ${m2(b2.balance)} (cost ${m2(b2.total_cost)}, paid ${m2(b2.total_paid)})`);

const pl=(await call(finC.getProfitLoss,{query:{}})).body.data;
ck("cancelled sale left revenue", m2(pl.revenue.ticket_sales)==="0.00", m2(pl.revenue.ticket_sales));
ck("the 150 lost to the airline is shown", m2(pl.cancellations.unrecovered_cost)==="150.00", m2(pl.cancellations.unrecovered_cost));
ck("no fee was kept (full refund)", m2(pl.cancellations.fees_kept)==="0.00", m2(pl.cancellations.fees_kept));
ck("net profit reflects the real loss", m2(pl.net_profit)==="-150.00", m2(pl.net_profit));

// And a partial airline refund nets to zero too.
const t2=await call(ticketC.createTicket,{body:{ticket_type:"LOCAL",passenger_name:"P2",contact_number:"062",
  from_city:"A",to_city:"C",flight_date:"2026-09-02",airline_name:"Star Airline",
  cost_price:100,selling_price:150,amount_paid:150,account_id:A["Cash"]}});
await call(airlineC.payAirline,{params:{id:airlineId},body:{amount:100,account_id:A["Premier Bank"]}});
await call(ticketC.cancelTicket,{params:{id:t2.body.data.id},
  body:{refund_amount:150,airline_refund:60,account_id:A["Cash"],airline_account_id:A["Premier Bank"]}});
const b3=(await pg.query(`SELECT balance FROM v_airline_account WHERE airline_id=$1`,[airlineId])).rows[0].balance;
ck("partial airline refund also nets to zero", m2(b3)==="0.00", m2(b3));

console.log(`\nPASS (${pass.length})`);pass.forEach(p=>console.log("  ✓ "+p));
if(fail.length){console.log(`\nFAIL (${fail.length})`);fail.forEach(f=>console.log("  ✗ "+f));process.exit(1);}
console.log("\nCancellations no longer leave a phantom airline credit.");
