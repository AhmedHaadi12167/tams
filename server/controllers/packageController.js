/**
 * packageController.js
 *
 * Hajj / Umrah and other bundled packages.
 *
 * A package is a list of cost lines (visa, ticket, hotel, transport, …).
 * total_cost is rolled up from those lines by a database trigger, so it
 * can never drift from what the lines say.
 *
 * The selling price is NOT derived — it is negotiated with the customer
 * and typed in. Profit is selling_price - total_cost.
 */

const { body, validationResult } = require("express-validator");
const { query, withTransaction } = require("../config/db");
const response = require("../utils/response");
const { hasTable } = require("../services/schemaInfo");

const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

const MIGRATION_MSG = "Packages need a database update. Run migration_v8.sql.";
const TYPES = ["hajj", "umrah", "tour", "custom"];
const STATUSES = ["quoted", "confirmed", "in_progress", "completed", "cancelled"];
const ITEM_TYPES = [
  "visa",
  "ticket",
  "hotel",
  "transport",
  "meals",
  "guide",
  "insurance",
  "other",
];

const calcPaymentStatus = (paid, total) => {
  const p = Number(paid) || 0;
  const t = Number(total) || 0;
  if (p <= 0) return "unpaid";
  if (p >= t) return "paid";
  return "partial";
};

const packageValidation = [
  body("label").trim().notEmpty().withMessage("Package name is required"),
  body("package_type").optional().isIn(TYPES).withMessage("Invalid package type"),
  body("status").optional().isIn(STATUSES).withMessage("Invalid status"),
  body("selling_price")
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage("Selling price must be a positive number"),
  body("pilgrim_count")
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1 })
    .withMessage("At least one traveller is required"),
  body("items").optional().isArray().withMessage("Items must be a list"),
  body("items.*.description")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Each line needs a description"),
  body("items.*.unit_cost")
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage("Line cost must be a positive number"),
];

/** Replace a package's lines wholesale — simplest correct approach. */
const writeItems = async (client, businessId, packageId, items = []) => {
  await client.query(`DELETE FROM package_items WHERE package_id = $1`, [
    packageId,
  ]);
  let order = 0;
  for (const it of items) {
    if (!it || !String(it.description || "").trim()) continue;
    await client.query(
      `INSERT INTO package_items
         (business_id, package_id, item_type, description, quantity,
          unit_cost, supplier, visa_id, ticket_id, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        businessId,
        packageId,
        ITEM_TYPES.includes(it.item_type) ? it.item_type : "other",
        String(it.description).trim(),
        Number(it.quantity) > 0 ? Number(it.quantity) : 1,
        round2(it.unit_cost),
        it.supplier || null,
        it.visa_id || null,
        it.ticket_id || null,
        order++,
      ],
    );
  }
};

/** GET /api/packages */
const getPackages = async (req, res, next) => {
  try {
    if (!(await hasTable("packages")))
      return response.error(res, MIGRATION_MSG, 503);

    const {
      page = 1,
      limit = 20,
      search = "",
      package_type,
      status,
      payment_status,
      only_due,
      from_date,
      to_date,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.businessId];
    const conditions = ["p.business_id = $1"];
    let pi = 2;

    if (search) {
      conditions.push(
        `(p.label ILIKE $${pi} OR p.lead_name ILIKE $${pi} OR p.contact_number ILIKE $${pi})`,
      );
      params.push(`%${search}%`);
      pi++;
    }
    if (package_type) {
      conditions.push(`p.package_type = $${pi}`);
      params.push(package_type);
      pi++;
    }
    if (status) {
      conditions.push(`p.status = $${pi}`);
      params.push(status);
      pi++;
    }
    if (payment_status) {
      conditions.push(`p.payment_status = $${pi}`);
      params.push(payment_status);
      pi++;
    }
    if (from_date) {
      conditions.push(`p.departure_date >= $${pi}`);
      params.push(from_date);
      pi++;
    }
    if (to_date) {
      conditions.push(`p.departure_date <= $${pi}`);
      params.push(to_date);
      pi++;
    }
    if (only_due === "true" || only_due === "1") {
      conditions.push(`(p.selling_price - p.amount_paid) > 0`);
    }

    const where = conditions.join(" AND ");

    const [countRes, dataRes] = await Promise.all([
      query(
        `SELECT COUNT(*),
                COALESCE(SUM(p.selling_price), 0)                 AS total_sales,
                COALESCE(SUM(p.total_cost), 0)                    AS total_cost,
                COALESCE(SUM(p.revenue), 0)                       AS total_revenue,
                COALESCE(SUM(p.amount_paid), 0)                   AS total_collected,
                COALESCE(SUM(p.selling_price - p.amount_paid), 0) AS total_balance,
                COALESCE(SUM(p.pilgrim_count), 0)                 AS total_travellers
         FROM packages p WHERE ${where}`,
        params,
      ),
      query(
        `SELECT p.*, u.name AS created_by_name, c.name AS customer_name,
                (SELECT COUNT(*) FROM package_items i WHERE i.package_id = p.id) AS item_count
         FROM packages p
         LEFT JOIN users u     ON u.id = p.created_by
         LEFT JOIN customers c ON c.id = p.customer_id
         WHERE ${where}
         ORDER BY p.created_at DESC
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, parseInt(limit), offset],
      ),
    ]);

    const c = countRes.rows[0];
    return response.success(
      res,
      {
        packages: dataRes.rows,
        summary: {
          total_sales: round2(c.total_sales),
          total_cost: round2(c.total_cost),
          total_revenue: round2(c.total_revenue),
          total_collected: round2(c.total_collected),
          total_balance: round2(c.total_balance),
          total_travellers: parseInt(c.total_travellers),
        },
      },
      "Success",
      200,
      {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(c.count),
        totalPages: Math.ceil(parseInt(c.count) / parseInt(limit)),
      },
    );
  } catch (err) {
    next(err);
  }
};

