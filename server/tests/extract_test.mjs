// What the AI returns is not what the form receives.
//
// Between the two sits a normaliser, and it is doing more than tidying:
// it strips the titles that would otherwise split one man into two
// customers, it forces the passenger list into an array whatever shape came
// back, and it refuses to paper over a document that says three passengers
// when only two could be read.
//
// The model is stubbed here. The point is not to test Claude — it is to
// test what happens to Claude's answer, including the answers it gets
// wrong, which is the part that runs on every extraction in production.
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
const require = createRequire(import.meta.url);
const SERVER = "/sessions/awesome-festive-mccarthy/mnt/tams/server";
const pass = [], fail = [];
const ck = (n, ok, d = "") => (ok ? pass : fail).push(n + (d ? ` — ${d}` : ""));

// ── Stub the SDK ────────────────────────────────────────────────────────
let nextReply = "{}";
let lastPrompt = "";
class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async ({ messages }) => {
        lastPrompt = messages[0].content.find((c) => c.type === "text").text;
        return { content: [{ type: "text", text: nextReply }] };
      },
    };
  }
}
const Module = require("module");
const orig = Module._resolveFilename;
require.cache["__SDK__"] = {
  id: "__SDK__",
  filename: "__SDK__",
  loaded: true,
  exports: FakeAnthropic,
};
Module._resolveFilename = function (r, p, ...rest) {
  if (r === "@anthropic-ai/sdk") return "__SDK__";
  return orig.call(this, r, p, ...rest);
};

const { extractTicketData } = require(`${SERVER}/services/aiExtraction.js`);
const { cleanName } = require(`${SERVER}/services/nameClean.js`);

const file = path.join(os.tmpdir(), "fake-ticket.png");
fs.writeFileSync(file, "not really a png");
const read = async (reply) => {
  nextReply = typeof reply === "string" ? reply : JSON.stringify(reply);
  return extractTicketData(file, "image/png", ["Star Airline"]);
};

// ── Titles ──────────────────────────────────────────────────────────────
ck("MR comes off", cleanName("MR ABDIFATAH MOHAMED MOHAMUD") === "ABDIFATAH MOHAMED MOHAMUD");
ck("MRS comes off", cleanName("MRS SAHRO IBRAHIM MAALIN") === "SAHRO IBRAHIM MAALIN");
ck("so do the infant and child codes", cleanName("INF AMINA ABDIFATAH") === "AMINA ABDIFATAH");
ck("a title with a full stop too", cleanName("Dr. Cali Xasan") === "Cali Xasan");
ck("stacked titles are all removed", cleanName("MR DR CALI XASAN") === "CALI XASAN");
ck("a name that merely starts with those letters is untouched",
   cleanName("MRIDULA SHARMA") === "MRIDULA SHARMA", cleanName("MRIDULA SHARMA"));
ck("MOHAMED keeps its M", cleanName("MOHAMED ALI") === "MOHAMED ALI");
ck("nothing but a title is not a name", cleanName("MR") === null || cleanName("MR ") === null);
ck("double spaces collapse", cleanName("CALI   XASAN") === "CALI XASAN");

// ── The document Ahmed sent ─────────────────────────────────────────────
const two = await read({
  contact_name: "ABDIFATAH MOHAMED MOHAMUD",
  contact_number: "612225088",
  passenger_count: 2,
  passengers: [
    { passenger_name: "MR ABDIFATAH MOHAMED MOHAMUD", ticket_reference: "KMUMGQ-16226-000011" },
    { passenger_name: "MRS SAHRO IBRAHIM MAALIN", ticket_reference: "KMUMGQ-16226-000010" },
  ],
  from_city: "MGQ", to_city: "NBO", flight_date: "2027-05-01",
  airline_name: "Star Airline", ticket_type: "INTERNATIONAL",
  base_price: 700, tax: 200, surcharge: 100, total_price: 1000,
});

