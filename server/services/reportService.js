const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");
// v3: adds customer statement + group booking PDFs
// v19: the customer statement is now a branded invoice — see generateCustomerStatementPDF

// Format date cleanly — no timezone, just "18 Jun 2026"
const formatDate = (val) => {
  if (!val) return "-";
  const d = new Date(val);
  if (isNaN(d)) return "-";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

// Truncate text safely
const trunc = (str, len) => {
  if (!str) return "-";
  return str.length > len ? str.slice(0, len - 1) + "…" : str;
};

/**
 * Generate a PDF revenue report
 * Layout (landscape A4 = 841 x 595):
 * Cols: #, Passenger, Route, Airline, Date, Type, Cost, Sell, Revenue
 */
const generatePDFReport = (res, reportData, filters) => {
  // Landscape A4 with comfortable margins
  const M = 50; // page margin
  const doc = new PDFDocument({ margin: M, size: "A4", layout: "landscape" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="revenue-report.pdf"',
  );
  doc.pipe(res);

  const pageW = 841 - M * 2; // 741 usable

  // ── Header ──────────────────────────────────────────────
  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .fillColor("#111827")
    .text("Revenue Report", M, 34, { align: "center", width: pageW });
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#666666")
    .text(
      `Period: ${filters.from ? formatDate(filters.from) : "All time"}  →  ${filters.to ? formatDate(filters.to) : "Now"}`,
      M,
      56,
      { align: "center", width: pageW },
    );

  // ── Summary boxes ────────────────────────────────────────
  const { summary } = reportData;
  const summaryY = 76;
  const boxW = Math.floor((pageW - 5 * 8) / 6); // 6 boxes
  const boxes = [
    ["Revenue", `$${Number(summary.total_revenue || 0).toFixed(2)}`, "#1d4ed8"],
    [
      "Collected",
      `$${Number(summary.total_collected || 0).toFixed(2)}`,
      "#15803d",
    ],
    [
      "Balance Due",
      `$${Number(summary.total_balance || 0).toFixed(2)}`,
      "#b91c1c",
    ],
    ["Tickets", summary.total_tickets, "#1d4ed8"],
    ["Local", summary.local_tickets, "#1d4ed8"],
    ["International", summary.international_tickets, "#1d4ed8"],
  ];
  boxes.forEach(([label, value, color], i) => {
    const bx = M + i * (boxW + 8);
    doc.rect(bx, summaryY, boxW, 38).fillAndStroke("#f0f4ff", "#c7d7ff");
    doc
      .fillColor(color)
      .fontSize(6.5)
      .font("Helvetica-Bold")
      .text(String(label).toUpperCase(), bx + 8, summaryY + 7, {
        width: boxW - 16,
      });
    doc
      .fillColor("#111827")
      .fontSize(12)
      .font("Helvetica-Bold")
      .text(String(value), bx + 8, summaryY + 18, { width: boxW - 16 });
  });

  // ── Table ────────────────────────────────────────────────
  const tableTop = summaryY + 56;

  // Column definitions [label, x, width]
  const cols = [
    ["#", M, 22],
    ["Passenger", 72, 110],
    ["Route", 182, 100],
    ["Airline", 282, 72],
    ["Flight", 354, 58],
    ["Booked", 412, 58],
    ["Type", 470, 36],
    ["Cost", 506, 46],
    ["Sell", 552, 46],
    ["Revenue", 598, 50],
    ["Paid", 648, 46],
    ["Balance", 694, 47],
  ];

  const printHeader = (yy) => {
    doc.rect(M, yy, pageW, 16).fill("#1d4ed8");
    doc.fillColor("#ffffff").fontSize(7.5).font("Helvetica-Bold");
    cols.forEach(([label, x, w]) =>
      doc.text(label, x + 2, yy + 4, { width: w - 4, lineBreak: false }),
    );
    doc.font("Helvetica").fontSize(7.5);
    return yy + 18;
  };

  let y = printHeader(tableTop);
  let rowNum = 0;

  for (const ticket of reportData.tickets) {
    if (y > 540) {
      doc.addPage({ size: "A4", layout: "landscape" });
      y = printHeader(M);
    }

    if (rowNum % 2 === 0) {
      doc.rect(M, y - 2, pageW, 16).fill("#f8faff");
    }

    const balance =
      Number(ticket.selling_price || 0) - Number(ticket.amount_paid || 0);
    const row = [
      String(rowNum + 1),
      trunc(ticket.passenger_name, 20),
      trunc(`${ticket.from_city} → ${ticket.to_city}`, 18),
      trunc(ticket.airline_name, 13),
      formatDate(ticket.flight_date),
      formatDate(ticket.created_at),
      ticket.ticket_type === "INTERNATIONAL" ? "INTL" : "LOCAL",
      `$${Number(ticket.cost_price || 0).toFixed(2)}`,
      `$${Number(ticket.selling_price || 0).toFixed(2)}`,
      `$${Number(ticket.revenue || 0).toFixed(2)}`,
      `$${Number(ticket.amount_paid || 0).toFixed(2)}`,
      `$${balance.toFixed(2)}`,
    ];

    row.forEach((val, i) => {
      if (i === 9) doc.fillColor("#15803d");
      else if (i === 11 && balance > 0) doc.fillColor("#b91c1c");
      else doc.fillColor("#111827");
      const [, x, w] = cols[i];
      doc.text(val, x + 2, y, { width: w - 4, lineBreak: false });
    });

    doc
      .moveTo(M, y + 12)
      .lineTo(M + pageW, y + 12)
      .strokeColor("#e5e7eb")
      .lineWidth(0.5)
      .stroke();

    y += 16;
    rowNum++;
  }

  // ── Totals row ───────────────────────────────────────────
  const sum = (fn) =>
    reportData.tickets.reduce((s, t) => s + Number(fn(t) || 0), 0);
  const totalCost = sum((t) => t.cost_price);
  const totalSell = sum((t) => t.selling_price);
  const totalRevenue = sum((t) => t.revenue);
  const totalPaid = sum((t) => t.amount_paid);
  const totalBalance = totalSell - totalPaid;

  doc.rect(M, y, pageW, 18).fill("#1d4ed8");
  doc.fillColor("#ffffff").fontSize(7.5).font("Helvetica-Bold");
  doc.text(`TOTAL  (${reportData.tickets.length} tickets)`, 72, y + 5, {
    width: 200,
  });
  doc.text(`$${totalCost.toFixed(2)}`, 508, y + 5, { width: 44 });
  doc.text(`$${totalSell.toFixed(2)}`, 554, y + 5, { width: 44 });
  doc.text(`$${totalRevenue.toFixed(2)}`, 600, y + 5, { width: 48 });
  doc.text(`$${totalPaid.toFixed(2)}`, 650, y + 5, { width: 44 });
  doc.text(`$${totalBalance.toFixed(2)}`, 696, y + 5, { width: 45 });
  y += 30;

  // ── Airline breakdown ────────────────────────────────────
  const airlines = reportData.airlines || [];
  if (airlines.length > 0) {
    if (y > 440) {
      doc.addPage({ size: "A4", layout: "landscape" });
      y = M;
    }
    doc
      .fillColor("#111827")
      .fontSize(12)
      .font("Helvetica-Bold")
      .text("Tickets by Airline", M, y);
    y += 18;

    // Top airline highlight
    const top = airlines[0];
    doc.rect(M, y, pageW, 30).fillAndStroke("#fef9c3", "#fde047");
    doc
      .fillColor("#a16207")
      .fontSize(7)
      .font("Helvetica-Bold")
      .text("TOP AIRLINE", M + 10, y + 6);
    doc
      .fillColor("#111827")
      .fontSize(11)
      .font("Helvetica-Bold")
      .text(
        `${top.airline_name}  —  ${top.tickets} tickets · $${Number(top.total_revenue).toFixed(2)} revenue`,
        M + 10,
        y + 14,
        { width: pageW - 20 },
      );
    y += 40;

    const aCols = [
      ["#", M, 24],
      ["Airline", M + 24, 220],
      ["Tickets", M + 244, 70],
      ["Share", M + 314, 200],
      ["Sales", M + 514, 110],
      ["Revenue", M + 624, 117],
    ];
    doc.rect(M, y, pageW, 16).fill("#1d4ed8");
    doc.fillColor("#ffffff").fontSize(8).font("Helvetica-Bold");
    aCols.forEach(([label, x, w]) =>
      doc.text(label, x + 4, y + 4, { width: w - 8, lineBreak: false }),
    );
    y += 18;

    const maxTickets = Number(top.tickets) || 1;
    doc.font("Helvetica").fontSize(8);
    airlines.forEach((a, i) => {
      if (y > 545) {
        doc.addPage({ size: "A4", layout: "landscape" });
        y = M;
      }
      if (i % 2 === 0) doc.rect(M, y - 2, pageW, 16).fill("#f8faff");
      doc.fillColor("#111827");
      doc.text(String(i + 1), aCols[0][1] + 4, y, { width: 18 });
      doc.text(trunc(a.airline_name, 40), aCols[1][1] + 4, y, { width: 212 });
      doc.text(String(a.tickets), aCols[2][1] + 4, y, { width: 62 });
      // share bar
      const barW = Math.max((Number(a.tickets) / maxTickets) * 190, 2);
      doc.rect(aCols[3][1] + 4, y + 1, 190, 8).fill("#e5e7eb");
      doc
        .rect(aCols[3][1] + 4, y + 1, barW, 8)
        .fill(i === 0 ? "#eab308" : "#3b82f6");
      doc.fillColor("#111827");
      doc.text(`$${Number(a.total_sales).toFixed(2)}`, aCols[4][1] + 4, y, {
        width: 102,
      });
      doc.fillColor("#15803d");
      doc.text(`$${Number(a.total_revenue).toFixed(2)}`, aCols[5][1] + 4, y, {
        width: 109,
      });
      y += 16;
    });
  }

  // ── Footer ───────────────────────────────────────────────
  doc
    .fillColor("#666666")
    .fontSize(7)
    .font("Helvetica")
    .text(`Generated by TAMS · ${new Date().toLocaleString("en-GB")}`, M, 566, {
      align: "center",
      width: pageW,
    });

  doc.end();
};

/**
 * Generate an Excel revenue report
 */
const generateExcelReport = async (res, reportData, filters) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TAMS";

  // Summary sheet
  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.addRow(["Revenue Report"]);
  summarySheet.addRow([
    `Period: ${filters.from ? formatDate(filters.from) : "All time"} → ${filters.to ? formatDate(filters.to) : "Now"}`,
  ]);
  summarySheet.addRow([]);
  summarySheet.addRow(["Metric", "Value"]);
  summarySheet.addRow([
    "Total Revenue",
    `$${Number(reportData.summary.total_revenue || 0).toFixed(2)}`,
  ]);
  summarySheet.addRow([
    "Total Collected",
    `$${Number(reportData.summary.total_collected || 0).toFixed(2)}`,
  ]);
  summarySheet.addRow([
    "Balance Due",
    `$${Number(reportData.summary.total_balance || 0).toFixed(2)}`,
  ]);
  summarySheet.addRow(["Total Tickets", reportData.summary.total_tickets]);
  summarySheet.addRow(["Local Tickets", reportData.summary.local_tickets]);
  summarySheet.addRow([
    "International Tickets",
    reportData.summary.international_tickets,
  ]);
  summarySheet.getRow(1).font = { bold: true, size: 14 };
  summarySheet.getRow(4).font = { bold: true };

  // Tickets sheet
  const sheet = workbook.addWorksheet("Tickets");
  sheet.columns = [
    { header: "Passenger", key: "passenger_name", width: 28 },
    { header: "Type", key: "ticket_type", width: 14 },
    { header: "From", key: "from_city", width: 18 },
    { header: "To", key: "to_city", width: 18 },
    { header: "Airline", key: "airline_name", width: 20 },
    { header: "Flight Date", key: "flight_date", width: 14 },
    { header: "Base Price", key: "base_price", width: 12 },
    { header: "Tax", key: "tax", width: 10 },
    { header: "Surcharge", key: "surcharge", width: 12 },
    { header: "Cost Price", key: "cost_price", width: 12 },
    { header: "Selling Price", key: "selling_price", width: 14 },
    { header: "Commission", key: "agent_commission", width: 12 },
    { header: "Revenue", key: "revenue", width: 12 },
    { header: "Amount Paid", key: "amount_paid", width: 12 },
    { header: "Balance", key: "balance", width: 12 },
    { header: "Payment", key: "payment_status", width: 10 },
    { header: "Status", key: "status", width: 12 },
    { header: "Agent", key: "agent_name", width: 20 },
    { header: "Booked Date", key: "created_at", width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };

  // Add rows with clean dates
  reportData.tickets.forEach((t) => {
    sheet.addRow({
      ...t,
      flight_date: formatDate(t.flight_date),
      created_at: formatDate(t.created_at),
      balance: (
        Number(t.selling_price || 0) - Number(t.amount_paid || 0)
      ).toFixed(2),
    });
  });

  // Totals row
  const lastRow = sheet.lastRow.number + 1;
  const totalsRow = sheet.addRow({
    passenger_name: `TOTAL (${reportData.tickets.length} tickets)`,
    cost_price: reportData.tickets
      .reduce((s, t) => s + Number(t.cost_price || 0), 0)
      .toFixed(2),
    selling_price: reportData.tickets
      .reduce((s, t) => s + Number(t.selling_price || 0), 0)
      .toFixed(2),
    revenue: reportData.tickets
      .reduce((s, t) => s + Number(t.revenue || 0), 0)
      .toFixed(2),
  });
  totalsRow.font = { bold: true };
  totalsRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1D4ED8" },
  };
  totalsRow.font = { bold: true, color: { argb: "FFFFFFFF" } };

  // Agent performance sheet
  if (reportData.agentPerformance?.length) {
    const agentSheet = workbook.addWorksheet("Agent Performance");
    agentSheet.columns = [
      { header: "Agent", key: "agent_name", width: 25 },
      { header: "Total Tickets", key: "total_tickets", width: 14 },
      { header: "Total Revenue", key: "total_revenue", width: 16 },
    ];
    agentSheet.getRow(1).font = { bold: true };
    agentSheet.addRows(reportData.agentPerformance);
  }

  // Airlines sheet
  if (reportData.airlines?.length) {
    const airlineSheet = workbook.addWorksheet("Airlines");
    airlineSheet.columns = [
      { header: "Airline", key: "airline_name", width: 30 },
      { header: "Tickets", key: "tickets", width: 12 },
      { header: "Total Sales", key: "total_sales", width: 14 },
      { header: "Total Revenue", key: "total_revenue", width: 16 },
    ];
    airlineSheet.getRow(1).font = { bold: true };
    airlineSheet.addRows(reportData.airlines);
    // Highlight the top airline
    airlineSheet.getRow(2).font = { bold: true };
    airlineSheet.getRow(2).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFEF9C3" },
    };
  }

  // Cargo sheet
  if (reportData.cargo?.length) {
    const cargoSheet = workbook.addWorksheet("Cargo");
    cargoSheet.columns = [
      { header: "Tracking", key: "tracking_number", width: 14 },
      { header: "Item", key: "item_description", width: 20 },
      { header: "From", key: "from_city", width: 16 },
      { header: "To", key: "to_city", width: 16 },
      { header: "Sender", key: "sender_name", width: 20 },
      { header: "Receiver", key: "receiver_name", width: 20 },
      { header: "Weight (kg)", key: "weight_kg", width: 12 },
      { header: "Total Price", key: "total_price", width: 12 },
      { header: "Status", key: "cargo_status", width: 14 },
      { header: "Payment", key: "payment_status", width: 12 },
    ];
    cargoSheet.getRow(1).font = { bold: true };
    cargoSheet.addRows(reportData.cargo);
  }

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="revenue-report.xlsx"',
  );
  await workbook.xlsx.write(res);
  res.end();
};

