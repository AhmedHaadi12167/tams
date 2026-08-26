// The account picker sends whatever the API's id field is called. If those
// two ever disagree the dropdown looks perfect and silently sends nothing
// usable — which is exactly what happened.
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
const S={__DB__:dbShim,__RPT__:{generateAirlinePDF:async()=>Buffer.from(""),generatePDFReport:async()=>Buffer.from(""),generateExcelReport:async()=>Buffer.from("")},__AI__:{extractTicketData:async()=>({})},__MAIL__:{sendOTPEmail:async()=>true}};
Module._resolveFilename=function(r,p,...rest){if(typeof r==="string"){if(r.endsWith("config/db"))return"__DB__";if(r.endsWith("services/reportService"))return"__RPT__";if(r.endsWith("services/aiExtraction"))return"__AI__";if(r.endsWith("services/emailService"))return"__MAIL__";}return orig.call(this,r,p,...rest);};
for(const[id,exports]of Object.entries(S))require.cache[id]={id,filename:id,loaded:true,exports};

const accountC=require(`${SERVER}/controllers/accountController.js`);
const visaC=require(`${SERVER}/controllers/visaController.js`);
const reportC=require(`${SERVER}/controllers/reportController.js`);

const biz=(await pg.query(`INSERT INTO businesses (name,email) VALUES ('E','e@x.c') RETURNING id`)).rows[0].id;
const user=(await pg.query(`INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`,[biz])).rows[0].id;
const ctx={businessId:biz,user:{id:user,role:"admin"}};
const mkRes=()=>{const r={code:200,body:null};r.status=c=>(r.code=c,r);r.json=b=>(r.body=b,r);return r;};
const call=async(fn,req)=>{const res=mkRes();let err=null;await fn({...ctx,...req},res,e=>err=e);if(err)throw err;return res;};

// 1. Every account the API returns must carry BOTH keys the UI might use.
const list=await call(accountC.getAccounts,{query:{}});
const accts=list.body.data.accounts;
ck("API returns an id on every account", accts.every(a=>a.id), `${accts.filter(a=>!a.id).length} missing`);
ck("API still returns account_id", accts.every(a=>a.account_id));
ck("the two agree", accts.every(a=>a.id===a.account_id));

// 2. The id the dropdown would send must actually work end to end.
const dahab=accts.find(a=>a.name==="Dahabshiil Bank");
const v=await call(visaC.createVisa,{body:{applicant_name:"GEEDI ALI",destination_country:"OMAN",
  visa_type:"Tourism",cost_price:300,selling_price:400,amount_paid:300,account_id:dahab.id}});
await call(visaC.addVisaPayment,{params:{id:v.body.data.id},body:{amount:50,account_id:dahab.id}});
const landed=(await pg.query(
  `SELECT a.name FROM v_cash_ledger l JOIN payment_accounts a ON a.id=l.account_id
    WHERE l.business_id=$1 AND l.source='visa' ORDER BY l.occurred_at DESC LIMIT 1`,[biz])).rows[0].name;
ck("a visa payment using that id lands in Dahabshiil Bank", landed==="Dahabshiil Bank", landed);

// 3. Sending the account NAME (the old broken behaviour) must be refused.
let refused=false;
try { await call(visaC.addVisaPayment,{params:{id:v.body.data.id},body:{amount:10,account_id:"Dahabshiil Bank"}}); }
catch { refused=true; }
ck("sending the account name instead of its id is refused", refused);

// 4. Reports must cover every service, not just tickets.
await pg.query(`INSERT INTO cargo_shipments (business_id,created_by,sender_name,receiver_name,from_city,to_city,flat_price,amount_paid,payment_status,tracking_number)
                VALUES ($1,$2,'S','R','A','B',100,40,'partial','CGO-1')`,[biz,user]);
const rep=(await call(reportC.getReportSummary,{query:{}})).body.data;
ck("reports include visas", rep.services.visas.count===1, `${rep.services.visas.count}`);
ck("reports include cargo",  rep.services.cargo.count===1, `${rep.services.cargo.count}`);
ck("visa revenue is charged minus cost", m2(rep.services.visas.revenue)==="100.00", m2(rep.services.visas.revenue));
const sumRev = rep.services.tickets.revenue+rep.services.cargo.revenue+rep.services.visas.revenue+rep.services.packages.revenue;
ck("service rows add up to total revenue", m2(sumRev)===m2(rep.summary.total_revenue), `${m2(sumRev)} vs ${m2(rep.summary.total_revenue)}`);
const sumCol = rep.services.tickets.collected+rep.services.cargo.collected+rep.services.visas.collected+rep.services.packages.collected;
ck("service rows add up to collected", m2(sumCol)===m2(rep.summary.total_collected), `${m2(sumCol)} vs ${m2(rep.summary.total_collected)}`);

console.log(`\nPASS (${pass.length})`);pass.forEach(p=>console.log("  ✓ "+p));
if(fail.length){console.log(`\nFAIL (${fail.length})`);fail.forEach(f=>console.log("  ✗ "+f));process.exit(1);}
console.log("\nThe picker's id matches the API, and Reports covers every service.");
