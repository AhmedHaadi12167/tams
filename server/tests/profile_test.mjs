// You can set your own job title. You cannot promote yourself.
//
// A title and a role look similar on screen and are nothing alike: the role
// is an access level the system enforces, the title is what a customer reads
// under a signature on an invoice. Keeping them in separate columns is what
// makes it safe to let anyone edit their own title — no wording in that box
// can change what the person is allowed to do.
//
// This file holds that line. The interesting assertions are the ones about
// what /api/profile REFUSES to write.
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const SERVER = "/sessions/awesome-festive-mccarthy/mnt/tams/server";
const pass = [], fail = [];
const ck = (n, ok, d = "") => (ok ? pass : fail).push(n + (d ? ` — ${d}` : ""));

const pg = await PGlite.create();
await pg.exec(`CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`);
await pg.exec(fs.readFileSync("cfg/schema.sql", "utf8").replace(/CREATE EXTENSION[^;]*;/gi, ""));

const dbShim = {
  query: (t, p = []) => pg.query(t, p),
  withTransaction: async (fn) => {
    await pg.exec("BEGIN");
    try { const r = await fn({ query: (t, p = []) => pg.query(t, p) }); await pg.exec("COMMIT"); return r; }
    catch (e) { await pg.exec("ROLLBACK"); throw e; }
  },
};
const Module = require("module"); const orig = Module._resolveFilename;
const S = {
  __DB__: dbShim,
  __RPT__: { generateCustomerStatementPDF: async () => Buffer.from("") },
  __AI__: { extractTicketData: async () => ({}) },
  __MAIL__: { sendOTPEmail: async () => true },
};
Module._resolveFilename = function (r, p, ...rest) {
  if (typeof r === "string") {
    if (r.endsWith("config/db")) return "__DB__";
    if (r.endsWith("services/reportService")) return "__RPT__";
    if (r.endsWith("services/aiExtraction")) return "__AI__";
    if (r.endsWith("services/emailService")) return "__MAIL__";
  }
  return orig.call(this, r, p, ...rest);
};
for (const [id, exports] of Object.entries(S)) require.cache[id] = { id, filename: id, loaded: true, exports };

const profileC = require(`${SERVER}/controllers/profileController.js`);

const biz = (await pg.query(`INSERT INTO businesses (name,email) VALUES ('Mubah','m@x.c') RETURNING id`)).rows[0].id;
const uid = (await pg.query(
  `INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'Faarax Cali','f@x.c','h','accountant') RETURNING id`,
  [biz])).rows[0].id;

const mkRes = () => { const r = { code: 200, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); return r; };
const call = async (body) => {
  const res = mkRes(); let err = null;
  await profileC.updateProfile(
    { businessId: biz, user: { id: uid, role: "accountant" }, body },
    res,
    (e) => (err = e),
  );
  return err ? { code: err.statusCode || 500, message: err.message } : { code: res.code, body: res.body };
};
const row = async () =>
  (await pg.query(`SELECT name, title, role, email FROM users WHERE id=$1`, [uid])).rows[0];

// ── Setting a title ──────────────────────────────────────────────────────
const r1 = await call({ name: "Faarax Cali", title: "Finance Manager" });
ck("a title can be set from your own profile", r1.code === 200, String(r1.code));
ck("and it is stored", (await row()).title === "Finance Manager", (await row()).title);
ck("the response carries it back for the form",
   r1.body?.data?.title === "Finance Manager", JSON.stringify(r1.body?.data));

// ── Clearing it ──────────────────────────────────────────────────────────
await call({ name: "Faarax Cali", title: "   " });
ck("an empty box means no title, not an empty string",
   (await row()).title === null, JSON.stringify((await row()).title));

// ── Editing your name still works, and alone ─────────────────────────────
await call({ name: "Faarax Cali Xasan", title: "Operations Director" });
await call({ name: "Faarax C. Xasan" });
const afterNameOnly = await row();
ck("saving only a name leaves the title alone",
   afterNameOnly.name === "Faarax C. Xasan" &&
   afterNameOnly.title === "Operations Director",
   `${afterNameOnly.name} / ${afterNameOnly.title}`);

// ── THE SECURITY LINE ────────────────────────────────────────────────────
//
// The whole reason this is safe to expose: the route writes two columns and
// no others. Anything else in the body is ignored, however it is spelled.
const sneaky = await call({
  name: "Faarax C. Xasan",
  title: "Chief Executive Officer",
  role: "super_admin",
  is_active: false,
  email: "attacker@evil.com",
  business_id: "00000000-0000-0000-0000-000000000000",
  password_hash: "x",
});
ck("a grand title is allowed", sneaky.code === 200, String(sneaky.code));
const after = await row();
ck("but the role is untouched by it",
   after.role === "accountant", after.role);
ck("the email cannot be changed here either",
   after.email === "f@x.c", after.email);
ck("calling yourself CEO changes the invoice, not your access",
   after.title === "Chief Executive Officer" && after.role === "accountant",
   `${after.title} / ${after.role}`);

// ── Limits ───────────────────────────────────────────────────────────────
const long = await call({ name: "Faarax C. Xasan", title: "x".repeat(121) });
ck("a title longer than the column is refused, not truncated",
   long.code === 422, String(long.code));
ck("and the previous title survives the refusal",
   (await row()).title === "Chief Executive Officer", (await row()).title);

const ok120 = await call({ name: "Faarax C. Xasan", title: "y".repeat(120) });
ck("exactly 120 characters is accepted", ok120.code === 200, String(ok120.code));

const noName = await call({ name: "   ", title: "Manager" });
ck("a blank name is still refused", noName.code === 422, String(noName.code));

console.log(`\nPASS (${pass.length})`); pass.forEach(p => console.log("  ✓ " + p));
if (fail.length) { console.log(`\nFAIL (${fail.length})`); fail.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
console.log("\nAnyone can title themselves; nobody can promote themselves.");