// ─── Shared helpers for statement PDFs ─────────────────────────────

const money = (v) => `$${Number(v || 0).toFixed(2)}`;

const drawTableHeader = (doc, cols, y, pageW, x0 = 40) => {
  doc.rect(x0, y, pageW, 16).fill("#1d4ed8");
  doc.fillColor("#ffffff").fontSize(8).font("Helvetica-Bold");
  cols.forEach(([label, x, w]) => {
    doc.text(label, x + 2, y + 4, { width: w - 4, lineBreak: false });
  });
  doc.font("Helvetica").fontSize(8).fillColor("#111827");
  return y + 18;
};

const statusColor = (status) =>
  status === "paid" ? "#15803d" : status === "partial" ? "#b45309" : "#b91c1c";

/**
 * ─── Invoice styling ──────────────────────────────────────────────────────
 *
 * One palette, defined once.
 *
 * Deep teal rather than the blue used everywhere else in TAMS, and that is
 * deliberate: the invoice is the only thing in this system a customer ever
 * holds. Giving it its own colour makes it read as a document from the
 * agency rather than a printout of an internal screen. Every value here is
 * dark enough to survive a cheap mono printer, which is how most of these
 * will actually be read.
 */
const INV = {
  teal: "#0F766E",
  tealDeep: "#134E4A",
  tealSoft: "#5EEAD4",
  tealPale: "#F0FDFA",
  slate: "#0F172A",
  body: "#334155",
  muted: "#64748B",
  line: "#E2E8F0",
  rowAlt: "#F8FAFC",
  green: "#15803D",
  red: "#B91C1C",
  amber: "#B45309",
  white: "#FFFFFF",
};

