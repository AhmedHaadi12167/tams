/**
 * openingImportController.js
 *
 * Bringing balances over from the previous system, in bulk.
 *
 *   GET  /financials/opening-items/template?type=receivable|payable
 *        An Excel template with the right columns and an example row.
 *   POST /financials/opening-items/import/preview   (multipart: file, type)
 *        Reads the sheet and matches every row to the EXACT customer or
 *        airline already on file — by phone first, then by name. Nothing is
 *        saved. Rows that can't be matched safely are flagged, not guessed.
 *   POST /financials/opening-items/import/commit    (JSON: type, rows)
 *        Saves the rows the user confirmed (with any matches they changed),
 *        all in one transaction: either every row is recorded or none is.
 *
 * Each imported row becomes an ordinary opening balance item, so it shows on
 * the customer's statement / the airline's account, can be collected or paid
 * later, and appears in the journal and on the balance sheet.
 */

const ExcelJS = require("exceljs");
const multer = require("multer");
const { query, withTransaction } = require("../config/db");
const response = require("../utils/response");
const { samePhone, digitsOf } = require("../services/phoneMatch");
const { cleanName } = require("../services/nameClean");
const { findAirlineMatch, resolveAirline } = require("../services/airlineService");
const { isUuid } = require("../utils/sqlSafe");

const MAX_ROWS = 2000;
const SERVICES = ["ticket", "visa", "cargo", "package", "other"];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const COLUMNS = {
  receivable: [
    { header: "Customer name", key: "name", width: 32 },
    { header: "Phone", key: "phone", width: 18 },
    { header: "Service", key: "service", width: 12 },
    { header: "Amount", key: "amount", width: 14 },
    { header: "Date", key: "date", width: 14 },
    { header: "Reason", key: "reason", width: 44 },
  ],
  payable: [
    { header: "Airline", key: "name", width: 32 },
    { header: "Amount", key: "amount", width: 14 },
    { header: "Date", key: "date", width: 14 },
    { header: "Reason", key: "reason", width: 44 },
  ],
};

// Headers people actually type, mapped to our keys.
const HEADER_ALIASES = {
  name: ["customer name", "customer", "name", "client", "airline", "airline name", "supplier", "carrier"],
  phone: ["phone", "phone number", "mobile", "tel", "telephone", "contact"],
  service: ["service", "service type", "type"],
  amount: ["amount", "balance", "amount due", "owed", "debt", "total"],
  date: ["date", "entry date", "as of", "since"],
  reason: ["reason", "note", "notes", "description", "details", "memo"],
};

const requireBusiness = (req, res) => {
  if (!req.businessId) {
    response.error(res, "Select a business first (pass business_id)", 400);
    return false;
  }
  return true;
};
const typeOrThrow = (t) => {
  if (!["receivable", "payable"].includes(t)) {
    const err = new Error("Choose receivables (customers owe) or payables (owed to airlines)");
    err.statusCode = 400;
    err.expose = true;
    throw err;
  }
  return t;
};

// ── Upload: spreadsheets only, kept in memory, never written to disk ────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      /\.(xlsx|csv)$/i.test(file.originalname || "") ||
      [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/csv",
        "application/csv",
        "application/vnd.ms-excel",
      ].includes(file.mimetype);
    if (ok) return cb(null, true);
    cb(new Error("Upload an Excel (.xlsx) or CSV file"), false);
  },
}).single("file");

// ── Reading the sheet ───────────────────────────────────────────────────────

const cellText = (v) => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if (v.hyperlink) return String(v.text || v.hyperlink);
  }
  return String(v).trim();
};

const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === ";" || ch === "\t") { row.push(cur.trim()); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cur.trim()); rows.push(row); row = []; cur = "";
    } else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
};