/** POST /api/packages */
const createPackage = async (req, res, next) => {
  try {
    if (!(await hasTable("packages")))
      return response.error(res, MIGRATION_MSG, 503);

    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const {
      customer_id,
      package_type,
      label,
      lead_name,
      contact_number,
      pilgrim_count,
      departure_date,
      return_date,
      status,
      selling_price,
      amount_paid,
      payment_method,
      notes,
      items = [],
    } = req.body;

    const selling = round2(selling_price);
    const paid = round2(amount_paid);
    if (paid > selling + 0.001) {
      return response.error(
        res,
        "Amount paid cannot exceed the agreed package price",
        400,
      );
    }

    const pkg = await withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO packages (
           business_id, customer_id, created_by, package_type, label,
           lead_name, contact_number, pilgrim_count, departure_date, return_date,
           status, selling_price, amount_paid, payment_status, notes
         ) VALUES ($1,$2,$3,COALESCE($4::package_type,'umrah'),$5,$6,$7,COALESCE($8::INTEGER,1),
                   $9,$10,COALESCE($11::package_status,'quoted'),$12,$13,$14,$15)
         RETURNING *`,
        [
          req.businessId,
          customer_id || null,
          req.user.id,
          package_type || null,
          label.trim(),
          lead_name?.toUpperCase().trim() || null,
          contact_number?.trim() || null,
          pilgrim_count ? parseInt(pilgrim_count) : null,
          departure_date || null,
          return_date || null,
          status || null,
          selling,
          paid,
          calcPaymentStatus(paid, selling),
          notes || null,
        ],
      );

      const created = r.rows[0];
      await writeItems(client, req.businessId, created.id, items);

      if (paid > 0) {
        await client.query(
          `INSERT INTO package_payments (business_id, package_id, collected_by, amount, method, note)
           VALUES ($1,$2,$3,$4,$5,'Initial payment')`,
          [
            req.businessId,
            created.id,
            req.user.id,
            paid,
            payment_method || "cash",
          ],
        );
      }

      // Re-read so total_cost reflects the trigger's rollup
      const fresh = await client.query(`SELECT * FROM packages WHERE id = $1`, [
        created.id,
      ]);
      return fresh.rows[0];
    });

    return response.created(res, pkg, "Package created");
  } catch (err) {
    next(err);
  }
};

/** GET /api/packages/:id */
const getPackage = async (req, res, next) => {
  try {
    if (!(await hasTable("packages")))
      return response.error(res, MIGRATION_MSG, 503);

    const [pkgRes, itemsRes, paymentsRes] = await Promise.all([
      query(
        `SELECT p.*, u.name AS created_by_name,
                c.name AS customer_name, c.phone AS customer_phone,
                b.name AS business_name
         FROM packages p
         LEFT JOIN users u      ON u.id = p.created_by
         LEFT JOIN customers c  ON c.id = p.customer_id
         LEFT JOIN businesses b ON b.id = p.business_id
         WHERE p.id = $1 AND p.business_id = $2`,
        [req.params.id, req.businessId],
      ),
      query(
        `SELECT * FROM package_items WHERE package_id = $1 AND business_id = $2
         ORDER BY sort_order, created_at`,
        [req.params.id, req.businessId],
      ),
      query(
        `SELECT p.*, u.name AS collected_by_name
         FROM package_payments p
         JOIN users u ON u.id = p.collected_by
         WHERE p.package_id = $1 AND p.business_id = $2
         ORDER BY p.created_at DESC`,
        [req.params.id, req.businessId],
      ),
    ]);

    if (pkgRes.rows.length === 0)
      return response.notFound(res, "Package not found");

    return response.success(res, {
      package: pkgRes.rows[0],
      items: itemsRes.rows,
      payments: paymentsRes.rows,
    });
  } catch (err) {
    next(err);
  }
};

/** PUT /api/packages/:id */
const updatePackage = async (req, res, next) => {
  try {
    if (!(await hasTable("packages")))
      return response.error(res, MIGRATION_MSG, 503);

    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const existing = await query(
      `SELECT amount_paid FROM packages WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (existing.rows.length === 0)
      return response.notFound(res, "Package not found");

    const paid = round2(existing.rows[0].amount_paid);
    const selling = round2(req.body.selling_price);
    if (paid > selling + 0.001) {
      return response.error(
        res,
        `Already collected $${paid.toFixed(2)} — the package price cannot be lower than that.`,
        400,
      );
    }

    const pkg = await withTransaction(async (client) => {
      await client.query(
        `UPDATE packages SET
           customer_id    = $1,
           package_type   = COALESCE($2::package_type, package_type),
           label          = $3,
           lead_name      = $4,
           contact_number = $5,
           pilgrim_count  = COALESCE($6, pilgrim_count),
           departure_date = $7,
           return_date    = $8,
           status         = COALESCE($9::package_status, status),
           selling_price  = $10,
           payment_status = $11,
           notes          = $12
         WHERE id = $13 AND business_id = $14`,
        [
          req.body.customer_id || null,
          req.body.package_type || null,
          req.body.label.trim(),
          req.body.lead_name?.toUpperCase().trim() || null,
          req.body.contact_number?.trim() || null,
          req.body.pilgrim_count ? parseInt(req.body.pilgrim_count) : null,
          req.body.departure_date || null,
          req.body.return_date || null,
          req.body.status || null,
          selling,
          calcPaymentStatus(paid, selling),
          req.body.notes || null,
          req.params.id,
          req.businessId,
        ],
      );

      if (Array.isArray(req.body.items)) {
        await writeItems(client, req.businessId, req.params.id, req.body.items);
      }

      const fresh = await client.query(`SELECT * FROM packages WHERE id = $1`, [
        req.params.id,
      ]);
      return fresh.rows[0];
    });

    return response.success(res, pkg, "Package updated");
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/packages/:id */
const deletePackage = async (req, res, next) => {
  try {
    if (!(await hasTable("packages")))
      return response.error(res, MIGRATION_MSG, 503);
    const r = await query(
      `DELETE FROM packages WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.id, req.businessId],
    );
    if (r.rows.length === 0) return response.notFound(res, "Package not found");
    return response.success(res, null, "Package deleted");
  } catch (err) {
    next(err);
  }
};

/** POST /api/packages/:id/payments  { amount, method, note } */
const addPackagePayment = async (req, res, next) => {
  try {
    if (!(await hasTable("packages")))
      return response.error(res, MIGRATION_MSG, 503);

    const pkgRes = await query(
      `SELECT id, label, selling_price, amount_paid
       FROM packages WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (pkgRes.rows.length === 0)
      return response.notFound(res, "Package not found");

    const p = pkgRes.rows[0];
    const balance = round2(Number(p.selling_price) - Number(p.amount_paid));
    const amount =
      req.body.amount === undefined ||
      req.body.amount === null ||
      req.body.amount === ""
        ? balance
        : round2(req.body.amount);

    if (!(amount > 0))
      return response.error(res, "Amount must be greater than 0", 400);
    if (amount > balance + 0.001)
      return response.error(
        res,
        `Amount exceeds the remaining balance ($${balance.toFixed(2)})`,
        400,
      );

    const updated = await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO package_payments (business_id, package_id, collected_by, amount, method, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          req.businessId,
          p.id,
          req.user.id,
          amount,
          req.body.method || "cash",
          req.body.note || null,
        ],
      );
      const newPaid = round2(Number(p.amount_paid) + amount);
      const r = await client.query(
        `UPDATE packages SET amount_paid = $1, payment_status = $2
         WHERE id = $3 RETURNING *`,
        [newPaid, calcPaymentStatus(newPaid, p.selling_price), p.id],
      );
      return r.rows[0];
    });

    return response.created(
      res,
      updated,
      `Collected $${amount.toFixed(2)} for ${p.label}`,
    );
  } catch (err) {
    next(err);
  }
};

module.exports = {
  packageValidation,
  getPackages,
  createPackage,
  getPackage,
  updatePackage,
  deletePackage,
  addPackagePayment,
  ITEM_TYPES,
};
