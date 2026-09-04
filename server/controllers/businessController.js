const { body, validationResult } = require("express-validator");
const { query } = require("../config/db");
const response = require("../utils/response");
const { hasColumn } = require("../services/schemaInfo");

/**
 * GET /api/businesses
 * Super admin — list all businesses with stats
 */
const getBusinesses = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search = "", status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = [];
    let pi = 1;

    if (search) {
      conditions.push(`(b.name ILIKE $${pi} OR b.email ILIKE $${pi})`);
      params.push(`%${search}%`);
      pi++;
    }
    if (status) {
      conditions.push(`b.status = $${pi}`);
      params.push(status);
      pi++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [countRes, dataRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM businesses b ${where}`, params),
      query(
        `SELECT b.*,
          (SELECT COUNT(*) FROM users WHERE business_id = b.id) AS total_users,
          (SELECT COUNT(*) FROM tickets WHERE business_id = b.id) AS total_tickets,
          (SELECT COUNT(*) FROM cargo_shipments WHERE business_id = b.id) AS total_cargo,
          (SELECT COUNT(*) FROM tickets WHERE business_id = b.id
            AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())) AS tickets_this_month,
          (SELECT COUNT(*) FROM cargo_shipments WHERE business_id = b.id
            AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())) AS cargo_this_month,
          (SELECT COALESCE(SUM(revenue), 0) FROM tickets WHERE business_id = b.id) AS total_revenue
         FROM businesses b ${where}
         ORDER BY b.created_at DESC
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, parseInt(limit), offset],
      ),
    ]);

    return response.paginated(
      res,
      dataRes.rows,
      page,
      limit,
      parseInt(countRes.rows[0].count),
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/businesses/:id
 */
const getBusiness = async (req, res, next) => {
  try {
    const [bizRes, usersRes, statsRes] = await Promise.all([
      query(`SELECT * FROM businesses WHERE id = $1`, [req.params.id]),
      query(
        `SELECT id, name, email, role, is_active, last_login FROM users WHERE business_id = $1 ORDER BY created_at`,
        [req.params.id],
      ),
      query(
        `SELECT
          (SELECT COUNT(*) FROM tickets WHERE business_id = $1) AS total_tickets,
          (SELECT COALESCE(SUM(revenue), 0) FROM tickets WHERE business_id = $1) AS total_revenue,
          (SELECT COUNT(*) FROM tickets WHERE business_id = $1 AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())) AS tickets_this_month,
          (SELECT COUNT(*) FROM cargo_shipments WHERE business_id = $1) AS total_cargo,
          (SELECT COUNT(*) FROM customers WHERE business_id = $1) AS total_customers`,
        [req.params.id],
      ),
    ]);

    if (bizRes.rows.length === 0)
      return response.notFound(res, "Business not found");

    return response.success(res, {
      business: bizRes.rows[0],
      users: usersRes.rows,
      stats: statsRes.rows[0],
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/businesses/logo
 *
 * Stores an image and hands back the file name to put on a business.
 *
 * Upload and assignment are separate steps on purpose. A logo is chosen
 * while REGISTERING an agency, at which point there is no business row to
 * attach it to — so the file is stored first and its name travels with the
 * rest of the form. The same endpoint serves the edit screen, where the
 * name is sent to PUT /businesses/:id instead.
 *
 * The consequence is that abandoning a half-filled registration form leaves
 * an orphaned file. That is the right trade: a few kilobytes of litter
 * costs nothing, whereas the alternative — creating the business first so
 * there is something to upload against — would leave a real agency record
 * behind every abandoned form.
 */
const uploadLogo = async (req, res, next) => {
  try {
    if (!req.file) return response.error(res, "No logo uploaded", 400);
    // The file NAME, not a path. Uploads are served from UPLOAD_PATH, which
    // moves between environments; storing a path would break every logo the
    // day that directory changes.
    return response.created(
      res,
      { logo_url: `logos/${req.file.filename}` },
      "Logo uploaded",
    );
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/businesses/:id
 * Update business info and/or status
 */
const updateBusiness = async (req, res, next) => {
  try {
    const { name, email, phone, address, status, logo_url, website } = req.body;

    // Three states, not two: absent means "leave it alone", a value means
    // "set it", and an empty string means "remove it". COALESCE alone can
    // only express the first two, which is why a logo could be replaced but
    // never taken off.
    const tri = (v) => (v === undefined ? null : String(v));
    const triSet = (col, n) =>
      `${col} = CASE WHEN $${n}::TEXT IS NULL THEN ${col}
                     WHEN $${n} = '' THEN NULL
                     ELSE $${n} END`;

    // website arrives with migration_v19. Writing to it unconditionally
    // would turn editing a business into a 503 on any database that has not
    // been migrated yet — for a field nobody asked to change.
    const withWebsite = await hasColumn("businesses", "website");

    const params = [
      name || null,
      email || null,
      phone || null,
      address || null,
      status || null,
      tri(logo_url),
    ];
    if (withWebsite) params.push(tri(website));
    params.push(req.params.id);
    const idIdx = params.length;

    const result = await query(
      `UPDATE businesses SET
        name        = COALESCE($1, name),
        email       = COALESCE($2, email),
        phone       = COALESCE($3, phone),
        address     = COALESCE($4, address),
        status      = COALESCE($5::business_status, status),
        ${triSet("logo_url", 6)}${withWebsite ? `,\n        ${triSet("website", 7)}` : ""}
       WHERE id = $${idIdx}
       RETURNING *`,
      params,
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Business not found");
    return response.success(
      res,
      result.rows[0],
      "Business updated successfully",
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/businesses/overview
 * Platform-wide stats for super admin dashboard
 */
const getPlatformOverview = async (req, res, next) => {
  try {
    const [summaryRes, monthlyRes, topBizRes] = await Promise.all([
      query(`
        SELECT
          (SELECT COUNT(*) FROM businesses) AS total_businesses,
          (SELECT COUNT(*) FROM businesses WHERE status = 'active') AS active_businesses,
          (SELECT COUNT(*) FROM users) AS total_users,
          (SELECT COUNT(*) FROM tickets) AS total_tickets,
          (SELECT COALESCE(SUM(revenue), 0) FROM tickets) AS total_revenue,
          (SELECT COUNT(*) FROM cargo_shipments) AS total_cargo
      `),
      query(`
        SELECT DATE_TRUNC('month', created_at)::DATE AS month,
               COUNT(*) AS tickets
        FROM tickets
        WHERE created_at >= NOW() - INTERVAL '6 months'
        GROUP BY 1 ORDER BY 1
      `),
      query(`
        SELECT b.name,
               COUNT(t.id) AS tickets_this_month,
               COALESCE(SUM(t.revenue), 0) AS revenue_this_month
        FROM businesses b
        LEFT JOIN tickets t ON t.business_id = b.id
          AND DATE_TRUNC('month', t.created_at) = DATE_TRUNC('month', NOW())
        GROUP BY b.id, b.name
        ORDER BY tickets_this_month DESC
        LIMIT 10
      `),
    ]);

    return response.success(res, {
      summary: summaryRes.rows[0],
      monthlyTrend: monthlyRes.rows,
      topBusinesses: topBizRes.rows,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/businesses/mine
 *
 * The signed-in user's own agency — name, logo and contact strip.
 *
 * Every printed document needs this, and the alternative was for each page
 * to reach for whatever fragment of it happened to be nearby: the customer
 * statement got it bundled with the statement, the cargo receipt had no way
 * to get it at all. One endpoint, one shape, so both documents carry the
 * same letterhead.
 */
const getMyBusiness = async (req, res, next) => {
  try {
    if (!req.businessId)
      return response.error(res, "No business on this account", 400);

    const result = await query(
      `SELECT id, name, email, phone, address,
              ${(await hasColumn("businesses", "logo_url")) ? "logo_url," : "NULL::TEXT AS logo_url,"}
              ${(await hasColumn("businesses", "website")) ? "website" : "NULL::TEXT AS website"}
         FROM businesses WHERE id = $1`,
      [req.businessId],
    );
    if (result.rows.length === 0) return response.notFound(res, "Business not found");
    return response.success(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getMyBusiness,
  getBusinesses,
  getBusiness,
  updateBusiness,
  uploadLogo,
  getPlatformOverview,
};
