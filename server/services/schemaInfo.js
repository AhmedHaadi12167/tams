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

const hasTable = async (table) => {
  if (tableCache.has(table)) return tableCache.get(table);
  let exists = false;
  try {
    const r = await query(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
    exists = Boolean(r.rows[0] && r.rows[0].t);
  } catch {
    exists = false;
  }
  tableCache.set(table, exists);
  return exists;
};

const hasColumn = async (table, column) => {
  const key = `${table}.${column}`;
  if (columnCache.has(key)) return columnCache.get(key);
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
  columnCache.set(key, exists);
  return exists;
};

/** Call after running a migration so a restart isn't needed. */
const resetSchemaCache = () => {
  tableCache.clear();
  columnCache.clear();
};

module.exports = { hasTable, hasColumn, resetSchemaCache };
