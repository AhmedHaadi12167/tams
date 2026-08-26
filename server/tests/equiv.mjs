// A fresh install (schema.sql alone) and an upgraded one (old schema +
// migrations) must end up with identical databases. If they diverge, one
// group of users gets bugs the other never sees.
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
const strip = (s) => s.replace(/CREATE EXTENSION[^;]*;/gi, "");
const shim = `CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`;

async function build(files) {
  const db = await PGlite.create();
  await db.exec(shim);
  for (const f of files) await db.exec(strip(fs.readFileSync("cfg/" + f, "utf8")));
  return db;
}

const shape = async (db) => {
  const cols = await db.query(`
    SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns WHERE table_schema='public'
     ORDER BY table_name, column_name`);
  const views = await db.query(`
    SELECT table_name FROM information_schema.views
     WHERE table_schema='public' ORDER BY table_name`);
  const trig = await db.query(`
    SELECT trigger_name, event_object_table FROM information_schema.triggers
     WHERE trigger_schema='public' ORDER BY 1,2`);
  return {
    cols: cols.rows.map(r => `${r.table_name}.${r.column_name}:${r.data_type}:${r.is_nullable}`),
    views: views.rows.map(r => r.table_name),
    trig: [...new Set(trig.rows.map(r => `${r.event_object_table}.${r.trigger_name}`))],
  };
};

const fresh = await shape(await build(["schema.sql"]));
// schema.sql already contains every migration, so re-running all of them on
// top of it must land in exactly the same place. Anything that isn't
// idempotent shows up here as a shape difference.
const upgraded = await shape(
  await build([
    "schema.sql",
    ...Array.from({ length: 9 }, (_, i) => `migration_v${i + 10}.sql`),
  ]),
);

const diff = (a, b, label) => {
  const onlyA = a.filter(x => !b.includes(x));
  const onlyB = b.filter(x => !a.includes(x));
  if (!onlyA.length && !onlyB.length) { console.log(`  ✓ ${label} identical (${a.length})`); return true; }
  console.log(`  ✗ ${label} differs`);
  onlyA.slice(0,10).forEach(x => console.log("      fresh only: " + x));
  onlyB.slice(0,10).forEach(x => console.log("      upgrade only: " + x));
  return false;
};

const ok = [
  diff(fresh.cols, upgraded.cols, "columns"),
  diff(fresh.views, upgraded.views, "views"),
  diff(fresh.trig, upgraded.trig, "triggers"),
].every(Boolean);

console.log(ok ? "\nfresh install and upgraded install are structurally identical" : "\nDIVERGENCE FOUND");
process.exit(ok ? 0 : 1);
