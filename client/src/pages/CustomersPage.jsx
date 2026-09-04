import React, { useState, useEffect, useCallback } from "react";
import { customersAPI, ticketsAPI, downloadBlob, visasAPI, packagesAPI, fileUrl } from "../services/api";
import { useAuth } from "../context/AuthContext";
import {
  Button,
  Card,
  Spinner,
  EmptyState,
  Pagination,
  Input,
  Modal,
  Badge,
  RowsPerPage,
  Select,
} from "../components/ui";
import toast from "react-hot-toast";
import {
  Users,
  Search,
  Eye,
  Pencil,
  Trash2,
  Ticket,
  FileText,
  Printer,
  Download,
  Banknote,
  Wallet,
  Stamp,
  Luggage,
  Plus,
  PiggyBank,
} from "lucide-react";
import { format } from "date-fns";
import { fmtDate } from "../utils/date";
import AccountSelect, { refreshAccounts } from "../components/AccountSelect";
// The invoice stylesheet, paper sizes and print plumbing are shared with
// the cargo receipt, so the two documents stay the same document.
import {
  INV_CSS,
  PAPER_CSS,
  DISC_ICONS,
  esc,
  wirePrintWindow,
} from "../utils/invoice";
import ActionsMenu from "../components/ActionsMenu";

const money = (v) => `$${Number(v || 0).toFixed(2)}`;
const payBadge = { paid: "success", partial: "warning", unpaid: "danger" };

// ─── Printable invoice ───────────────────────────────────────────────────────
//
// Deliberately a near-copy of the PDF in services/reportService.js: same
// palette, same order, same wording, same proportions. A customer who is
// handed the printed page and later receives the PDF must be looking at the
// same document, or the two become "the invoice" and "the other invoice" and
// someone has to reconcile them.

