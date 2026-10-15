import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pg = await PGlite.create();
await pg.exec(
  `CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`,
);
await pg.exec(
  fs
    .readFileSync(path.join(server, "config", "schema.sql"), "utf8")
    .replace(/CREATE EXTENSION[^;]*;/gi, ""),
);
await pg.exec(
  fs.readFileSync(path.join(server, "config", "migration_v30.sql"), "utf8"),
);

const Module = require("module");
const dbShim = {
  query: (sql, params = []) => pg.query(sql, params),
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.endsWith("config/db")) return "__DB_SHIM__";
  return originalResolve.call(this, request, parent, ...rest);
};
require.cache.__DB_SHIM__ = {
  id: "__DB_SHIM__",
  filename: "__DB_SHIM__",
  loaded: true,
  exports: dbShim,
};

const cities = require(path.join(server, "controllers", "cityController.js"));
const businesses = await pg.query(
  `INSERT INTO businesses (name, email)
   VALUES ('Agency One', 'one@example.test'), ('Agency Two', 'two@example.test')
   RETURNING id`,
);
const [agencyOne, agencyTwo] = businesses.rows.map((row) => row.id);
const responseFor = () => {
  const response = { statusCode: 200, body: null };
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
};
const call = async (handler, businessId, req = {}) => {
  const response = responseFor();
  let error;
  await handler(
    { businessId, query: {}, body: {}, ...req },
    response,
    (err) => {
      error = err;
    },
  );
  if (error) throw error;
  return response;
};

const airportChoices = await call(cities.listCities, agencyOne, {
  query: { search: "Mogadishu" },
});
assert.equal(airportChoices.statusCode, 200);
assert.ok(
  airportChoices.body.data.some(
    (airport) =>
      airport.city_name === "Mogadishu" &&
      airport.iata_code === "MGQ" &&
      airport.primary,
  ),
);

const londonChoices = await call(cities.listCities, agencyOne, {
  query: { search: "London" },
});
assert.ok(
  londonChoices.body.data.some(
    (airport) =>
      airport.city_name === "London" &&
      airport.country_code === "GB" &&
      airport.iata_code === "LHR" &&
      airport.primary,
  ),
);

const saved = await call(cities.saveCity, agencyOne, {
  body: { iata_code: "MGQ" },
});
assert.equal(saved.statusCode, 200);
assert.equal(saved.body.data.iata_code, "MGQ");
assert.equal(saved.body.data.city_name, "Mogadishu");

const savedChoice = await call(cities.listCities, agencyOne, {
  query: { search: "MGQ" },
});
assert.equal(savedChoice.body.data[0].saved, true);

const otherAgencyChoices = await call(cities.listCities, agencyTwo, {
  query: { search: "MGQ" },
});
assert.equal(
  otherAgencyChoices.body.data.some((airport) => airport.saved),
  false,
);

const invalidAirport = await call(cities.saveCity, agencyOne, {
  body: { iata_code: "ZZZ" },
});
assert.equal(invalidAirport.statusCode, 422);

console.log("✓ airport lookup, primary IATA, persistence, and business scope");
await pg.close();
