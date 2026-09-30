/**
 * audit_fixes_test.mjs
 *
 * One check for each money bug found in the September 2026 audit, run
 * through the real controllers against a real PostgreSQL (PGlite).
 *
 *   1. Double-submits: two cancels or two payments at once
 *   2. Deletes that took payment history (and cash) with them
 *   3. Cancelling through the edit form; visa/package cancel flow
 *   4. Balance sheet: tax, as-of date, transfer fees, overpayments
 *   5. One Cash in Hand account per business, holding the opening cash
 *
 * The db shim serialises transactions, the way row locks do in production:
 * a check made OUTSIDE the transaction still races (and the old code fails
 * these tests), a check made inside a locked transaction does not.
 *
 *     cd server/tests && node audit_fixes_test.mjs
 */

import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pass = [];
const fail = [];
const ck = (name, ok, detail = "") =>
  (ok ? pass : fail).push(name + (detail !== "" ? ` — ${detail}` : ""));
const m2 = (v) => Number(v).toFixed(2);

// ── Real Postgres ──────────────────────────────────────────────────────────
const pg = await PGlite.create();
await pg.exec(
  `CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';`,
);
await pg.exec(
  fs
    .readFileSync(`${SERVER}/config/schema.sql`, "utf8")
    .replace(/CREATE EXTENSION[^;]*;/gi, ""),
);

// Transactions queue behind each other, like FOR UPDATE on the same row.
let chain = Promise.resolve();
const dbShim = {
  query: (t, p = []) => pg.query(t, p),
  withTransaction: (fn) => {
    const run = chain.then(async () => {
      await pg.exec("BEGIN");
      try {
        const r = await fn({ query: (t, p = []) => pg.query(t, p) });
        await pg.exec("COMMIT");
        return r;
      } catch (e) {
        await pg.exec("ROLLBACK");
        throw e;
      }
    });
    chain = run.catch(() => {});
    return run;
  },
};
const Module = require("module");
const orig = Module._resolveFilename;
const S = {
  __DB__: dbShim,
  __RPT__: {
    generateAirlinePDF: async () => Buffer.from(""),
    generatePDFReport: async () => Buffer.from(""),
    generateExcelReport: async () => Buffer.from(""),
    generateCustomerStatementPDF: async () => Buffer.from(""),
  },
  __AI__: { extractTicketData: async () => ({}) },
  __MAIL__: { sendOTPEmail: async () => true },
};
Module._resolveFilename = function (r, p, ...rest) {
  if (typeof r === "string") {
    if (r.endsWith("config/db")) return "__DB__";
    if (r.endsWith("services/reportService")) return "__RPT__";
    if (r.endsWith("services/aiExtraction")) return "__AI__";
    if (r.endsWith("services/emailService")) return "__MAIL__";
  }
  return orig.call(this, r, p, ...rest);
};
for (const [id, exports] of Object.entries(S))
  require.cache[id] = { id, filename: id, loaded: true, exports };

const ticketC = require(`${SERVER}/controllers/ticketController.js`);
const airlineC = require(`${SERVER}/controllers/airlineController.js`);
const taxC = require(`${SERVER}/controllers/taxController.js`);
const finC = require(`${SERVER}/controllers/financialsController.js`);
const visaC = require(`${SERVER}/controllers/visaController.js`);
const pkgC = require(`${SERVER}/controllers/packageController.js`);
const custC = require(`${SERVER}/controllers/customerController.js`);
const accC = require(`${SERVER}/controllers/accountController.js`);
const supC = require(`${SERVER}/controllers/supplierController.js`);
const { cancelHandler } = require(`${SERVER}/services/serviceCancel.js`);

// ── A business ─────────────────────────────────────────────────────────────
const biz = (
  await pg.query(
    `INSERT INTO businesses (name,email) VALUES ('Audit','audit@x.c') RETURNING id`,
  )
).rows[0].id;
const user = (
  await pg.query(
    `INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,'A','a@x.c','h','admin') RETURNING id`,
    [biz],
  )
).rows[0].id;
const ctx = { businessId: biz, user: { id: user, role: "admin" } };
const mkRes = () => {
  const r = { code: 200, body: null };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
};
const call = async (fn, req = {}) => {
  const res = mkRes();
  let err = null;
  await fn(
    { ...ctx, params: {}, query: {}, body: {}, ...req },
    res,
    (e) => (err = e),
  );
  if (err) {
    res.code = err.statusCode || 500;
    res.body = { message: err.message };
  }
  return res;
};
const sheet = async (q = {}) =>
  (await call(finC.getBalanceSheet, { query: q })).body.data;
