/**
 * phoneMatch.js
 *
 * One rule for "is this the same phone number?", used everywhere a user
 * searches by phone.
 *
 * The same person gets written down several ways:
 *
 *   +252 61 234 5678   →  252612345678
 *   0612345678         →  0612345678
 *   612345678          →  612345678
 *
 * As digit strings none of those contains the others, so a substring match
 * finds nothing. What they share is the national number — the last nine
 * digits. Comparing that ignores the country code and the leading trunk
 * zero, which is exactly what a person means when they say "same number".
 *
 * Short searches still fall back to a substring test, so typing the last
 * few digits of a number keeps working.
 */

/** Digits only. */
const digitsOf = (raw) => String(raw || "").replace(/[^0-9]/g, "");

/**
 * SQL fragment testing whether `column` matches the digits in parameter $n.
 * The parameter must be pushed as the RAW digit string, not wrapped in %.
 *
 * @param {string} column  e.g. "t.contact_number"
 * @param {number} n       parameter index
 */
const phoneMatches = (column, n) => {
  const d = `regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g')`;
  return `(
    ${d} <> ''
    AND (
      ${d} LIKE '%' || $${n} || '%'
      OR $${n} LIKE '%' || ${d} || '%'
      OR (
        LENGTH($${n}) >= 7 AND LENGTH(${d}) >= 7
        AND RIGHT(${d}, 9) = RIGHT($${n}, 9)
      )
    )
  )`;
};

/**
 * The same rule in JavaScript, for comparing values already in memory.
 */
const samePhone = (a, b) => {
  const x = digitsOf(a);
  const y = digitsOf(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  if (x.length >= 7 && y.length >= 7) {
    return x.slice(-9) === y.slice(-9);
  }
  return false;
};

module.exports = { phoneMatches, samePhone, digitsOf };
