// Tax belongs to the government, not the airline — and not to the agency.
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
import { seedAccounts } from "./seed.mjs";
const require=createRequire(import.meta.url);
const SERVER="/sessions/awesome-festive-mccarthy/mnt/tams/server";
const pass=[],fail=[];const ck=(n,ok,d="")=>(ok?pass:fail).push(n+(d?` — ${d}`:""));
const m2=v=>Number(v).toFixed(2);

const pg=await PGlite.create();
await pg.exec(`CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`);
await pg.exec(fs.readFileSync("cfg/schema.sql","utf8").replace(/CREATE EXTENSION[^;]*;/gi,""));
const dbShim={query:(t,p=[])=>pg.query(t,p),withTransaction:async(fn)=>{await pg.exec("BEGIN");try{const r=await fn({query:(t,p=[])=>pg.query(t,p)});await pg.exec("COMMIT");return r;}catch(e){await pg.exec("ROLLBACK");throw e;}}};
const Module=require("module");const orig=Module._resolveFilename;
const S={__DB__:dbShim,__RPT__:{generateAirlinePDF:async()=>Buffer.from(""),generatePDFReport:async()=>Buffer.from(""),generateExcelReport:async()=>Buffer.from("")},__AI__:{extractTicketData:async()=>({})},__MAIL__:{sendOTPEmail:async()=>true}};
Module._resolveFilename=function(r,p,...rest){if(typeof r==="string"){if(r.endsWith("config/db"))return"__DB__";if(r.endsWith("services/reportService"))return"__RPT__";if(r.endsWith("services/aiExtraction"))return"__AI__";if(r.endsWith("services/emailService"))return"__MAIL__";}return orig.call(this,r,p,...rest);};
for(const[id,exports]of Object.entries(S))require.cache[id]={id,filename:id,loaded:true,exports};

const ticketC=require(`${SERVER}/controllers/ticketController.js`);
const airlineC=require(`${SERVER}/controllers/airlineController.js`);
const taxC=require(`${SERVER}/controllers/taxController.js`);
const accountC=require(`${SERVER}/controllers/accountController.js`);
const finC=require(`${SERVER}/controllers/financialsController.js`);

