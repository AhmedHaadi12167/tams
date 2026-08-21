const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
// v3: adds customer statement + group booking PDFs

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
 * Customer statement PDF (portrait A4 = 595 x 841)
 * Shows all tickets booked by / for the customer, payments, and balances.
 */
const generateCustomerStatementPDF = (res, data) => {
  const { customer, tickets, payments, summary } = data;
  const M = 50; // comfortable page margin
  const doc = new PDFDocument({ margin: M, size: "A4" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="statement-${(customer.name || "customer").replace(/[^a-z0-9]/gi, "-").toLowerCase()}.pdf"`,
  );
  doc.pipe(res);

  const pageW = 595 - M * 2; // 495 usable

  // Header
  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .fillColor("#111827")
    .text("Customer Statement", M, 44, { align: "center", width: pageW });
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#666666")
    .text(`Generated ${new Date().toLocaleString("en-GB")}`, M, 66, {
      align: "center",
      width: pageW,
    });

  // Customer info
  doc.fillColor("#111827").fontSize(10).font("Helvetica-Bold");
  doc.text(customer.company_name || customer.name, M, 96);
  doc.font("Helvetica").fontSize(9).fillColor("#444444");
  doc.text(
    [
      customer.phone ? `Phone: ${customer.phone}` : null,
      customer.email ? `Email: ${customer.email}` : null,
      customer.passport_number ? `Passport: ${customer.passport_number}` : null,
    ]
      .filter(Boolean)
      .join("   ·   ") || "—",
    M,
    110,
  );

  // Summary boxes
  const summaryY = 134;
  const boxW = (pageW - 30) / 4;
  const boxes = [
    ["Tickets", summary.ticket_count, "#1d4ed8"],
    ["Total Amount", money(summary.total_amount), "#1d4ed8"],
    ["Total Paid", money(summary.total_paid), "#15803d"],
    ["Balance Due", money(summary.total_balance), "#b91c1c"],
  ];
  boxes.forEach(([label, value, color], i) => {
    const bx = M + i * (boxW + 10);
    doc.rect(bx, summaryY, boxW, 38).fillAndStroke("#f8faff", "#c7d7ff");
    doc
      .fillColor(color)
      .fontSize(6.5)
      .font("Helvetica-Bold")
      .text(String(label).toUpperCase(), bx + 6, summaryY + 7, {
        width: boxW - 12,
      });
    doc
      .fillColor("#111827")
      .fontSize(12)
      .font("Helvetica-Bold")
      .text(String(value), bx + 6, summaryY + 18, { width: boxW - 12 });
  });

  // Tickets table
  doc
    .fillColor("#111827")
    .fontSize(11)
    .font("Helvetica-Bold")
    .text("Tickets", M, summaryY + 56);

  const cols = [
    ["#", M, 18],
    ["Passenger", 68, 95],
    ["Route", 163, 88],
    ["Flight", 251, 52],
    ["Booked", 303, 52],
    ["Total", 355, 48],
    ["Paid", 403, 48],
    ["Balance", 451, 48],
    ["Status", 499, 46],
  ];

  let y = drawTableHeader(doc, cols, summaryY + 72, pageW, M);
  tickets.forEach((t, i) => {
    if (y > 750) {
      doc.addPage();
      y = drawTableHeader(doc, cols, M, pageW, M);
    }
    if (i % 2 === 0) doc.rect(M, y - 2, pageW, 16).fill("#f8faff");

    const route =
      `${t.from_city} → ${t.to_city}` +
      (t.trip_type === "round_trip" ? " ⇄" : "");
    const row = [
      String(i + 1),
      trunc(t.passenger_name + (t.is_self ? "" : " *"), 17),
      trunc(route, 17),
      formatDate(t.flight_date),
      formatDate(t.booked_date),
      money(t.selling_price),
      money(t.amount_paid),
      money(t.balance),
      (t.payment_status || "unpaid").toUpperCase(),
    ];
    row.forEach((val, ci) => {
      const [, x, w] = cols[ci];
      doc.fillColor(ci === 8 ? statusColor(t.payment_status) : "#111827");
      doc.text(val, x + 2, y, { width: w - 4, lineBreak: false });
    });
    y += 16;
  });

  // Totals row
  doc.rect(M, y, pageW, 18).fill("#1d4ed8");
  doc.fillColor("#ffffff").fontSize(8).font("Helvetica-Bold");
  doc.text("TOTAL", 68, y + 5, { width: 95 });
  doc.text(money(summary.total_amount), 357, y + 5, { width: 44 });
  doc.text(money(summary.total_paid), 405, y + 5, { width: 44 });
  doc.text(money(summary.total_balance), 453, y + 5, { width: 44 });
  y += 26;

  if (tickets.some((t) => !t.is_self)) {
    doc
      .fillColor("#666666")
      .fontSize(7)
      .font("Helvetica")
      .text("* booked by this customer for a family member / friend", M, y);
    y += 16;
  }

  // Payment history
  if (payments.length > 0) {
    if (y > 690) {
      doc.addPage();
      y = M;
    }
    doc
      .fillColor("#111827")
      .fontSize(11)
      .font("Helvetica-Bold")
      .text("Payment History", M, y);
    y += 16;

    const pCols = [
      ["#", M, 18],
      ["Date", 68, 78],
      ["Passenger", 146, 122],
      ["Amount", 268, 58],
      ["Method", 326, 62],
      ["Collected By", 388, 157],
    ];
    y = drawTableHeader(doc, pCols, y, pageW, M);
    payments.forEach((p, i) => {
      if (y > 770) {
        doc.addPage();
        y = drawTableHeader(doc, pCols, M, pageW, M);
      }
      if (i % 2 === 0) doc.rect(M, y - 2, pageW, 16).fill("#f8faff");
      const row = [
        String(i + 1),
        formatDate(p.created_at),
        trunc(p.passenger_name, 24),
        money(p.amount),
        p.method || "cash",
        trunc(p.collected_by_name, 28),
      ];
      row.forEach((val, ci) => {
        const [, x, w] = pCols[ci];
        doc.fillColor(ci === 3 ? "#15803d" : "#111827");
        doc.text(val, x + 2, y, { width: w - 4, lineBreak: false });
      });
      y += 16;
    });
  }

  doc
    .fillColor("#666666")
    .fontSize(7)
    .text(`Generated by TAMS · ${new Date().toLocaleString("en-GB")}`, M, 790, {
      align: "center",
      width: pageW,
    });

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
      p.trip_type === "round_trip" && p.return_date
        ? `${flight} ⇄`
        : flight;

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
    .text(`Generated by TAMS · ${new Date().toLocaleString("en-GB")}`, M, y + 28, {
      align: "center",
      width: pageW,
    });

  doc.end();
};

module.exports = {
  generatePDFReport,
  generateExcelReport,
  generateCustomerStatementPDF,
  generateGroupBookingPDF,
  generateAirlinePDF,
};