const pl = async () => (await call(finC.getProfitLoss)).body.data;
const accountsTotal = async () =>
  Number(
    (
      await pg.query(
        `SELECT COALESCE(SUM(balance),0) s FROM v_account_balance WHERE business_id=$1`,
        [biz],
      )
    ).rows[0].s,
  );
const balanced = async (label) => {
  const s = await sheet();
  ck(
    `${label}: balance sheet balances`,
    m2(s.difference) === "0.00",
    m2(s.difference),
  );
  ck(
    `${label}: sheet cash equals the accounts`,
    m2(s.cash_and_bank ?? s.assets.cash_and_bank) === m2(await accountsTotal()),
    `${m2(s.assets.cash_and_bank)} vs ${m2(await accountsTotal())}`,
  );
  return s;
};

// ── 5. Cash in Hand ────────────────────────────────────────────────────────
const cih = (
  await pg.query(
    `SELECT id, name, kind FROM payment_accounts WHERE business_id=$1 AND is_cash_in_hand`,
    [biz],
  )
).rows;
ck(
  "a new business gets exactly one Cash in Hand account",
  cih.length === 1 && cih[0].name === "Cash in Hand",
  JSON.stringify(cih),
);
const CASH = cih[0].id;

let r = await call(finC.updateOpeningBalances, {
  body: { opening_cash: 1000 },
});
ck("opening cash is saved", r.code === 200, r.body?.message);
const cihRow = (
  await pg.query(`SELECT opening_balance FROM payment_accounts WHERE id=$1`, [
    CASH,
  ])
).rows[0];
const bizRow = (
  await pg.query(`SELECT opening_cash FROM businesses WHERE id=$1`, [biz])
).rows[0];
ck(
  "opening cash is stored in the Cash in Hand account",
  m2(cihRow.opening_balance) === "1000.00",
  m2(cihRow.opening_balance),
);
ck(
  "and not on the business record",
  m2(bizRow.opening_cash) === "0.00",
  m2(bizRow.opening_cash),
);
r = await call(finC.updateOpeningBalances, { body: { opening_cash: 1200 } });
ck(
  "changing it replaces rather than adds",
  m2(
    (
      await pg.query(
        `SELECT opening_balance FROM payment_accounts WHERE id=$1`,
        [CASH],
      )
    ).rows[0].opening_balance,
  ) === "1200.00",
);

r = await call(accC.createAccount, {
  body: { name: "Petty cash", kind: "cash" },
});
ck("a second cash account is refused", r.code === 400, r.body?.message);
r = await call(accC.deleteAccount, { params: { id: CASH } });
ck("Cash in Hand cannot be deleted", r.code === 409, r.body?.message);
r = await call(accC.updateAccount, {
  params: { id: CASH },
  body: {
    name: "Cash in Hand",
    kind: "cash",
    opening_balance: 1200,
    is_active: false,
  },
});
ck("Cash in Hand cannot be deactivated", r.code === 400, r.body?.message);

const legacyBiz = (
  await pg.query(
    `INSERT INTO businesses (name,email) VALUES ('Legacy cash','legacy-cash@x.c') RETURNING id`,
  )
).rows[0].id;
const legacyCash = (
  await pg.query(
    `SELECT id FROM payment_accounts WHERE business_id=$1 AND is_cash_in_hand`,
    [legacyBiz],
  )
).rows[0].id;
await pg.query(
  `UPDATE payment_accounts SET name='Cash', is_cash_in_hand=FALSE WHERE id=$1`,
  [legacyCash],
);
const namedCash = (
  await pg.query(
    `INSERT INTO payment_accounts (business_id,name,kind)
     VALUES ($1,'Cash in Hand','bank') RETURNING id`,
    [legacyBiz],
  )
).rows[0].id;
r = await call(finC.updateOpeningBalances, {
  businessId: legacyBiz,
  body: { opening_cash: 250 },
});
ck(
  "opening cash reuses the existing Cash in Hand account",
  r.code === 200,
  r.body?.message,
);
ck(
  "opening cash does not create a duplicate account",
  (
    await pg.query(
      `SELECT COUNT(*)::INT AS n FROM payment_accounts WHERE business_id=$1 AND name='Cash in Hand'`,
      [legacyBiz],
    )
  ).rows[0].n === 1,
);
ck(
  "opening cash promotes the existing named account",
  r.body?.data?.cash_in_hand_account_id === namedCash,
);
ck(
  "opening cash stores the balance on that account",
  Number(
    (
      await pg.query(
        `SELECT opening_balance FROM payment_accounts WHERE id=$1`,
        [namedCash],
      )
    ).rows[0].opening_balance,
  ) === 250,
);

