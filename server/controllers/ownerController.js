/**
 * ownerController.js
 *
 * The people who own the agency.
 *
 * Each owner has:
 *   - opening capital  what they had in the business before TAMS (no cash moves)
 *   - ownership %      how much of the business they own
 *   - profit share %   how much of the profit is theirs (often, not always,
 *                      the same as ownership)
 * and a history of money they put in (capital) or took out (drawings). Every
 * one of those movements goes through a real payment account, so it appears
 * on the Accounts page, in the cash ledger and in the journal, and the
 * balance sheet shows each owner's equity line by line.
 */

const { query, withTransaction } = require("../config/db");
const response = require("../utils/response");
const { hasTable } = require("../services/schemaInfo");
const { requireAccount } = require("../services/accountResolver");
const { uuidOrThrow } = require("../utils/sqlSafe");

const MIGRATION_MSG =
  "Owners need a database update. Ask your administrator to run migration_v29.sql.";
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const fail = (message, status = 400) => {
  const err = new Error(message);
  err.statusCode = status;
  err.expose = true;
  return err;
};

const pctOrThrow = (v, label) => {
  if (v === undefined || v === null || v === "") return 0;
  const num = Number(v);
  if (!Number.isFinite(num) || num < 0 || num > 100)
    throw fail(`${label} must be between 0 and 100`);
  return Math.round(num * 1000) / 1000;
};

const amountOrThrow = (v, label) => {
  if (v === undefined || v === null || v === "") return 0;
  const num = Number(v);
  if (!Number.isFinite(num) || num < 0)
    throw fail(`${label} must be a number of zero or more`);
  return round2(num);
};

/**
 * Percentages across the active owners may not add up to more than 100.
 * Checked inside the transaction, with the business's owners locked, so two
 * people editing at once can't both squeeze in under the limit.
 */
const checkTotals = async (client, businessId, exceptId, ownership, profit) => {
  const r = await client.query(
    `SELECT COALESCE(SUM(ownership_pct), 0) AS own,
            COALESCE(SUM(profit_share_pct), 0) AS profit
       FROM (SELECT ownership_pct, profit_share_pct FROM business_owners
              WHERE business_id = $1 AND is_active
                AND ($2::UUID IS NULL OR id <> $2::UUID)
              FOR UPDATE) o`,
    [businessId, exceptId],
  );
  const own = Number(r.rows[0].own) + ownership;
  const profit_ = Number(r.rows[0].profit) + profit;
  if (own > 100.0005)
    throw fail(
      `Ownership would total ${own.toFixed(2)}%. The owners' shares can't add up to more than 100%.`,
    );
  if (profit_ > 100.0005)
    throw fail(
      `Profit shares would total ${profit_.toFixed(2)}%. They can't add up to more than 100%.`,
    );
};

const OWNER_SELECT = `
  SELECT ow.*,
         COALESCE(SUM(tx.amount) FILTER (WHERE tx.amount > 0), 0)  AS contributed,
         COALESCE(-SUM(tx.amount) FILTER (WHERE tx.amount < 0), 0) AS withdrawn,
         COUNT(tx.id)::INT                                          AS transactions,
         MAX(tx.occurred_at)                                        AS last_movement_at
    FROM business_owners ow
    LEFT JOIN owner_transactions tx ON tx.owner_id = ow.id
   WHERE ow.business_id = $1`;

const shape = (o) => ({
  ...o,
  opening_capital: round2(o.opening_capital),
  ownership_pct: Number(o.ownership_pct),
  profit_share_pct: Number(o.profit_share_pct),
  contributed: round2(o.contributed),
  withdrawn: round2(o.withdrawn),
  capital: round2(Number(o.opening_capital) + Number(o.contributed)),
  net_invested: round2(
    Number(o.opening_capital) + Number(o.contributed) - Number(o.withdrawn),
  ),
});

/** GET /api/owners */
const getOwners = async (req, res, next) => {
  try {
    if (!(await hasTable("business_owners")))
      return response.error(res, MIGRATION_MSG, 503);
    if (!req.businessId)
      return response.error(res, "Select a business first", 400);

    const r = await query(
      `${OWNER_SELECT} GROUP BY ow.id ORDER BY ow.is_active DESC, ow.opening_capital DESC, ow.name`,
      [req.businessId],
    );
    const owners = r.rows.map(shape);
    const active = owners.filter((o) => o.is_active);
    return response.success(res, {
      owners,
      totals: {
        ownership_pct: round2(active.reduce((s, o) => s + o.ownership_pct, 0)),
        profit_share_pct: round2(
          active.reduce((s, o) => s + o.profit_share_pct, 0),
        ),
        opening_capital: round2(owners.reduce((s, o) => s + o.opening_capital, 0)),
        contributed: round2(owners.reduce((s, o) => s + o.contributed, 0)),
        withdrawn: round2(owners.reduce((s, o) => s + o.withdrawn, 0)),
        net_invested: round2(owners.reduce((s, o) => s + o.net_invested, 0)),
      },
    });
  } catch (err) {
    next(err);
  }
};

