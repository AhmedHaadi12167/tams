const { body, validationResult } = require("express-validator");
const { query } = require("../config/db");
const response = require("../utils/response");

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
 * PUT /api/businesses/:id
 * Update business info and/or status
 */
const updateBusiness = async (req, res, next) => {
  try {
    const { name, email, phone, address, status } = req.body;
    const result = await query(
      `UPDATE businesses SET
        name        = COALESCE($1, name),
        email       = COALESCE($2, email),
        phone       = COALESCE($3, phone),
        address     = COALESCE($4, address),
        status      = COALESCE($5, status)
       WHERE id = $6
       RETURNING *`,
      [
        name || null,
        email || null,
        phone || null,
        address || null,
        status || null,
        req.params.id,
      ],
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

module.exports = {
  getBusinesses,
  getBusiness,
  updateBusiness,
  getPlatformOverview,
};