r = await call(accC.createAccount, {
  body: { name: "Premier Bank", kind: "bank", opening_balance: 5000 },
});
const BANK = r.body.data.id;

let s = await balanced("opening position");
ck(
  "the sheet shows one Cash in Hand line equal to the account",
  m2(s.assets.cash_in_hand) === "1200.00",
  m2(s.assets.cash_in_hand),
);
ck(
  "Cash in Hand is not listed again among the other accounts",
  !s.assets.accounts.some((a) => a.account_id === CASH),
);

// ── helpers ────────────────────────────────────────────────────────────────
const book = async (o) =>
  (
    await call(ticketC.createTicket, {
      body: {
        ticket_type: "LOCAL",
        contact_number: "061",
        from_city: "MGQ",
        to_city: "NBO",
        flight_date: "2026-12-01",
        account_id: CASH,
        ...o,
      },
    })
  ).body.data;
const airlineId = async (name) =>
  (
    await pg.query(`SELECT id FROM airlines WHERE business_id=$1 AND name=$2`, [
      biz,
      name,
    ])
  ).rows[0].id;

// ── 1. Double-submits ──────────────────────────────────────────────────────
const t1 = await book({
  passenger_name: "RACE CANCEL",
  airline_name: "Echo Air",
  cost_price: 100,
  selling_price: 200,
  amount_paid: 200,
});
const both = await Promise.all(
  [1, 2].map(() =>
    call(ticketC.cancelTicket, {
      params: { id: t1.id },
      body: { refund_amount: 150, account_id: CASH },
    }),
  ),
);
const refunds = (
  await pg.query(
    `SELECT amount FROM ticket_payments WHERE ticket_id=$1 AND amount<0`,
    [t1.id],
  )
).rows;
ck(
  "two cancels at once refund only once",
  refunds.length === 1,
  refunds.map((x) => x.amount).join(","),
);
ck(
  "the second cancel is refused",
  both.filter((x) => x.code === 409).length === 1,
  both.map((x) => x.code).join(","),
);

const t2 = await book({
  passenger_name: "RACE PAY",
  airline_name: "Echo Air",
  cost_price: 100,
  selling_price: 200,
  amount_paid: 0,
});
await Promise.all(
  [1, 2].map(() =>
    call(ticketC.addPayment, {
      params: { id: t2.id },
      body: { amount: 100, account_id: CASH },
    }),
  ),
);
const t2b = (
  await pg.query(
    `SELECT amount_paid, (SELECT SUM(amount) FROM ticket_payments WHERE ticket_id=$1) rows FROM tickets WHERE id=$1`,
    [t2.id],
  )
).rows[0];
ck(
  "two payments at once are both kept on the ticket",
  m2(t2b.amount_paid) === m2(t2b.rows) && m2(t2b.amount_paid) === "200.00",
  `${t2b.amount_paid} vs rows ${t2b.rows}`,
);
const over = await Promise.all(
  [1, 2].map(() =>
    call(ticketC.addPayment, {
      params: { id: t2.id },
      body: { amount: 10, account_id: CASH },
    }),
  ),
);
ck(
  "a paid-up ticket refuses more money",
  over.every((x) => x.code === 400),
);