const readGrid = async (file) => {
  if (/\.csv$/i.test(file.originalname || "") || /csv/.test(file.mimetype)) {
    return parseCsv(file.buffer.toString("utf8"));
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const ws = wb.worksheets.find((w) => w.rowCount > 0) || wb.worksheets[0];
  if (!ws) return [];
  const grid = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const cells = [];
    for (let c = 1; c <= Math.max(r.cellCount, 8); c++) cells.push(cellText(r.getCell(c).value));
    if (cells.some((c) => c !== "")) grid.push(cells);
  });
  return grid;
};

const mapHeaders = (headerRow) => {
  const idx = {};
  headerRow.forEach((h, i) => {
    const k = String(h || "").trim().toLowerCase().replace(/[*:]/g, "").trim();
    for (const [key, names] of Object.entries(HEADER_ALIASES))
      if (idx[key] === undefined && names.includes(k)) idx[key] = i;
  });
  return idx;
};

const parseAmount = (raw) => {
  const s = String(raw ?? "").replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? round2(n) : NaN;
};

const today = () => new Date().toISOString().slice(0, 10);
const parseDate = (raw) => {
  const s = String(raw ?? "").trim();
  if (!s) return { value: today(), defaulted: true };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: s };
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return { value: s.slice(0, 10) };
  // Excel serial day number
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Math.round((Number(s) - 25569) * 86400 * 1000));
    return { value: d.toISOString().slice(0, 10) };
  }
  // 31/12/2025, 31-12-2025, 31.12.2025 (day first, as used in Somalia)
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const d = new Date(`${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return { value: d.toISOString().slice(0, 10) };
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return { value: d.toISOString().slice(0, 10) };
  return { error: `"${s}" isn't a date we can read — use YYYY-MM-DD` };
};

const normService = (raw) => {
  const s = String(raw || "").trim().toLowerCase().replace(/s$/, "");
  if (!s) return "other";
  if (s.startsWith("tick") || s === "air" || s === "flight") return "ticket";
  if (s.startsWith("vis")) return "visa";
  if (s.startsWith("carg") || s === "parcel") return "cargo";
  if (s.startsWith("pack") || s === "umrah" || s === "hajj") return "package";
  return SERVICES.includes(s) ? s : "other";
};

const normName = (s) => String(cleanName(s) || s || "").toUpperCase().replace(/\s+/g, " ").trim();

// ── Matching ────────────────────────────────────────────────────────────────

const matchCustomers = async (businessId, rows) => {
  const all = (
    await query(`SELECT id, name, phone FROM customers WHERE business_id = $1`, [businessId])
  ).rows;
  return rows.map((r) => {
    const digits = digitsOf(r.phone);
    if (digits.length >= 7) {
      const byPhone = all.filter((c) => samePhone(c.phone, digits));
      if (byPhone.length === 1)
        return { ...r, match: "matched", via: "phone", party_id: byPhone[0].id, party_name: byPhone[0].name };
      if (byPhone.length > 1) {
        const sameName = byPhone.filter((c) => normName(c.name) === normName(r.name));
        if (sameName.length === 1)
          return { ...r, match: "matched", via: "phone + name", party_id: sameName[0].id, party_name: sameName[0].name };
        return {
          ...r, match: "ambiguous",
          message: `${byPhone.length} customers share this phone — choose the right one`,
          candidates: byPhone.map((c) => ({ id: c.id, name: c.name, phone: c.phone })),
        };
      }
    }
    const byName = all.filter((c) => normName(c.name) === normName(r.name));
    if (byName.length === 1)
      return { ...r, match: "matched", via: "name", party_id: byName[0].id, party_name: byName[0].name };
    if (byName.length > 1)
      return {
        ...r, match: "ambiguous",
        message: `${byName.length} customers are called "${byName[0].name}" — choose the right one`,
        candidates: byName.map((c) => ({ id: c.id, name: c.name, phone: c.phone })),
      };
    return { ...r, match: "new", message: "New customer — will be created", party_name: normName(r.name) };
  });
};

