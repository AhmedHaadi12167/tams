/**
 * agentController.js
 *
 * External agents — people who bring the agency customers and earn a
 * commission per ticket. They are not TAMS users and have no login.
 *
 * Money flows the opposite way to a customer: the agency OWES the agent.
 *   earned  = SUM(tickets.agent_commission) for their tickets
 *   paid    = SUM(agent_payments.amount)
 *   balance = earned - paid
 */

const { body, validationResult } = require("express-validator");
const { query } = require("../config/db");
const response = require("../utils/response");
const { hasTable } = require("../services/schemaInfo");

const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

const MIGRATION_MSG =
  "Agents need a database update. Run migration_v8.sql.";

const agentsTableExists = () => hasTable("agents");

const agentValidation = [
  body("name").trim().notEmpty().withMessage("Agent name is required"),
  body("phone")
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ min: 3 })
    .withMessage("Phone number looks too short"),
  body("email")
    .optional({ nullable: true, checkFalsy: true })
    .isEmail()
    .withMessage("Valid email required"),
];

/**
 * GET /api/agents
 * Every agent with what they have earned, been paid and are still owed.
 */
const getAgents = async (req, res, next) => {
  try {
    if (!(await agentsTableExists()))
      return response.error(res, MIGRATION_MSG, 503);

    const { search = "", only_due, include_inactive } = req.query;
    const params = [req.businessId];
    const conditions = ["a.business_id = $1"];
    let pi = 2;

    if (search) {
      conditions.push(`(a.agent_name ILIKE $${pi} OR a.phone ILIKE $${pi})`);
      params.push(`%${search}%`);
      pi++;
    }
    if (only_due === "true" || only_due === "1") conditions.push("a.balance > 0");
    if (!(include_inactive === "true" || include_inactive === "1"))
      conditions.push("a.is_active");

    const where = conditions.join(" AND ");

    const [rowsRes, totalsRes] = await Promise.all([
      query(
        `SELECT * FROM v_agent_account a
         WHERE ${where}
         ORDER BY a.balance DESC, a.agent_name`,
        params,
      ),
      query(
        `SELECT
           COALESCE(SUM(commission_earned), 0) AS earned,
           COALESCE(SUM(commission_paid), 0)   AS paid,
           COALESCE(SUM(balance), 0)           AS balance,
           COUNT(*) FILTER (WHERE balance > 0) AS agents_owing,
           COUNT(*)                            AS total_agents
         FROM v_agent_account WHERE business_id = $1`,
        [req.businessId],
      ),
    ]);

    const t = totalsRes.rows[0];
    return response.success(res, {
      agents: rowsRes.rows.map((a) => ({
        ...a,
        ticket_count: parseInt(a.ticket_count),
        commission_earned: round2(a.commission_earned),
        commission_paid: round2(a.commission_paid),
        balance: round2(a.balance),
      })),
      totals: {
        earned: round2(t.earned),
        paid: round2(t.paid),
        balance: round2(t.balance),
        agents_owing: parseInt(t.agents_owing),
        total_agents: parseInt(t.total_agents),
      },
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/agents/simple — id + name only, for the ticket form dropdown */
const listAgentsSimple = async (req, res, next) => {
  try {
    if (!(await agentsTableExists())) return response.success(res, []);
    const r = await query(
      `SELECT id, name, phone FROM agents
       WHERE business_id = $1 AND is_active ORDER BY name`,
      [req.businessId],
    );
    return response.success(res, r.rows);
  } catch (err) {
    next(err);
  }
};

/** POST /api/agents */
const createAgent = async (req, res, next) => {
  try {
    if (!(await agentsTableExists()))
      return response.error(res, MIGRATION_MSG, 503);

    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const { name, phone, email, id_number, notes } = req.body;

    // Warn rather than block — two people can share a name
    if (phone) {
      const dup = await query(
        `SELECT name FROM agents WHERE business_id = $1 AND phone = $2 LIMIT 1`,
        [req.businessId, phone.trim()],
      );
      if (dup.rows.length > 0) {
        return response.error(
          res,
          `${dup.rows[0].name} already uses that phone number.`,
          409,
        );
      }
    }

    const r = await query(
      `INSERT INTO agents (business_id, name, phone, email, id_number, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        req.businessId,
        name.trim(),
        phone?.trim() || null,
        email?.trim() || null,
        id_number?.trim() || null,
        notes || null,
      ],
    );
    return response.created(res, r.rows[0], "Agent added");
  } catch (err) {
    next(err);
  }
};

/** GET /api/agents/:id — profile, account and the tickets behind it */
const getAgent = async (req, res, next) => {
  try {
    if (!(await agentsTableExists()))
      return response.error(res, MIGRATION_MSG, 503);

    const [agentRes, accountRes, ticketsRes, paymentsRes] = await Promise.all([
      query(`SELECT * FROM agents WHERE id = $1 AND business_id = $2`, [
        req.params.id,
        req.businessId,
      ]),
      query(
        `SELECT * FROM v_agent_account WHERE agent_id = $1 AND business_id = $2`,
        [req.params.id, req.businessId],
      ),
      query(
        `SELECT t.id, t.passenger_name, t.from_city, t.to_city, t.flight_date,
                t.airline_name, t.selling_price, t.agent_commission,
                t.created_at, u.name AS booked_by
         FROM tickets t
         LEFT JOIN users u ON u.id = t.created_by
         WHERE t.agent_id = $1 AND t.business_id = $2 AND t.status <> 'cancelled'
         ORDER BY t.created_at DESC
         LIMIT 200`,
        [req.params.id, req.businessId],
      ),
      query(
        `SELECT p.*, u.name AS paid_by_name
         FROM agent_payments p
         JOIN users u ON u.id = p.paid_by
         WHERE p.agent_id = $1 AND p.business_id = $2
         ORDER BY p.created_at DESC`,
        [req.params.id, req.businessId],
      ),
    ]);

    if (agentRes.rows.length === 0)
      return response.notFound(res, "Agent not found");

    const acc = accountRes.rows[0] || {};
    return response.success(res, {
      agent: agentRes.rows[0],
      account: {
        ticket_count: parseInt(acc.ticket_count || 0),
        commission_earned: round2(acc.commission_earned),
        commission_paid: round2(acc.commission_paid),
        balance: round2(acc.balance),
      },
      tickets: ticketsRes.rows,
      payments: paymentsRes.rows,
    });
  } catch (err) {
    next(err);
  }
};

/** PUT /api/agents/:id */
const updateAgent = async (req, res, next) => {
  try {
    if (!(await agentsTableExists()))
      return response.error(res, MIGRATION_MSG, 503);

    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const { name, phone, email, id_number, notes, is_active } = req.body;
    const r = await query(
      `UPDATE agents SET
         name = $1, phone = $2, email = $3, id_number = $4, notes = $5,
         is_active = COALESCE($6, is_active)
       WHERE id = $7 AND business_id = $8 RETURNING *`,
      [
        name.trim(),
        phone?.trim() || null,
        email?.trim() || null,
        id_number?.trim() || null,
        notes || null,
        is_active ?? null,
        req.params.id,
        req.businessId,
      ],
    );
    if (r.rows.length === 0) return response.notFound(res, "Agent not found");
    return response.success(res, r.rows[0], "Agent updated");
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/agents/:id — refuse while tickets still credit them */
const deleteAgent = async (req, res, next) => {
  try {
    if (!(await agentsTableExists()))
      return response.error(res, MIGRATION_MSG, 503);

    const inUse = await query(
      `SELECT COUNT(*) FROM tickets WHERE agent_id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (parseInt(inUse.rows[0].count) > 0) {
      return response.error(
        res,
        `This agent is credited on ${inUse.rows[0].count} ticket(s). Deactivate them instead of deleting.`,
        409,
      );
    }
    const r = await query(
      `DELETE FROM agents WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.id, req.businessId],
    );
    if (r.rows.length === 0) return response.notFound(res, "Agent not found");
    return response.success(res, null, "Agent deleted");
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/agents/:id/payments  { amount, method, reference, note }
 * Omit amount to pay the whole outstanding commission.
 */
const payAgent = async (req, res, next) => {
  try {
    if (!(await agentsTableExists()))
      return response.error(res, MIGRATION_MSG, 503);

    const accRes = await query(
      `SELECT agent_name, balance FROM v_agent_account
       WHERE agent_id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (accRes.rows.length === 0)
      return response.notFound(res, "Agent not found");

    const balance = round2(accRes.rows[0].balance);
    const amount =
      req.body.amount === undefined ||
      req.body.amount === null ||
      req.body.amount === ""
        ? balance
        : round2(req.body.amount);

    if (!(amount > 0))
      return response.error(res, "Amount must be greater than 0", 400);
    if (balance <= 0)
      return response.error(
        res,
        `No commission outstanding for ${accRes.rows[0].agent_name}.`,
        400,
      );
    if (amount > balance + 0.001)
      return response.error(
        res,
        `Amount exceeds the outstanding commission ($${balance.toFixed(2)}).`,
        400,
      );

    const inserted = await query(
      `INSERT INTO agent_payments
         (business_id, agent_id, paid_by, amount, method, reference, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        req.businessId,
        req.params.id,
        req.user.id,
        amount,
        req.body.method || "cash",
        req.body.reference || null,
        req.body.note || null,
      ],
    );

    const after = await query(
      `SELECT balance FROM v_agent_account WHERE agent_id = $1 AND business_id = $2`,
      [req.params.id, req.businessId],
    );

    return response.created(
      res,
      { payment: inserted.rows[0], balance: round2(after.rows[0].balance) },
      `Paid $${amount.toFixed(2)} to ${accRes.rows[0].agent_name}`,
    );
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/agents/payments/:paymentId */
const deleteAgentPayment = async (req, res, next) => {
  try {
    if (!(await agentsTableExists()))
      return response.error(res, MIGRATION_MSG, 503);
    const r = await query(
      `DELETE FROM agent_payments WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.paymentId, req.businessId],
    );
    if (r.rows.length === 0) return response.notFound(res, "Payment not found");
    return response.success(res, null, "Payment reversed");
  } catch (err) {
    next(err);
  }
};

module.exports = {
  agentValidation,
  getAgents,
  listAgentsSimple,
  createAgent,
  getAgent,
  updateAgent,
  deleteAgent,
  payAgent,
  deleteAgentPayment,
};
