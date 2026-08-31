/**
 * accountController.js
 *
 * Where the money sits, and every movement in or out of it.
 *
 * Two ideas do all the work here, and both live in the database rather than
 * in this file:
 *
 *   v_cash_ledger    every movement from all eight sources, one shape
 *   v_account_balance  opening balance + everything in − everything out
 *
 * Keeping them there means the balance shown on a card and the rows shown in
 * the ledger are computed from the same definition. If they were assembled
 * separately in JavaScript they would eventually disagree, and when a
 * balance and its own transaction list disagree, nobody can tell which is
 * lying.
 */

const { body, validationResult } = require("express-validator");
const { query, withTransaction } = require("../config/db");
const response = require("../utils/response");
const { hasTable, hasColumn } = require("../services/schemaInfo");
const { uuidOrThrow, isUuid } = require("../utils/sqlSafe");

const MIGRATION_MSG =
  "Payment accounts need a database update. Run migration_v11.sql.";

const KINDS = ["cash", "bank", "mobile", "merchant", "other"];

const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

/**
 * The columns that exist only to print an account on an invoice, in the
 * order they were added: number and holder with migration_v19, icon with
 * v20.
 *
 * Asked for rather than assumed, and asked for one at a time, so a database
 * sitting between two migrations keeps working on whichever columns it
 * actually has. The answers are cached in schemaInfo, so this costs one
 * round trip per column per fifteen seconds at worst.
 */
const INVOICE_COLUMNS = ["account_number", "account_holder", "icon_url"];

const presentInvoiceColumns = async () => {
  const present = [];
  for (const c of INVOICE_COLUMNS) {
    if (await hasColumn("payment_accounts", c)) present.push(c);
  }
  return present;
};

/** Trim to null — an empty box means "not recorded", not an empty string. */
const blankToNull = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

/** Which table each ledger source lives in, for assigning an account later. */
const SOURCE_TABLES = {
  ticket: "ticket_payments",
  visa: "visa_payments",
  package: "package_payments",
  cargo: "cargo_payments",
  airline: "airline_payments",
  agent: "agent_payments",
  expense: "expenses",
};

const accountValidation = [
  body("name").trim().notEmpty().withMessage("Account name is required"),
  body("kind").optional().isIn(KINDS).withMessage("Invalid account type"),
  body("opening_balance")
    .optional({ nullable: true, checkFalsy: true })
    .isFloat()
    .withMessage("Opening balance must be a number"),
];

const transferValidation = [
  body("from_account_id").isUUID().withMessage("Choose the account to send from"),
  body("to_account_id").isUUID().withMessage("Choose the account to send to"),
  body("amount").isFloat({ gt: 0 }).withMessage("Amount must be greater than zero"),
  body("fee")
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage("Fee cannot be negative"),
];

/**
 * GET /api/accounts
 * Every account with its balance, plus whatever money has no account yet.
 */
