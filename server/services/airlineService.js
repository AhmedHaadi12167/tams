/**
 * airlineService.js
 *
 * One place that decides what an airline is called.
 *
 * Agents type airline names by hand, so the same carrier arrives as
 * "Star Airline", "star airlines", "STAR  AIRWAYS". This resolves any
 * of those to a single master row and returns the agency's chosen
 * spelling, so reports never split one airline into several.
 *
 * The matching rule mirrors airline_match_key() in migration_v5.sql —
 * keep the two in sync if you change one.
 */

const { query } = require("../config/db");

// The airlines table arrives with migration_v5. Until it's run, everything
// still has to work — booking a ticket must never fail because a migration
// is pending. Checked once per process, then cached.
let tableReady = null;

const airlinesTableExists = async () => {
  if (tableReady !== null) return tableReady;
  try {
    const r = await query(`SELECT to_regclass('public.airlines') AS t`);
    tableReady = Boolean(r.rows[0] && r.rows[0].t);
  } catch {
    tableReady = false;
  }
  if (!tableReady) {
    console.warn(
      "[TAMS] airlines table not found — run: psql -U postgres -d tams_db -f config/migration_v5.sql\n" +
        "       Until then airline names are saved as typed, without de-duplication.",
    );
  }
  return tableReady;
};

// Aliases arrive with migration_v6 and are optional — v5 alone still works.
let aliasReady = null;

const aliasTableExists = async () => {
  if (aliasReady !== null) return aliasReady;
  try {
    const r = await query(`SELECT to_regclass('public.airline_aliases') AS t`);
    aliasReady = Boolean(r.rows[0] && r.rows[0].t);
  } catch {
    aliasReady = false;
  }
  return aliasReady;
};

/** Lets a successful migration take effect without restarting the server. */
const resetAirlineTableCache = () => {
  tableReady = null;
  aliasReady = null;
};

const GENERIC_SUFFIX =
  /\s+(AIRLINES CO|AIRLINES|AIRLINE|AIRWAYS|AIRWAY|AVIATION|LINES|AIR)$/;

/**
 * "Star Airlines" / "star airline " / "STAR AIRWAYS" -> "STAR"
 * "Fly Dubai" / "FlyDubai" -> "FLYDUBAI"
 */
const matchKey = (raw) => {
  if (!raw) return null;
  // Strip accents first so "Ünïted" and "United" agree.
  let k = String(raw)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
  // Punctuation becomes a space, never nothing — otherwise "Star-Airlines"
  // collapses to "STARAIRLINES" and the suffix rule can't see the last word.
  k = k.replace(/[^A-Z0-9]+/g, " ");
  k = k.replace(/\s+/g, " ").trim();
  // twice, to catch "AIR LINES" and "AIRLINES CO"
  k = k.replace(GENERIC_SUFFIX, "");
  k = k.replace(GENERIC_SUFFIX, "");
  k = k.replace(/ /g, "");
  if (!k) {
    k = String(raw)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  }
  return k || null;
};

/** Tidy a name for display: collapse whitespace, trim. */
const cleanName = (raw) => String(raw || "").replace(/\s+/g, " ").trim();

/**
 * Resolve a typed airline name to the agency's master row.
 * Creates the airline the first time it's seen.
 *
 * @param {string} rawName  whatever the agent typed
 * @param {string} businessId
 * @param {object} client   optional pg client, to run inside a transaction
 * @returns {{ id: string|null, name: string }} canonical id + display name
 */