const matchAirlines = async (businessId, rows) => {
  const cache = new Map();
  const out = [];
  for (const r of rows) {
    const key = normName(r.name);
    if (!cache.has(key)) cache.set(key, await findAirlineMatch(r.name, businessId));
    const m = cache.get(key);
    if (m.matched)
      out.push({ ...r, match: "matched", via: m.via || "name", party_id: m.airline.id, party_name: m.airline.name });
    else
      out.push({
        ...r,
        match: "new",
        message: m.suggestions.length
          ? `Not on file. Did you mean ${m.suggestions.map((s) => s.name).join(" / ")}?`
          : "New airline — will be created",
        party_name: String(r.name).trim(),
        candidates: m.suggestions.map((s) => ({ id: s.id, name: s.name })),
      });
  }
  return out;
};

/** Already recorded? Same party, amount, date and reason. */
const markDuplicates = async (businessId, type, rows) => {
  const existing = (
    await query(
      `SELECT customer_id, airline_id, amount, entry_date::TEXT AS entry_date, LOWER(reason) AS reason
         FROM opening_balance_items WHERE business_id = $1 AND balance_type = $2`,
      [businessId, type],
    )
  ).rows;
  const seen = new Set();
  return rows.map((r) => {
    if (r.match === "error") return r;
    const key = `${r.party_id || normName(r.name)}|${r.amount}|${r.entry_date}|${String(r.reason).toLowerCase()}`;
    const dupDb =
      r.party_id &&
      existing.some(
        (e) =>
          (type === "receivable" ? e.customer_id : e.airline_id) === r.party_id &&
          round2(e.amount) === r.amount &&
          e.entry_date === r.entry_date &&
          e.reason === String(r.reason).toLowerCase(),
      );
    const dupFile = seen.has(key);
    seen.add(key);
    if (dupDb) return { ...r, duplicate: "Already recorded — will be skipped unless you include it" };
    if (dupFile) return { ...r, duplicate: "Same as an earlier row in this file" };
    return r;
  });
};

// ── Handlers ────────────────────────────────────────────────────────────────

