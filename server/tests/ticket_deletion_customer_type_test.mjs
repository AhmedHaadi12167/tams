import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";

const require = createRequire(import.meta.url);
const db = await PGlite.create();
const strip = (sql) =>
  sql.replace(/CREATE EXTENSION[^;]*;/gi, "").replace(/^\uFEFF/, "");

await db.exec(`
  CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid
  LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';
`);
await db.exec(strip(fs.readFileSync("../config/schema.sql", "utf8")));
await db.exec(strip(fs.readFileSync("../config/migration_v25.sql", "utf8")));
await db.exec(`
  CREATE TYPE customer_kind AS ENUM ('individual', 'company');
  ALTER TABLE customers ALTER COLUMN customer_type DROP DEFAULT;
  ALTER TABLE customers ALTER COLUMN customer_type TYPE customer_kind
    USING customer_type::customer_kind;
  ALTER TABLE customers ALTER COLUMN customer_type SET DEFAULT 'individual';
`);

const dbShim = {
  query: (text, params = []) => db.query(text, params),
  withTransaction: async (callback) => {
    await db.exec("BEGIN");
    try {
      const result = await callback({
        query: (text, params = []) => db.query(text, params),
      });
      await db.exec("COMMIT");
      return result;
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  },
};
const Module = require("module");
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (typeof request === "string") {
    if (request.endsWith("config/db")) return "__TAMS_TEST_DB__";
    if (request.endsWith("services/aiExtraction")) return "__TAMS_TEST_AI__";
    if (request.endsWith("services/reportService"))
      return "__TAMS_TEST_REPORT__";
  }
  return resolveFilename.call(this, request, parent, ...rest);
};
require.cache.__TAMS_TEST_DB__ = {
  id: "__TAMS_TEST_DB__",
  filename: "__TAMS_TEST_DB__",
  loaded: true,
  exports: dbShim,
};
require.cache.__TAMS_TEST_AI__ = {
  id: "__TAMS_TEST_AI__",
  filename: "__TAMS_TEST_AI__",
  loaded: true,
  exports: { extractTicketData: async () => ({}) },
};
require.cache.__TAMS_TEST_REPORT__ = {
  id: "__TAMS_TEST_REPORT__",
  filename: "__TAMS_TEST_REPORT__",
  loaded: true,
  exports: { generateCustomerStatementPDF: () => {} },
};
const customersController = require("../controllers/customerController.js");
const ticketsController = require("../controllers/ticketController.js");
Module._resolveFilename = resolveFilename;

const invoke = async (controller, request) => {
  const response = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let error = null;
  await controller(request, response, (nextError) => {
    error = nextError;
  });
  return { response, error };
};

const business = (
  await db.query(
    `INSERT INTO businesses (name, email)
     VALUES ('Deletion Test', 'deletion@test.invalid') RETURNING id`,
  )
).rows[0].id;
const user = (
  await db.query(
    `INSERT INTO users (business_id, name, email, password_hash, role)
     VALUES ($1, 'Test Admin', 'deletion-admin@test.invalid', 'test', 'admin')
     RETURNING id`,
    [business],
  )
).rows[0].id;
const context = { businessId: business, user: { id: user, role: "admin" } };

const createdCustomer = await invoke(customersController.createCustomer, {
  ...context,
  body: {
    name: "Company Customer",
    customer_type: "company",
    company_name: "Example Company",
  },
});
if (
  createdCustomer.error ||
  createdCustomer.response.statusCode !== 201 ||
  createdCustomer.response.body.data.customer_type !== "company"
) {
  throw new Error(
    `Enum-backed customer creation failed: ${createdCustomer.error?.message || createdCustomer.response.body?.message}`,
  );
}

const unpaidTicket = (
  await db.query(
    `INSERT INTO tickets
       (business_id, created_by, ticket_type, passenger_name, from_city,
        to_city, flight_date, airline_name, cost_price, selling_price)
     VALUES ($1,$2,'LOCAL','Unpaid Passenger','MGQ','HGA','2026-10-01',
             'Test Air',10,20)
     RETURNING id`,
    [business, user],
  )
).rows[0].id;
const noReason = await invoke(ticketsController.deleteTicket, {
  ...context,
  params: { id: unpaidTicket },
  body: {},
});
if (!noReason.response.body?.message?.includes("reason is required")) {
  throw new Error("Unpaid ticket deletion did not require a reason");
}

const deleted = await invoke(ticketsController.deleteTicket, {
  ...context,
  params: { id: unpaidTicket },
  body: { reason: "Duplicate booking" },
});
const audit = await db.query(
  `SELECT reason, passenger_name FROM ticket_deletion_audit WHERE ticket_id = $1`,
  [unpaidTicket],
);
if (
  deleted.error ||
  deleted.response.statusCode !== 200 ||
  audit.rows[0]?.reason !== "Duplicate booking" ||
  audit.rows[0]?.passenger_name !== "Unpaid Passenger"
) {
  throw new Error(
    `Reasoned unpaid-ticket deletion was not audited: status=${deleted.response.statusCode}, error=${deleted.error?.message}, message=${deleted.response.body?.message}, audit=${JSON.stringify(audit.rows)}`,
  );
}

const account = (
  await db.query(
    `INSERT INTO payment_accounts (business_id, name, opening_balance)
     VALUES ($1, 'Cash', 100) RETURNING id`,
    [business],
  )
).rows[0].id;
const paidTicket = (
  await db.query(
    `INSERT INTO tickets
       (business_id, created_by, ticket_type, passenger_name, from_city,
        to_city, flight_date, airline_name, cost_price, selling_price,
        amount_paid, payment_status)
     VALUES ($1,$2,'LOCAL','Paid Passenger','MGQ','DXB','2026-10-02',
             'Test Air',10,50,25,'partial')
     RETURNING id`,
    [business, user],
  )
).rows[0].id;
await db.query(
  `INSERT INTO ticket_payments
     (business_id, ticket_id, collected_by, amount, method, account_id)
   VALUES ($1,$2,$3,25,'cash',$4)`,
  [business, paidTicket, user, account],
);

const blockedDelete = await invoke(ticketsController.deleteTicket, {
  ...context,
  params: { id: paidTicket },
  body: { reason: "Duplicate booking" },
});
const stillThere = await db.query(`SELECT id FROM tickets WHERE id = $1`, [
  paidTicket,
]);
const paymentCount = await db.query(
  `SELECT COUNT(*)::INT AS count FROM ticket_payments WHERE ticket_id = $1`,
  [paidTicket],
);
if (
  blockedDelete.error?.statusCode !== 409 ||
  stillThere.rows.length !== 1 ||
  paymentCount.rows[0].count !== 1
) {
  throw new Error("Paid-ticket deletion did not preserve financial history");
}

console.log("PASS: enum customer type and ticket deletion money safeguards");
await db.close();
