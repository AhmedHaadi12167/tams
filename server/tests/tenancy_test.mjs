// An agency may edit itself, and nothing else.
//
// Opening up "edit your own agency" and "change your own email" adds two
// write paths that were previously closed, and both sit on top of a
// multi-tenant database. The interesting assertions here are all negative:
// what these routes REFUSE to do when asked nicely.
//
//   - an admin editing their agency must not reach another agency's row
//   - an admin must not be able to lift their own suspension
//   - changing the address you sign in with must cost a password
//   - two accounts must never end up sharing one sign-in address
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
import bcrypt from "bcryptjs";
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

const bizC     = require(`${SERVER}/controllers/businessController.js`);
const profileC = require(`${SERVER}/controllers/profileController.js`);

// Two agencies on one platform — the whole point of the boundary.
const mubah = (await pg.query(`INSERT INTO businesses (name,email,phone) VALUES ('Mubah Travel','info@mubah.so','111') RETURNING id`)).rows[0].id;
const rival = (await pg.query(`INSERT INTO businesses (name,email,phone) VALUES ('Rival Travel','info@rival.so','222') RETURNING id`)).rows[0].id;

const PW = "correct-horse-battery";
const hash = bcrypt.hashSync(PW, 4); // low cost: this is a test, not a login
const adminId = (await pg.query(
  `INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'Mubah Admin','admin@mubah.so',$2,'admin') RETURNING id`,
  [mubah, hash])).rows[0].id;
await pg.query(
  `INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'Rival Admin','admin@rival.so',$2,'admin')`,
  [rival, hash]);

const mkRes = () => { const r = { code: 200, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); return r; };
const run = async (fn, req) => {
  const res = mkRes(); let err = null;
  await fn({ businessId: mubah, user: { id: adminId, role: "admin" }, params: {}, query: {}, body: {}, ...req }, res, (e) => (err = e));
  return err ? { code: err.statusCode || 500, message: err.message } : { code: res.code, body: res.body };
};
const bizRow = async (id) =>
  (await pg.query(`SELECT name, email, phone, address, status FROM businesses WHERE id=$1`, [id])).rows[0];
const userRow = async () =>
  (await pg.query(`SELECT name, email, role FROM users WHERE id=$1`, [adminId])).rows[0];

// ── An admin edits their own agency ──────────────────────────────────────
const ok = await run(bizC.updateMyBusiness, {
  body: { name: "Mubah Travel & Cargo", phone: "0615000111", address: "Bakaara, Mogadishu", website: "mubah.so" },
});
ck("an admin can edit their own agency", ok.code === 200, String(ok.code));
const m1 = await bizRow(mubah);
ck("the name reaches the letterhead", m1.name === "Mubah Travel & Cargo", m1.name);
ck("so does the phone and address",
   m1.phone === "0615000111" && m1.address === "Bakaara, Mogadishu",
   `${m1.phone} / ${m1.address}`);

// ── THE TENANCY LINE ─────────────────────────────────────────────────────
//
// There is no id in the route, so the obvious attack is to put one in the
// body and hope it is used.
const crossTenant = await run(bizC.updateMyBusiness, {
  params: { id: rival },
  body: { id: rival, business_id: rival, name: "STOLEN" },
});
ck("sending another agency's id in the body changes nothing there",
   (await bizRow(rival)).name === "Rival Travel",
   (await bizRow(rival)).name);
ck("it edits the caller's own agency instead",
   (await bizRow(mubah)).name === "STOLEN",
   `${crossTenant.code} ${(await bizRow(mubah)).name}`);

// Put the name back for readability of what follows.
await run(bizC.updateMyBusiness, { body: { name: "Mubah Travel" } });

// ── Suspension is the platform's switch, not the tenant's ────────────────
await pg.query(`UPDATE businesses SET status='suspended' WHERE id=$1`, [mubah]);
const unsuspend = await run(bizC.updateMyBusiness, {
  body: { name: "Mubah Travel", status: "active" },
});
ck("an admin may still edit while suspended", unsuspend.code === 200, String(unsuspend.code));
ck("but cannot lift their own suspension",
   (await bizRow(mubah)).status === "suspended",
   (await bizRow(mubah)).status);

// The platform owner can, through the other route.
const res2 = mkRes();
await bizC.updateBusiness(
  { params: { id: mubah }, body: { status: "active" }, user: { role: "super_admin" } },
  res2, () => {},
);
ck("the platform owner can", (await bizRow(mubah)).status === "active",
   (await bizRow(mubah)).status);

// ── Two agencies cannot share a sign-in address ──────────────────────────
const clash = await run(bizC.updateMyBusiness, {
  body: { name: "Mubah Travel", email: "info@rival.so" },
});
ck("taking another agency's email is refused, in plain words",
   clash.code === 409, `${clash.code} ${clash.body?.message || clash.message || ""}`);
ck("and the original email survives the attempt",
   (await bizRow(mubah)).email === "info@mubah.so", (await bizRow(mubah)).email);

// ── Changing your own email ──────────────────────────────────────────────
const noPw = await run(profileC.updateProfile, {
  body: { name: "Mubah Admin", email: "new@mubah.so" },
});
ck("changing your sign-in address without a password is refused",
   noPw.code === 422, String(noPw.code));
ck("and the address is untouched",
   (await userRow()).email === "admin@mubah.so", (await userRow()).email);

const wrongPw = await run(profileC.updateProfile, {
  body: { name: "Mubah Admin", email: "new@mubah.so", current_password: "not-it" },
});
ck("a wrong password is refused too", wrongPw.code === 401, String(wrongPw.code));
ck("still untouched", (await userRow()).email === "admin@mubah.so", (await userRow()).email);

const taken = await run(profileC.updateProfile, {
  body: { name: "Mubah Admin", email: "ADMIN@RIVAL.SO", current_password: PW },
});
ck("an address another account already uses is refused, whatever the case",
   taken.code === 409, String(taken.code));

const good = await run(profileC.updateProfile, {
  body: { name: "Mubah Admin", email: "new@mubah.so", current_password: PW },
});
ck("with the right password it goes through", good.code === 200, String(good.code));
ck("and the account signs in with the new address",
   (await userRow()).email === "new@mubah.so", (await userRow()).email);

// Saving the form again, address unchanged, must not demand a password.
const noChange = await run(profileC.updateProfile, {
  body: { name: "Mubah Admin Renamed", email: "new@mubah.so" },
});
ck("saving with the address unchanged needs no password",
   noChange.code === 200, String(noChange.code));
ck("and the name still saves", (await userRow()).name === "Mubah Admin Renamed",
   (await userRow()).name);

// ── And none of it touches the role ──────────────────────────────────────
ck("the role is never written by either route",
   (await userRow()).role === "admin", (await userRow()).role);

console.log(`\nPASS (${pass.length})`); pass.forEach(p => console.log("  ✓ " + p));
if (fail.length) { console.log(`\nFAIL (${fail.length})`); fail.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
console.log("\nAn agency edits itself, and only itself.");