// ── 3. The edit form cannot cancel ─────────────────────────────────────────
const t3 = await book({
  passenger_name: "EDIT FLIP",
  airline_name: "Delta Air",
  cost_price: 100,
  selling_price: 200,
  amount_paid: 200,
});
r = await call(ticketC.updateTicket, {
  params: { id: t3.id },
  body: {
    ...t3,
    airline_name: "Delta Air",
    status: "cancelled",
    amount_paid: 200,
  },
});
ck(
  "editing a ticket ignores status",
  r.code === 200 && r.body.data.status !== "cancelled",
  `${r.code} ${r.body?.data?.status}`,
);
r = await call(ticketC.updateTicket, {
  params: { id: t1.id },
  body: { ...t1, airline_name: "Echo Air", amount_paid: 50 },
});
ck("a cancelled ticket cannot be edited", r.code === 409, r.body?.message);
r = await call(ticketC.updateTicket, {
  params: { id: t3.id },
  body: {
    ...t3,
    airline_name: "Delta Air",
    amount_paid: 150,
    account_id: undefined,
  },
});
const t3b = (
  await pg.query(`SELECT amount_paid FROM tickets WHERE id=$1`, [t3.id])
).rows[0];
ck(
  "an edit with no account for the money change changes nothing",
  r.code === 400 && m2(t3b.amount_paid) === "200.00",
  `${r.code} paid=${t3b.amount_paid}`,
);
r = await call(ticketC.createTicket, {
  body: {
    ticket_type: "LOCAL",
    passenger_name: "OVER",
    contact_number: "062",
    from_city: "A",
    to_city: "B",
    flight_date: "2026-12-02",
    airline_name: "Zed Air",
    cost_price: 10,
    selling_price: 20,
    amount_paid: 50,
    account_id: CASH,
  },
});
ck("booking cannot take more than the price", r.code === 400, r.body?.message);
await balanced("after ticket races");

// ── 2. Deletes keep the money ──────────────────────────────────────────────
const v1 = (
  await call(visaC.createVisa, {
    body: {
      applicant_name: "VISA KEEP",
      destination_country: "UAE",
      cost_price: 50,
      selling_price: 100,
      amount_paid: 100,
      account_id: CASH,
    },
  })
).body.data;
const before = await accountsTotal();
r = await call(visaC.deleteVisa, { params: { id: v1.id } });
ck("a paid visa cannot be deleted", r.code === 409, r.body?.message);
ck("and the accounts keep its money", m2(await accountsTotal()) === m2(before));

const cust = (
  await pg.query(
    `INSERT INTO customers (business_id,name,phone) VALUES ($1,'DEP GUY','0615') RETURNING id`,
    [biz],
  )
).rows[0].id;
await call(custC.addDeposit, {
  params: { id: cust },
  body: { amount: 250, account_id: CASH },
});
const before2 = await accountsTotal();
r = await call(custC.deleteCustomer, { params: { id: cust } });
ck(
  "a customer holding a deposit cannot be deleted",
  r.code === 409,
  r.body?.message,
);
ck(
  "and the deposit stays in the accounts",
  m2(await accountsTotal()) === m2(before2),
);
let fkBlocked = false;
try {
  await pg.query(`DELETE FROM customers WHERE id=$1`, [cust]);
} catch {
  fkBlocked = true;
}
ck(
  "the database itself refuses to delete deposits with the customer",
  fkBlocked,
);
r = await call(custC.addDeposit, {
  params: { id: cust },
  body: { amount: -300, account_id: CASH },
});
ck(
  "a deposit refund above what is held is refused",
  r.code === 400,
  r.body?.message,
);

// ── 3b. Visa and package cancel flow ───────────────────────────────────────
const v2 = (
  await call(visaC.createVisa, {
    body: {
      applicant_name: "VISA CANCEL",
      destination_country: "UAE",
      cost_price: 200,
      selling_price: 300,
      amount_paid: 300,
      account_id: CASH,
    },
  })
).body.data;
r = await call(supC.paySupplier, {
  params: { kind: "visa", id: v2.id },
  body: { account_id: BANK },
});
ck("visa supplier paid", r.code === 200, r.body?.message);
r = await call(visaC.updateVisa, {
  params: { id: v2.id },
  body: {
    applicant_name: "VISA CANCEL",
    destination_country: "UAE",
    cost_price: 200,
    selling_price: 300,
    status: "cancelled",
  },
});
ck("the visa edit form cannot cancel", r.code === 400, r.body?.message);
const plBefore = await pl();
r = await call(cancelHandler("visa"), {
  params: { id: v2.id },
  body: {
    refund_amount: 100,
    account_id: CASH,
    supplier_refund: 150,
    supplier_account_id: BANK,
  },
});
ck(
  "visa cancel records refund and supplier return",
  r.code === 200,
  r.body?.message,
);
const plAfter = await pl();
ck(
  "the cancelled visa leaves the kept money, less the supplier's share, as profit",
  m2(plAfter.cancellations.other_services) === "150.00",
  m2(plAfter.cancellations.other_services),
);
ck(
  "and its sale leaves revenue",
  m2(plBefore.revenue.visa_sales - plAfter.revenue.visa_sales) === "300.00",
);
r = await call(cancelHandler("visa"), { params: { id: v2.id }, body: {} });
ck("a visa cannot be cancelled twice", r.code === 409);
r = await call(visaC.addVisaPayment, {
  params: { id: v2.id },
  body: { amount: 10, account_id: CASH },
});
ck("a cancelled visa takes no payments", r.code === 409);

