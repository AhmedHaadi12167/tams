/**
 * agentService.js
 *
 * Turns a name and phone typed on a ticket into an agent record.
 *
 * Agents are created where the work happens — on the booking form — rather
 * than as a separate admin chore. Matching is by phone first, because two
 * people can share a name but not a number.
 */

const { query } = require("../config/db");
const { hasTable } = require("./schemaInfo");

/** Digits only, so '+252 61 234 5678' and '0612345678' compare equal. */
const phoneKey = (raw) => String(raw || "").replace(/[^0-9]/g, "");

const cleanName = (raw) => String(raw || "").replace(/\s+/g, " ").trim();

/**
 * Find or create the agent this commission belongs to.
 *
 * @param {{agent_id?:string, agent_name?:string, agent_phone?:string}} input
 * @param {string} businessId
 * @param {object} [client] optional pg client so it can join a transaction
 * @returns {Promise<{id: string|null, name: string|null, created: boolean}>}
 */
const resolveAgent = async (input, businessId, client = null) => {
  const run = client ? client.query.bind(client) : query;
  const empty = { id: null, name: null, created: false };

  if (!businessId) return empty;
  if (!(await hasTable("agents"))) return empty;

  // An explicit pick from the dropdown always wins
  if (input?.agent_id) {
    const byId = await run(
      `SELECT id, name FROM agents WHERE id = $1 AND business_id = $2`,
      [input.agent_id, businessId],
    );
    if (byId.rows.length > 0) {
      return { id: byId.rows[0].id, name: byId.rows[0].name, created: false };
    }
  }

  const name = cleanName(input?.agent_name);
  const digits = phoneKey(input?.agent_phone);
  if (!name && !digits) return empty;

  // Phone is the strongest signal — but the same person is written both as
  // '0612345678' and '+252 61 234 5678'. Comparing the last nine digits
  // ignores the country code and the leading trunk zero.
  if (digits.length >= 7) {
    const byPhone = await run(
      `SELECT id, name FROM agents
       WHERE business_id = $1
         AND LENGTH(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')) >= 7
         AND RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 9)
             = RIGHT($2, 9)
       LIMIT 1`,
      [businessId, digits],
    );
    if (byPhone.rows.length > 0) {
      return { id: byPhone.rows[0].id, name: byPhone.rows[0].name, created: false };
    }
  }

  if (name) {
    const byName = await run(
      `SELECT id, name FROM agents
       WHERE business_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
      [businessId, name],
    );
    if (byName.rows.length > 0) {
      const found = byName.rows[0];
      // Fill in a phone we didn't have before rather than making a duplicate
      if (digits.length >= 3) {
        await run(
          `UPDATE agents SET phone = COALESCE(NULLIF(TRIM(phone), ''), $1)
           WHERE id = $2`,
          [String(input.agent_phone).trim(), found.id],
        );
      }
      return { id: found.id, name: found.name, created: false };
    }
  }

  // Nobody matched — this is a new agent
  const created = await run(
    `INSERT INTO agents (business_id, name, phone)
     VALUES ($1, $2, $3) RETURNING id, name`,
    [
      businessId,
      name || String(input.agent_phone).trim(),
      digits.length >= 3 ? String(input.agent_phone).trim() : null,
    ],
  );
  return { id: created.rows[0].id, name: created.rows[0].name, created: true };
};

module.exports = { resolveAgent, phoneKey, cleanName };
