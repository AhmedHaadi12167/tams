/**
 * schemaInfo.js
 *
 * Cheap, cached answers to "does this table/column exist yet?".
 *
 * Migrations are run by hand, so a server can be running newer code than
 * the database it is pointed at. Rather than let that surface as a 500 in
 * the middle of a booking, features check here first and degrade quietly.
 *
 * Checks run on the pool, never inside a caller's transaction — a failing
 * query inside a transaction aborts the whole thing.
 */

const { query } = require("../config/db");

const tableCache = new Map();
const columnCache = new Map();

/**
 * A "yes" is cached forever — tables and columns are not removed under a
 * running server. A "no" is cached only briefly.
 *
 * That asymmetry matters more than it looks. Migrations are run by hand
 * while the API is up, and a permanently cached "no" meant a feature stayed
 * silently switched off until somebody happened to restart the process —
 * with no error anywhere to explain why. Payments would record with no
 * account, balances would quietly under-count, and nothing would say so.
 *
 * Fifteen seconds is long enough to keep the check off the hot path and
 * short enough that running a migration takes effect on its own.
 */
const NEGATIVE_TTL_MS = 15_000;

const readCache = (cache, key) => {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  if (hit.value) return true;
  if (Date.now() - hit.at < NEGATIVE_TTL_MS) return false;
  cache.delete(key);
  return undefined;
};

const writeCache = (cache, key, value) => {
  cache.set(key, { value, at: Date.now() });
  return value;
};

const hasTable = async (table) => {
  const cached = readCache(tableCache, table);
  if (cached !== undefined) return cached;
  let exists = false;
  try {
    const r = await query(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
    exists = Boolean(r.rows[0] && r.rows[0].t);
  } catch {
    exists = false;
  }
  return writeCache(tableCache, table, exists);
};

const hasColumn = async (table, column) => {
  const key = `${table}.${column}`;
  const cached = readCache(columnCache, key);
  if (cached !== undefined) return cached;
  let exists = false;
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    exists = r.rows.length > 0;
  } catch {
    exists = false;
  }
  return writeCache(columnCache, key, exists);
};

/** Call after running a migration so a restart isn't needed. */
const resetSchemaCache = () => {
  tableCache.clear();
  columnCache.clear();
};

module.exports = { hasTable, hasColumn, resetSchemaCache };