const getAccounts = async (req, res, next) => {
  try {
    if (!(await hasTable("payment_accounts")))
      return response.error(res, MIGRATION_MSG, 503);

    const invoiceCols = await presentInvoiceColumns();

    const [accountsRes, unassignedRes, tradeRes] = await Promise.all([
      query(
        `SELECT b.*, a.notes, a.opening_date${
          invoiceCols.map((c) => `, a.${c}`).join("")
        }
           FROM v_account_balance b
           JOIN payment_accounts a ON a.id = b.account_id
          WHERE b.business_id = $1
          ORDER BY a.is_active DESC, b.sort_order, b.name`,
        [req.businessId],
      ),
      // Money recorded before accounts existed, or where the old text label
      // was too vague to map. Real money, no home yet — surfaced rather than
      // quietly dropped, because a total that silently omits rows is worse
      // than one that admits it is incomplete.
      query(
        `SELECT direction, COUNT(*)::INT AS count, COALESCE(SUM(amount),0) AS total
           FROM v_cash_ledger
          WHERE business_id = $1 AND account_id IS NULL
          GROUP BY direction`,
        [req.businessId],
      ),
      // Collections and payments, with transfers held apart.
      //
      // Moving $1,500 from EVC to Premier Bank is not $1,500 collected and
      // $1,500 paid — it is the same money in a different place. Counting it
      // as trade made the agency look far busier than it was, and made this
      // screen disagree with Financials for no real reason.
      query(
        `SELECT
           COALESCE(SUM(amount) FILTER (WHERE direction='in'  AND source NOT LIKE 'transfer%'), 0) AS collected,
           COALESCE(SUM(amount) FILTER (WHERE direction='out' AND source NOT LIKE 'transfer%'), 0) AS paid_out,
           COALESCE(SUM(amount) FILTER (WHERE source = 'transfer_in'), 0)                          AS transferred,
           COUNT(*) FILTER (WHERE source = 'transfer_in')::INT                                     AS transfer_count
         FROM v_cash_ledger
         WHERE business_id = $1`,
        [req.businessId],
      ),
    ]);

    const accounts = accountsRes.rows.map((r) => ({
      ...r,
      // The view calls the key account_id. Returning `id` as well means a
      // consumer that reaches for either gets a real value rather than
      // undefined — which in a <select> silently becomes the option's text.
      id: r.account_id,
      opening_balance: round2(r.opening_balance),
      total_in: round2(r.total_in),
      total_out: round2(r.total_out),
      balance: round2(r.balance),
      movement_count: Number(r.movement_count),
    }));

    const unassigned = { in: 0, out: 0, count: 0 };
    for (const r of unassignedRes.rows) {
      unassigned[r.direction] = round2(r.total);
      unassigned.count += r.count;
    }

    const trade = tradeRes.rows[0];
    const balanceTotal = round2(accounts.reduce((s, a) => s + a.balance, 0));

    // What the accounts say they hold, versus what the trade actually
    // produced. These differ by exactly the money that has no account yet,
    // so saying so turns a confusing discrepancy into a to-do item.
    const netTrade = round2(Number(trade.collected) - Number(trade.paid_out));

    return response.success(res, {
      accounts,
      summary: {
        total_balance: balanceTotal,
        // Real trade only — transfers are excluded, because moving your own
        // money between your own accounts is neither income nor expense.
        collected: round2(trade.collected),
        paid_out: round2(trade.paid_out),
        transferred: round2(trade.transferred),
        transfer_count: trade.transfer_count,
        net_trade: netTrade,
        // Non-zero means some movements still have no account, so the
        // balances above don't yet tell the whole story.
        unassigned_gap: round2(balanceTotal - netTrade),
        account_count: accounts.length,
      },
      unassigned,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/accounts/ledger
 *
 * Every movement, newest first, with who it was with and when. This is the
 * screen someone opens when they want to know why a balance is what it is.
 */
const getLedger = async (req, res, next) => {
  try {
    if (!(await hasTable("payment_accounts")))
      return response.error(res, MIGRATION_MSG, 503);

    const {
      page = 1,
      limit = 50,
      account_id,
      direction,
      source,
      from_date,
      to_date,
      search,
      unassigned,
    } = req.query;

    const lim = Math.min(parseInt(limit) || 50, 500);
    const offset = ((parseInt(page) || 1) - 1) * lim;

    const params = [req.businessId];
    const where = ["l.business_id = $1"];
    let pi = 2;

    if (unassigned === "true" || unassigned === "1") {
      where.push("l.account_id IS NULL");
    } else if (account_id) {
      where.push(`l.account_id = $${pi}`);
      params.push(uuidOrThrow(account_id, "account id"));
      pi++;
    }
    if (direction === "in" || direction === "out") {
      where.push(`l.direction = $${pi}`);
      params.push(direction);
      pi++;
    }
    if (source) {
      where.push(`l.source = $${pi}`);
      params.push(source);
      pi++;
    }
    if (from_date) {
      where.push(`l.occurred_at >= $${pi}::DATE`);
      params.push(from_date);
      pi++;
    }
    if (to_date) {
      // Inclusive of the whole end day, which is what a person means when
      // they pick a date range.
      where.push(`l.occurred_at < ($${pi}::DATE + INTERVAL '1 day')`);
      params.push(to_date);
      pi++;
    }
    if (search) {
      where.push(`(l.party ILIKE $${pi} OR l.reference ILIKE $${pi} OR l.note ILIKE $${pi})`);
      params.push(`%${search}%`);
      pi++;
    }

    const clause = where.join(" AND ");

    const [totalsRes, rowsRes] = await Promise.all([
      query(
        `SELECT COUNT(*)::INT AS count,
                COALESCE(SUM(l.amount) FILTER (WHERE l.direction='in'),0)  AS total_in,
                COALESCE(SUM(l.amount) FILTER (WHERE l.direction='out'),0) AS total_out
           FROM v_cash_ledger l
          WHERE ${clause}`,
        params,
      ),
      query(
        `SELECT l.*, a.name AS account_name, a.kind AS account_kind, u.name AS user_name
           FROM v_cash_ledger l
           LEFT JOIN payment_accounts a ON a.id = l.account_id
           LEFT JOIN users u            ON u.id = l.user_id
          WHERE ${clause}
          ORDER BY l.occurred_at DESC
          LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, lim, offset],
      ),
    ]);

    const t = totalsRes.rows[0];
    return response.success(
      res,
      {
        movements: rowsRes.rows.map((r) => ({ ...r, amount: round2(r.amount) })),
        totals: {
          total_in: round2(t.total_in),
          total_out: round2(t.total_out),
          net: round2(Number(t.total_in) - Number(t.total_out)),
        },
      },
      "Success",
      200,
      {
        page: parseInt(page) || 1,
        limit: lim,
        total: t.count,
        totalPages: Math.ceil(t.count / lim),
      },
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/accounts/icon
 *
 * Stores an image and hands back the file name to put on an account.
 *
 * Upload and assignment are separate steps, exactly as they are for an
 * agency logo, and for the same reason: the icon is chosen on the form that
 * CREATES the account, when there is no row yet to attach it to. An
 * abandoned form leaves a few kilobytes of litter, which is a far better
 * trade than creating the account first so there is something to upload
 * against.
 */
const uploadIcon = async (req, res, next) => {
  try {
    if (!req.file) return response.error(res, "No icon uploaded", 400);
    return response.created(
      res,
      { icon_url: `icons/${req.file.filename}` },
      "Icon uploaded",
    );
  } catch (err) {
    next(err);
  }
};

/** POST /api/accounts */
const createAccount = async (req, res, next) => {
  try {
    if (!(await hasTable("payment_accounts")))
      return response.error(res, MIGRATION_MSG, 503);

    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const { name, kind, opening_balance, opening_date, notes } = req.body;

    const cols = [
      "business_id", "name", "kind", "opening_balance", "opening_date", "notes",
    ];
    const vals = [
      req.businessId,
      String(name).trim(),
      KINDS.includes(kind) ? kind : "bank",
      round2(opening_balance),
      opening_date || null,
      notes || null,
    ];
    for (const c of await presentInvoiceColumns()) {
      cols.push(c);
      vals.push(blankToNull(req.body[c]));
    }

    const result = await query(
      `INSERT INTO payment_accounts (${cols.join(", ")}, sort_order)
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")},
               COALESCE((SELECT MAX(sort_order)+10 FROM payment_accounts WHERE business_id=$1), 0))
       RETURNING *`,
      vals,
    );
    return response.created(res, result.rows[0], "Account added");
  } catch (err) {
    next(err);
  }
};

/** PUT /api/accounts/:id */
const updateAccount = async (req, res, next) => {
  try {
    if (!(await hasTable("payment_accounts")))
      return response.error(res, MIGRATION_MSG, 503);

    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const { name, kind, opening_balance, opening_date, notes, is_active } =
      req.body;

    const sets = [];
    const vals = [];
    const p = (v) => `$${vals.push(v)}`;

    // Numbered as the values are pushed, because two of these columns are
    // optional and hand-numbering a list that changes length is how $7 ends
    // up meaning the account id in one branch and the business id in the
    // other.
    sets.push(`name = ${p(String(name).trim())}`);
    sets.push(`kind = ${p(KINDS.includes(kind) ? kind : "bank")}`);
    sets.push(`opening_balance = ${p(round2(opening_balance))}`);
    sets.push(`opening_date = ${p(opening_date || null)}`);
    sets.push(`notes = ${p(notes || null)}`);
    sets.push(
      `is_active = COALESCE(${p(typeof is_active === "boolean" ? is_active : null)}, is_active)`,
    );
    for (const c of await presentInvoiceColumns()) {
      sets.push(`${c} = ${p(blankToNull(req.body[c]))}`);
    }
    sets.push("updated_at = NOW()");

    const result = await query(
      `UPDATE payment_accounts
          SET ${sets.join(",\n              ")}
        WHERE id = ${p(uuidOrThrow(req.params.id, "account id"))}
          AND business_id = ${p(req.businessId)}
        RETURNING *`,
      vals,
    );
    if (result.rows.length === 0) return response.notFound(res, "Account not found");
    return response.success(res, result.rows[0], "Account updated");
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/accounts/:id
 *
 * Refused if anything has ever moved through it. The foreign keys enforce
 * this too, but checking first lets us explain why instead of surfacing a
 * constraint violation.
 */
const deleteAccount = async (req, res, next) => {
  try {
    if (!(await hasTable("payment_accounts")))
      return response.error(res, MIGRATION_MSG, 503);

    const id = uuidOrThrow(req.params.id, "account id");

    const used = await query(
      `SELECT COUNT(*)::INT AS n FROM v_cash_ledger
        WHERE business_id = $1 AND account_id = $2`,
      [req.businessId, id],
    );
    if (used.rows[0].n > 0) {
      return response.error(
        res,
        `This account has ${used.rows[0].n} transaction${used.rows[0].n === 1 ? "" : "s"} and cannot be deleted. Mark it inactive instead — its history stays intact and it stops appearing in dropdowns.`,
        409,
      );
    }

    const del = await query(
      `DELETE FROM payment_accounts WHERE id=$1 AND business_id=$2 RETURNING id`,
      [id, req.businessId],
    );
    if (del.rows.length === 0) return response.notFound(res, "Account not found");
    return response.success(res, null, "Account deleted");
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/accounts/transfer
 *
 * Moving money between the agency's own accounts. Not income, not an
 * expense — the business is no richer afterwards. Recorded once, read as two
 * movements by the ledger view, so both balances change and the total does
 * not.
 */
const createTransfer = async (req, res, next) => {
  try {
    if (!(await hasTable("account_transfers")))
      return response.error(res, MIGRATION_MSG, 503);

    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const { from_account_id, to_account_id, amount, fee, transferred_at, reference, note } =
      req.body;

    if (from_account_id === to_account_id)
      return response.error(res, "Choose two different accounts", 400);

    const amt = round2(amount);
    const feeAmt = round2(fee);

    const result = await withTransaction(async (client) => {
      // Both accounts must belong to this agency. Without this check a
      // crafted request could move money into another business's books.
      const owned = await client.query(
        `SELECT id FROM payment_accounts
          WHERE business_id = $1 AND id IN ($2, $3)`,
        [req.businessId, from_account_id, to_account_id],
      );
      if (owned.rows.length !== 2) {
        const err = new Error("Account not found");
        err.statusCode = 404;
        throw err;
      }

      const ins = await client.query(
        `INSERT INTO account_transfers
           (business_id, from_account_id, to_account_id, amount, fee,
            transferred_at, reference, note, created_by)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::TIMESTAMPTZ, NOW()),$7,$8,$9)
         RETURNING *`,
        [
          req.businessId,
          from_account_id,
          to_account_id,
          amt,
          feeAmt,
          transferred_at || null,
          reference || null,
          note || null,
          req.user.id,
        ],
      );
      return ins.rows[0];
    });

    return response.created(
      res,
      result,
      `Transferred $${amt.toFixed(2)}${feeAmt > 0 ? ` (fee $${feeAmt.toFixed(2)})` : ""}`,
    );
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/accounts/assign
 *
 * Give an account to a movement that has none — the older records that
 * predate accounts, or ones where the old free-text label was too vague to
 * map automatically.
 */
const assignAccount = async (req, res, next) => {
  try {
    if (!(await hasTable("payment_accounts")))
      return response.error(res, MIGRATION_MSG, 503);

    const { source, movement_id, account_id } = req.body;

    const table = SOURCE_TABLES[source];
    if (!table)
      return response.error(res, "That kind of movement cannot be reassigned", 400);
    if (!isUuid(movement_id) || !isUuid(account_id))
      return response.error(res, "Invalid movement or account", 400);

    // `table` comes from SOURCE_TABLES, never from the request, so it is a
    // fixed string from our own code rather than user input.
    const result = await query(
      `UPDATE ${table} SET account_id = $1
        WHERE id = $2 AND business_id = $3
          AND EXISTS (SELECT 1 FROM payment_accounts
                       WHERE id = $1 AND business_id = $3)
        RETURNING id`,
      [account_id, movement_id, req.businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Movement not found");

    return response.success(res, null, "Account assigned");
  } catch (err) {
    next(err);
  }
};

module.exports = {
  accountValidation,
  transferValidation,
  getAccounts,
  getLedger,
  uploadIcon,
  createAccount,
  updateAccount,
  deleteAccount,
  createTransfer,
  assignAccount,
};
