/**
 * nameClean.js — one spelling of a person's name.
 *
 * Airline documents print titles: "MR ABDIFATAH MOHAMED MOHAMUD" travels,
 * while the contact section names "ABDIFATAH MOHAMED MOHAMUD" as the man
 * paying. They are the same person. Stored as two strings they become two
 * customers, and then his balance is split across both records, his
 * statement shows half his bookings, and the money owed to the agency is
 * scattered under two names that look identical on screen.
 *
 * So the title comes off at every door: when the AI reads a document, when
 * a booking is saved, and when a name is typed by hand. It lives in its own
 * tiny module rather than inside aiExtraction because the save path must
 * strip names whether or not anything AI-related is available — the test
 * harness replaces the extraction service entirely, and a rule that
 * disappears under test is a rule that is not enforced.
 */

// The title must be followed by whitespace or be the whole string. The
// whitespace is what keeps MRIDULA and MOHAMED intact — without it the rule
// would eat the first two letters of a real name. Allowing end-of-string as
// well is what catches a lone "MR" left in a table cell, which would
// otherwise be booked as a passenger of that name.
const TITLES =
  /^(?:(?:MR|MRS|MS|MISS|MSTR|MASTER|DR|PROF|SIR|MADAM|MDM|ADT|CHD|INF)\.?(?:\s+|$))+/i;

/**
 * @param {*} v  whatever the form or the model supplied
 * @returns {string|null}  the name without its title, or null if there is
 *                         nothing left worth calling a name
 */
const cleanName = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const stripped = s.replace(TITLES, "").replace(/\s+/g, " ").trim();
  // A string that was nothing but a title is not a name.
  return stripped || null;
};

module.exports = { cleanName, TITLES };