ck("both passengers are read", two.passengers.length === 2, String(two.passengers.length));
ck("with their titles removed",
   two.passengers[0].passenger_name === "ABDIFATAH MOHAMED MOHAMUD" &&
   two.passengers[1].passenger_name === "SAHRO IBRAHIM MAALIN",
   two.passengers.map((p) => p.passenger_name).join(" | "));
ck("each keeps their own ticket number",
   two.passengers[0].ticket_reference === "KMUMGQ-16226-000011" &&
   two.passengers[1].ticket_reference === "KMUMGQ-16226-000010");
ck("the contact is kept apart from the passengers",
   two.contact_name === "ABDIFATAH MOHAMED MOHAMUD" && two.contact_number === "612225088");
ck("the count is what was actually read", two.passenger_count === 2, String(two.passenger_count));
ck("and the document's own count agreed", two.passenger_count_mismatch === false);
ck("the price stays the combined total, undivided",
   Number(two.selling_price) === 1000, String(two.selling_price));
ck("cost is base plus tax", Number(two.cost_price) === 900, String(two.cost_price));

// ── A document that claims more passengers than it lists ────────────────
const short = await read({
  passenger_count: 3,
  passengers: [{ passenger_name: "ONLY ONE" }, { passenger_name: "AND TWO" }],
  total_price: 300,
});
ck("a missing passenger is reported, not silently accepted",
   short.passenger_count_mismatch === true &&
   short.passenger_count === 2 &&
   short.passenger_count_stated === 3,
   `${short.passenger_count} of ${short.passenger_count_stated}`);

// ── The model ignoring the instruction ──────────────────────────────────
const legacy = await read({
  passenger_name: "MR SOLO TRAVELLER",
  ticket_reference: "ABC123",
  contact_number: "615000111",
  total_price: 250,
});
ck("an old-shape reply still yields a passenger list",
   Array.isArray(legacy.passengers) && legacy.passengers.length === 1,
   JSON.stringify(legacy.passengers));
ck("and it is titled correctly", legacy.passengers[0].passenger_name === "SOLO TRAVELLER");
ck("the flat passenger_name is kept for the older callers",
   legacy.passenger_name === "SOLO TRAVELLER", String(legacy.passenger_name));
ck("with no contact named, the traveller is assumed to be paying",
   legacy.contact_name === "SOLO TRAVELLER", String(legacy.contact_name));

// ── Junk rows ───────────────────────────────────────────────────────────
const junk = await read({
  passengers: [
    { passenger_name: "REAL PERSON" },
    { passenger_name: "" },
    { passenger_name: null },
    {},
    { passenger_name: "MR" },
  ],
  total_price: 100,
});
ck("blank and header rows are dropped rather than booked",
   junk.passengers.length === 1 && junk.passengers[0].passenger_name === "REAL PERSON",
   JSON.stringify(junk.passengers));

// ── A reply wrapped in a markdown fence ─────────────────────────────────
const fenced = await read(
  '```json\n{"passengers":[{"passenger_name":"FENCED NAME"}],"total_price":50}\n```',
);
ck("a fenced reply is still parsed", fenced.passengers[0].passenger_name === "FENCED NAME");

// ── No passengers at all ────────────────────────────────────────────────
const empty = await read({ from_city: "MGQ", total_price: 10 });
ck("an unreadable document yields an empty list, not a crash",
   Array.isArray(empty.passengers) && empty.passengers.length === 0);
ck("and no invented passenger name", empty.passenger_name === null);

// ── The prompt still carries the registry ───────────────────────────────
ck("the agency's airlines are still shown to the model",
   lastPrompt.includes("Star Airline") && lastPrompt.includes("already registered"));
ck("and the model is told the price is for the whole booking",
   lastPrompt.includes("PRICING IS FOR THE WHOLE BOOKING"));

console.log(`\nPASS (${pass.length})`); pass.forEach(p => console.log("  ✓ " + p));
if (fail.length) { console.log(`\nFAIL (${fail.length})`); fail.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
console.log("\nEvery passenger read, every title stripped, nothing invented.");
