const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
// Titles are stripped in the prompt AND here, because a rule the model is
// asked to follow is a rule it will sometimes not follow.
const { cleanName } = require("./nameClean");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * The agency's registered airlines are injected into the prompt so Claude
 * returns the spelling already on record. Without this the model happily
 * alternates between "Star Airline", "Star Airlines" and "STAR AIRWAYS"
 * depending on how the PDF is laid out, and each becomes a separate carrier.
 */
const airlineGuidance = (knownAirlines = []) => {
  if (!knownAirlines.length) return "";
  const list = knownAirlines.slice(0, 200).map((a) => `- ${a}`).join("\n");
  return `

IMPORTANT — airline_name must match the agency's existing records.
These airlines are already registered:
${list}

If the ticket's carrier is one of these — including when the ticket writes it
differently (different capitalisation, singular/plural, an IATA code, or an
abbreviation) — return the registered spelling EXACTLY as written above.
Only if the carrier is genuinely not in the list, return the name as printed
on the ticket.`;
};

const EXTRACTION_PROMPT = `You are a data extraction assistant for a travel agency management system.

Analyze this airline ticket (image or PDF) and extract the following fields. Return ONLY valid JSON, no explanation, no markdown.

ONE DOCUMENT CAN COVER SEVERAL PASSENGERS. A family or a company group flies
on one itinerary: same route, same date, same airline, one combined price,
but two or more travellers, each with their own ticket number. Read every
one of them.

Two different things are being asked for, and confusing them corrupts the
agency's accounts:

- CONTACT — the ONE person the booking is billed to. This is who pays, who
  owes the balance, and who the statement is addressed to. Documents label
  this "Contact Information", "Booked by", "Billing", "Agent contact" or
  similar, and it is where the phone number lives. There is never more than
  one. The contact is often also the first passenger; that is fine, return
  them in both places.
- PASSENGERS — everyone who actually travels. Documents label this
  "Passenger Information", "Traveller details", "Names", or simply list them
  beside their ticket numbers. There may be one, or there may be ten.

Required JSON structure:
{
  "contact_name": "Name of the person the booking is billed to, or null",
  "contact_number": "Their phone number, or null",
  "passenger_count": "How many passengers the document says are travelling, as a number, or null",
  "passengers": [
    {
      "passenger_name": "Full name of this traveller",
      "ticket_reference": "THIS passenger's own ticket/e-ticket number, or null",
      "passport_number": "This passenger's passport number, or null",
      "nationality": "This passenger's nationality, or null"
    }
  ],
  "from_city": "Departure city/airport or null",
  "to_city": "Destination city/airport or null",
  "flight_date": "YYYY-MM-DD format or null",
  "return_date": "YYYY-MM-DD if it is a round trip, otherwise null",
  "airline_name": "Airline name or null",
  "ticket_reference": "Booking reference/PNR for the whole booking, or null",
  "ticket_type": "LOCAL or INTERNATIONAL based on whether it crosses international borders",
  "base_price": "The base price number only (before tax) or null",
  "tax": "The tax amount number only or null",
  "surcharge": "The surcharge amount number only or null",
  "total_price": "The final total price number only or null"
}

Rules:
- Return ONLY the JSON object, no other text
- Use null for any field not found
- "passengers" must ALWAYS be an array, even for a single traveller
- List passengers in the order they are printed on the document
- When ticket numbers are listed beside the names, match each passenger to
  their OWN number by position. Do not give every passenger the same number.
- Strip titles from names: "MR ABDIFATAH MOHAMED MOHAMUD" is
  "ABDIFATAH MOHAMED MOHAMUD". Drop MR, MRS, MS, MISS, MSTR, MASTER, DR,
  PROF, and the INF/CHD/ADT passenger-type codes. Keep the rest of the name
  exactly as printed.
- "passenger_count" is what the DOCUMENT states (e.g. "2 Adults", "PAX: 3").
  If it states nothing, use the number of passengers you found.
- Dates must be in YYYY-MM-DD format
- ticket_type is INTERNATIONAL if flight crosses international borders, LOCAL otherwise
- PRICING IS FOR THE WHOLE BOOKING, not per passenger. If the document
  prints a per-person fare and a total, return the TOTAL. If it prints only
  a per-person fare, multiply it by the number of passengers.
- For pricing: extract numbers only, no currency symbols`;

