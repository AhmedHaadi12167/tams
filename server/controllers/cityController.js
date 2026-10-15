const { query } = require("../config/db");
const response = require("../utils/response");
const airportDirectory = require("../data/airports.json");

const tableExists = async () => {
  const result = await query(
    `SELECT to_regclass('public.ticket_cities') AS table_name`,
  );
  return Boolean(result.rows[0]?.table_name);
};

const cleanSearch = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

const typeRank = {
  large_airport: 0,
  medium_airport: 1,
  small_airport: 2,
  seaplane_base: 3,
  heliport: 4,
};

const primaryAirportCodes = {
  "amman:jo": "AMM",
  "bangkok:th": "BKK",
  "beijing:cn": "PEK",
  "casablanca:ma": "CMN",
  "chicago:us": "ORD",
  "colombo:lk": "CMB",
  "delhi:in": "DEL",
  "doha:qa": "DOH",
  "houston:us": "IAH",
  "istanbul:tr": "IST",
  "jakarta:id": "CGK",
  "johannesburg:za": "JNB",
  "london:gb": "LHR",
  "los angeles:us": "LAX",
  "mexico city:mx": "MEX",
  "milan:it": "MXP",
  "moscow:ru": "SVO",
  "mumbai:in": "BOM",
  "new york:us": "JFK",
  "orlando:us": "MCO",
  "osaka:jp": "KIX",
  "paris:fr": "CDG",
  "portland:us": "PDX",
  "rome:it": "FCO",
  "san francisco:us": "SFO",
  "seoul:kr": "ICN",
  "sao paulo:br": "GRU",
  "shanghai:cn": "PVG",
  "tehran:ir": "IKA",
  "tenerife:es": "TFS",
  "tokyo:jp": "HND",
  "washington:us": "IAD",
};

const migrationRequired = (res) =>
  response.error(
    res,
    "Saved airport choices need a database update. Run migration_v30.sql.",
    503,
  );

const listCities = async (req, res, next) => {
  try {
    if (!(await tableExists())) return migrationRequired(res);

    const search = String(req.query.search || "").trim().slice(0, 100);
    const savedResult = await query(
      `SELECT id, city_name, airport_name, iata_code, country_code,
              airport_type, TRUE AS saved
       FROM ticket_cities
       WHERE business_id = $1
         AND ($2 = '' OR city_name ILIKE $3 OR airport_name ILIKE $3 OR iata_code ILIKE $3)
       ORDER BY city_name, airport_name
       LIMIT 30`,
      [req.businessId, search, `%${search}%`],
    );

    const normalized = cleanSearch(search);
    const savedCodes = new Set(
      savedResult.rows.map((airport) => airport.iata_code),
    );
    const directoryMatches = airportDirectory
      .filter((airport) => {
        if (savedCodes.has(airport.iata_code)) return false;
        if (!normalized) return airport.airport_type === "large_airport";
        return [
          airport.city,
          airport.airport_name,
          airport.iata_code,
          airport.country_code,
        ].some((value) => cleanSearch(value).includes(normalized));
      })
      .sort(
        (a, b) =>
          (typeRank[a.airport_type] ?? 9) - (typeRank[b.airport_type] ?? 9) ||
          a.city.localeCompare(b.city) ||
          a.airport_name.localeCompare(b.airport_name),
      )
      .slice(0, search ? 20 : 10)
      .map((airport) => ({
        city_name: airport.city,
        airport_name: airport.airport_name,
        iata_code: airport.iata_code,
        country_code: airport.country_code,
        airport_type: airport.airport_type,
        saved: false,
      }));

    const airportsByCode = new Map();
    for (const airport of [...savedResult.rows, ...directoryMatches]) {
      if (!airportsByCode.has(airport.iata_code)) {
        airportsByCode.set(airport.iata_code, airport);
      }
    }
    const resultsByCity = new Map();
    for (const airport of airportsByCode.values()) {
      const key = `${cleanSearch(airport.city_name)}:${airport.country_code}`;
      if (!resultsByCity.has(key)) resultsByCity.set(key, []);
      resultsByCity.get(key).push(airport);
    }
    const results = [];
    for (const airports of resultsByCity.values()) {
      const preferenceKey = `${cleanSearch(airports[0].city_name)}:${String(
        airports[0].country_code,
      ).toLowerCase()}`;
      const preferredCode = primaryAirportCodes[preferenceKey];
      airports.sort(
        (a, b) =>
          (a.iata_code === preferredCode ? -1 : 0) -
            (b.iata_code === preferredCode ? -1 : 0) ||
          (typeRank[a.airport_type] ?? 9) -
            (typeRank[b.airport_type] ?? 9) ||
          Number(Boolean(b.saved)) - Number(Boolean(a.saved)) ||
          a.airport_name.localeCompare(b.airport_name),
      );
      airports.forEach((airport, index) =>
        results.push({ ...airport, primary: index === 0 }),
      );
    }

    return response.success(res, results);
  } catch (err) {
    next(err);
  }
};

const saveCity = async (req, res, next) => {
  try {
    if (!(await tableExists())) return migrationRequired(res);

    const iataCode = String(req.body.iata_code || "")
      .trim()
      .toUpperCase();
    const airport = airportDirectory.find(
      (item) => item.iata_code === iataCode,
    );
    if (!airport) {
      return response.error(res, "Select a valid airport from the list.", 422);
    }

    const saved = await query(
      `INSERT INTO ticket_cities (
         business_id, city_name, airport_name, iata_code, country_code, airport_type
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (business_id, iata_code) DO UPDATE SET
         city_name = EXCLUDED.city_name,
         airport_name = EXCLUDED.airport_name,
         country_code = EXCLUDED.country_code,
         airport_type = EXCLUDED.airport_type
       RETURNING id, city_name, airport_name, iata_code, country_code,
                 airport_type, TRUE AS saved`,
      [
        req.businessId,
        airport.city,
        airport.airport_name,
        airport.iata_code,
        airport.country_code,
        airport.airport_type,
      ],
    );

    return response.success(res, saved.rows[0], "Airport saved");
  } catch (err) {
    next(err);
  }
};

module.exports = { listCities, saveCity };
