/**
 * sqlSafe.js
 *
 * Almost every query in TAMS binds its values as $1, $2, … which is what
 * makes SQL injection impossible: the driver sends the statement and the
 * values separately, so nothing a user types can ever be read as SQL.
 *
 * A handful of dashboard queries are assembled differently. They build one
 * WHERE fragment and reuse it across a dozen statements that each have
 * their own parameter lists, so threading a bound value through all of them
 * would mean renumbering every placeholder in the file — a change far more
 * likely to introduce a bug than to prevent one.
 *
 * For those, this module provides the next best thing: prove the value is a
 * UUID before it goes anywhere near a query. A string matching this pattern
 * contains only hex digits and hyphens, so it cannot carry a quote, a
 * semicolon, a comment marker, or anything else with meaning in SQL. The
 * check is on the shape of the value, not on where it came from, which is
 * what makes it hold even if the calling code changes later.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Return the value only if it is a well-formed UUID, otherwise throw.
 *
 * Throwing rather than returning null is deliberate. A malformed id here
 * means either a bug or an attempt at something; silently substituting a
 * default would hide both, and could quietly widen a query's scope beyond
 * the business it was meant to cover.
 *
 * @param {string} value
 * @param {string} label  what this id is, for the error message
 * @returns {string} the same value, now known to be safe to inline
 */
const uuidOrThrow = (value, label = "id") => {
  const s = String(value ?? "");
  if (!UUID_RE.test(s)) {
    const err = new Error(`Invalid ${label}`);
    // errorHandler reads statusCode; status is set too so this stays correct
    // if the handler is ever changed to the other convention.
    err.statusCode = 400;
    err.status = 400;
    err.expose = true;
    throw err;
  }
  return s;
};

/** Non-throwing variant, for places that have a sensible fallback. */
const isUuid = (value) => UUID_RE.test(String(value ?? ""));

module.exports = { uuidOrThrow, isUuid, UUID_RE };