const pk = (
  await call(pkgC.createPackage, {
    body: {
      label: "Umrah Oct",
      package_type: "umrah",
      selling_price: 1000,
      amount_paid: 400,
      account_id: CASH,
      items: [{ item_type: "hotel", description: "Hotel", cost: 300 }],
    },
  })
).body;
ck("package created", !!pk?.data?.id, pk?.message);
if (pk?.data?.id) {
  r = await call(cancelHandler("package"), {
    params: { id: pk.data.id },
    body: { refund_amount: 400, account_id: CASH },
  });
  ck("package cancel with full refund", r.code === 200, r.body?.message);
}
await balanced("after visa and package cancellations");

// ── 4. Balance sheet ───────────────────────────────────────────────────────
// Tax: payable to the government, not the airline.
await book({
  passenger_name: "TAX CASE",
  airline_name: "Alpha Air",
  cost_price: 400,
  tax: 90,
  selling_price: 500,
  amount_paid: 500,
});
await call(airlineC.payAirline, {
  params: { id: await airlineId("Alpha Air") },
  body: { account_id: BANK },
});
s = await balanced("ticket with tax, airline paid");
const airlinesPage = (
  await pg.query(
    `SELECT COALESCE(SUM(balance),0) b FROM v_airline_account WHERE business_id=$1`,
    [biz],
  )
).rows[0].b;
ck(
  "payable to airlines matches the Airlines page (tax excluded)",
  m2(s.liabilities.payable_to_airlines) === m2(airlinesPage),
  `${m2(s.liabilities.payable_to_airlines)} vs ${m2(airlinesPage)}`,
);
ck(
  "the tax shows as owed to the government",
  m2(s.liabilities.tax_payable) === "90.00",
  m2(s.liabilities.tax_payable),
);
await call(taxC.payTax, { body: { amount: 90, account_id: BANK } });
s = await balanced("after paying the tax");
ck(
  "tax paid leaves no tax payable",
  m2(s.liabilities.tax_payable) === "0.00",
  m2(s.liabilities.tax_payable),
);

// Cancelled with the customer paying less than the tax: a real loss.
const t4 = await book({
  passenger_name: "SHORT TAX",
  airline_name: "Gamma Air",
  cost_price: 400,
  tax: 90,
  selling_price: 500,
  amount_paid: 50,
});
await call(ticketC.cancelTicket, {
  params: { id: t4.id },
  body: { refund_amount: 0 },
});
const p4 = await pl();
ck(
  "uncollected tax on a cancelled ticket is reported as a loss",
  m2(p4.cancellations.tax_shortfall) === "40.00",
  m2(p4.cancellations.tax_shortfall),
);
const rev4 = (
  await pg.query(`SELECT revenue FROM tickets WHERE id=$1`, [t4.id])
).rows[0].revenue;
ck("and the ticket's own revenue agrees", m2(rev4) === "-40.00", m2(rev4));
await balanced("after a short-tax cancellation");

// Transfer fee: an expense, visible everywhere.
r = await call(accC.createTransfer, {
  body: { from_account_id: BANK, to_account_id: CASH, amount: 500, fee: 15 },
});
ck("transfer with a fee recorded", r.code === 201, r.body?.message);
s = await balanced("after a transfer fee");
const p5 = await pl();
ck(
  "the fee is an expense on the income statement",
  m2(p5.operating_costs.bank_fees) === "15.00",
  m2(p5.operating_costs.bank_fees),
);
const cf = (await call(finC.getCashFlow)).body.data;
ck(
  "the fee shows as an outflow on cash flow",
  m2(cf.outflow.bank_fees) === "15.00",
  m2(cf.outflow.bank_fees),
);
ck(
  "collected-by-method adds up to total collected",
  m2(cf.inflow.by_method.reduce((a, x) => a + x.total, 0)) ===
    m2(cf.inflow.total),
  `${m2(cf.inflow.by_method.reduce((a, x) => a + x.total, 0))} vs ${m2(cf.inflow.total)}`,
);

