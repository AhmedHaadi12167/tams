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
await db.exec(strip(fs.readFileSync("../config/migration_v24.sql", "utf8")));
await db.exec(strip(fs.readFileSync("../config/migration_v26.sql", "utf8")));

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
  if (typeof request === "string" && request.endsWith("config/db")) {
    return "__TAMS_TEST_DB__";
  }
  return resolveFilename.call(this, request, parent, ...rest);
};
require.cache.__TAMS_TEST_DB__ = {
  id: "__TAMS_TEST_DB__",
  filename: "__TAMS_TEST_DB__",
  loaded: true,
  exports: dbShim,
};
const financialsController = require("../controllers/financialsController.js");
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
  if (error) throw error;
  return response;
};

const business = (
  await db.query(
    `INSERT INTO businesses (name, email)
     VALUES ('Opening Controller Test', 'opening-controller@test.invalid')
     RETURNING id`,
  )
).rows[0].id;
const user = (
  await db.query(
    `INSERT INTO users (business_id, name, email, password_hash, role)
     VALUES ($1, 'Test Admin', 'opening-controller-admin@test.invalid', 'test', 'admin')
     RETURNING id`,
    [business],
  )
).rows[0].id;
const customer = (
  await db.query(
    `INSERT INTO customers (business_id, name, phone)
     VALUES ($1, 'Opening Customer', '0610000000') RETURNING id`,
    [business],
  )
).rows[0].id;
const account = (
  await db.query(
    `INSERT INTO payment_accounts (business_id, name, opening_balance)
     VALUES ($1, 'Cash', 0) RETURNING id`,
    [business],
  )
).rows[0].id;
const context = { businessId: business, user: { id: user } };

const created = await invoke(financialsController.createOpeningItem, {
  ...context,
  body: {
    balance_type: "receivable",
    customer_id: customer,
    service_type: "ticket",
    reason: "Prior unpaid ticket",
    amount: 25,
  },
});
if (created.statusCode !== 201) {
  throw new Error(
    `Opening receivable creation failed: ${created.body?.message}`,
  );
}
const openingItemId = created.body.data.id;

const payableCreated = await invoke(financialsController.createOpeningItem, {
  ...context,
  body: {
    balance_type: "payable",
    reason: "Old supplier invoice",
    amount: 80,
  },
});
if (payableCreated.statusCode !== 201) {
  throw new Error(
    `Opening payable creation failed: ${payableCreated.body?.message}`,
  );
}
const payableId = payableCreated.body.data.id;
const payableUpdated = await invoke(financialsController.updateOpeningItem, {
  ...context,
  params: { id: payableId },
  body: {
    reason: "Corrected supplier invoice",
    amount: 95,
    entry_date: "2025-01-15",
  },
});
if (
  payableUpdated.statusCode !== 200 ||
  payableUpdated.body.data.reason !== "Corrected supplier invoice" ||
  Number(payableUpdated.body.data.amount) !== 95
) {
  throw new Error("Opening payable edit failed");
}
const payableDeleted = await invoke(financialsController.deleteOpeningItem, {
  ...context,
  params: { id: payableId },
  body: { reason: "Duplicate opening entry" },
});
const payableAudit = await db.query(
  `SELECT deletion_reason FROM opening_balance_deletion_audit
    WHERE opening_item_id = $1`,
  [payableId],
);
if (
  payableDeleted.statusCode !== 200 ||
  payableAudit.rows[0]?.deletion_reason !== "Duplicate opening entry"
) {
  throw new Error("Opening payable deletion was not audited");
}

const collected = await invoke(financialsController.collectOpeningReceivable, {
  ...context,
  params: { id: openingItemId },
  body: { amount: 10, account_id: account },
});
if (collected.statusCode !== 201) {
  throw new Error(
    `Opening receivable collection failed: ${collected.body?.message}`,
  );
}

const receivableUpdated = await invoke(financialsController.updateOpeningItem, {
  ...context,
  params: { id: openingItemId },
  body: {
    balance_type: "receivable",
    customer_id: customer,
    service_type: "ticket",
    reason: "Corrected prior ticket",
    amount: 30,
    entry_date: "2025-01-10",
  },
});
if (
  receivableUpdated.statusCode !== 200 ||
  receivableUpdated.body.data.reason !== "Corrected prior ticket" ||
  Number(receivableUpdated.body.data.amount) !== 30
) {
  throw new Error("Opening receivable edit failed");
}

const reduceBelowPaid = await invoke(financialsController.updateOpeningItem, {
  ...context,
  params: { id: openingItemId },
  body: {
    customer_id: customer,
    service_type: "ticket",
    reason: "Too small",
    amount: 9,
  },
});
if (
  reduceBelowPaid.statusCode !== 400 ||
  !reduceBelowPaid.body.message.includes("already collected")
) {
  throw new Error("Receivable was allowed below its collected amount");
}

const paidDelete = await invoke(financialsController.deleteOpeningItem, {
  ...context,
  params: { id: openingItemId },
  body: { reason: "Remove it" },
});
if (paidDelete.statusCode !== 409) {
  throw new Error("Opening receivable with payments was allowed to delete");
}

const receivables = await invoke(financialsController.getReceivables, {
  ...context,
  query: { limit: 50 },
});
const item = receivables.body.data.items[0];
if (
  Number(receivables.body.data.aging.total) !== 20 ||
  Number(item?.paid_amount) !== 10 ||
  Number(item?.balance) !== 20 ||
  item?.reason !== "Corrected prior ticket"
) {
  throw new Error(
    "Receivables report did not show the remaining opening balance",
  );
}

let overpaymentError = null;
await financialsController.collectOpeningReceivable(
  {
    ...context,
    params: { id: openingItemId },
    body: { amount: 21, account_id: account },
  },
  {
    status() {
      return this;
    },
    json() {
      return this;
    },
  },
  (error) => {
    overpaymentError = error;
  },
);
if (overpaymentError?.statusCode !== 400) {
  throw new Error("Collection greater than the remaining balance was accepted");
}

const accountBalance = (
  await db.query(
    `SELECT balance FROM v_account_balance WHERE account_id = $1`,
    [account],
  )
).rows[0].balance;
if (Number(accountBalance) !== 10) {
  throw new Error(
    "Opening receivable collection did not reach its selected account once",
  );
}

console.log(
  "PASS: opening item CRUD, payment bounds, deletion audit, collection, and reporting",
);
await db.close();
