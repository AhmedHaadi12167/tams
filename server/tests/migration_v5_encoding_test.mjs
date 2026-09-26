import { PGlite } from "@electric-sql/pglite";
import fs from "fs";

const db = await PGlite.create();
const readSql = (path) =>
  fs
    .readFileSync(path, "utf8")
    .replace(/CREATE EXTENSION[^;]*;/gi, "")
    .replace(/^\uFEFF/, "");

await db.exec(`
  CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid
  LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';
`);
await db.exec(readSql("../config/schema.sql"));

const business = (
  await db.query(
    `INSERT INTO businesses (name, email)
     VALUES ('Airline Migration Test', 'airline-migration@test.invalid')
     RETURNING id`,
  )
).rows[0].id;
const user = (
  await db.query(
    `INSERT INTO users (business_id, name, email, password_hash, role)
     VALUES ($1, 'Test User', 'airline-migration-user@test.invalid', 'test', 'admin')
     RETURNING id`,
    [business],
  )
).rows[0].id;
const ticket = (
  await db.query(
    `INSERT INTO tickets
       (business_id, created_by, ticket_type, passenger_name, from_city,
        to_city, flight_date, airline_name, cost_price, selling_price)
     VALUES ($1,$2,'LOCAL','Test Passenger','MGQ','HGA','2026-10-01',
             'Star Airlines',10,20)
     RETURNING id`,
    [business, user],
  )
).rows[0].id;

await db.exec(readSql("../config/migration_v5.sql"));

const result = await db.query(
  `SELECT airline_match_key('Star Airlines'::VARCHAR) AS first,
          airline_match_key('Fly Dubai'::VARCHAR) AS second,
          airline_match_key(U&'\\00DCn\\00EFted Air'::VARCHAR) AS accented`,
);
if (
  result.rows[0].first !== "STAR" ||
  result.rows[0].second !== "FLYDUBAI" ||
  result.rows[0].accented !== "UNITED"
) {
  throw new Error(
    `Unexpected airline normalization: ${JSON.stringify(result.rows[0])}`,
  );
}

const linked = await db.query(
  `SELECT t.airline_id, a.name, a.match_key
     FROM tickets t
     JOIN airlines a ON a.id = t.airline_id
    WHERE t.id = $1 AND t.business_id = $2`,
  [ticket, business],
);
if (
  linked.rows[0]?.name !== "Star Airlines" ||
  linked.rows[0]?.match_key !== "STAR"
) {
  throw new Error(
    `Migration did not link the ticket airline: ${JSON.stringify(linked.rows)}`,
  );
}

console.log(
  "PASS: migration_v5 creates airline_match_key, normalizes VARCHAR names, and links tickets",
);
await db.close();