const readBody = (body) => {
  const name = String(body.name || "").trim();
  if (!name) throw fail("The owner's name is required");
  return {
    name,
    phone: String(body.phone || "").trim() || null,
    email: String(body.email || "").trim() || null,
    opening_capital: amountOrThrow(body.opening_capital, "Opening capital"),
    ownership_pct: pctOrThrow(body.ownership_pct, "Ownership"),
    profit_share_pct: pctOrThrow(body.profit_share_pct, "Profit share"),
    joined_on: body.joined_on || null,
    notes: String(body.notes || "").trim() || null,
  };
};

/** POST /api/owners */
const createOwner = async (req, res, next) => {
  try {
    if (!(await hasTable("business_owners")))
      return response.error(res, MIGRATION_MSG, 503);
    const v = readBody(req.body);

    const owner = await withTransaction(async (client) => {
      await checkTotals(client, req.businessId, null, v.ownership_pct, v.profit_share_pct);
      const dup = await client.query(
        `SELECT 1 FROM business_owners WHERE business_id = $1 AND LOWER(name) = LOWER($2)`,
        [req.businessId, v.name],
      );
      if (dup.rows.length) throw fail(`An owner called "${v.name}" already exists`, 409);
      const r = await client.query(
        `INSERT INTO business_owners
           (business_id, name, phone, email, opening_capital, ownership_pct,
            profit_share_pct, joined_on, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          req.businessId, v.name, v.phone, v.email, v.opening_capital,
          v.ownership_pct, v.profit_share_pct, v.joined_on, v.notes, req.user.id,
        ],
      );
      return r.rows[0];
    });
    return response.created(res, owner, `${owner.name} added as an owner`);
  } catch (err) {
    next(err);
  }
};

/** PUT /api/owners/:id */
const updateOwner = async (req, res, next) => {
  try {
    if (!(await hasTable("business_owners")))
      return response.error(res, MIGRATION_MSG, 503);
    const id = uuidOrThrow(req.params.id, "owner id");
    const v = readBody(req.body);
    const isActive =
      typeof req.body.is_active === "boolean" ? req.body.is_active : null;

    const owner = await withTransaction(async (client) => {
      const cur = await client.query(
        `SELECT * FROM business_owners WHERE id = $1 AND business_id = $2 FOR UPDATE`,
        [id, req.businessId],
      );
      if (!cur.rows.length) throw fail("Owner not found", 404);
      const willBeActive = isActive === null ? cur.rows[0].is_active : isActive;
      if (willBeActive)
        await checkTotals(client, req.businessId, id, v.ownership_pct, v.profit_share_pct);
      const dup = await client.query(
        `SELECT 1 FROM business_owners
          WHERE business_id = $1 AND LOWER(name) = LOWER($2) AND id <> $3`,
        [req.businessId, v.name, id],
      );
      if (dup.rows.length) throw fail(`An owner called "${v.name}" already exists`, 409);
      const r = await client.query(
        `UPDATE business_owners
            SET name = $1, phone = $2, email = $3, opening_capital = $4,
                ownership_pct = $5, profit_share_pct = $6, joined_on = $7,
                notes = $8, is_active = COALESCE($9, is_active), updated_at = NOW()
          WHERE id = $10 AND business_id = $11
          RETURNING *`,
        [
          v.name, v.phone, v.email, v.opening_capital, v.ownership_pct,
          v.profit_share_pct, v.joined_on, v.notes, isActive, id, req.businessId,
        ],
      );
      return r.rows[0];
    });
    return response.success(res, owner, "Owner updated");
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/owners/:id
 * Only an owner with no money history can be removed; otherwise mark them
 * inactive so their capital history stays in the books.
 */
const deleteOwner = async (req, res, next) => {
  try {
    if (!(await hasTable("business_owners")))
      return response.error(res, MIGRATION_MSG, 503);
    const id = uuidOrThrow(req.params.id, "owner id");
    const used = await query(
      `SELECT COUNT(*)::INT AS n FROM owner_transactions WHERE owner_id = $1`,
      [id],
    );
    if (used.rows[0].n > 0)
      return response.error(
        res,
        "This owner has capital or drawings recorded and can't be deleted. Mark them inactive instead — their history stays in the books.",
        409,
      );
    const r = await query(
      `DELETE FROM business_owners WHERE id = $1 AND business_id = $2 RETURNING name`,
      [id, req.businessId],
    );
    if (!r.rows.length) return response.notFound(res, "Owner not found");
    return response.success(res, null, `${r.rows[0].name} removed`);
  } catch (err) {
    next(err);
  }
};

/** GET /api/owners/:id/transactions */
const getOwnerTransactions = async (req, res, next) => {
  try {
    if (!(await hasTable("owner_transactions")))
      return response.error(res, MIGRATION_MSG, 503);
    const id = uuidOrThrow(req.params.id, "owner id");
    const r = await query(
      `SELECT tx.*, a.name AS account_name, u.name AS created_by_name
         FROM owner_transactions tx
         LEFT JOIN payment_accounts a ON a.id = tx.account_id
         LEFT JOIN users u ON u.id = tx.created_by
        WHERE tx.owner_id = $1 AND tx.business_id = $2
        ORDER BY tx.occurred_at DESC, tx.created_at DESC`,
      [id, req.businessId],
    );
    return response.success(
      res,
      r.rows.map((t) => ({ ...t, amount: round2(t.amount) })),
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/owners/:id/transactions
 * { kind: 'contribution' | 'withdrawal', amount, account_id, occurred_at, reference, note }
 */
const addOwnerTransaction = async (req, res, next) => {
  try {
    if (!(await hasTable("owner_transactions")))
      return response.error(res, MIGRATION_MSG, 503);
    const id = uuidOrThrow(req.params.id, "owner id");
    const kind = req.body.kind;
    if (!["contribution", "withdrawal"].includes(kind))
      return response.error(res, "Choose capital in or drawings out", 400);
    const amount = round2(req.body.amount);
    if (!(amount > 0))
      return response.error(res, "Amount must be greater than zero", 400);
    const when = req.body.occurred_at || null;
    if (when && Number.isNaN(Date.parse(when)))
      return response.error(res, "That date isn't valid", 400);

    const tx = await withTransaction(async (client) => {
      const owner = await client.query(
        `SELECT id, name, is_active FROM business_owners
          WHERE id = $1 AND business_id = $2 FOR UPDATE`,
        [id, req.businessId],
      );
      if (!owner.rows.length) throw fail("Owner not found", 404);
      if (!owner.rows[0].is_active)
        throw fail("This owner is inactive. Reactivate them first.", 409);
      const accountId = await requireAccount(
        req.body,
        req.businessId,
        client,
        kind === "contribution" ? "capital" : "drawing",
      );
      const r = await client.query(
        `INSERT INTO owner_transactions
           (business_id, owner_id, kind, amount, account_id, occurred_at,
            reference, note, created_by)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::TIMESTAMPTZ, NOW()),$7,$8,$9)
         RETURNING *`,
        [
          req.businessId,
          id,
          kind,
          kind === "contribution" ? amount : -amount,
          accountId,
          when,
          req.body.reference || null,
          req.body.note || null,
          req.user.id,
        ],
      );
      return { row: r.rows[0], name: owner.rows[0].name };
    });

    return response.created(
      res,
      tx.row,
      kind === "contribution"
        ? `$${amount.toFixed(2)} capital received from ${tx.name}`
        : `$${amount.toFixed(2)} paid out to ${tx.name} as drawings`,
    );
  } catch (err) {
    // The overdraft guard: drawings bigger than the account holds.
    if (err.constraint === "chk_account_balance_nonnegative")
      return response.error(
        res,
        "That account doesn't hold enough money for these drawings.",
        400,
      );
    next(err);
  }
};

/** DELETE /api/owners/transactions/:txId — for an entry made by mistake. */
const deleteOwnerTransaction = async (req, res, next) => {
  try {
    if (!(await hasTable("owner_transactions")))
      return response.error(res, MIGRATION_MSG, 503);
    const r = await query(
      `DELETE FROM owner_transactions WHERE id = $1 AND business_id = $2 RETURNING id`,
      [uuidOrThrow(req.params.txId, "transaction id"), req.businessId],
    );
    if (!r.rows.length) return response.notFound(res, "Transaction not found");
    return response.success(res, null, "Entry removed");
  } catch (err) {
    if (err.constraint === "chk_account_balance_nonnegative")
      return response.error(
        res,
        "Removing this capital would leave its account below zero. Record drawings or a transfer instead.",
        409,
      );
    next(err);
  }
};

module.exports = {
  getOwners,
  createOwner,
  updateOwner,
  deleteOwner,
  getOwnerTransactions,
  addOwnerTransaction,
  deleteOwnerTransaction,
};