/**
 * Small vector glyphs, drawn in white inside a filled teal disc.
 *
 * Drawn rather than set in a font because PDFKit's built-in faces are
 * Helvetica, Times and Courier — there is no icon font to reach for, and
 * embedding one to draw three shapes would add a hundred kilobytes to every
 * invoice. Three paths cost nothing and print identically everywhere.
 */
const GLYPHS = {
  // A mobile handset: body, screen notch, home dot.
  phone: (doc, cx, cy) => {
    doc.roundedRect(cx - 3.4, cy - 5.4, 6.8, 10.8, 1.4).fill(INV.white);
    doc.rect(cx - 1.2, cy - 4.2, 2.4, 0.7).fill(INV.teal);
    doc.circle(cx, cy + 3.7, 0.7).fill(INV.teal);
  },
  // A map pin: disc over a tapering point.
  pin: (doc, cx, cy) => {
    doc.circle(cx, cy - 1.6, 3.4).fill(INV.white);
    doc
      .polygon([cx - 2.6, cy - 0.2], [cx + 2.6, cy - 0.2], [cx, cy + 5.4])
      .fill(INV.white);
    doc.circle(cx, cy - 1.7, 1.3).fill(INV.teal);
  },
  // An envelope: body with the flap drawn back in the disc's own colour.
  mail: (doc, cx, cy) => {
    doc.roundedRect(cx - 5.6, cy - 4, 11.2, 8, 1).fill(INV.white);
    doc
      .moveTo(cx - 5.6, cy - 3.4)
      .lineTo(cx, cy + 0.9)
      .lineTo(cx + 5.6, cy - 3.4)
      .lineWidth(1.1)
      .stroke(INV.teal);
  },
};

/** A glyph on a filled disc — the shape used all along the footer. */
const iconDisc = (doc, glyph, cx, cy, r = 9) => {
  doc.circle(cx, cy, r).fill(INV.teal);
  doc.save();
  GLYPHS[glyph](doc, cx, cy);
  doc.restore();
};

const PAGE_W = 595; // A4 portrait, in PDF points
const PAGE_H = 842;
const IM = 40; // invoice margin
const IW = PAGE_W - IM * 2; // 515 usable
const RIGHT = PAGE_W - IM; // 555

// The footer is stamped onto every page after the fact, so content has to
// stop short of it. Every page-break decision below measures against this
// one number rather than each picking its own margin — which is how a
// signature ends up printed through a phone number.
const FOOT_TOP = PAGE_H - 112; // 730
const CONTENT_BOTTOM = FOOT_TOP - 8; // 722

/**
 * Shrink a string until it actually fits the space it is given.
 *
 * `lineBreak: false` asks PDFKit not to wrap, and mostly it doesn't — but
 * "mostly" produced an invoice with a package name spilling its last letter
 * onto a second line, on top of the row beneath. Measuring and cutting the
 * string ourselves removes the question: what is drawn is what was measured.
 *
 * The font and size must already be set on `doc`, since both change the
 * answer.
 */
const fit = (doc, text, width) => {
  const s = String(text ?? "");
  if (s === "") return "";
  // Three quarters of a point of slack. PDFKit's own wrapper and
  // widthOfString disagree by a fraction, and a string measuring exactly its
  // column width was the one case that still wrapped.
  width = width - 0.75;
  if (doc.widthOfString(s) <= width) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(s.slice(0, mid) + "…") <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo) + "…" : "";
};

/**
 * Set the largest of `sizes` at which `text` fits `width`, and return the
 * text — truncated only if even the smallest size is too wide.
 *
 * An agency name is the one string on this page that belongs to the reader
 * rather than to us, and cutting it to "Dayax Travel & Genera…" at the top
 * of their own invoice looks like a bug in their software. Dropping a point
 * or two of type is a much smaller price.
 */
const fitOrShrink = (doc, text, width, font, sizes) => {
  const s = String(text ?? "");
  doc.font(font);
  for (const size of sizes) {
    doc.fontSize(size);
    if (doc.widthOfString(s) <= width) return s;
  }
  doc.fontSize(sizes[sizes.length - 1]);
  return fit(doc, s, width);
};

/**
 * Draw exactly one line of text, cut to the width it is given.
 *
 * `lineBreak: false` turns out not to be enough on its own. PDFKit wrapped a
 * string measuring 131.86pt inside a 132pt column, dropping its last three
 * characters onto the row beneath — so an invoice line read
 * "Air Ticket — Mogadishu to Nairobi" with a stray "(re…" printed through
 * the row below it. Capping the call at a single line's height is what
 * actually stops that; pre-cutting with fit() is what makes the result a
 * clean ellipsis instead of a silent chop.
 *
 * The font and size must already be set, since both decide where the cut is.
 */
const oneLine = (doc, text, x, y, width, opts = {}) => {
  const size = doc._fontSize || 8;
  const cut = fit(doc, text, width);

  // `width` is only passed through when the text has to be aligned inside
  // it. Left-aligned text is given no width at all, which is the only way to
  // be certain PDFKit cannot wrap: `lineBreak: false` turned out not to be
  // enough on its own, and a capped height merely hid the second line rather
  // than preventing it — which is how "Dayax Travela Agency One" printed as
  // "Dayax Travela Agency" with the last word clipped away invisibly.
  const opt = { lineBreak: false, height: size * 1.35, ...opts };
  if (opt.align && opt.align !== "left") opt.width = width;
  else delete opt.width;

  doc.text(cut, x, y, opt);
};

/** Uploaded files live wherever multer put them — ask, don't guess. */
const uploadRoot = () => {
  try {
    return require("../middlewares/upload").uploadDir;
  } catch {
    return path.resolve(
      process.env.UPLOAD_PATH || path.join(__dirname, "..", "uploads"),
    );
  }
};

/**
 * Absolute path to a business logo, or null.
 *
 * The name comes from the database, so it is not user input in the direct
 * sense — but it was user input once, and a stored '../../../etc/passwd'
 * would be read just as happily as a PNG. Resolving it and confirming it is
 * still inside the upload directory costs nothing and closes that off.
 *
 * Returning null rather than throwing matters just as much: a missing or
 * unreadable logo must produce an invoice without a logo, never a failed
 * download at the counter.
 */