/** Initials for the lettermark used when no image has been uploaded. */
const brandInitials = (name) => {
  const parts = String(name || "")
    .replace(/[^A-Za-z ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.length
    ? parts.slice(0, 2).map((w) => w[0]).join("").toUpperCase()
    : "TA";
};

/** Same derivation as the server's, so both documents quote one number. */
const invoiceNumber = (customer) => {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  const tail =
    String(customer?.id || "").replace(/-/g, "").slice(-5).toUpperCase() || "00000";
  return `INV-${ymd}-${tail}`;
};

/**
 * Tickets, visas and packages as one list of billed services — the same
 * shape the PDF builds, for the same reason: a customer bought services
 * from one agency and expects one bill that adds up.
 */
const invoiceLines = (data) => {
  const out = [];
  (data.tickets || []).forEach((t) =>
    out.push({
      who: t.passenger_name + (t.is_self === false ? " *" : ""),
      // A colon rather than an em dash, matching the PDF: the dash and its
      // two spaces were the difference between a round trip reading
      // "Mogadishu to Dubai (return)" and losing its last three letters.
      service: `Air Ticket: ${t.from_city} to ${t.to_city}${
        t.trip_type === "round_trip" ? " (return)" : ""
      }`,
      reference: t.ticket_reference,
      date: t.flight_date,
      total: t.selling_price,
      balance: t.balance,
    }),
  );
  (data.visas || []).forEach((v) =>
    out.push({
      who: v.applicant_name,
      service: `Visa Service: ${v.destination_country}${v.visa_type ? `, ${v.visa_type}` : ""}`,
      reference: v.reference,
      date: v.applied_date,
      total: v.selling_price,
      balance: v.balance,
    }),
  );
  (data.packages || []).forEach((p) =>
    out.push({
      who: p.lead_name || p.label,
      service: `${String(p.package_type || "package").toUpperCase()} Package: ${p.label}`,
      reference: p.pilgrim_count ? `${p.pilgrim_count} traveller(s)` : null,
      date: p.departure_date,
      total: p.selling_price,
      balance: p.balance,
    }),
  );
  return out;
};

const printStatement = (data, preparedBy, paper = "A4") => {
  const { customer, payments = [], summary } = data;
  const business = data.business || {};
  const methods = data.payment_methods || [];
  const lines = invoiceLines(data);
  const balanceDue = Number(summary.total_balance) || 0;

  // Money the agency is holding that this invoice has not spent yet. The
  // part already spent is not added anywhere here — it is inside RECEIVED
  // already, through the payment row the application wrote on the booking.
  const held = Number(summary.deposit_held ?? data.deposit?.held) || 0;
  const netDue = Number(summary.net_due ?? balanceDue - held) || 0;
  const hasDeposit = held > 0.001 || Number(summary.deposit_taken) > 0.001;

  // "Paid" means nothing left to find, so a balance covered by a deposit
  // counts: the money is already in the agency's hands.
  const settled = netDue <= 0.001;
  const inCredit = netDue < -0.001;

  const brand = business.logo_url
    ? `<img src="${esc(fileUrl(business.logo_url))}" alt="" />`
    : `<div class="mark">${esc(brandInitials(business.name))}</div>`;

  // Two-tone: the first word carries the brand colour, the rest is near
  // black. A cheap effect that reads as deliberate, which a single flat
  // colour at this size does not.
  const agencyName = String(business.name || "TAMS").trim();
  const cut = agencyName.indexOf(" ");
  const nameHead = cut === -1 ? agencyName : agencyName.slice(0, cut);
  const nameTail = cut === -1 ? "" : agencyName.slice(cut);

  const rows = lines
    .map(
      (r, i) => `<tr>
        <td>${i + 1}</td>
        <td class="who">${esc(r.who)}</td>
        <td>${esc(r.service)}</td>
        <td>${esc(r.reference || "—")}</td>
        <td>${esc(fmtDate(r.date))}</td>
        <td class="num">${money(r.total)}</td>
        <td class="num ${Number(r.balance) > 0.001 ? "owing" : "clear"}">${money(r.balance)}</td>
      </tr>`,
    )
    .join("");

  const shown = payments.slice(0, 8);
  const receipts = shown.length
    ? `<div class="rh"><span>RECEIPTS</span>${
        payments.length > shown.length
          ? `<span style="font-weight:normal;color:#64748B">showing ${shown.length} of ${payments.length}</span>`
          : ""
      }</div>
       <table>${shown
         .map(
           (p) => `<tr>
             <td style="width:62px">${esc(fmtDate(p.created_at))}</td>
             <td>${esc(p.passenger_name || "—")}</td>
             <td style="width:74px;color:#64748B">${esc(p.account_name || p.method || "—")}</td>
             <td style="width:56px;text-align:right;font-weight:bold;color:${
               Number(p.amount) < 0 ? "var(--red)" : "var(--green)"
             }">${money(p.amount)}</td>
           </tr>`,
         )
         .join("")}</table>`
    : `<div class="empty"><b>No receipts recorded yet</b>
         Payments appear here as soon as they are collected.</div>`;

  const methodCards = methods
    .map((m) => {
      const panel = m.icon_url
        ? `<img src="${esc(fileUrl(m.icon_url))}" alt="" />`
        : `<span class="ini">${esc(brandInitials(m.name))}</span>`;
      // The holder only. Repeating the bank's name under its own logo said
      // the same thing twice and cost a third line of height for it.
      const sub = m.account_holder || "";
      return `<div class="method">
        <div class="panel">${panel}</div>
        <div class="body">
          <div class="num">${esc(m.account_number || m.name)}</div>
          ${sub ? `<div class="hold">${esc(sub)}</div>` : ""}
        </div>
      </div>`;
    })
    .join("");

  const contacts = [
    ["phone", "Call", business.phone],
    ["pin", "Visit", business.address],
    ["mail", "Online", [business.email, business.website].filter(Boolean).join("  ·  ")],
  ].filter(([, , v]) => v);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <title>Invoice — ${esc(customer.name)}</title>
    <style>${INV_CSS}</style>
    <style id="paper">${PAPER_CSS[paper] || PAPER_CSS.A4}</style></head><body>

    <div class="bar">
      <span>Paper</span>
      <button type="button" id="p-a4" class="on">A4</button>
      <button type="button" id="p-a5">A5</button>
      <button type="button" id="p-go" class="go">Print</button>
    </div>

    <div class="band">
      <div class="brand">${brand}</div>
      <div class="agency"><div class="nm"><span class="a">${esc(nameHead)}</span><span class="b">${esc(nameTail)}</span></div></div>
      <div class="slash soft"></div>
      <div class="slash"></div>
      <div class="stamp"><span>INVOICE</span></div>
    </div>
    <div class="rule"></div>

    <div class="cols">
      <div>
        <div class="hwrap"><h2>Invoice To</h2></div>
        <div class="kv"><b>Display Name:</b> ${esc(customer.company_name || customer.name)}</div>
        <div class="kv"><b>Full Name:</b> ${esc(customer.name)}</div>
        ${customer.phone ? `<div class="kv"><b>Contact:</b> ${esc(customer.phone)}</div>` : ""}
        ${customer.email ? `<div class="kv"><b>Email:</b> ${esc(customer.email)}</div>` : ""}
        ${customer.passport_number ? `<div class="kv"><b>Passport:</b> ${esc(customer.passport_number)}</div>` : ""}
      </div>
      <div class="right">
        <div class="hwrap"><h2>Invoice Information</h2></div>
        <div class="kv"><b>Invoice No:</b> ${esc(invoiceNumber(customer))}</div>
        <div class="kv"><b>Issued:</b> ${esc(fmtDate(new Date()))}</div>
        <div class="kv"><b>Services:</b> ${lines.length} item${lines.length === 1 ? "" : "s"}</div>
        ${
          held > 0.001
            ? `<div class="kv"><b>On Deposit:</b> <span style="font-weight:bold;color:var(--green)">${money(held)}</span></div>`
            : ""
        }
        <div class="kv"><b>Balance:</b> <span style="font-weight:bold;color:${
          settled ? "var(--green)" : "var(--red)"
        }">${money(Math.max(netDue, 0))} · ${
          inCredit ? "IN CREDIT" : settled ? "PAID" : "UNPAID"
        }</span></div>
      </div>
    </div>

    <div style="margin-top:15px" class="hwrap"><h2>Service Costs</h2></div>
    <div class="tablewrap">
      <table>
        <!-- Proportions, not pixels: the same column ratios the PDF uses, so
             the two documents line up whatever width the paper gives them. -->
        <colgroup>
          <col style="width:5.4%"><col style="width:19.8%"><col style="width:28%">
          <col style="width:14.4%"><col style="width:12.4%"><col style="width:9.7%">
          <col style="width:10.3%">
        </colgroup>
        <thead><tr>
          <th>SN</th><th>Customer</th><th>Service</th><th>Reference</th>
          <th>Date</th><th style="text-align:right">Total</th><th style="text-align:right">Balance</th>
        </tr></thead>
        <tbody>${
          rows ||
          `<tr><td colspan="7" class="none">Nothing billed on this invoice.</td></tr>`
        }</tbody>
      </table>
    </div>

    <section class="panels">
      <div class="receipts">${receipts}</div>
      <div class="totals">
        <div><span class="l">SALES</span><span class="v">${money(summary.total_amount)}</span></div>
        <div><span class="l">RECEIVED</span><span class="v">${money(summary.total_paid)}</span></div>
        ${
          // Without a deposit the panel stays the three rows it has always
          // been. With one, the balance stops being the last word: the
          // deposit is subtracted in front of the customer and the bottom
          // row is what they actually have to hand over.
          held > 0.001
            ? `<div><span class="l">BALANCE</span><span class="v">${money(balanceDue)}</span></div>
               <div class="credit"><span class="l">ON DEPOSIT</span><span class="v">−${money(held)}</span></div>
               <div class="strong"><span class="l">${
                 inCredit ? "IN CREDIT" : "NET DUE"
               }</span><span class="v">${money(Math.abs(netDue))}</span></div>`
            : `<div class="strong"><span class="l">BALANCE</span><span class="v">${money(balanceDue)}</span></div>`
        }
      </div>
    </section>

    ${
      hasDeposit
        ? `<div class="note"><b>Deposit:</b> ${money(summary.deposit_taken ?? data.deposit?.taken)} received,
             ${money(summary.deposit_applied ?? data.deposit?.applied)} already used on the services above,
             <b>${money(held)} still held</b> on this account.${
               inCredit
                 ? ` ${money(Math.abs(netDue))} of it is over and above what is owed.`
                 : ""
             }</div>`
        : ""
    }

    ${
      lines.some((r) => String(r.who).endsWith(" *"))
        ? '<div class="note">* booked by this customer for a family member or friend</div>'
        : ""
    }

    ${
      methodCards
        ? `<section style="margin-top:14px">
             <div class="hwrap"><h2>Payment Methods</h2></div>
             <div class="methods">${methodCards}</div>
           </section>`
        : ""
    }

    ${
      preparedBy
        ? `<section class="sign">
             <div class="n">${esc(preparedBy.name)},
               <span>${esc(
                 String(preparedBy.role || "")
                   .replace(/_/g, " ")
                   .replace(/\b\w/g, (c) => c.toUpperCase()),
               )}</span></div>
             <div class="d">${esc(
               new Date().toLocaleDateString("en-GB", {
                 weekday: "long",
                 day: "numeric",
                 month: "long",
                 year: "numeric",
               }),
             )}</div>
           </section>`
        : ""
    }

    <section class="foot">
      <div class="ty">Thank you for your business</div>
      <div class="fr"></div>
      <div class="fc">${contacts
        .map(
          ([glyph, l, v]) =>
            `<div><div class="disc">${DISC_ICONS[glyph]}</div>
               <div class="ft"><div class="fl">${l.toUpperCase()}</div><div class="fv">${esc(v)}</div></div>
             </div>`,
        )
        .join("")}</div>
      <div class="gen">generated ${esc(new Date().toLocaleString("en-GB"))}</div>
    </section>

    </body></html>`;

  const win = window.open("", "_blank");
  if (!win) return toast.error("Allow pop-ups to print the invoice");
  win.document.write(html);
  win.document.close();
  wirePrintWindow(win, paper);
};

/**
 * Narrow a statement to the ticked passengers, recomputing the totals so the
 * printed page never shows figures that disagree with its own rows.
 */
const filterStatement = (data, ticketIds, visaIds, packageIds) => {
  if (!data) return data;
  const allT = (data.tickets || []).length === ticketIds.length;
  const allV = (data.visas || []).length === (visaIds || []).length;
  const allP = (data.packages || []).length === (packageIds || []).length;
  if (allT && allV && allP) return data;

  const kT = new Set(ticketIds);
  const kV = new Set(visaIds || []);
  const kP = new Set(packageIds || []);

  const tickets = (data.tickets || []).filter((t) => kT.has(t.id));
  const visas = (data.visas || []).filter((v) => kV.has(v.id));
  const packages = (data.packages || []).filter((p) => kP.has(p.id));
  const payments = (data.payments || []).filter((p) => kT.has(p.ticket_id));

  const sum = (rows) =>
    rows.reduce(
      (a, r) => ({
        amount: a.amount + (parseFloat(r.selling_price) || 0),
        paid: a.paid + (parseFloat(r.amount_paid) || 0),
        balance: a.balance + (parseFloat(r.balance) || 0),
      }),
      { amount: 0, paid: 0, balance: 0 },
    );
  const t = sum(tickets), v = sum(visas), p = sum(packages);

  // The deposit is a fact about the customer, not about the rows that were
  // ticked, so it survives the filter untouched — but the net due has to be
  // recomputed, or a three-passenger invoice would carry the net figure for
  // all seven.
  const balance = t.balance + v.balance + p.balance;
  const held = Number(data.summary?.deposit_held ?? data.deposit?.held) || 0;

  return {
    ...data,
    tickets,
    visas,
    packages,
    payments,
    summary: {
      ...data.summary,
      ticket_count: tickets.length,
      visa_count: visas.length,
      package_count: packages.length,
      item_count: tickets.length + visas.length + packages.length,
      total_amount: (t.amount + v.amount + p.amount).toFixed(2),
      total_paid: (t.paid + v.paid + p.paid).toFixed(2),
      total_balance: balance.toFixed(2),
      net_due: (balance - held).toFixed(2),
    },
  };
};

// ─── Collect Payment (from statement) ────────────────────────────────────────
//
// A customer owing money on a visa or a Hajj package is owed-from in exactly
// the same way as one owing on a ticket, so the statement collects all three
// the same way. Previously only tickets could be settled here, which meant
// walking to another screen to take money the statement had just shown you.
const COLLECT = {
  ticket: {
    api: (id, body) => ticketsAPI.addPayment(id, body),
    title: (r) => r.passenger_name,
    subtitle: (r) => `${r.from_city} → ${r.to_city}`,
  },
  visa: {
    api: (id, body) => visasAPI.addPayment(id, body),
    title: (r) => r.applicant_name,
    subtitle: (r) => `${r.destination_country} visa`,
  },
  package: {
    api: (id, body) => packagesAPI.addPayment(id, body),
    title: (r) => r.label,
    subtitle: (r) => `${r.package_type} package`,
  },
};

function CollectForm({ target, onDone, onCancel }) {
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [saving, setSaving] = useState(false);

  const kind = COLLECT[target.kind] || COLLECT.ticket;
  const record = target.record;
  const balance = Number(record.balance) || 0;

  const submit = async (e) => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (!val || val <= 0) return toast.error("Enter a valid amount");
    if (val > balance + 0.001)
      return toast.error(`Amount exceeds balance (${money(balance)})`);
    setSaving(true);
    try {
      await kind.api(record.id, {
        amount: val,
        account_id: accountId || undefined,
      });
      toast.success(`${money(val)} collected from ${kind.title(record)}`);
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to collect payment");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-4 text-center">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {kind.title(record)} · {kind.subtitle(record)}
        </p>
        <p className="text-lg font-bold text-red-600 mt-1">
          Balance: {money(balance)}
        </p>
      </div>
      <Input
        label="Amount to collect *"
        type="number"
        min="0.01"
        step="0.01"
        max={balance}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder={balance.toFixed(2)}
        required
      />
      <AccountSelect
        direction="in"
        value={accountId}
        onChange={(e) => setAccountId(e.target.value)}
      />
      <div className="flex gap-3 justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          <Banknote className="w-4 h-4" />
          {saving ? "Collecting..." : "Collect"}
        </Button>
      </div>
    </form>
  );
}

// ─── Statement Modal ─────────────────────────────────────────────────────────
function StatementModal({
  data, downloading, paper, setPaper, onPrint, onDownload, onCollect,
  selectedIds, selectedVisaIds, selectedPackageIds,
  onToggle, onToggleVisa, onTogglePackage, onSelectAll, onClearAll,
}) {
  const { customer, tickets, payments, summary } = data;
  const visas = data.visas || [];
  const packages = data.packages || [];

  const totalItems = tickets.length + visas.length + packages.length;
  const totalSelected =
    selectedIds.length + selectedVisaIds.length + selectedPackageIds.length;
  const allSelected = totalItems > 0 && totalSelected === totalItems;
  const partial = totalSelected > 0 && !allSelected;

  // Totals follow the ticks, so the figures always match what will be sent
  const addUp = (rows, ids) =>
    rows
      .filter((r) => ids.includes(r.id))
      .reduce(
        (a, r) => ({
          total: a.total + (parseFloat(r.selling_price) || 0),
          paid: a.paid + (parseFloat(r.amount_paid) || 0),
          balance: a.balance + (parseFloat(r.balance) || 0),
        }),
        { total: 0, paid: 0, balance: 0 },
      );
  const st = addUp(tickets, selectedIds);
  const sv = addUp(visas, selectedVisaIds);
  const sp = addUp(packages, selectedPackageIds);
  const sel = {
    total: st.total + sv.total + sp.total,
    paid: st.paid + sv.paid + sp.paid,
    balance: st.balance + sv.balance + sp.balance,
  };

  // What the agency is holding for this customer. Shown here so the tiles
  // say the same thing the printed invoice will — a member of staff reading
  // "Balance 190" on screen and "Net due 0" on paper would rightly assume
  // one of them is lying.
  const held = Number(summary?.deposit_held ?? data.deposit?.held) || 0;
  const netDue = sel.balance - held;

  const tiles = [
    ["Items", totalSelected, ""],
    ["Total", money(sel.total), ""],
    ["Paid", money(sel.paid), "text-green-600"],
    ["Balance", money(sel.balance), "text-red-600"],
    ...(held > 0.001
      ? [
          ["On deposit", money(held), "text-green-600"],
          [
            netDue < -0.001 ? "In credit" : "Net due",
            money(Math.abs(netDue)),
            netDue > 0.001 ? "text-red-600" : "text-green-600",
          ],
        ]
      : []),
  ];

  return (
    <div className="space-y-5">
      {/* Actions */}
      <div className="flex gap-2 justify-end items-center flex-wrap">
        {partial && (
          <span className="text-xs font-medium text-blue-600 dark:text-blue-400 mr-auto">
            Invoicing {totalSelected} of {totalItems} items
          </span>
        )}
        {/* One choice, applied to both buttons. The printed page and the
            downloaded file are the same document, so asking twice which
            paper it is on would be asking the same question twice. */}
        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          Paper
          <select
            value={paper}
            onChange={(e) => setPaper(e.target.value)}
            className="px-2 py-1 rounded-lg border text-xs bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="A4">A4</option>
            <option value="A5">A5</option>
          </select>
        </label>
        <Button variant="outline" size="sm" onClick={onPrint} disabled={totalSelected === 0}>
          <Printer className="w-4 h-4" /> Print
        </Button>
        <Button size="sm" onClick={onDownload} disabled={downloading || totalSelected === 0}>
          <Download className="w-4 h-4" />
          {downloading ? "Preparing..." : "Download PDF"}
        </Button>
      </div>

      {/* Summary */}
      <div
        className={`grid gap-3 text-center ${
          tiles.length > 4 ? "grid-cols-3 sm:grid-cols-6" : "grid-cols-4"
        }`}
      >
        {tiles.map(([label, val, cls]) => (
          <div
            key={label}
            className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-3"
          >
            <p className="text-xs text-gray-500 uppercase tracking-wide">
              {label}
            </p>
            <p
              className={`text-lg font-bold text-gray-900 dark:text-white ${cls}`}
            >
              {val}
            </p>
          </div>
        ))}
      </div>

      {/* Tickets */}
      <div>
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
          <Ticket className="w-4 h-4" /> Flight tickets ({tickets.length})
        </h4>
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800">
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = partial; }}
                    onChange={(e) => (e.target.checked ? onSelectAll() : onClearAll())}
                    className="rounded cursor-pointer"
                    title="Select everything"
                  />
                </th>
                {[
                  "Passenger",
                  "Route",
                  "Flight",
                  "Booked",
                  "Total",
                  "Paid",
                  "Balance",
                  "Status",
                  "",
                ].map((h) => (
                  <th
                    key={h}
                    className="text-left px-3 py-2 text-gray-500 font-semibold uppercase tracking-wide"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/40">
              {tickets.map((t) => (
                <tr
                  key={t.id}
                  className={selectedIds.includes(t.id) ? "" : "opacity-45"}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(t.id)}
                      onChange={() => onToggle(t.id)}
                      className="rounded cursor-pointer"
                    />
                  </td>
                  <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                    {t.passenger_name}
                    {!t.is_self && (
                      <span className="text-blue-500" title="Booked for someone else"> *</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-500">
                    {t.from_city} → {t.to_city}
                    {t.trip_type === "round_trip" ? " ⇄" : ""}
                  </td>
                  <td className="px-3 py-2 text-gray-500">
                    {fmtDate(t.flight_date, "dd MMM yy")}
                    {t.return_date && (
                      <p className="text-gray-400">
                        ⇄ {fmtDate(t.return_date, "dd MMM yy")}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-500">
                    {fmtDate(t.booked_date, "dd MMM yy")}
                  </td>
                  <td className="px-3 py-2">{money(t.selling_price)}</td>
                  <td className="px-3 py-2 text-green-600">
                    {money(t.amount_paid)}
                  </td>
                  <td className="px-3 py-2 font-semibold text-red-600">
                    {money(t.balance)}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={payBadge[t.payment_status] || "danger"}>
                      {t.payment_status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {Number(t.balance) > 0 && t.status === "active" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onCollect(t)}
                        title="Collect payment"
                        className="text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20"
                      >
                        <Banknote className="w-4 h-4" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {tickets.some((t) => !t.is_self) && (
          <p className="text-xs text-gray-400 mt-1">
            * booked by {customer.name} for a family member / friend
          </p>
        )}
      </div>

      {/* Visa services */}
      {visas.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
            <Stamp className="w-4 h-4" /> Visa services ({visas.length})
          </h4>
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800">
                  <th className="px-3 py-2 w-8"></th>
                  {["Applicant", "Country", "Type", "Applied", "Status", "Total", "Paid", "Balance", ""].map((h, hi) => (
                    <th key={h || hi} className="text-left px-3 py-2 text-gray-500 font-semibold uppercase tracking-wide">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/40">
                {visas.map((v) => (
                  <tr key={v.id} className={selectedVisaIds.includes(v.id) ? "" : "opacity-45"}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedVisaIds.includes(v.id)}
                        onChange={() => onToggleVisa(v.id)}
                        className="rounded cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{v.applicant_name}</td>
                    <td className="px-3 py-2 text-gray-500">{v.destination_country}</td>
                    <td className="px-3 py-2 text-gray-500">{v.visa_type || "—"}</td>
                    <td className="px-3 py-2 text-gray-500">{fmtDate(v.applied_date, "dd MMM yy")}</td>
                    <td className="px-3 py-2">
                      <Badge variant={v.status === "collected" ? "purple" : v.status === "approved" ? "success" : "info"}>
                        {v.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">{money(v.selling_price)}</td>
                    <td className="px-3 py-2 text-green-600">{money(v.amount_paid)}</td>
                    <td className={`px-3 py-2 font-semibold ${Number(v.balance) > 0 ? "text-red-600" : "text-gray-400"}`}>
                      {money(v.balance)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {Number(v.balance) > 0 && onCollect && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onCollect(v, "visa")}
                          title="Collect payment"
                          className="text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20"
                        >
                          <Banknote className="w-4 h-4" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Hajj & Umrah packages */}
      {packages.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
            <Luggage className="w-4 h-4" /> Hajj &amp; Umrah packages ({packages.length})
          </h4>
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800">
                  <th className="px-3 py-2 w-8"></th>
                  {["Package", "Type", "Pax", "Departs", "Status", "Total", "Paid", "Balance", ""].map((h, hi) => (
                    <th key={h || hi} className="text-left px-3 py-2 text-gray-500 font-semibold uppercase tracking-wide">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/40">
                {packages.map((p) => (
                  <tr key={p.id} className={selectedPackageIds.includes(p.id) ? "" : "opacity-45"}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedPackageIds.includes(p.id)}
                        onChange={() => onTogglePackage(p.id)}
                        className="rounded cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{p.label}</td>
                    <td className="px-3 py-2">
                      <Badge variant={p.package_type === "hajj" ? "purple" : "success"}>
                        {p.package_type}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-gray-500">{p.pilgrim_count}</td>
                    <td className="px-3 py-2 text-gray-500">{fmtDate(p.departure_date, "dd MMM yy")}</td>
                    <td className="px-3 py-2 text-gray-500">{p.status}</td>
                    <td className="px-3 py-2">{money(p.selling_price)}</td>
                    <td className="px-3 py-2 text-green-600">{money(p.amount_paid)}</td>
                    <td className={`px-3 py-2 font-semibold ${Number(p.balance) > 0 ? "text-red-600" : "text-gray-400"}`}>
                      {money(p.balance)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {Number(p.balance) > 0 && onCollect && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onCollect(p, "package")}
                          title="Collect payment"
                          className="text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20"
                        >
                          <Banknote className="w-4 h-4" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Payments */}
      {payments.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
            <Banknote className="w-4 h-4 text-green-600" /> Payment History (
            {payments.length})
          </h4>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {payments.map((p, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center justify-between gap-3 text-sm py-1.5 px-3 bg-green-50 dark:bg-green-900/10 rounded-lg"
              >
                <div>
                  <span className="font-semibold text-green-700 dark:text-green-400">
                    {money(p.amount)}
                  </span>
                  <span className="text-xs text-gray-500 ml-2">
                    {p.passenger_name} · {p.account_name || p.method}
                  </span>
                </div>
                <div className="text-right text-xs text-gray-500">
                  <p>{p.collected_by_name}</p>
                  <p>{fmtDate(p.created_at, "dd MMM yyyy HH:mm")}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Add a customer, before there is anything to sell them ────────────────
//
// A customer used to exist only as a by-product of a booking, so putting a
// walk-in on file meant inventing a ticket and deleting it afterwards.
const EMPTY_CUSTOMER = {
  name: "",
  phone: "",
  email: "",
  passport_number: "",
  nationality: "",
  customer_type: "individual",
  company_name: "",
};

function AddCustomerModal({ open, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY_CUSTOMER);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Blank on every open, so the last person's details are never sitting in
  // the boxes when the next one walks in. EMPTY_CUSTOMER lives outside the
  // component: rebuilt on each render it would be a new object every time,
  // which is a dependency that can never settle.
  useEffect(() => {
    if (open) setForm(EMPTY_CUSTOMER);
  }, [open]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return toast.error("Enter a name");
    setSaving(true);
    try {
      const res = await customersAPI.create(form);
      toast.success(res.data.message || "Customer added");
      onSaved?.();
      onClose();
    } catch (err) {
      // The 409 here is the duplicate-phone guard, and its message names the
      // person already on file — far more use than "already exists".
      toast.error(err.response?.data?.message || "Could not add the customer");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add customer">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Full name *" value={form.name} onChange={set("name")} />
          <Input
            label="Phone"
            value={form.phone}
            onChange={set("phone")}
            placeholder="0618344223"
            hint="Used to find them later, and to spot duplicates"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Email" type="email" value={form.email} onChange={set("email")} />
          <Input
            label="Passport number"
            value={form.passport_number}
            onChange={set("passport_number")}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Nationality" value={form.nationality} onChange={set("nationality")} />
          <Select label="Type" value={form.customer_type} onChange={set("customer_type")}>
            <option value="individual">Individual</option>
            <option value="company">Company</option>
          </Select>
        </div>
        {form.customer_type === "company" && (
          <Input label="Company name" value={form.company_name} onChange={set("company_name")} />
        )}
        <div className="flex gap-3 justify-end pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            <Plus className="w-4 h-4" /> Add customer
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Money taken with nothing booked ──────────────────────────────────────
//
// This is not income. The agency has not earned it and may have to hand it
// back, so it is recorded as a deposit — cash in the account and a debt on
// the balance sheet — rather than as a payment against some unrelated
// booking, which was the only thing possible before and made that booking's
// balance wrong.
function DepositModal({ customer, onClose, onDone }) {
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [note, setNote] = useState("");
  const [held, setHeld] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!customer) return;
    setAmount("");
    setAccountId("");
    setNote("");
    customersAPI
      .deposits(customer.id)
      .then((r) => setHeld(r.data.data))
      .catch(() => setHeld(null));
  }, [customer]);

  const submit = async (e) => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (!val) return toast.error("Enter an amount");
    setSaving(true);
    try {
      const res = await customersAPI.deposit(customer.id, {
        amount: val,
        account_id: accountId || undefined,
        note: note || undefined,
      });
      toast.success(res.data.message);
      refreshAccounts();
      onDone?.();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || "Could not record it");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={Boolean(customer)}
      onClose={onClose}
      title={customer ? `Hold money for ${customer.name}` : ""}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-3">
          <p className="text-sm text-blue-900 dark:text-blue-100">
            Money taken before anything is booked. It goes into the account
            you choose, and shows on the balance sheet as money owed back
            until it is used or returned — it is not counted as income.
          </p>
          {held && (
            <p className="text-xs text-blue-800 dark:text-blue-200 mt-1.5">
              Currently holding{" "}
              <strong>${Number(held.balance || 0).toFixed(2)}</strong> for this
              customer.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Amount"
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="300.00"
            hint="A negative amount hands money back"
          />
          <AccountSelect
            direction={parseFloat(amount) < 0 ? "out" : "in"}
            label={parseFloat(amount) < 0 ? "Returned from *" : "Received into *"}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          />
        </div>

        <Input
          label="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Deposit for Umrah in Ramadan"
        />

        <div className="flex gap-3 justify-end pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            <PiggyBank className="w-4 h-4" /> Record
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function CustomersPage() {
  const { isAdmin, canWrite, user } = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  // Which customer we're taking money from with nothing booked yet.
  const [depositFor, setDepositFor] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [onlyDue, setOnlyDue] = useState(false);
  const [sort, setSort] = useState("recent");
  const [viewModal, setViewModal] = useState(null);
  const [viewData, setViewData] = useState(null);
  const [viewDeposit, setViewDeposit] = useState(null);
  const [applying, setApplying] = useState(null);

  /**
   * Spend the customer's deposit on one of their bookings.
   *
   * No cash moves — the money arrived when the deposit was taken and is
   * already in an account. What changes is that the agency stops owing it
   * and the booking stops being unpaid. The server applies the smaller of
   * what is held and what is owed, so this can never overpay.
   */
  const useDepositOn = async (kind, recordId) => {
    if (!viewModal) return;
    setApplying(recordId);
    try {
      const res = await customersAPI.applyDeposit(viewModal.id, {
        kind,
        record_id: recordId,
      });
      toast.success(res.data.message);
      await openView(viewModal);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || "Could not use the deposit");
    } finally {
      setApplying(null);
    }
  };
  const [viewLoading, setViewLoading] = useState(false);
  const [stmtModal, setStmtModal] = useState(null);
  const [stmtData, setStmtData] = useState(null);
  const [stmtLoading, setStmtLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // A4 or A5, shared by the Print button and the PDF download.
  const [paper, setPaper] = useState("A4");
  // What the user clicked Collect on: { kind: 'ticket'|'visa'|'package', record }
  const [collectTarget, setCollectTarget] = useState(null);
  // What goes on the statement. Everything is selected by default.
  const [selectedTicketIds, setSelectedTicketIds] = useState([]);
  const [selectedVisaIds, setSelectedVisaIds] = useState([]);
  const [selectedPackageIds, setSelectedPackageIds] = useState([]);

  const openStatement = async (customer) => {
    setStmtModal(customer);
    setStmtData(null);
    setStmtLoading(true);
    try {
      const res = await customersAPI.statement(customer.id);
      const d = res.data.data;
      setStmtData(d);
      setSelectedTicketIds((d.tickets || []).map((t) => t.id));
      setSelectedVisaIds((d.visas || []).map((v) => v.id));
      setSelectedPackageIds((d.packages || []).map((p) => p.id));
    } catch {
      toast.error("Failed to load statement");
      setStmtModal(null);
    } finally {
      setStmtLoading(false);
    }
  };

  const downloadStatementPDF = async (customer) => {
    setDownloading(true);
    try {
      const all =
        !stmtData ||
        (selectedTicketIds.length === (stmtData.tickets || []).length &&
          selectedVisaIds.length === (stmtData.visas || []).length &&
          selectedPackageIds.length === (stmtData.packages || []).length);
      const res = await customersAPI.statementPDF(
        customer.id,
        all
          ? undefined
          : {
              ticket_ids: selectedTicketIds,
              visa_ids: selectedVisaIds,
              package_ids: selectedPackageIds,
            },
        paper,
      );
      downloadBlob(
        res.data,
        `invoice-${customer.name.replace(/\s+/g, "-").toLowerCase()}${
          all ? "" : "-partial"
        }-${paper.toLowerCase()}.pdf`,
      );
    } catch {
      toast.error("Failed to download PDF");
    } finally {
      setDownloading(false);
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    customersAPI
      .list({ page, limit, search, only_due: onlyDue, sort })
      .then((res) => {
        setCustomers(res.data.data);
        setMeta(res.data.meta);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page, limit, search, onlyDue, sort]);

  useEffect(() => {
    load();
  }, [load]);

  const openView = async (customer) => {
    setViewModal(customer);
    setViewLoading(true);
    try {
      const res = await customersAPI.get(customer.id);
      setViewData(res.data.data);
      // What is being held for them, and what it has already paid for. A
      // deposit the customer can see on their receipt but not on their
      // profile is a support call waiting to happen.
      customersAPI
        .deposits(customer.id)
        .then((d) => setViewDeposit(d.data.data))
        .catch(() => setViewDeposit(null));
    } catch {
      toast.error("Failed to load customer details");
    } finally {
      setViewLoading(false);
    }
  };

  const handleDelete = async (customer) => {
    if (
      !window.confirm(
        `Delete ${customer.name}? This won't delete their tickets.`,
      )
    )
      return;
    try {
      await customersAPI.delete(customer.id);
      toast.success("Customer deleted");
      load();
    } catch {
      toast.error("Failed to delete customer");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Customers
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {meta.total} passenger profiles
            {meta.customers_owing > 0 && (
              <>
                {" · "}
                <span className="text-red-600 dark:text-red-400 font-medium">
                  {meta.customers_owing} owing ${meta.total_outstanding}
                </span>
              </>
            )}
          </p>
        </div>
        {canWrite() && (
          <div className="flex gap-2">
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="w-4 h-4" /> Add customer
            </Button>
          </div>
        )}
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex-1 min-w-48">
            <Input
              placeholder="Search by name, passport, or phone..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>

          <button
            onClick={() => {
              setOnlyDue((v) => !v);
              setPage(1);
            }}
            className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition ${
              onlyDue
                ? "bg-red-50 border-red-300 text-red-600 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400"
                : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            }`}
          >
            <Wallet className="w-4 h-4" />
            {onlyDue ? "Showing balance due only" : "Balance due only"}
          </button>

          <Select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
            }}
            className="w-44"
          >
            <option value="recent">Newest first</option>
            <option value="balance">Highest balance</option>
            <option value="name">Name A–Z</option>
          </Select>

          <RowsPerPage
            value={limit}
            onChange={(n) => {
              setLimit(n);
              setPage(1);
            }}
          />
        </div>
      </Card>

      <Card>
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner size="lg" />
          </div>
        ) : customers.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No customers yet"
            description="A customer is saved automatically whenever you book a ticket — or add one here first, which is what you want for a walk-in you expect to see again."
            action={
              canWrite() ? (
                <Button onClick={() => setAddOpen(true)}>
                  <Plus className="w-4 h-4" /> Add customer
                </Button>
              ) : null
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  {[
                    "Name",
                    "Phone",
                    "Tickets",
                    "Billed",
                    "Paid",
                    "Balance",
                    "Since",
                    "",
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {customers.map((c) => (
                  <tr
                    key={c.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                      {c.name}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {c.phone || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="info">
                        {c.ticket_count} ticket
                        {c.ticket_count !== "1" ? "s" : ""}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      ${Number(c.total_billed || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-green-600 dark:text-green-400 whitespace-nowrap">
                      ${Number(c.total_paid || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {Number(c.balance) > 0 ? (
                        <span className="font-semibold text-red-600 dark:text-red-400">
                          ${Number(c.balance).toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-gray-400">Settled</span>
                      )}
                      {/* Money the agency is holding for them, after
                          whatever has already been spent. Shown next to what
                          they owe because the two answer the same question
                          from opposite sides — someone owing $50 while $190
                          of their own money sits in the drawer is not a
                          customer to chase. */}
                      {Number(c.deposit_balance) > 0 && (
                        <span className="block text-xs text-blue-600 dark:text-blue-400 font-medium mt-0.5">
                          {money(c.deposit_balance)} on deposit
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                      {format(new Date(c.created_at), "dd MMM yyyy")}
                    </td>
                    <td className="px-4 py-3">
                      <ActionsMenu
                        items={[
                          { label: "View", icon: Eye, onClick: () => openView(c) },
                          // Available whatever the balance says. Taking a
                          // deposit from someone who owes nothing is the
                          // normal case, not the exception.
                          { label: "Hold money (deposit)", icon: PiggyBank, onClick: () => setDepositFor(c) },
                          { label: "Statement", icon: FileText, onClick: () => openStatement(c) },
                          isAdmin()
                            ? { label: "Delete", icon: Trash2, danger: true, onClick: () => handleDelete(c) }
                            : null,
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-4 pb-4">
          <Pagination
            page={page}
            totalPages={meta.totalPages}
            onChange={setPage}
          />
        </div>
      </Card>

      {/* Customer Detail Modal */}
      <Modal
        open={!!viewModal}
        onClose={() => {
          setViewModal(null);
          setViewData(null);
          setViewDeposit(null);
        }}
        title="Customer Profile"
        size="lg"
      >
        {viewLoading ? (
          <div className="flex justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : (
          viewData && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[
                  ["Name", viewData.customer.name],
                  ["Phone", viewData.customer.phone || "—"],
                  ["Passport", viewData.customer.passport_number || "—"],
                  [
                    "Date of Birth",
                    viewData.customer.date_of_birth
                      ? format(
                          new Date(viewData.customer.date_of_birth),
                          "dd MMM yyyy",
                        )
                      : "—",
                  ],
                  ["Nationality", viewData.customer.nationality || "—"],
                  ["Email", viewData.customer.email || "—"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {label}
                    </p>
                    <p className="font-medium text-gray-900 dark:text-white">
                      {value}
                    </p>
                  </div>
                ))}
              </div>

              {viewDeposit && Number(viewDeposit.balance) > 0 && (
                <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <p className="text-sm font-semibold text-blue-900 dark:text-blue-100 flex items-center gap-2">
                        <PiggyBank className="w-4 h-4" />
                        {money(viewDeposit.balance)} held on deposit
                      </p>
                      <p className="text-xs text-blue-800 dark:text-blue-200 mt-0.5">
                        Taken {money(viewDeposit.taken)} · used{" "}
                        {money(viewDeposit.applied)}. Use it on any unpaid
                        booking below — no money moves, the cash is already in
                        your account.
                      </p>
                    </div>
                  </div>
                  {viewDeposit.applications?.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {viewDeposit.applications.map((a) => (
                        <li
                          key={a.id}
                          className="text-xs text-blue-800 dark:text-blue-200"
                        >
                          {money(a.amount)} → {a.applied_to}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {[
                { key: "tickets", kind: "ticket", icon: Ticket, title: "Flights",
                  describe: (r) => `${r.from_city} → ${r.to_city}`,
                  detail: (r) => `${r.airline_name || "—"} · ${r.flight_date ? fmtDate(r.flight_date, "dd MMM yyyy") : "—"}` },
                { key: "visas", kind: "visa", icon: Stamp, title: "Visas",
                  describe: (r) => r.destination_country,
                  detail: (r) => r.visa_type || "—" },
                { key: "packages", kind: "package", icon: Luggage, title: "Packages",
                  describe: (r) => r.label,
                  detail: (r) => `${r.package_type || ""} · ${r.pilgrim_count || 1} pilgrim(s)` },
                { key: "cargo", kind: "cargo", icon: Luggage, title: "Cargo",
                  describe: (r) => r.tracking_number || r.item_description || "Shipment",
                  detail: (r) => `${r.from_city} → ${r.to_city}` },
              ].map((svc) => {
                const rows = viewData[svc.key] || [];
                if (rows.length === 0) return null;
                const Icon = svc.icon;
                return (
                  <div key={svc.key}>
                    <h4 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                      <Icon className="w-4 h-4" /> {svc.title} ({rows.length})
                    </h4>
                    <div className="space-y-2">
                      {rows.map((r) => {
                        const owing =
                          Math.round(
                            ((Number(r.selling_price) || 0) -
                              (Number(r.amount_paid) || 0)) * 100,
                          ) / 100;
                        return (
                          <div
                            key={r.id}
                            className="flex flex-wrap items-center justify-between gap-3 py-2 px-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
                          >
                            <div>
                              <p className="text-sm font-medium text-gray-900 dark:text-white">
                                {svc.describe(r)}
                              </p>
                              <p className="text-xs text-gray-500">{svc.detail(r)}</p>
                            </div>
                            <div className="flex items-center gap-3">
                              {/* Offered on whatever is unpaid, whichever
                                  service it is. A deposit that could only be
                                  spent on a flight was no use to someone who
                                  had paid ahead for a package. */}
                              {viewDeposit &&
                                Number(viewDeposit.balance) > 0 &&
                                r.status !== "cancelled" &&
                                owing > 0.001 && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    loading={applying === r.id}
                                    onClick={() => useDepositOn(svc.kind, r.id)}
                                  >
                                    <PiggyBank className="w-3.5 h-3.5" /> Use deposit
                                  </Button>
                                )}
                              <div className="text-right">
                                <p className="text-sm font-semibold text-gray-900 dark:text-white">
                                  {money(r.selling_price)}
                                </p>
                                <p
                                  className={`text-xs ${
                                    owing > 0 ? "text-red-500 font-medium" : "text-gray-400"
                                  }`}
                                >
                                  {owing > 0 ? `${money(owing)} due` : "paid"}
                                </p>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
      </Modal>

      {/* Statement Modal */}
      <Modal
        open={!!stmtModal}
        onClose={() => {
          setStmtModal(null);
          setStmtData(null);
        }}
        title={stmtModal ? `Statement — ${stmtModal.name}` : "Statement"}
        size="xl"
      >
        {stmtLoading || !stmtData ? (
          <div className="flex justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : (
          <StatementModal
            data={stmtData}
            downloading={downloading}
            paper={paper}
            setPaper={setPaper}
            selectedIds={selectedTicketIds}
            selectedVisaIds={selectedVisaIds}
            selectedPackageIds={selectedPackageIds}
            onToggle={(id) =>
              setSelectedTicketIds((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
              )
            }
            onToggleVisa={(id) =>
              setSelectedVisaIds((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
              )
            }
            onTogglePackage={(id) =>
              setSelectedPackageIds((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
              )
            }
            onSelectAll={() => {
              setSelectedTicketIds((stmtData.tickets || []).map((t) => t.id));
              setSelectedVisaIds((stmtData.visas || []).map((v) => v.id));
              setSelectedPackageIds((stmtData.packages || []).map((p) => p.id));
            }}
            onClearAll={() => {
              setSelectedTicketIds([]);
              setSelectedVisaIds([]);
              setSelectedPackageIds([]);
            }}
            onPrint={() =>
              printStatement(
                filterStatement(stmtData, selectedTicketIds, selectedVisaIds, selectedPackageIds),
                // The job title if they have one — a customer reading
                // "Operations Director" learns who signed their invoice;
                // "admin" tells them only what the software lets that person
                // click.
                user ? { name: user.name, role: user.title || user.role } : null,
                paper,
              )
            }
            onDownload={() => downloadStatementPDF(stmtModal)}
            onCollect={(record, kind = "ticket") => setCollectTarget({ kind, record })}
          />
        )}
      </Modal>

      {/* Collect Payment Modal */}
      <Modal
        open={!!collectTarget}
        onClose={() => setCollectTarget(null)}
        title="Collect Payment"
        size="md"
      >
        {collectTarget && (
          <CollectForm
            target={collectTarget}
            onDone={() => {
              setCollectTarget(null);
              if (stmtModal) openStatement(stmtModal); // refresh statement
              load(); // refresh counts
            }}
            onCancel={() => setCollectTarget(null)}
          />
        )}
      </Modal>
      <AddCustomerModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={load}
      />
      <DepositModal
        customer={depositFor}
        onClose={() => setDepositFor(null)}
        onDone={load}
      />

    </div>
  );
}
