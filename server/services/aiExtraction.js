const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");

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

Required JSON structure:
{
  "passenger_name": "Full name of passenger or null",
  "contact_number": "Phone number or null",
  "from_city": "Departure city/airport or null",
  "to_city": "Destination city/airport or null",
  "flight_date": "YYYY-MM-DD format or null",
  "airline_name": "Airline name or null",
  "ticket_reference": "Booking reference/PNR code or null",
  "ticket_type": "LOCAL or INTERNATIONAL based on whether it crosses international borders",
  "base_price": "The base price number only (before tax) or null",
  "tax": "The tax amount number only or null",
  "surcharge": "The surcharge amount number only or null",
  "total_price": "The final total price number only or null"
}

Rules:
- Return ONLY the JSON object, no other text
- Use null for any field not found
- Dates must be in YYYY-MM-DD format
- ticket_type is INTERNATIONAL if flight crosses international borders, LOCAL otherwise
- For pricing: extract numbers only, no currency symbols`;

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
    max_tokens: 1024,
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
    "passenger_name",
    "contact_number",
    "from_city",
    "to_city",
    "flight_date",
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

  // Auto-calculate:
  // cost_price = base_price + tax
  // selling_price = total_price
  // revenue = surcharge
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