// Supplier overpaid after the cost was lowered: a credit, not a vanishing.
const v3 = (
  await call(visaC.createVisa, {
    body: {
      applicant_name: "SUP CREDIT",
      destination_country: "UAE",
      cost_price: 200,
      selling_price: 300,
      amount_paid: 300,
      account_id: CASH,
    },
  })
).body.data;
await call(supC.paySupplier, {
  params: { kind: "visa", id: v3.id },
  body: { account_id: BANK },
});
await call(visaC.updateVisa, {
  params: { id: v3.id },
  body: {
    applicant_name: "SUP CREDIT",
    destination_country: "UAE",
    cost_price: 150,
    selling_price: 300,
  },
});
s = await balanced("after a supplier overpayment");
ck(
  "the overpaid supplier is shown as a credit",
  m2(s.assets.supplier_credit) === "50.00",
  m2(s.assets.supplier_credit),
);

// As-of: a sale 10 days ago, another today. Five days ago only the first existed.
const old = await book({
  passenger_name: "OLD SALE",
  airline_name: "Beta Air",
  cost_price: 100,
  selling_price: 300,
  amount_paid: 300,
});
const sheetBeforeNew = await sheet();
await pg.query(`UPDATE tickets SET created_at = NOW() - INTERVAL '10 days'`);
await pg.query(
  `UPDATE ticket_payments SET created_at = NOW() - INTERVAL '10 days'`,
);
await pg.query(
  `UPDATE visa_applications SET created_at = NOW() - INTERVAL '10 days', cancelled_at = CASE WHEN cancelled_at IS NULL THEN NULL ELSE NOW() - INTERVAL '10 days' END`,
);
await pg.query(
  `UPDATE visa_payments SET created_at = NOW() - INTERVAL '10 days'`,
);
await pg.query(
  `UPDATE packages SET created_at = NOW() - INTERVAL '10 days', cancelled_at = NOW() - INTERVAL '10 days'`,
);
await pg.query(
  `UPDATE package_payments SET created_at = NOW() - INTERVAL '10 days'`,
);
await pg.query(
  `UPDATE supplier_payments SET created_at = NOW() - INTERVAL '10 days'`,
);
await pg.query(
  `UPDATE airline_payments SET created_at = NOW() - INTERVAL '10 days'`,
);
await pg.query(
  `UPDATE tickets SET cancelled_at = NOW() - INTERVAL '10 days' WHERE cancelled_at IS NOT NULL`,
);
await pg.query(
  `UPDATE customer_deposits SET created_at = NOW() - INTERVAL '10 days'`,
);
await pg.query(`UPDATE tax_payments SET paid_at = NOW() - INTERVAL '10 days'`);
await pg.query(
  `UPDATE account_transfers SET transferred_at = NOW() - INTERVAL '10 days'`,
);
await book({
  passenger_name: "NEW SALE",
  airline_name: "Beta Air",
  cost_price: 100,
  selling_price: 700,
  amount_paid: 700,
});
const d5 = (
  await pg.query(
    `SELECT ((NOW() AT TIME ZONE 'Africa/Mogadishu') - INTERVAL '5 days')::DATE::TEXT AS d`,
  )
).rows[0].d;
const hist = await sheet({ as_of: d5 });
ck(
  "an as-of balance sheet balances",
  m2(hist.difference) === "0.00",
  m2(hist.difference),
);
ck(
  "and its cash is the cash held on that date, not today",
  m2(hist.assets.cash_and_bank) === m2(sheetBeforeNew.assets.cash_and_bank),
  `${m2(hist.assets.cash_and_bank)} vs ${m2(sheetBeforeNew.assets.cash_and_bank)}`,
);
await balanced("today, after the new sale");

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\nPASS (${pass.length})`);
pass.forEach((x) => console.log("  ✓ " + x));
if (fail.length) {
  console.log(`\nFAIL (${fail.length})`);
  fail.forEach((x) => console.log("  ✗ " + x));
  process.exit(1);
}
console.log(
  `\nAll ${pass.length} audit checks passed against real PostgreSQL.`,
);