const biz=(await pg.query(`INSERT INTO businesses (name,email) VALUES ('E','e@x.c') RETURNING id`)).rows[0].id;
await seedAccounts(pg, biz);
const user=(await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`,[biz])).rows[0].id;
const A=Object.fromEntries((await pg.query(`SELECT id,name FROM payment_accounts WHERE business_id=$1`,[biz])).rows.map(r=>[r.name,r.id]));
const ctx={businessId:biz,user:{id:user,role:"admin"}};
const mkRes=()=>{const r={code:200,body:null};r.status=c=>(r.code=c,r);r.json=b=>(r.body=b,r);return r;};
const call=async(fn,req)=>{const res=mkRes();let err=null;await fn({...ctx,...req},res,e=>err=e);if(err)throw err;return res;};

// Ticket: cost 500 of which 80 is tax. Sold for 700. Customer pays in full.
await call(ticketC.createTicket,{body:{ticket_type:"LOCAL",passenger_name:"P",contact_number:"061",
  from_city:"A",to_city:"B",flight_date:"2026-09-01",airline_name:"Star Airline",
  cost_price:500,tax:80,selling_price:700,amount_paid:700,account_id:A["Cash"]}});

const acct=(await pg.query(`SELECT total_cost,total_tax,balance FROM v_airline_account WHERE business_id=$1`,[biz])).rows[0];
ck("airline is owed cost minus tax", m2(acct.total_cost)==="420.00", m2(acct.total_cost));
ck("the tax is shown separately", m2(acct.total_tax)==="80.00", m2(acct.total_tax));
ck("airline balance excludes the tax", m2(acct.balance)==="420.00", m2(acct.balance));

// Settling in full should clear the airline, not overpay by the tax.
const airlineId=(await pg.query(`SELECT id FROM airlines WHERE business_id=$1 LIMIT 1`,[biz])).rows[0].id;
await call(airlineC.payAirline,{params:{id:airlineId},body:{account_id:A["Premier Bank"]}});
const after=(await pg.query(`SELECT balance FROM v_airline_account WHERE business_id=$1`,[biz])).rows[0].balance;
ck("settling in full clears the airline exactly", m2(after)==="0.00", m2(after));

// Tax is owed to the authority.
const tax=(await call(taxC.getTaxAccount,{query:{}})).body.data;
ck("tax owed is the 80 collected", m2(tax.summary.tax_owed)==="80.00", m2(tax.summary.tax_owed));

// Overpaying tax is refused.
// Returns a 400 rather than throwing, so check the response.
const over = await call(taxC.payTax,{body:{amount:100,account_id:A["Cash"]}});
ck("paying more tax than is owed is refused", over.code===400, over.body?.message?.slice(0,50));

// Pay it, and the balance clears and shows in the ledger.
await call(taxC.payTax,{body:{amount:80,account_id:A["Cash"]}});
const tax2=(await call(taxC.getTaxAccount,{query:{}})).body.data;
ck("tax owed reaches zero", m2(tax2.summary.tax_owed)==="0.00", m2(tax2.summary.tax_owed));

const led=(await pg.query(`SELECT direction,amount FROM v_cash_ledger WHERE business_id=$1 AND source='tax'`,[biz])).rows;
ck("the tax payment appears in the ledger as money out", led.length===1 && led[0].direction==="out" && m2(led[0].amount)==="80.00");

// Accounts still reconcile.
const bal=Number((await pg.query(`SELECT COALESCE(SUM(balance),0) s FROM v_account_balance WHERE business_id=$1`,[biz])).rows[0].s);
const flow=(await pg.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction='in'),0) i, COALESCE(SUM(amount) FILTER (WHERE direction='out'),0) o FROM v_cash_ledger WHERE business_id=$1 AND account_id IS NOT NULL`,[biz])).rows[0];
ck("accounts still equal money in minus out", m2(bal)===m2(Number(flow.i)-Number(flow.o)), `${m2(bal)}`);
ck("what's left is 700 in less 420 airline less 80 tax", m2(bal)==="200.00", m2(bal));

// ── Write-off on cancellation ──────────────────────────────────────────────
const t2=await call(ticketC.createTicket,{body:{ticket_type:"LOCAL",passenger_name:"P2",contact_number:"062",
  from_city:"A",to_city:"C",flight_date:"2026-09-02",airline_name:"Star Airline",
  cost_price:100,selling_price:300,amount_paid:100,account_id:A["Cash"]}});
const r=await call(ticketC.cancelTicket,{params:{id:t2.body.data.id},
  body:{refund_amount:0,airline_refund:0,write_off:true}});
ck("cancelling with a write-off needs no account", r.code===200, r.body?.message);
const tk=(await pg.query(`SELECT written_off, cancellation_fee FROM tickets WHERE id=$1`,[t2.body.data.id])).rows[0];
ck("the 200 still owed was written off", m2(tk.written_off)==="200.00", m2(tk.written_off));
ck("the 100 already paid is kept as a fee", m2(tk.cancellation_fee)==="100.00", m2(tk.cancellation_fee));

const pl=(await call(finC.getProfitLoss,{query:{}})).body.data;
ck("the write-off shows as a loss in the P&L", m2(pl.cancellations.written_off)==="200.00", m2(pl.cancellations.written_off));
ck("tax collected is disclosed in the P&L", m2(pl.tax.collected)==="80.00", m2(pl.tax.collected));

console.log(`\nPASS (${pass.length})`);pass.forEach(p=>console.log("  ✓ "+p));
if(fail.length){console.log(`\nFAIL (${fail.length})`);fail.forEach(f=>console.log("  ✗ "+f));process.exit(1);}
console.log("\nTax reaches the government, not the airline; write-offs are visible.");
