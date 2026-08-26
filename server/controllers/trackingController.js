/**
 * trackingController.js
 *
 * The one part of TAMS anybody can reach without logging in.
 *
 * A customer has a tracking number and one question: where is my parcel and
 * who do I collect it from. That is all this returns.
 *
 * Because there is no login, everything here is written on the assumption
 * that the caller is a stranger who may be guessing codes:
 *
 *   * only fields a customer needs are selected — never prices, never what
 *     they still owe, never internal ids, never who booked it
 *   * contact numbers are masked, except the office phone, which is meant
 *     to be public
 *   * a missing shipment and a malformed code give the same answer, so the
 *     endpoint cannot be used to work out which codes exist
 *   * lookups are rate limited in index.js
 */

const { query } = require("../config/db");
const response = require("../utils/response");

/**
 * Customers write tracking numbers with spaces, dashes and any case they
 * feel like. Comparing the stripped, upper-cased form means "trk 123-456"
 * and "TRK123456" find the same parcel.
 */
const normalise = (raw) =>
  String(raw || "")
    .replace(/[\s-]/g, "")
    .toUpperCase();

/**
 * Show enough of a phone number that the right person recognises it, and
 * too little for a stranger to use: 0612345678 becomes 06••••5678.
 */
const maskPhone = (raw) => {
  const s = String(raw || "").trim();
  if (s.length < 6) return null;
  return s.slice(0, 2) + "••••" + s.slice(-4);
};

/** Plain-language status, in the order a parcel actually moves. */
const STATUS_TEXT = {
  pending: {
    label: "Received",
    detail: "We have your items and they are being prepared for despatch.",
  },
  in_progress: {
    label: "On the way",
    detail: "Your items are in transit.",
  },
  delivered: {
    label: "Arrived",
    detail: "Your items have arrived and are ready to collect.",
  },
  cancelled: {
    label: "Cancelled",
    detail: "This shipment was cancelled. Please contact the office.",
  },
};

/**
 * GET /api/public/track/:code
 * No authentication. Deliberately sparse.
 */
const track = async (req, res, next) => {
  try {
    const code = normalise(req.params.code);

    // Same reply for "too short to be real" as for "no such parcel", so the
    // shape of the response never hints at what a valid code looks like.
    const notFound = () =>
      response.error(
        res,
        "We couldn't find a shipment with that tracking number. Please check it and try again.",
        404,
      );

    if (code.length < 4 || code.length > 64) return notFound();

    const result = await query(
      `SELECT cs.tracking_number,
              cs.item_description,
              cs.cargo_status,
              cs.from_city,
              cs.to_city,
              cs.sender_name,
              cs.receiver_name,
              cs.receiver_contact,
              cs.arrived_city,
              cs.arrived_office,
              cs.arrived_phone,
              cs.arrived_at,
              cs.created_at,
              cs.updated_at,
              b.name  AS business_name,
              b.phone AS business_phone
         FROM cargo_shipments cs
         JOIN businesses b ON b.id = cs.business_id
        WHERE UPPER(REPLACE(REPLACE(cs.tracking_number, ' ', ''), '-', '')) = $1
        LIMIT 1`,
      [code],
    );

    if (result.rows.length === 0) return notFound();

    const s = result.rows[0];
    const status = STATUS_TEXT[s.cargo_status] || STATUS_TEXT.pending;
    const arrived = s.cargo_status === "delivered";

    // Where to go, and who to ring. Falls back to the agency's own details
    // when the arriving office hasn't been filled in yet, so the customer is
    // never left with nobody to contact.
    const collectAt = arrived
      ? {
          city: s.arrived_city || s.to_city,
          office: s.arrived_office || s.business_name,
          phone: s.arrived_phone || s.business_phone || null,
          arrived_at: s.arrived_at,
        }
      : null;

    return response.success(res, {
      tracking_number: s.tracking_number,
      item: s.item_description || "Your items",
      status: s.cargo_status,
      status_label: status.label,
      status_detail: status.detail,
      route: { from: s.from_city, to: s.to_city },
      // First names only. Enough for the customer to know it's theirs,
      // not enough to be worth harvesting.
      sender: String(s.sender_name || "").split(/\s+/)[0] || null,
      receiver: String(s.receiver_name || "").split(/\s+/)[0] || null,
      receiver_contact: maskPhone(s.receiver_contact),
      collect_at: collectAt,
      agency: { name: s.business_name },
      sent_at: s.created_at,
      updated_at: s.updated_at,
      // Ready-made sentence, so the page and any SMS say the same thing.
      message: arrived
        ? `Alaabtaada waxay taalaa ${collectAt.city}${
            collectAt.office ? `, gaar ahaan xafiiska ${collectAt.office}` : ""
          }.`
        : status.detail,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { track };
