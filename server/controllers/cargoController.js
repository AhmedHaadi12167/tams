const { body, validationResult } = require("express-validator");
const { query } = require("../config/db");
const response = require("../utils/response");
const { v4: uuidv4 } = require("uuid");

const cargoValidation = [
  body("item_description")
    .trim()
    .notEmpty()
    .withMessage("Item description is required"),
  body("weight_kg")
    .isFloat({ min: 0.1 })
    .withMessage("Weight must be greater than 0"),
  body("price_per_kg")
    .isFloat({ min: 0 })
    .withMessage("Price per kg must be a positive number"),
  body("sender_name").trim().notEmpty().withMessage("Sender name is required"),
  body("from_city").trim().notEmpty().withMessage("From city is required"),
  body("receiver_name")
    .trim()
    .notEmpty()
    .withMessage("Receiver name is required"),
  body("to_city").trim().notEmpty().withMessage("To city is required"),
];

// Generate a simple tracking number
const generateTracking = () => {
  const prefix = "CGO";
  const num = Math.floor(100000 + Math.random() * 900000);
  return `${prefix}-${num}`;
};

/**
 * GET /api/cargo
 */
const getCargo = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = "",
      cargo_status,
      payment_status,
      from_date,
      to_date,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.businessId];
    const conditions = ["c.business_id = $1"];
    let pi = 2;

    if (search) {
      conditions.push(
        `(c.sender_name ILIKE $${pi} OR c.receiver_name ILIKE $${pi} OR c.tracking_number ILIKE $${pi} OR c.item_description ILIKE $${pi})`,
      );
      params.push(`%${search}%`);
      pi++;
    }
    if (cargo_status) {
      conditions.push(`c.cargo_status = $${pi}`);
      params.push(cargo_status);
      pi++;
    }
    if (payment_status) {
      conditions.push(`c.payment_status = $${pi}`);
      params.push(payment_status);
      pi++;
    }
    if (from_date) {
      conditions.push(`c.created_at >= $${pi}`);
      params.push(from_date);
      pi++;
    }
    if (to_date) {
      conditions.push(`c.created_at <= $${pi}`);
      params.push(to_date + " 23:59:59");
      pi++;
    }

    const where = conditions.join(" AND ");

    const [countRes, dataRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM cargo_shipments c WHERE ${where}`, params),
      query(
        `SELECT c.*, u.name AS agent_name FROM cargo_shipments c
         LEFT JOIN users u ON u.id = c.created_by
         WHERE ${where} ORDER BY c.created_at DESC
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
 * POST /api/cargo
 */
const createCargo = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.validationError(res, errors.array());

    const {
      item_description,
      weight_kg,
      price_per_kg,
      sender_contact,
      from_city,
      receiver_contact,
      to_city,
      notes,
      amount_paid,
      photo_url,
    } = req.body;

    // Force uppercase on names
    const sender_name = req.body.sender_name?.toUpperCase().trim();
    const receiver_name = req.body.receiver_name?.toUpperCase().trim();

    const tracking_number = generateTracking();

    // Auto-determine payment status
    const total = parseFloat(weight_kg) * parseFloat(price_per_kg);
    const paid = parseFloat(amount_paid || 0);
    let paymentStatus = "unpaid";
    if (paid >= total) paymentStatus = "paid";
    else if (paid > 0) paymentStatus = "partial";

    const result = await query(
      `INSERT INTO cargo_shipments (
        business_id, created_by, item_description, weight_kg, price_per_kg,
        sender_name, sender_contact, from_city,
        receiver_name, receiver_contact, to_city,
        tracking_number, notes, amount_paid, payment_status, photo_url
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        req.businessId,
        req.user.id,
        item_description,
        weight_kg,
        price_per_kg,
        sender_name,
        sender_contact || null,
        from_city,
        receiver_name,
        receiver_contact || null,
        to_city,
        tracking_number,
        notes || null,
        paid,
        paymentStatus,
        photo_url || null,
      ],
    );

    return response.created(
      res,
      result.rows[0],
      "Shipment created successfully",
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/cargo/:id
 */
const getCargoById = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.*, u.name AS agent_name FROM cargo_shipments c
       LEFT JOIN users u ON u.id = c.created_by
       WHERE c.id = $1 AND c.business_id = $2`,
      [req.params.id, req.businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Shipment not found");
    return response.success(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/cargo/:id
 */
const updateCargo = async (req, res, next) => {
  try {
    const {
      item_description,
      weight_kg,
      price_per_kg,
      sender_name,
      sender_contact,
      from_city,
      receiver_name,
      receiver_contact,
      to_city,
      notes,
      cargo_status,
      amount_paid,
      photo_url,
    } = req.body;

    // Recalculate payment status
    const total = parseFloat(weight_kg) * parseFloat(price_per_kg);
    const paid = parseFloat(amount_paid || 0);
    let paymentStatus = "unpaid";
    if (paid >= total) paymentStatus = "paid";
    else if (paid > 0) paymentStatus = "partial";

    const result = await query(
      `UPDATE cargo_shipments SET
        item_description=$1, weight_kg=$2, price_per_kg=$3,
        sender_name=$4, sender_contact=$5, from_city=$6,
        receiver_name=$7, receiver_contact=$8, to_city=$9,
        notes=$10, cargo_status=COALESCE($11, cargo_status),
        amount_paid=$12, payment_status=$13,
        photo_url=$16
       WHERE id=$14 AND business_id=$15
       RETURNING *`,
      [
        item_description,
        weight_kg,
        price_per_kg,
        sender_name,
        sender_contact || null,
        from_city,
        receiver_name,
        receiver_contact || null,
        to_city,
        notes || null,
        cargo_status || null,
        paid,
        paymentStatus,
        req.params.id,
        req.businessId,
        photo_url || null,
      ],
    );

    if (result.rows.length === 0)
      return response.notFound(res, "Shipment not found");
    return response.success(res, result.rows[0], "Shipment updated");
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/cargo/:id
 */
const deleteCargo = async (req, res, next) => {
  try {
    const result = await query(
      `DELETE FROM cargo_shipments WHERE id = $1 AND business_id = $2 RETURNING id`,
      [req.params.id, req.businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Shipment not found");
    return response.success(res, null, "Shipment deleted");
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/cargo/photo
 * Upload (or camera-capture) a single item photo. Returns the stored path;
 * the caller saves it on the shipment as photo_url.
 */
const uploadCargoPhoto = async (req, res, next) => {
  try {
    if (!req.file) return response.error(res, "No photo uploaded", 400);
    if (!req.file.mimetype.startsWith("image/")) {
      return response.error(res, "Only image files are allowed", 415);
    }
    const url = `${req.user.business_id}/${req.file.filename}`;
    return response.created(res, { photo_url: url }, "Photo uploaded");
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/cargo/:id/photo
 */
const deleteCargoPhoto = async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE cargo_shipments SET photo_url = NULL
       WHERE id = $1 AND business_id = $2 RETURNING *`,
      [req.params.id, req.businessId],
    );
    if (result.rows.length === 0)
      return response.notFound(res, "Shipment not found");
    return response.success(res, result.rows[0], "Photo removed");
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getCargo,
  createCargo,
  getCargoById,
  updateCargo,
  deleteCargo,
  cargoValidation,
  uploadCargoPhoto,
  deleteCargoPhoto,
};
