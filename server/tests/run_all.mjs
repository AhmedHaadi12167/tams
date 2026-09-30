/**
 * Runs every *_test.mjs (plus equiv.mjs) in this folder, one at a time,
 * and exits non-zero if any fails. Used by `npm test` and by CI.
 *
 *     cd server && npm test
 *     cd server && npm test -- audit_fixes_test.mjs rules_test.mjs
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const picked = process.argv.slice(2);
const files = (picked.length
  ? picked
  : fs
      .readdirSync(here)
      .filter((f) => f.endsWith("_test.mjs") || f === "equiv.mjs")
).sort();

// Many tests read the schema from ./cfg, a copy of ../config. Refresh it
// first so they always test the migrations actually being shipped.
fs.cpSync(path.join(here, "..", "config"), path.join(here, "cfg"), {
  recursive: true,
});

const results = [];
for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, f)], {
    cwd: here,
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
  });
  const ok = r.status === 0;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ f, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${f}  (${secs}s)`);
  if (!ok) {
    const out = `${r.stdout || ""}\n${r.stderr || ""}`
      .split("\n")
      .filter((l) => /✗|Error|FAIL|assert/i.test(l) && l.length < 400)
      .slice(0, 15);
    out.forEach((l) => console.log("      " + l.trim()));
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} test files passed.`);
process.exit(failed.length ? 1 : 0);
