/**
 * date.js — one place that understands calendar dates.
 *
 * A flight date, an applied date or a departure date is a calendar day, not
 * a moment in time. `new Date("2026-09-01")` parses that string as midnight
 * UTC, so anywhere west of Greenwich it renders as 31 August. Feeding a
 * `Date` back through `.toISOString().slice(0,10)` has the mirror problem
 * east of Greenwich.
 *
 * Everything here works in LOCAL calendar terms, so a date shown on screen
 * is the date stored in the database, and saving a record never moves it.
 */

import { format } from "date-fns";

const pad = (n) => String(n).padStart(2, "0");

/** Exactly 'YYYY-MM-DD', with no time part. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turn any stored value into a Date positioned at LOCAL midnight.
 * Returns null for empty or unparseable input.
 */
export const parseDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m && DATE_ONLY.test(s)) {
    // Build from parts so the browser can't shift it by a timezone
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

/** Value for an <input type="date">. Always 'YYYY-MM-DD' or ''. */
export const toDateInput = (value) => {
  if (!value) return "";
  const s = String(value);
  if (DATE_ONLY.test(s)) return s; // already exactly what the input wants

  const d = parseDate(value);
  if (!d) return "";
  // Local components, never toISOString, which would convert to UTC
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Display a calendar date. Falls back to a dash rather than 'Invalid Date'. */
export const fmtDate = (value, pattern = "dd MMM yyyy") => {
  const d = parseDate(value);
  if (!d) return "—";
  try {
    return format(d, pattern);
  } catch {
    return "—";
  }
};

/** Today, in the format an <input type="date"> expects. */
export const todayInput = () => toDateInput(new Date());

/** Shift a calendar date by whole days without touching the clock. */
export const addDays = (value, days) => {
  const d = parseDate(value) || new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
};