/** GET /financials/opening-items/template?type= */
const downloadTemplate = async (req, res, next) => {
  try {
    const type = typeOrThrow(req.query.type || "receivable");
    const wb = new ExcelJS.Workbook();
    wb.creator = "TAMS";
    const ws = wb.addWorksheet(type === "receivable" ? "Receivables" : "Payables");
    ws.columns = COLUMNS[type];
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    if (type === "receivable") {
      ws.addRow({ name: "AHMED ALI HASSAN", phone: "0615123456", service: "ticket", amount: 350, date: "2026-08-31", reason: "Ticket MGQ-NBO unpaid balance (old system)" });
      ws.addRow({ name: "FADUMO OMAR", phone: "0617000111", service: "visa", amount: 120, date: "2026-08-31", reason: "Umrah visa balance" });
    } else {
      ws.addRow({ name: "Daallo Airlines", amount: 2400, date: "2026-08-31", reason: "Unpaid tickets up to 31 Aug (old system)" });
    }
    const notes = wb.addWorksheet("How to fill");
    notes.columns = [{ width: 110 }];
    [
      "One row per balance. Keep the header row exactly as it is.",
      type === "receivable"
        ? "Customer name and Phone: phone is matched first, then the exact name. Unknown customers are created for you."
        : "Airline: matched to your airlines by name or alias. Unknown airlines are created for you.",
      type === "receivable" ? "Service: ticket, visa, cargo, package or other." : "",
      "Amount: what is still owed, in dollars (no minus sign).",
      "Date: the date the balance was brought over, YYYY-MM-DD (e.g. the day before you started TAMS).",
      "Reason: a short description the customer or airline will recognise.",
      "Nothing is saved until you review the preview and press Import.",
    ].filter(Boolean).forEach((t) => notes.addRow([t]));

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="tams-opening-${type}s-template.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
};


const bad = (message) => {
  const err = new Error(message);
  err.statusCode = 400;
  err.expose = true;
  return err;
};

/** Read, validate and match a spreadsheet. Saves nothing. */
const buildPreview = async (businessId, type, file) => {
  const grid = await readGrid(file);
  if (grid.length < 2)
    throw bad("The sheet is empty. Fill in the template and try again.");
  const idx = mapHeaders(grid[0]);
  const needed = type === "receivable" ? ["name", "amount"] : ["name", "amount"];
  const missing = needed.filter((k) => idx[k] === undefined);
  if (missing.length)
    throw bad(
      `Couldn't find the ${missing.map((m) => (m === "name" ? (type === "receivable" ? "Customer name" : "Airline") : "Amount")).join(" and ")} column. Use the template's header row.`,
    );
  const body = grid.slice(1, MAX_ROWS + 2);
  if (body.length > MAX_ROWS)
    throw bad(`Up to ${MAX_ROWS} rows per import. Split the file and import it in parts.`);

  const get = (row, k) => (idx[k] === undefined ? "" : row[idx[k]] ?? "");
  const parsed = body.map((row, i) => {
    const name = String(get(row, "name")).trim();
    const amount = parseAmount(get(row, "amount"));
    const date = parseDate(get(row, "date"));
    const r = {
      row: i + 2,
      name,
      phone: String(get(row, "phone")).trim() || null,
      service_type: type === "receivable" ? normService(get(row, "service")) : null,
      amount,
      entry_date: date.value || null,
      reason: String(get(row, "reason")).trim() || "Brought forward from the previous system",
    };
    const problems = [];
    if (!name) problems.push(type === "receivable" ? "Customer name is empty" : "Airline is empty");
    if (amount === null) problems.push("Amount is empty");
    else if (Number.isNaN(amount)) problems.push("Amount isn't a number");
    else if (amount <= 0) problems.push("Amount must be more than zero");
    if (date.error) problems.push(date.error);
    return problems.length ? { ...r, match: "error", message: problems.join("; ") } : r;
  });

  const valid = parsed.filter((r) => r.match !== "error");
  const matched =
    type === "receivable"
      ? await matchCustomers(businessId, valid)
      : await matchAirlines(businessId, valid);
  const byRow = new Map(matched.map((r) => [r.row, r]));
  let rows = parsed.map((r) => byRow.get(r.row) || r);
  rows = await markDuplicates(businessId, type, rows);

  const count = (m) => rows.filter((r) => r.match === m).length;
  return {
    type,
    file_name: file.originalname,
    rows,
    summary: {
      rows: rows.length,
      matched: count("matched"),
      new: count("new"),
      ambiguous: count("ambiguous"),
      errors: count("error"),
      duplicates: rows.filter((r) => r.duplicate).length,
      total_amount: round2(rows.filter((r) => r.match !== "error").reduce((s, r) => s + r.amount, 0)),
    },
  };
};

/** POST /financials/opening-items/import/preview */
const previewImport = (req, res, next) => {
  upload(req, res, async (uploadErr) => {
    try {
      if (uploadErr) return response.error(res, uploadErr.message, 400);
      if (!requireBusiness(req, res)) return;
      const type = typeOrThrow(req.body.type);
      if (!req.file) return response.error(res, "Choose a file to upload", 400);

      return response.success(res, await buildPreview(req.businessId, type, req.file));
    } catch (err) {
      next(err);
    }
  });
};

/**
 * POST /financials/opening-items/import/commit
 * { type, rows: [{ row, name, phone, service_type, amount, entry_date, reason, party_id | null }] }
 */
const commitImport = async (req, res, next) => {
  try {
    if (!requireBusiness(req, res)) return;
    const type = typeOrThrow(req.body.type);
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return response.error(res, "Nothing to import", 400);
    if (rows.length > MAX_ROWS) return response.error(res, `Up to ${MAX_ROWS} rows per import`, 400);

    // Everything re-validated here — the preview is advice, not authority.
    const problems = [];
    const clean = rows.map((r, i) => {
      const n = r.row || i + 1;
      const amount = round2(r.amount);
      const date = parseDate(r.entry_date);
      const name = String(r.name || "").trim();
      if (!(amount > 0)) problems.push(`Row ${n}: amount must be more than zero`);
      if (date.error) problems.push(`Row ${n}: ${date.error}`);
      if (!r.party_id && !name) problems.push(`Row ${n}: no ${type === "receivable" ? "customer" : "airline"}`);
      if (r.party_id && !isUuid(r.party_id)) problems.push(`Row ${n}: invalid selection`);
      return {
        row: n,
        name,
        phone: String(r.phone || "").trim() || null,
        service_type: type === "receivable" ? (SERVICES.includes(r.service_type) ? r.service_type : "other") : null,
        amount,
        entry_date: date.value,
        reason: String(r.reason || "").trim() || "Brought forward from the previous system",
        party_id: r.party_id || null,
      };
    });
    if (problems.length) return response.error(res, problems.slice(0, 10).join(" · "), 400);

    const result = await withTransaction(async (client) => {
      let createdParties = 0;
      const created = new Map(); // normalised name → id, so one new customer isn't created twice
      let total = 0;
      for (const r of clean) {
        let partyId = r.party_id;
        if (partyId) {
          const own = await client.query(
            `SELECT id FROM ${type === "receivable" ? "customers" : "airlines"} WHERE id = $1 AND business_id = $2`,
            [partyId, req.businessId],
          );
          if (!own.rows.length) {
            const err = new Error(`Row ${r.row}: that ${type === "receivable" ? "customer" : "airline"} isn't in this business`);
            err.statusCode = 400;
            err.expose = true;
            throw err;
          }
        } else if (type === "receivable") {
          const key = `${normName(r.name)}|${digitsOf(r.phone)}`;
          if (!created.has(key)) {
            const c = await client.query(
              `INSERT INTO customers (business_id, name, phone) VALUES ($1, $2, $3) RETURNING id`,
              [req.businessId, normName(r.name), r.phone],
            );
            created.set(key, c.rows[0].id);
            createdParties++;
          }
          partyId = created.get(key);
        } else {
          const before = await client.query(`SELECT COUNT(*)::INT AS n FROM airlines WHERE business_id = $1`, [req.businessId]);
          const a = await resolveAirline(r.name, req.businessId, client);
          const after = await client.query(`SELECT COUNT(*)::INT AS n FROM airlines WHERE business_id = $1`, [req.businessId]);
          if (after.rows[0].n > before.rows[0].n) createdParties++;
          partyId = a.id;
        }

        await client.query(
          `INSERT INTO opening_balance_items
             (business_id, balance_type, customer_id, airline_id, service_type,
              reason, amount, entry_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::DATE, $9)`,
          [
            req.businessId,
            type,
            type === "receivable" ? partyId : null,
            type === "payable" ? partyId : null,
            r.service_type,
            r.reason,
            r.amount,
            r.entry_date,
            req.user.id,
          ],
        );
        total += r.amount;
      }
      return { imported: clean.length, created: createdParties, total: round2(total) };
    });

    return response.created(
      res,
      result,
      `${result.imported} opening ${type === "receivable" ? "receivable" : "payable"}${result.imported === 1 ? "" : "s"} imported ($${result.total.toFixed(2)})` +
        (result.created ? `, ${result.created} new ${type === "receivable" ? "customer" : "airline"}${result.created === 1 ? "" : "s"} created` : ""),
    );
  } catch (err) {
    next(err);
  }
};

module.exports = { downloadTemplate, previewImport, commitImport, buildPreview, readGrid };