/** Numbers arrive as "1,250.00", "$1250" or 1250 depending on the document. */
const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const extractTicketData = async (filePath, mimeType, knownAirlines = []) => {
  const fileBuffer = fs.readFileSync(filePath);
  const base64Data = fileBuffer.toString("base64");

  let contentBlock;
  if (mimeType === "application/pdf") {
    contentBlock = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: base64Data,
      },
    };
  } else {
    const validTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    const imageType = validTypes.includes(mimeType) ? mimeType : "image/jpeg";
    contentBlock = {
      type: "image",
      source: { type: "base64", media_type: imageType, data: base64Data },
    };
  }

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    // Raised for group bookings: ten passengers with their own ticket
    // numbers and passports is a much longer answer than one, and a reply
    // truncated mid-array is invalid JSON — the extraction fails outright
    // rather than dropping the last passenger, but either is a bad day.
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          contentBlock,
          {
            type: "text",
            text: EXTRACTION_PROMPT + airlineGuidance(knownAirlines),
          },
        ],
      },
    ],
  });

  const rawText = message.content[0].text.trim();
  const jsonText = rawText
    .replace(/^```json?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const extracted = JSON.parse(jsonText);

  const fields = [
    "contact_name",
    "contact_number",
    "from_city",
    "to_city",
    "flight_date",
    "return_date",
    "airline_name",
    "ticket_reference",
    "ticket_type",
    "base_price",
    "tax",
    "surcharge",
    "total_price",
  ];

  const clean = {};
  for (const field of fields) {
    clean[field] = extracted[field] ?? null;
  }

  if (!["LOCAL", "INTERNATIONAL"].includes(clean.ticket_type)) {
    clean.ticket_type = "LOCAL";
  }

  // ── Passengers ──────────────────────────────────────────────────────────
  //
  // Always an array, even when the model ignored the instruction and
  // returned the old single-passenger shape. Every consumer downstream can
  // then be written once instead of twice.
  const rawPassengers = Array.isArray(extracted.passengers)
    ? extracted.passengers
    : extracted.passenger_name
      ? [
          {
            passenger_name: extracted.passenger_name,
            ticket_reference: extracted.ticket_reference ?? null,
          },
        ]
      : [];

  clean.passengers = rawPassengers
    .map((p) => ({
      passenger_name: cleanName(p?.passenger_name),
      ticket_reference: p?.ticket_reference ?? null,
      passport_number: p?.passport_number ?? null,
      nationality: p?.nationality ?? null,
    }))
    // A row with no name is not a passenger. It is usually the model
    // repeating a table header, and letting it through would book a ticket
    // for someone called "Passenger Name".
    .filter((p) => p.passenger_name);

  clean.contact_name = cleanName(clean.contact_name);

  // What the document claimed, and what we could actually read. They are
  // reported separately and never quietly reconciled: "the ticket says 3
  // passengers, I found 2" is something a human must look at, because the
  // missing one is a seat somebody paid for.
  const stated = toNumber(extracted.passenger_count);
  clean.passenger_count = clean.passengers.length;
  clean.passenger_count_stated =
    stated !== null ? Math.round(stated) : null;
  clean.passenger_count_mismatch =
    clean.passenger_count_stated !== null &&
    clean.passenger_count_stated !== clean.passenger_count;

  // Back-compatible single-passenger fields. The edit form, the older tests
  // and anything else reading the flat shape keep working unchanged.
  clean.passenger_name = clean.passengers[0]?.passenger_name ?? null;
  if (!clean.ticket_reference)
    clean.ticket_reference = clean.passengers[0]?.ticket_reference ?? null;

  // The contact is who pays. When the document does not name one, the lead
  // passenger is the only honest guess — somebody handed over the money.
  if (!clean.contact_name) clean.contact_name = clean.passenger_name;

  // Auto-calculate:
  // cost_price = base_price + tax
  // selling_price = total_price
  // revenue = surcharge
  //
  // These are the totals for the whole booking, however many passengers it
  // covers. Dividing them is the save path's job, not the reader's — the
  // form has to show the agent the same combined figure the document shows
  // the customer, or they cannot check the two against each other.
  if (clean.base_price !== null && clean.tax !== null) {
    clean.cost_price = (
      parseFloat(clean.base_price) + parseFloat(clean.tax)
    ).toFixed(2);
  }
  if (clean.total_price !== null) {
    clean.selling_price = parseFloat(clean.total_price).toFixed(2);
  }
  if (clean.surcharge !== null) {
    clean.revenue_hint = parseFloat(clean.surcharge).toFixed(2);
  }

  return clean;
};

module.exports = { extractTicketData };
