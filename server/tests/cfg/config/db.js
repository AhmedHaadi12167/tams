const { Pool, types } = require('pg');
require('dotenv').config();

/**
 * Keep DATE columns as plain 'YYYY-MM-DD' strings.
 *
 * By default node-postgres turns a DATE into a JS Date at LOCAL midnight.
 * JSON.stringify then serialises that as UTC, so in UTC+3 a flight_date of
 * 2026-09-01 reaches the browser as '2026-08-31T21:00:00.000Z' — and taking
 * the first ten characters gives the wrong day. Loading a record and saving
 * it again walked every date backwards one day at a time.
 *
 * A calendar date has no timezone, so the honest representation is the text
 * Postgres already stores. 1082 = date, 1182 = date[].
 */
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1182, (v) => v);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

const query = (text, params) => pool.query(text, params);

const getClient = () => pool.connect();

// Transaction helper
const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { query, getClient, withTransaction, pool };