const resolveAirline = async (rawName, businessId, client = null) => {
  const run = client ? client.query.bind(client) : query;
  const name = cleanName(rawName);
  const key = matchKey(name);

  if (!key || !businessId) return { id: null, name };

  // Checked on the pool, never on `client` — a failed query inside a
  // transaction would abort it and take the whole booking down with it.
  if (!(await airlinesTableExists())) return { id: null, name };

  const existing = await run(
    `SELECT id, name FROM airlines WHERE business_id = $1 AND match_key = $2 LIMIT 1`,
    [businessId, key],
  );
  if (existing.rows.length > 0) {
    // Use the spelling already on record — that's the whole point.
    return { id: existing.rows[0].id, name: existing.rows[0].name };
  }

  // Not a name match — try the alias list ("THY" -> Turkish Airlines)
  if (await aliasTableExists()) {
    const viaAlias = await run(
      `SELECT a.id, a.name
       FROM airline_aliases al
       JOIN airlines a ON a.id = al.airline_id
       WHERE al.business_id = $1 AND al.match_key = $2
       LIMIT 1`,
      [businessId, key],
    );
    if (viaAlias.rows.length > 0) {
      return {
        id: viaAlias.rows[0].id,
        name: viaAlias.rows[0].name,
        via: "alias",
      };
    }
  }

  // First time this carrier is seen. ON CONFLICT guards the race where two
  // agents create the same airline at the same moment.
  const inserted = await run(
    `INSERT INTO airlines (business_id, name, match_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id, match_key) DO UPDATE SET name = airlines.name
     RETURNING id, name`,
    [businessId, name, key],
  );
  return { id: inserted.rows[0].id, name: inserted.rows[0].name };
};

// ── Fuzzy suggestions ────────────────────────────────────────────────────────

/** Levenshtein distance, capped for speed on obviously-distant strings. */
const distance = (a, b) => {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 4) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      last = tmp;
    }
  }
  return prev[b.length];
};

/**
 * Look a name up WITHOUT creating anything.
 * Used right after AI extraction so the agent sees whether the carrier
 * on the PDF is one they already have.
 *
 * @returns {{ matched: boolean, airline: object|null, via: string|null,
 *             suggestions: Array<{id,name,reason}>, name: string }}
 */
const findAirlineMatch = async (rawName, businessId) => {
  const name = cleanName(rawName);
  const key = matchKey(name);
  const empty = { matched: false, airline: null, via: null, suggestions: [], name };

  if (!key || !businessId) return empty;
  if (!(await airlinesTableExists())) return empty;

  const exact = await query(
    `SELECT id, name FROM airlines WHERE business_id = $1 AND match_key = $2 LIMIT 1`,
    [businessId, key],
  );
  if (exact.rows.length > 0) {
    return {
      matched: true,
      airline: exact.rows[0],
      via: "name",
      suggestions: [],
      name: exact.rows[0].name,
    };
  }

  if (await aliasTableExists()) {
    const viaAlias = await query(
      `SELECT a.id, a.name, al.alias
       FROM airline_aliases al
       JOIN airlines a ON a.id = al.airline_id
       WHERE al.business_id = $1 AND al.match_key = $2 LIMIT 1`,
      [businessId, key],
    );
    if (viaAlias.rows.length > 0) {
      return {
        matched: true,
        airline: { id: viaAlias.rows[0].id, name: viaAlias.rows[0].name },
        via: `alias "${viaAlias.rows[0].alias}"`,
        suggestions: [],
        name: viaAlias.rows[0].name,
      };
    }
  }

  // No match — offer the nearest registered carriers
  const all = await query(
    `SELECT id, name, match_key FROM airlines WHERE business_id = $1`,
    [businessId],
  );
  const suggestions = all.rows
    .map((a) => {
      const k = a.match_key || "";
      let reason = null;
      let rank = 99;
      if (k && (k.startsWith(key) || key.startsWith(k))) {
        reason = "similar name";
        rank = 0;
      } else {
        const d = distance(key, k);
        if (d <= 2) {
          reason = "close spelling";
          rank = d;
        }
      }
      return reason ? { id: a.id, name: a.name, reason, rank } : null;
    })
    .filter(Boolean)
    .sort((x, y) => x.rank - y.rank)
    .slice(0, 4)
    .map(({ id, name: n, reason }) => ({ id, name: n, reason }));

  return { ...empty, suggestions };
};

/** Registered names, for the extraction prompt and the autocomplete. */
const knownAirlineNames = async (businessId) => {
  if (!businessId || !(await airlinesTableExists())) return [];
  const r = await query(
    `SELECT name FROM airlines WHERE business_id = $1 AND is_active ORDER BY name`,
    [businessId],
  );
  return r.rows.map((x) => x.name);
};

module.exports = {
  resolveAirline,
  findAirlineMatch,
  knownAirlineNames,
  matchKey,
  cleanName,
  distance,
  airlinesTableExists,
  aliasTableExists,
  resetAirlineTableCache,
};