const logoPath = (logoUrl) => {
  if (!logoUrl) return null;
  try {
    const root = path.resolve(uploadRoot());
    const full = path.resolve(root, String(logoUrl));
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
};

/** Initials for the lettermark drawn when an agency has no logo. */
const initials = (name) => {
  const parts = String(name || "")
    .replace(/[^A-Za-z ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "TA";
  return parts
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
};

/**
 * A stable, quotable invoice number.
 *
 * Derived rather than stored, because a statement is a view of a running
 * account, not a numbered document in a ledger. Two invoices produced for
 * the same customer on the same day are the same document and get the same
 * number, which is what someone phoning about "invoice INV-20260830-4F2A1"
 * needs to be true.
 */
const invoiceNumber = (customer) => {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  const tail =
    String(customer?.id || "")
      .replace(/-/g, "")
      .slice(-5)
      .toUpperCase() || "00000";
  return `INV-${ymd}-${tail}`;
};

/**
 * The masthead, drawn on every page.
 *
 * `compact` halves it for continuation pages: the reader already knows whose
 * invoice this is, and repeating the full header would push two rows of
 * table onto a third sheet of paper.
 *
 * Returns the y to start writing at.
 */
const drawInvoiceHeader = (doc, business, { compact = false } = {}) => {
  const top = 26;
  const bandH = compact ? 46 : 66;
  const bandBottom = top + bandH;

  // Three things across one row: the agency's mark, its name, and the word
  // INVOICE. The name sits between the other two because that is the order
  // someone reads a letterhead in — who this is from, then what it is.
  //
  // The stamp is pushed to the far right and kept narrow so the middle slot,
  // which has to hold a name of unknown length, gets the room. INVOICE is
  // eight fixed characters; a business name is not, and the one that has to
  // be squeezed should be the one we control.
  const STAMP_L = 452; // top-left corner of the teal block
  doc.save();
  doc
    .polygon(
      [STAMP_L, top],
      [RIGHT, top],
      [RIGHT, bandBottom],
      [STAMP_L - 26, bandBottom],
    )
    .fill(INV.teal);
  doc
    .polygon(
      [STAMP_L - 32, top],
      [STAMP_L - 18, top],
      [STAMP_L - 44, bandBottom],
      [STAMP_L - 58, bandBottom],
    )
    .fill(INV.teal);
  doc
    .polygon(
      [STAMP_L - 54, top],
      [STAMP_L - 43, top],
      [STAMP_L - 69, bandBottom],
      [STAMP_L - 80, bandBottom],
    )
    .fill(INV.tealSoft);
  doc.restore();

  doc
    .fillColor(INV.white)
    .font("Helvetica-Bold")
    .fontSize(compact ? 9 : 11)
    .text("INVOICE", STAMP_L + 4, top + bandH / 2 - (compact ? 4 : 5), {
      width: RIGHT - STAMP_L - 14,
      align: "right",
      characterSpacing: 2,
      lineBreak: false,
      height: 16,
    });

  // Left: the agency's own mark, given as much of the band as it can use.
  const boxY = top + 4;
  const boxH = bandH - 8;
  const LOGO_W = compact ? 108 : 156;
  const file = logoPath(business?.logo_url);
  let drew = false;
  if (file) {
    try {
      // Reserved width, not measured width: PDFKit scales inside `fit` and
      // does not report what it used, so the name starts at a fixed point
      // and a wide logo can never collide with it.
      doc.image(file, IM, boxY, {
        fit: [LOGO_W, boxH],
        align: "left",
        valign: "center",
      });
      drew = true;
    } catch {
      // A corrupt or unsupported file must not take the invoice with it.
      drew = false;
    }
  }
  if (!drew) {
    doc.roundedRect(IM, boxY, boxH, boxH, 7).fill(INV.teal);
    doc
      .fillColor(INV.white)
      .font("Helvetica-Bold")
      .fontSize(Math.round(boxH * 0.42))
      .text(initials(business?.name), IM, boxY + boxH * 0.3, {
        width: boxH,
        align: "center",
        lineBreak: false,
        height: boxH,
      });
  }

  // ── The agency's name, between the mark and the stamp ────────────────
  //
  // Set in Times rather than Helvetica: this is the one line on the page
  // that is purely the agency's — everything else is a figure or a label —
  // so it is the one line worth setting like a wordmark rather than data.
  //
  // Two-tone, the first word in the brand colour and the rest near black.
  // A cheap effect, and it reads as deliberate where a single flat colour
  // at this size does not.
  const nameX = IM + (drew ? LOGO_W : boxH) + 14;
  const nameW = STAMP_L - 84 - nameX;
  const name = String(business?.name || "TAMS").trim();
  const cut = name.indexOf(" ");
  const head = cut === -1 ? name : name.slice(0, cut);
  const tail = cut === -1 ? "" : name.slice(cut); // keeps the leading space

  // Shrink to fit rather than truncate. Cutting an agency's own name off the
  // top of its own invoice looks like a fault in their software; a point or
  // two of type is a far smaller price.
  const sizes = compact ? [10, 9, 8, 7] : [14, 13, 12, 11, 10, 9];
  let size = sizes[sizes.length - 1];
  doc.font("Times-Bold");
  for (const trySize of sizes) {
    doc.fontSize(trySize);
    if (doc.widthOfString(name) <= nameW) {
      size = trySize;
      break;
    }
  }
  doc.fontSize(size);

  const headW = doc.widthOfString(head);
  const nameY = top + bandH / 2 - size * 0.52;
  doc.fillColor(INV.teal);
  doc.text(fit(doc, head, nameW), nameX, nameY, {
    lineBreak: false,
    height: size * 1.4,
  });
  if (tail) {
    doc.fillColor(INV.slate);
    doc.text(fit(doc, tail, Math.max(0, nameW - headW)), nameX + headW, nameY, {
      lineBreak: false,
      height: size * 1.4,
    });
  }

  const ruleY = bandBottom + 8;
  doc.rect(IM, ruleY, IW, 3).fill(INV.teal);
  return ruleY + (compact ? 12 : 16);
};

/** An underlined section title, in the style of the header rule. */
const sectionHeading = (doc, label, y, opts = {}) => {
  const { x = IM, width = IW, align = "left", color = INV.teal } = opts;
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(color);
  const w = doc.widthOfString(label);
  doc.text(label, x, y, { width, align, lineBreak: false });
  const lineX = align === "right" ? x + width - w : x;
  doc
    .moveTo(lineX, y + 12)
    .lineTo(lineX + w, y + 12)
    .lineWidth(0.9)
    .strokeColor(color)
    .stroke();
  return y + 21;
};

/** "Label: value" on one line, with the label in bold. */
const labelled = (doc, label, value, x, y, width, align = "left") => {
  const text = String(value ?? "");

  doc.font("Helvetica-Bold").fontSize(8).fillColor(INV.slate);
  const lw = doc.widthOfString(`${label} `);
  doc.font("Helvetica").fontSize(8);
  const vw = doc.widthOfString(text);

  // The available width is derived once and passed through, rather than
  // recomputed from the start position. Recomputing it as
  // (x + width) - (startX + lw) lost a fraction of a point to floating
  // point, which was enough for the fitter to decide the value didn't fit
  // and print "INV-20260830-890…" for a string that fitted exactly.
  // Two points of slack, so a value that measures exactly its column does
  // not sit on the boundary the fitter has to guess at. The line ends two
  // points shy of the margin, which nobody will ever see.
  const SLACK = 2;
  const overflows = lw + vw + SLACK > width;
  const startX =
    align === "right" && !overflows ? x + width - (lw + vw) - SLACK : x;
  const avail = overflows ? Math.max(0, width - lw) : vw + SLACK;

  doc
    .font("Helvetica-Bold")
    .fillColor(INV.slate)
    .text(`${label} `, startX, y, { lineBreak: false, height: 11 });
  doc.font("Helvetica").fontSize(8).fillColor(INV.body);
  oneLine(doc, text, startX + lw, y, avail);
  return y + 12;
};

/**
 * Tickets, visas and packages as one list of billed services.
 *
 * Three separate tables is how the old statement showed this, and it is how
 * the *system* thinks about it — but a customer who booked a flight and a
 * visa bought two services from one agency and expects to see them on one
 * bill, adding up to one total. The type survives as part of the service
 * description rather than as a section break.
 */
const serviceRows = (data) => {
  const rows = [];

  (data.tickets || []).forEach((t) => {
    rows.push({
      who: t.passenger_name + (t.is_self === false ? " *" : ""),
      // A colon rather than an em dash, and "to" rather than an arrow.
      // The arrow first: PDFKit's built-in Helvetica is WinAnsi-encoded and
      // has no "→", which printed as a stray "!'" in the middle of every
      // route. The colon second: the dash and its two spaces cost about
      // eight points, which was the difference between a round trip reading
      // "Mogadishu to Dubai (return)" and "Mogadishu to Dubai (retu…".
      service: `Air Ticket: ${t.from_city} to ${t.to_city}${
        t.trip_type === "round_trip" ? " (return)" : ""
      }`,
      reference: t.ticket_reference,
      date: t.flight_date,
      total: t.selling_price,
      balance: t.balance,
      status: t.payment_status,
    });
  });

  (data.visas || []).forEach((v) => {
    rows.push({
      who: v.applicant_name,
      service: `Visa Service: ${v.destination_country}${
        v.visa_type ? `, ${v.visa_type}` : ""
      }`,
      reference: v.reference,
      date: v.applied_date,
      total: v.selling_price,
      balance: v.balance,
      status: v.payment_status,
    });
  });

  (data.packages || []).forEach((p) => {
    rows.push({
      who: p.lead_name || p.label,
      service: `${String(p.package_type || "package").toUpperCase()} Package: ${p.label}`,
      reference: p.pilgrim_count ? `${p.pilgrim_count} traveller(s)` : null,
      date: p.departure_date,
      total: p.selling_price,
      balance: p.balance,
      status: p.payment_status,
    });
  });

  return rows;
};

/**
 * Customer statement PDF — an invoice the customer can be handed.
 *
 * A4 portrait, 595 x 842. Laid out top to bottom: masthead, who it is for
 * and what it is, the services billed, what has been received against them,
 * where to send the rest, and who to ask about it.
 */
const generateCustomerStatementPDF = (res, data) => {
  const { customer, payments = [], summary } = data;
  const business = data.business || null;
  const methods = data.payment_methods || [];
  const rows = serviceRows(data);

  // ── Paper size ─────────────────────────────────────────────────────────
  //
  // The layout below is written once, in A4 points, and A5 is produced by
  // scaling the whole page down rather than by a second set of coordinates.
  // That works exactly here and nowhere near as well in general: the A
  // series is defined so each size is its predecessor halved, and 420/595
  // is the same ratio as 595/842, so a uniform scale lands on A5 with
  // nothing left over. Two hand-written layouts would drift apart the first
  // time either was touched.
  const paper =
    String(data.page_size || "A4").toUpperCase() === "A5"
      ? { name: "A5", w: 420, h: 595 }
      : { name: "A4", w: PAGE_W, h: PAGE_H };
  const S = paper.w / PAGE_W;

  // bufferPages so the footer can be stamped onto every page after the
  // content has decided how many pages there are.
  const doc = new PDFDocument({
    margin: IM * S,
    size: paper.name,
    bufferPages: true,
  });

  // The transform is written into each page's own content stream, so it has
  // to be applied once per page — including pages that are returned to later
  // to have their footer stamped on, which inherit it from the stream.
  const scalePage = () => {
    if (S !== 1) doc.scale(S);

    // PDFKit decides when to start a new page by comparing the y it was
    // handed against page.height − margins.bottom, and it does that in the
    // coordinates we pass, before the transform. On A5 the page is 595 tall,
    // so every line below y=575 in our A4 coordinates looked like an
    // overflow and PDFKit helpfully began a second sheet — which is how the
    // A5 invoice came out as two pages of an A4 layout.
    //
    // Pinning the limit to the A4 content bottom makes that judgement mean
    // the same thing on both sizes. A negative bottom margin is unusual and
    // is exactly what it looks like: we are doing the pagination ourselves,
    // and asking PDFKit not to.
    doc.page.margins.bottom = paper.h - (PAGE_H - IM);
  };
  const newPage = () => {
    doc.addPage();
    scalePage();
  };
  scalePage();

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="invoice-${(customer.name || "customer")
      .replace(/[^a-z0-9]/gi, "-")
      .toLowerCase()}-${paper.name.toLowerCase()}.pdf"`,
  );
  doc.pipe(res);

  let y = drawInvoiceHeader(doc, business);

  // ── Invoice To / Invoice Information ───────────────────────────────────
  const colW = (IW - 30) / 2;
  const rightX = IM + colW + 30;

  const leftTop = sectionHeading(doc, "Invoice To", y);
  const rightTop = sectionHeading(doc, "Invoice Information", y, {
    x: rightX,
    width: colW,
    align: "right",
  });

  let ly = leftTop;
  ly = labelled(
    doc,
    "Display Name:",
    customer.company_name || customer.name,
    IM,
    ly,
    colW,
  );
  ly = labelled(doc, "Full Name:", customer.name, IM, ly, colW);
  if (customer.phone)
    ly = labelled(doc, "Contact:", customer.phone, IM, ly, colW);
  if (customer.email)
    ly = labelled(doc, "Email:", trunc(customer.email, 40), IM, ly, colW);
  if (customer.passport_number)
    ly = labelled(doc, "Passport:", customer.passport_number, IM, ly, colW);

  const balanceDue = Number(summary.total_balance) || 0;

  // A deposit the agency is still holding. It is shown as its own line and
  // subtracted at the bottom rather than folded into "received": the spent
  // part of a deposit is already inside total_paid, and adding it twice
  // would print an invoice claiming money that never arrived twice over.
  const held = Number(summary.deposit_held ?? data.deposit?.held) || 0;
  const netDue = Number(summary.net_due ?? balanceDue - held) || 0;
  const settled = netDue <= 0.001;
  const inCredit = netDue < -0.001;

  let ry = rightTop;
  ry = labelled(
    doc,
    "Invoice No:",
    invoiceNumber(customer),
    rightX,
    ry,
    colW,
    "right",
  );
  ry = labelled(
    doc,
    "Issued:",
    formatDate(new Date()),
    rightX,
    ry,
    colW,
    "right",
  );
  ry = labelled(
    doc,
    "Services:",
    `${summary.item_count ?? rows.length} item${
      (summary.item_count ?? rows.length) === 1 ? "" : "s"
    }`,
    rightX,
    ry,
    colW,
    "right",
  );

  if (held > 0.001)
    ry = labelled(doc, "On Deposit:", money(held), rightX, ry, colW, "right");

  // The status is the one thing on this page a reader looks for first, so it
  // is coloured rather than left to be found among the rest.
  doc.font("Helvetica-Bold").fontSize(8).fillColor(INV.slate);
  const bl = "Balance: ";
  const blw = doc.widthOfString(bl);
  const bv = `${money(Math.max(netDue, 0))}  ·  ${
    inCredit ? "IN CREDIT" : settled ? "PAID" : "UNPAID"
  }`;
  doc.font("Helvetica-Bold").fontSize(8);
  const bvw = doc.widthOfString(bv);
  const bx = rightX + colW - (blw + bvw);
  doc.fillColor(INV.slate).text(bl, bx, ry, { lineBreak: false });
  doc
    .fillColor(settled ? INV.green : INV.red)
    .text(bv, bx + blw, ry, { lineBreak: false });
  ry += 12;

  y = Math.max(ly, ry) + 14;

  // ── Service costs ──────────────────────────────────────────────────────
  //
  // The one block on the page a customer will actually read line by line, so
  // it is given a tinted ground and a heavier border than anything else —
  // enough that the eye lands on it first and stays inside it.
  y = sectionHeading(doc, "Service Costs", y);

  const cols = [
    ["SN", IM, 28, "left"],
    ["Customer", IM + 28, 100, "left"],
    ["Service", IM + 128, 148, "left"],
    ["Reference", IM + 276, 72, "left"],
    ["Date", IM + 348, 64, "left"],
    ["Total", IM + 412, 50, "right"],
    ["Balance", IM + 462, 53, "right"],
  ];

  const HEAD_H = 20;
  const ROW_H = 19;

  /**
   * Draw one page's worth of the table as a single bordered block.
   *
   * The tinted ground has to be painted before the rows and the border
   * stroked after, which means the block's height must be known up front —
   * hence counting the rows that fit first rather than drawing until
   * something overflows.
   */
  const drawTableBlock = (top, slice, startIndex) => {
    const h = HEAD_H + Math.max(slice.length, 1) * ROW_H;

    doc.roundedRect(IM, top, IW, h, 7).fill(INV.tealPale);

    doc.save();
    doc.roundedRect(IM, top, IW, HEAD_H, 7).clip();
    doc.rect(IM, top, IW, HEAD_H).fill(INV.teal);
    doc.restore();
    // Square off the header's lower corners so it reads as a band across the
    // top of the block rather than a floating pill.
    doc.rect(IM, top + HEAD_H - 7, IW, 7).fill(INV.teal);

    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(INV.white);
    cols.forEach(([label, x, w, align]) => {
      doc.text(label.toUpperCase(), x + 6, top + 7, {
        width: w - 12,
        align,
        lineBreak: false,
        characterSpacing: 0.4,
        height: 11,
      });
    });

    let ry = top + HEAD_H;
    slice.forEach((r, i) => {
      // Every other row lifted to white on the tint, which bands the table
      // without needing rules between the rows.
      if (i % 2 === 0) doc.rect(IM + 1, ry, IW - 2, ROW_H).fill(INV.white);

      const values = [
        String(startIndex + i + 1),
        r.who,
        r.service,
        r.reference || "—",
        formatDate(r.date),
        money(r.total),
        money(r.balance),
      ];
      values.forEach((v, ci) => {
        const [, x, w, align] = cols[ci];
        const owing = Number(r.balance) > 0.001;
        doc
          .font(ci === 1 ? "Helvetica-Bold" : "Helvetica")
          .fontSize(7.5)
          .fillColor(
            ci === 6
              ? owing
                ? INV.red
                : INV.green
              : ci === 1
                ? INV.slate
                : INV.body,
          );
        oneLine(doc, v, x + 6, ry + 6.5, w - 12, { align });
      });
      ry += ROW_H;
    });

    if (slice.length === 0) {
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor(INV.muted)
        .text("Nothing billed on this invoice.", IM, top + HEAD_H + 6, {
          width: IW,
          align: "center",
          lineBreak: false,
          height: 12,
        });
    }

    doc.roundedRect(IM, top, IW, h, 7).lineWidth(1.6).stroke(INV.teal);

    return top + h;
  };

  if (rows.length === 0) {
    y = drawTableBlock(y, [], 0);
  } else {
    let i = 0;
    while (i < rows.length) {
      let fits = Math.floor((CONTENT_BOTTOM - y - HEAD_H) / ROW_H);
      if (fits < 1) {
        newPage();
        y = drawInvoiceHeader(doc, business, { compact: true });
        fits = Math.floor((CONTENT_BOTTOM - y - HEAD_H) / ROW_H);
      }
      const take = Math.min(fits, rows.length - i);
      y = drawTableBlock(y, rows.slice(i, i + take), i);
      i += take;
      if (i < rows.length) {
        newPage();
        y = drawInvoiceHeader(doc, business, { compact: true });
      }
    }
  }

  y += 16;

  // ── Receipts (left) and totals (right), side by side ───────────────────
  //
  // Two panels rather than two stacked tables. Side by side, the eye reads
  // "here is what you paid, here is what that leaves" as one statement —
  // which is the only question a customer opens this document to answer.
  const panelGap = 14;
  const totalsW = 210;
  const receiptsW = IW - totalsW - panelGap;
  const totalsX = IM + receiptsW + panelGap;

  if (y + 130 > CONTENT_BOTTOM) {
    newPage();
    y = drawInvoiceHeader(doc, business, { compact: true });
  }

  // Three rows when there is no deposit — exactly what this panel has always
  // been. With one, the balance stops being the last word: the held deposit
  // is subtracted in front of the customer and the bottom row is what they
  // actually have to hand over.
  const totalRows =
    held > 0.001
      ? [
          ["Sales", money(summary.total_amount), INV.slate, false, false],
          ["Received", money(summary.total_paid), INV.green, false, false],
          ["Balance", money(balanceDue), INV.slate, false, false],
          ["On Deposit", `-${money(held)}`, INV.green, false, true],
          [
            inCredit ? "In Credit" : "Net Due",
            money(Math.abs(netDue)),
            INV.white,
            true,
            false,
          ],
        ]
      : [
          ["Sales", money(summary.total_amount), INV.slate, false, false],
          ["Received", money(summary.total_paid), INV.green, false, false],
          [
            "Balance",
            money(summary.total_balance),
            settled ? INV.green : INV.red,
            true,
            false,
          ],
        ];
  const TR_H = 26;
  const totalsH = TR_H * totalRows.length;

  // Receipts panel
  const recentPayments = payments.slice(0, 6);
  const receiptsH = Math.max(
    totalsH,
    recentPayments.length ? 26 + recentPayments.length * 17 + 8 : 74,
  );

  doc
    .roundedRect(IM, y, receiptsW, receiptsH, 6)
    .lineWidth(0.8)
    .fillAndStroke(INV.tealPale, INV.line);

  if (recentPayments.length === 0) {
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(INV.body)
      .text("No receipts recorded yet", IM, y + receiptsH / 2 - 14, {
        width: receiptsW,
        align: "center",
        lineBreak: false,
      });
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(INV.muted)
      .text(
        "Payments appear here as soon as they are collected.",
        IM,
        y + receiptsH / 2 + 1,
        { width: receiptsW, align: "center", lineBreak: false },
      );
  } else {
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(INV.tealDeep)
      .text("RECEIPTS", IM + 12, y + 9, {
        lineBreak: false,
        characterSpacing: 0.6,
      });
    if (payments.length > recentPayments.length) {
      doc
        .font("Helvetica")
        .fontSize(7)
        .fillColor(INV.muted)
        .text(
          `showing ${recentPayments.length} of ${payments.length}`,
          IM + 12,
          y + 9,
          { width: receiptsW - 24, align: "right", lineBreak: false },
        );
    }

    let py = y + 26;
    const whoW = receiptsW - 74 - 112;
    recentPayments.forEach((p) => {
      doc.font("Helvetica").fontSize(7.5).fillColor(INV.body);
      oneLine(doc, formatDate(p.created_at), IM + 12, py, 58);
      oneLine(doc, p.passenger_name || "—", IM + 74, py, whoW);
      doc.fillColor(INV.muted);
      oneLine(
        doc,
        p.account_name || p.method || "—",
        receiptsW + IM - 110,
        py,
        50,
      );
      doc
        .font("Helvetica-Bold")
        .fillColor(Number(p.amount) < 0 ? INV.red : INV.green)
        .text(money(p.amount), receiptsW + IM - 56, py, {
          width: 44,
          align: "right",
          lineBreak: false,
        });
      py += 17;
    });
  }

  // Totals panel
  totalRows.forEach(([label, value, color, strong, credit], i) => {
    const ty = y + i * TR_H;
    doc
      .rect(totalsX, ty, totalsW, TR_H)
      // Green for the row that counts in the customer's favour, so it cannot
      // be mistaken for another charge in a column of teal.
      .fill(credit ? INV.green : strong ? INV.tealDeep : INV.teal);
    if (!strong && !credit && i % 2 === 1) {
      doc.rect(totalsX, ty, totalsW, TR_H).fillOpacity(0.12).fill(INV.white);
      doc.fillOpacity(1);
    }
    doc
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .fillColor(INV.white)
      .text(label.toUpperCase(), totalsX + 14, ty + 8.5, {
        width: 90,
        lineBreak: false,
        characterSpacing: 0.5,
      });
    doc
      .font("Helvetica-Bold")
      .fontSize(strong ? 11 : 10)
      .fillColor(INV.white)
      .text(value, totalsX + 100, ty + (strong ? 7 : 8), {
        width: totalsW - 114,
        align: "right",
        lineBreak: false,
      });
  });

  y += Math.max(receiptsH, totalsH) + 8;

  // Where the deposit came from and where it went, in one sentence. The
  // panel shows what is left; a customer who handed over 400 wants to read
  // the 400 back, not work it out from the 190 that remains.
  if (
    held > 0.001 ||
    Number(summary.deposit_taken ?? data.deposit?.taken) > 0.001
  ) {
    const taken = Number(summary.deposit_taken ?? data.deposit?.taken) || 0;
    const used = Number(summary.deposit_applied ?? data.deposit?.applied) || 0;
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor(INV.muted)
      .text(
        `Deposit: ${money(taken)} received, ${money(used)} already used on the services above, ` +
          `${money(held)} still held on this account.` +
          (inCredit
            ? ` ${money(Math.abs(netDue))} of it is over and above what is owed.`
            : ""),
        IM,
        y,
        { width: IW, lineBreak: false },
      );
    y += 15;
  }

  if (rows.some((r) => String(r.who).endsWith(" *"))) {
    doc
      .font("Helvetica")
      .fontSize(6.5)
      .fillColor(INV.muted)
      .text("* booked by this customer for a family member or friend", IM, y, {
        width: IW,
        lineBreak: false,
      });
    y += 15;
  }

  // ── Payment methods ────────────────────────────────────────────────────
  //
  // Cash is never listed. This block exists to tell someone where to send
  // money they are not standing in front of you with, and "pay cash"
  // answers no question a person reading an invoice at home is asking.
  //
  // The bank's own mark leads each card and the number is the only text.
  // A customer recognises the logo of their bank before they finish reading
  // a word, so printing the name underneath as well said the same thing
  // twice and cost a third line of height for it. Where no icon has been
  // uploaded the name takes the mark's place instead, so a card is never
  // blank — and the number stays the one line set large, because it is the
  // only thing on the card that actually has to be read and copied.
  if (methods.length > 0) {
    const GAP = 9;
    const CARD_W = (IW - GAP * 2) / 3;
    const CARD_H = 40;
    const PANEL_W = 42;
    const rowsNeeded = Math.ceil(methods.length / 3);

    if (y + 26 + rowsNeeded * (CARD_H + GAP) > CONTENT_BOTTOM) {
      newPage();
      y = drawInvoiceHeader(doc, business, { compact: true });
    }

    y = sectionHeading(doc, "Payment Methods", y);

    methods.forEach((m, i) => {
      const cx = IM + (i % 3) * (CARD_W + GAP);
      const cy = y + Math.floor(i / 3) * (CARD_H + GAP);

      // A pale copy offset behind the card. PDFKit has no shadows, and this
      // is what gives the row depth instead of leaving flat outlines.
      doc.roundedRect(cx + 2, cy + 2.5, CARD_W, CARD_H, 8).fill(INV.tealPale);

      // White throughout, including behind the mark. A bank's logo is drawn
      // to sit on white; putting it on a tint changes the colour it was
      // designed against, and on the two-colour marks most Somali banks use
      // it looks like a printing fault.
      doc
        .roundedRect(cx, cy, CARD_W, CARD_H, 8)
        .lineWidth(1.1)
        .fillAndStroke(INV.white, INV.tealSoft);

      // A spine rather than a panel: it gives the card an edge to start
      // from without putting any colour behind the mark.
      doc.save();
      doc.roundedRect(cx, cy, CARD_W, CARD_H, 8).clip();
      doc.rect(cx, cy, 3.5, CARD_H).fill(INV.teal);
      doc.restore();

      const iconFile = logoPath(m.icon_url);
      let iconDrawn = false;
      if (iconFile) {
        try {
          doc.image(iconFile, cx + 9, cy + 7, {
            fit: [PANEL_W - 15, CARD_H - 14],
            align: "center",
            valign: "center",
          });
          iconDrawn = true;
        } catch {
          iconDrawn = false;
        }
      }
      if (!iconDrawn) {
        // No icon: the account's initials, set the way the lettermark in the
        // masthead is, so the fallback looks chosen rather than missed.
        doc.font("Helvetica-Bold").fontSize(11).fillColor(INV.teal);
        doc.text(initials(m.name), cx + 4, cy + CARD_H / 2 - 6, {
          width: PANEL_W - 6,
          align: "center",
          lineBreak: false,
          height: 14,
        });
      }

      const tx = cx + PANEL_W + 8;
      const tw = CARD_W - PANEL_W - 16;

      doc
        .font("Helvetica-Bold")
        .fontSize(m.account_number ? 9.5 : 8.5)
        .fillColor(INV.slate);
      oneLine(doc, m.account_number || m.name, tx, cy + 10, tw);

      const sub = m.account_holder || (m.account_number ? "" : "");
      if (sub) {
        doc.font("Helvetica").fontSize(7).fillColor(INV.muted);
        oneLine(doc, sub, tx, cy + 23, tw);
      }
    });

    y += rowsNeeded * (CARD_H + GAP) + 2;
  }

  // ── Signature ──────────────────────────────────────────────────────────
  if (data.prepared_by) {
    // Two centred lines. Worth a few points of tightening elsewhere on the
    // page to keep them off a sheet of their own — a second page carrying
    // nothing but a signature reads as a printing fault.
    if (y + 26 > CONTENT_BOTTOM) {
      newPage();
      y = drawInvoiceHeader(doc, business, { compact: true });
    }
    y += 3;
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INV.slate);
    const nm = `${data.prepared_by}, `;
    // Already a job title in almost every case — 'Operations Director' — so
    // it is only tidied, not rewritten. The underscore rule is there for the
    // fallback, where an access level like 'super_admin' comes through.
    const role = String(data.prepared_by_role || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const nw = doc.widthOfString(nm);
    doc.font("Helvetica").fontSize(9);
    const rw = doc.widthOfString(role);
    const sx = IM + (IW - (nw + rw)) / 2;
    doc
      .font("Helvetica-Bold")
      .fillColor(INV.slate)
      .text(nm, sx, y, { lineBreak: false });
    doc
      .font("Helvetica")
      .fillColor(INV.muted)
      .text(role, sx + nw, y, { lineBreak: false });
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(INV.muted)
      .text(
        new Date().toLocaleDateString("en-GB", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
        IM,
        y + 14,
        { width: IW, align: "center", lineBreak: false },
      );
  }

  // ── Footer, on every page ──────────────────────────────────────────────
  //
  // Written last, after all the pages exist, because PDFKit cannot go back
  // to a page once it has moved on unless it is asked to switch to it.
  //
  // This is also where the agency's phone, address and email live — and the
  // only place they live. The masthead carries the name alone; repeating the
  // contact details there made the top of the page busy and told the reader
  // nothing twice.
  const range = doc.bufferedPageRange();

  // One line per column, and cut to the column. A wrapped footer line would
  // push past the bottom margin, and PDFKit's answer to that is to start a
  // new page — which is how a two-number phone entry silently produced a
  // blank extra sheet with half a footer on it.
  const contacts = [
    ["phone", "Call", business?.phone || ""],
    ["pin", "Visit", business?.address || ""],
    [
      "mail",
      "Online",
      [business?.email, business?.website].filter(Boolean).join("  ·  "),
    ],
  ].filter(([, , v]) => v);

  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);

    doc
      .font("Times-Italic")
      .fontSize(9)
      .fillColor(INV.teal)
      .text("Thank you for your business", IM, FOOT_TOP, {
        width: IW,
        align: "center",
        lineBreak: false,
        height: 13,
      });

    doc.rect(IM, FOOT_TOP + 17, IW, 1.6).fill(INV.teal);

    if (contacts.length) {
      const cw = IW / contacts.length;
      contacts.forEach(([glyph, label, value], ci) => {
        const cx = IM + ci * cw;
        const discR = 8.5;

        iconDisc(doc, glyph, cx + discR, FOOT_TOP + 34, discR);

        const tx = cx + discR * 2 + 6;
        const tw = cw - (discR * 2 + 6) - 6;

        doc
          .font("Helvetica-Bold")
          .fontSize(6.5)
          .fillColor(INV.teal)
          .text(label.toUpperCase(), tx, FOOT_TOP + 27, {
            width: tw,
            lineBreak: false,
            characterSpacing: 0.9,
            height: 10,
          });
        doc.font("Helvetica").fontSize(7).fillColor(INV.body);
        oneLine(doc, value, tx, FOOT_TOP + 37.5, tw);
      });
    }

    doc
      .font("Helvetica")
      .fontSize(6.5)
      .fillColor(INV.muted)
      .text(
        `Page ${i + 1} of ${range.count}  ·  generated ${new Date().toLocaleString("en-GB")}`,
        IM,
        FOOT_TOP + 58,
        { width: IW, align: "right", lineBreak: false, height: 10 },
      );
  }

  doc.end();
};

