/**
 * accountResolver.js
 *
 * Turns whatever a payment form sent into the id of an account that really
 * belongs to this agency.
 *
 * Three inputs are accepted, in descending order of confidence:
 *
 *   1. account_id   an explicit choice from the dropdown — checked for
 *                   ownership, because trusting an id from the request would
 *                   let a crafted call post money into another agency's books
 *   2. method       the old free-text label ('cash', 'EVC'). Matched against
 *                   account names so requests written before this feature
 *                   still land somewhere sensible instead of nowhere
 *   3. nothing      returns null
 *
 * Returning null is a legitimate answer, not a failure. The money is still
 * recorded and still appears in the ledger; it simply has no account yet and
 * shows as unassigned until someone says where it went. Inventing an account
 * would be worse: it would look reconciled while being wrong.
 */

const { query } = require("../config/db");
const { hasTable } = require("./schemaInfo");
const { isUuid } = require("../utils/sqlSafe");

/**
 * @param {object} input   usually req.body
 * @param {string} businessId
 * @param {object} [client]  optional pg client so it can join a transaction
 * @returns {Promise<string|null>} account id, or null
 */
const resolveAccount = async (input, businessId, client = null) => {
  const run = client ? client.query.bind(client) : query;

  if (!businessId) return null;
  if (!(await hasTable("payment_accounts"))) return null;

  // 1. An explicit choice — but only if this agency owns it.
  const explicit = input?.account_id;
  if (isUuid(explicit)) {
    const r = await run(
      `SELECT id FROM payment_accounts WHERE id = $1 AND business_id = $2`,
      [explicit, businessId],
    );
    if (r.rows.length > 0) return r.rows[0].id;

    // A well-formed id this agency doesn't own is a real problem — a stale
    // dropdown, or a request aimed at someone else's books. Refusing loudly
    // is the only safe answer. Falling through to the label match below
    // would quietly file the money under whatever the method happened to
    // say, which is how money "disappears into Cash".
    const err = new Error(
      "That payment account was not found. Reload the page and choose it again.",
    );
    err.statusCode = 400;
    err.expose = true;
    throw err;
  }

  // 2. No account was chosen.
  //
  // There used to be a fallback here that matched the old `method` text
  // against account names. It was meant to keep older clients working, and
  // it was the single worst piece of code in this system: a payment sent
  // with method "cash" matched the account *named* Cash, so money landed
  // there confidently and wrongly, with no error and no way to tell.
  //
  // Guessing where money went is worse than refusing to record it. The
  // caller decides what to do about a null — requireAccount() below turns it
  // into a clear error wherever an amount actually moves.
  if (input?.method || input?.payment_method) {
    console.warn(
      "[accounts] A payment arrived with no account_id. It will not be " +
        "assigned to any account. This usually means a browser is still " +
        "running an older build — a hard refresh should fix it.",
    );
  }

  return null;
};

/**
 * Same as resolveAccount, but refuses to record money it cannot place.
 *
 * Used wherever an amount actually moves. The reasoning is simple: once an
 * agency has accounts set up, a payment that names none of them is a mistake,
 * not a preference. Guessing produces a balance that looks right and is
 * wrong — the single worst outcome for a system whose whole job is to say
 * where the money is.
 *
 * It stays silent when the agency has no accounts at all, so an installation
 * that hasn't run migration_v11 keeps working exactly as before.
 *
 * @param {object} input
 * @param {string} businessId
 * @param {object} [client]
 * @param {string} [what] what the money was for, for the error message
 */
const requireAccount = async (input, businessId, client = null, what = "payment") => {
  const resolved = await resolveAccount(input, businessId, client);
  if (resolved) return resolved;

  if (!(await hasTable("payment_accounts"))) return null;

  const run = client ? client.query.bind(client) : query;
  const any = await run(
    `SELECT 1 FROM payment_accounts
      WHERE business_id = $1 AND is_active LIMIT 1`,
    [businessId],
  );
  // No accounts configured — nothing to choose from, so don't block the sale.
  if (any.rows.length === 0) return null;

  const err = new Error(
    `Choose which account this ${what} went into or out of. ` +
      `Without it the money can't appear in any balance.`,
  );
  err.statusCode = 400;
  err.expose = true;
  throw err;
};

module.exports = { resolveAccount, requireAccount };
