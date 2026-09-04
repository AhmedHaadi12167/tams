/**
 * customerLink.js — one rule for "which customer is this?"
 *
 * Booking a ticket has always created the customer if they weren't on file.
 * Visas, packages and cargo did not: a visa only linked to someone whose
 * phone number matched *exactly*, and packages and cargo didn't look at all.
 * So the same person appeared as a customer if they flew and as nobody if
 * they shipped a parcel — which means their statement was incomplete, their
 * deposit could not be spent on the booking, and the agency had two views of
 * one relationship.
 *
 * The rule, in order:
 *
 *   1. an explicit customer_id, if the form supplied one
 *   2. someone with the same national phone number — '0612345678' and
 *      '+252 61 234 5678' are the same person, which exact matching missed
 *   3. someone with the same name
 *   4. otherwise, create them
 *
 * Name matching last and only after phone, because two people genuinely
 * share a name far more often than they share a number.
 */

const { query } = require("../config/db");
const { phoneMatches } = require("./phoneMatch");

/**
 * @param {object} args
 * @param {string} args.businessId
 * @param {string} [args.customerId]  an explicit choice, wins outright
 * @param {string} [args.name]
 * @param {string} [args.phone]
 * @param {object} [args.client]      pg client, to join a transaction
 * @returns {Promise<string|null>} customer id, or null if there was nothing
 *                                 to go on
 */
const resolveOrCreateCustomer = async ({
  businessId,
  customerId,
  name,
  phone,
  client = null,
}) => {
  const run = client ? client.query.bind(client) : query;
  if (customerId) return customerId;

  const cleanName = String(name || "").trim();
  const digits = String(phone || "").replace(/[^0-9]/g, "");

  if (digits) {
    const byPhone = await run(
      `SELECT id FROM customers
        WHERE business_id = $1 AND ${phoneMatches("phone", 2)} LIMIT 1`,
      [businessId, digits],
    );
    if (byPhone.rows.length > 0) return byPhone.rows[0].id;
  }

  if (!cleanName) return null;

  const byName = await run(
    `SELECT id FROM customers WHERE business_id = $1 AND name ILIKE $2 LIMIT 1`,
    [businessId, cleanName],
  );
  if (byName.rows.length > 0) return byName.rows[0].id;

  const created = await run(
    `INSERT INTO customers (business_id, name, phone) VALUES ($1,$2,$3) RETURNING id`,
    [businessId, cleanName, String(phone || "").trim() || null],
  );
  return created.rows[0].id;
};

module.exports = { resolveOrCreateCustomer };