/**
 * Group booking statement PDF (landscape A4)
 */
const generateGroupBookingPDF = (res, group) => {
  const passengers = group.passengers || [];
  const M = 50; // comfortable page margin
  const doc = new PDFDocument({ margin: M, size: "A4", layout: "landscape" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="group-booking-${(group.group_label || "group").replace(/[^a-z0-9]/gi, "-").toLowerCase()}.pdf"`,
  );
  doc.pipe(res);

  const pageW = 841 - M * 2; // 741 usable

  // Header
  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .fillColor("#111827")
    .text("Group Booking Statement", M, 36, { align: "center", width: pageW });
  doc
    .fontSize(10)
    .font("Helvetica-Bold")
    .fillColor("#1d4ed8")
    .text(group.group_label || "—", M, 58, { align: "center", width: pageW });
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#444444")
    .text(
      [
        `Customer: ${group.customer_display_name}`,
        group.customer_phone ? `Phone: ${group.customer_phone}` : null,
        `Type: ${group.group_type}`,
        `Booked by: ${group.created_by_name}`,
        group.flight_date ? `Flight: ${formatDate(group.flight_date)}` : null,
      ]
        .filter(Boolean)
        .join("   ·   "),
      M,
      74,
      { align: "center", width: pageW },
    );

  // Summary boxes
  const summaryY = 94;
  const boxW = Math.floor((pageW - 4 * 8) / 5);
  const boxes = [
    ["Passengers", group.ticket_count, "#1d4ed8"],
    ["Total Selling", money(group.total_selling_price), "#1d4ed8"],
    ["Total Revenue", money(group.total_revenue), "#1d4ed8"],
    ["Total Paid", money(group.total_paid), "#15803d"],
    ["Balance Due", money(group.total_balance), "#b91c1c"],
  ];
  boxes.forEach(([label, value, color], i) => {
    const bx = M + i * (boxW + 8);
    doc.rect(bx, summaryY, boxW, 38).fillAndStroke("#f0f4ff", "#c7d7ff");
    doc
      .fillColor(color)
      .fontSize(7)
      .font("Helvetica-Bold")
      .text(String(label).toUpperCase(), bx + 8, summaryY + 7, {
        width: boxW - 16,
      });
    doc
      .fillColor("#111827")
      .fontSize(13)
      .font("Helvetica-Bold")
      .text(String(value), bx + 8, summaryY + 18, { width: boxW - 16 });
  });

  // Passengers table
  const cols = [
    ["#", M, 22],
    ["Passenger", 72, 125],
    ["Route", 197, 108],
    ["Flight", 305, 60],
    ["Return", 365, 60],
    ["Airline", 425, 80],
    ["Type", 505, 42],
    ["Selling", 547, 56],
    ["Paid", 603, 56],
    ["Balance", 659, 58],
    ["Payment", 717, 74],
  ];

  let y = drawTableHeader(doc, cols, summaryY + 54, pageW, M);
  passengers.forEach((p, i) => {
    if (y > 530) {
      doc.addPage({ size: "A4", layout: "landscape" });
      y = drawTableHeader(doc, cols, M, pageW, M);
    }
    if (i % 2 === 0) doc.rect(M, y - 2, pageW, 16).fill("#f8faff");

    const balance =
      p.balance !== undefined
        ? p.balance
        : Number(p.selling_price || 0) - Number(p.amount_paid || 0);
    const row = [
      String(i + 1),
      trunc(p.passenger_name, 22),
      trunc(`${p.from_city} → ${p.to_city}`, 18),
      formatDate(p.flight_date),
      p.return_date ? formatDate(p.return_date) : "-",
      trunc(p.airline_name, 14),
      p.ticket_type === "INTERNATIONAL" ? "INTL" : "LOCAL",
      money(p.selling_price),
      money(p.amount_paid),
      money(balance),
      (p.payment_status || "unpaid").toUpperCase(),
    ];
    row.forEach((val, ci) => {
      const [, x, w] = cols[ci];
      doc.fillColor(ci === 10 ? statusColor(p.payment_status) : "#111827");
      doc.text(val, x + 2, y, { width: w - 4, lineBreak: false });
    });
    y += 16;
  });

  // Totals row
  doc.rect(M, y, pageW, 18).fill("#1d4ed8");
  doc.fillColor("#ffffff").fontSize(8).font("Helvetica-Bold");
  doc.text(`TOTAL  (${passengers.length} passengers)`, 72, y + 5, {
    width: 240,
  });
  doc.text(money(group.total_selling_price), 549, y + 5, { width: 52 });
  doc.text(money(group.total_paid), 605, y + 5, { width: 52 });
  doc.text(money(group.total_balance), 661, y + 5, { width: 54 });

  doc
    .fillColor("#666666")
    .fontSize(7)
    .font("Helvetica")
    .text(`Generated by TAMS · ${new Date().toLocaleString("en-GB")}`, M, 566, {
      align: "center",
      width: pageW,
    });

  doc.end();
};

/**
 * Airline report PDF — passenger manifest + revenue for one carrier.
 * Landscape A4 (842 x 595) so the passenger table has room.
 */
const generateAirlinePDF = (res, data, filters = {}) => {
  const { airline_name, summary, account, passengers, routes } = data;
  const M = 40;
  const doc = new PDFDocument({ margin: M, size: "A4", layout: "landscape" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="airline-${String(airline_name || "report")
      .replace(/[^a-z0-9]/gi, "-")
      .toLowerCase()}.pdf"`,
  );
  doc.pipe(res);

  const pageW = 842 - M * 2; // 762 usable

  // ── Header ──────────────────────────────────────────────
  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .fillColor("#111827")
    .text(airline_name || "Airline Report", M, 36, {
      align: "center",
      width: pageW,
    });

  const periodLabel =
    filters.from || filters.to
      ? `Period: ${filters.from || "start"} to ${filters.to || "today"}`
      : "All time";
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#666666")
    .text(
      `Airline Performance Report  ·  ${periodLabel}  ·  Generated ${new Date().toLocaleString("en-GB")}`,
      M,
      58,
      { align: "center", width: pageW },
    );

  // ── Summary boxes ───────────────────────────────────────
  const sy = 84;
  const boxW = (pageW - 6 * 8) / 7;
  const boxes = [
    ["Tickets", summary.tickets, "#1d4ed8"],
    ["Passengers", summary.passengers, "#1d4ed8"],
    ["Cost (period)", money(summary.total_cost), "#b45309"],
    ["Owed (all time)", money(account ? account.total_cost : 0), "#111827"],
    ["Paid to airline", money(account ? account.total_paid : 0), "#15803d"],
    ["Balance owed", money(account ? account.balance : 0), "#b91c1c"],
    ["Generated", new Date().toLocaleDateString("en-GB"), "#6b7280"],
  ];
  boxes.forEach(([label, value, color], i) => {
    const bx = M + i * (boxW + 8);
    doc.rect(bx, sy, boxW, 38).fillAndStroke("#f8faff", "#c7d7ff");
    doc
      .fillColor(color)
      .fontSize(6.5)
      .font("Helvetica-Bold")
      .text(String(label).toUpperCase(), bx + 6, sy + 7, { width: boxW - 12 });
    doc
      .fillColor("#111827")
      .fontSize(11)
      .font("Helvetica-Bold")
      .text(String(value), bx + 6, sy + 19, {
        width: boxW - 12,
        lineBreak: false,
      });
  });

  // ── Routes ──────────────────────────────────────────────
  let y = sy + 58;
  if (routes && routes.length) {
    doc
      .fillColor("#111827")
      .fontSize(11)
      .font("Helvetica-Bold")
      .text("Routes Flown", M, y);
    y += 16;
    doc.fontSize(8).font("Helvetica").fillColor("#374151");
    const perRow = 3;
    routes.forEach((r, i) => {
      const col = i % perRow;
      const rowY = y + Math.floor(i / perRow) * 13;
      doc.text(
        `${r.route}  —  ${r.tickets} ticket${Number(r.tickets) === 1 ? "" : "s"}  ·  ${money(r.cost)}`,
        M + col * (pageW / perRow),
        rowY,
        { width: pageW / perRow - 10, lineBreak: false },
      );
    });
    y += Math.ceil(routes.length / perRow) * 13 + 14;
  }

  // ── Passenger table ─────────────────────────────────────
  doc
    .fillColor("#111827")
    .fontSize(11)
    .font("Helvetica-Bold")
    .text("Passengers", M, y);
  y += 16;

  const cols = [
    ["#", M, 26],
    ["Passenger", 66, 150],
    ["Contact", 216, 96],
    ["Route", 312, 150],
    ["Flight Date", 462, 76],
    ["Type", 538, 56],
    ["Ref", 594, 66],
    ["Airline Cost", 660, 72],
    ["Booked By", 732, 70],
  ];

  y = drawTableHeader(doc, cols, y, pageW, M);

  (passengers || []).forEach((p, i) => {
    if (y > 545) {
      doc.addPage({ margin: M, size: "A4", layout: "landscape" });
      y = drawTableHeader(doc, cols, M, pageW, M);
    }
    if (i % 2 === 1) {
      doc.rect(M, y - 3, pageW, 14).fill("#f9fafb");
    }

    const flight = formatDate(p.flight_date);
    const flightLabel =
      p.trip_type === "round_trip" && p.return_date ? `${flight} ⇄` : flight;

    const row = [
      String(i + 1),
      trunc(p.passenger_name, 30),
      trunc(p.contact_number || "—", 19),
      trunc(`${p.from_city} - ${p.to_city}`, 30),
      flightLabel,
      p.ticket_type === "INTERNATIONAL" ? "INTL" : "LOCAL",
      trunc(p.ticket_reference || "—", 13),
      money(p.cost_price),
      trunc(p.agent_name || "—", 13),
    ];

    row.forEach((val, ci) => {
      const [, x, w] = cols[ci];
      doc
        .fillColor(ci === 7 ? "#b45309" : "#111827")
        .fontSize(7.5)
        .font(ci === 7 ? "Helvetica-Bold" : "Helvetica")
        .text(String(val), x + 2, y, { width: w - 4, lineBreak: false });
    });
    y += 14;
  });

  if (!passengers || passengers.length === 0) {
    doc
      .fillColor("#9ca3af")
      .fontSize(9)
      .font("Helvetica")
      .text("No tickets for this airline in the selected period.", M, y + 6, {
        width: pageW,
        align: "center",
      });
    y += 24;
  }

  // ── Totals row ──────────────────────────────────────────
  if (y > 535) {
    doc.addPage({ margin: M, size: "A4", layout: "landscape" });
    y = M;
  }
  doc.rect(M, y, pageW, 18).fill("#eef2ff");
  doc.fillColor("#1d4ed8").fontSize(8).font("Helvetica-Bold");
  doc.text("TOTAL COST OWED", M + 4, y + 5, { lineBreak: false });
  doc.text(money(summary.total_cost), cols[7][1] + 2, y + 5, {
    width: cols[7][2] - 4,
    lineBreak: false,
  });

  doc
    .fillColor("#9ca3af")
    .fontSize(7)
    .font("Helvetica")
    .text(
      `Generated by TAMS · ${new Date().toLocaleString("en-GB")}`,
      M,
      y + 28,
      {
        align: "center",
        width: pageW,
      },
    );

  doc.end();
};

module.exports = {
  generatePDFReport,
  generateExcelReport,
  generateCustomerStatementPDF,
  generateGroupBookingPDF,
  generateAirlinePDF,
};
