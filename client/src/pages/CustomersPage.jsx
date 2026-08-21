import React, { useState, useEffect, useCallback } from "react";
import { customersAPI, ticketsAPI, downloadBlob } from "../services/api";
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
} from "lucide-react";
import { format } from "date-fns";
import { fmtDate } from "../utils/date";

const money = (v) => `$${Number(v || 0).toFixed(2)}`;
const payBadge = { paid: "success", partial: "warning", unpaid: "danger" };

// ─── Printable statement (opens browser print dialog) ────────────────────────
const printStatement = (data) => {
  const { customer, tickets, payments, summary } = data;
  const visas = data.visas || [];
  const packages = data.packages || [];
  const rows = tickets
    .map(
      (t, i) => `<tr>
        <td>${i + 1}</td>
        <td>${t.passenger_name}${t.is_self ? "" : " *"}</td>
        <td>${t.from_city} → ${t.to_city}${t.trip_type === "round_trip" ? " ⇄" : ""}</td>
        <td>${fmtDate(t.flight_date)}${t.return_date ? "<br/>⇄ " + fmtDate(t.return_date) : ""}</td>
        <td>${fmtDate(t.booked_date)}</td>
        <td>${money(t.selling_price)}</td>
        <td>${money(t.amount_paid)}</td>
        <td>${money(t.balance)}</td>
        <td class="st-${t.payment_status}">${(t.payment_status || "unpaid").toUpperCase()}</td>
      </tr>`,
    )
    .join("");
  const payRows = payments
    .map(
      (p, i) => `<tr>
        <td>${i + 1}</td>
        <td>${fmtDate(p.created_at, "dd MMM yyyy HH:mm")}</td>
        <td>${p.passenger_name}</td>
        <td>${money(p.amount)}</td>
        <td>${p.method || "cash"}</td>
        <td>${p.collected_by_name}</td>
      </tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html><html><head><title>Statement — ${customer.name}</title>
    <style>
      body{font-family:Arial,sans-serif;margin:32px;color:#111}
      h1{font-size:20px;margin:0 0 4px;text-align:center}
      .sub{text-align:center;color:#666;font-size:12px;margin-bottom:16px}
      .info{font-size:13px;margin-bottom:16px}
      .boxes{display:flex;gap:10px;margin-bottom:20px}
      .box{flex:1;border:1px solid #c7d7ff;background:#f8faff;border-radius:8px;padding:10px}
      .box .l{font-size:10px;color:#1d4ed8;font-weight:bold;text-transform:uppercase}
      .box .v{font-size:18px;font-weight:bold}
      table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px}
      th{background:#1d4ed8;color:#fff;text-align:left;padding:6px}
      td{padding:6px;border-bottom:1px solid #e5e7eb}
      tr:nth-child(even) td{background:#f8faff}
      h2{font-size:14px}
      .st-paid{color:#15803d;font-weight:bold}.st-partial{color:#b45309;font-weight:bold}.st-unpaid{color:#b91c1c;font-weight:bold}
      .note{font-size:11px;color:#666}
      @media print{body{margin:12mm}}
    </style></head><body>
    <h1>Customer Statement</h1>
    <p class="sub">Generated ${new Date().toLocaleString("en-GB")}</p>
    <p class="info"><strong>${customer.company_name || customer.name}</strong>
      ${customer.phone ? " · Phone: " + customer.phone : ""}
      ${customer.email ? " · Email: " + customer.email : ""}
      ${customer.passport_number ? " · Passport: " + customer.passport_number : ""}</p>
    <div class="boxes">
      <div class="box"><div class="l">Items</div><div class="v">${summary.item_count ?? summary.ticket_count}</div>
        <div style="font-size:9px;color:#666">${summary.ticket_count} tickets · ${summary.visa_count || 0} visas · ${summary.package_count || 0} packages</div></div>
      <div class="box"><div class="l">Total Amount</div><div class="v">${money(summary.total_amount)}</div></div>
      <div class="box"><div class="l">Total Paid</div><div class="v" style="color:#15803d">${money(summary.total_paid)}</div></div>
      <div class="box"><div class="l">Balance Due</div><div class="v" style="color:#b91c1c">${money(summary.total_balance)}</div></div>
    </div>
    <h2>Flight Tickets</h2>
    <table><thead><tr><th>#</th><th>Passenger</th><th>Route</th><th>Flight</th><th>Booked</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${
      tickets.some((t) => !t.is_self)
        ? '<p class="note">* booked by this customer for a family member / friend &nbsp;·&nbsp; ⇄ round trip</p>'
        : '<p class="note">⇄ round trip</p>'
    }
    ${
      visas.length
        ? `<h2>Visa Services</h2>
    <table><thead><tr><th>#</th><th>Applicant</th><th>Country</th><th>Type</th><th>Applied</th><th>Status</th><th>Total</th><th>Paid</th><th>Balance</th></tr></thead>
    <tbody>${visas
      .map((v, i) => `<tr>
        <td>${i + 1}</td><td>${v.applicant_name}</td><td>${v.destination_country}</td>
        <td>${v.visa_type || "—"}</td><td>${fmtDate(v.applied_date)}</td>
        <td>${String(v.status || "").toUpperCase()}</td>
        <td>${money(v.selling_price)}</td><td>${money(v.amount_paid)}</td>
        <td>${money(v.balance)}</td></tr>`)
      .join("")}</tbody></table>`
        : ""
    }
    ${
      packages.length
        ? `<h2>Hajj &amp; Umrah Packages</h2>
    <table><thead><tr><th>#</th><th>Package</th><th>Type</th><th>Travellers</th><th>Departs</th><th>Status</th><th>Total</th><th>Paid</th><th>Balance</th></tr></thead>
    <tbody>${packages
      .map((p, i) => `<tr>
        <td>${i + 1}</td><td>${p.label}</td><td>${String(p.package_type || "").toUpperCase()}</td>
        <td>${p.pilgrim_count}</td><td>${fmtDate(p.departure_date)}</td>
        <td>${String(p.status || "").toUpperCase()}</td>
        <td>${money(p.selling_price)}</td><td>${money(p.amount_paid)}</td>
        <td>${money(p.balance)}</td></tr>`)
      .join("")}</tbody></table>`
        : ""
    }
    ${
      payments.length
        ? `<h2>Payment History</h2>
    <table><thead><tr><th>#</th><th>Date</th><th>Passenger</th><th>Amount</th><th>Method</th><th>Collected By</th></tr></thead>
    <tbody>${payRows}</tbody></table>`
        : ""
    }
    <script>window.onload=function(){window.print()}</script>
    </body></html>`;

  const win = window.open("", "_blank");
  if (!win) return toast.error("Allow pop-ups to print the statement");
  win.document.write(html);
  win.document.close();
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

  return {
    ...data,
    tickets,
    visas,
    packages,
    payments,
    summary: {
      ticket_count: tickets.length,
      visa_count: visas.length,
      package_count: packages.length,
      item_count: tickets.length + visas.length + packages.length,
      total_amount: (t.amount + v.amount + p.amount).toFixed(2),
      total_paid: (t.paid + v.paid + p.paid).toFixed(2),
      total_balance: (t.balance + v.balance + p.balance).toFixed(2),
    },
  };
};

// ─── Collect Payment (from statement) ────────────────────────────────────────
function CollectForm({ ticket, onDone, onCancel }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [saving, setSaving] = useState(false);
  const balance = Number(ticket.balance) || 0;

  const submit = async (e) => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (!val || val <= 0) return toast.error("Enter a valid amount");
    if (val > balance + 0.001)
      return toast.error(`Amount exceeds balance (${money(balance)})`);
    setSaving(true);
    try {
      await ticketsAPI.addPayment(ticket.id, { amount: val, method });
      toast.success(`${money(val)} collected from ${ticket.passenger_name}`);
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
          {ticket.passenger_name} · {ticket.from_city} → {ticket.to_city}
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
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Method
        </label>
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
        >
          <option value="cash">Cash</option>
          <option value="evc">EVC Plus</option>
          <option value="edahab">eDahab</option>
          <option value="bank">Bank transfer</option>
          <option value="other">Other</option>
        </select>
      </div>
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
  data, downloading, onPrint, onDownload, onCollect,
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

  return (
    <div className="space-y-5">
      {/* Actions */}
      <div className="flex gap-2 justify-end items-center flex-wrap">
        {partial && (
          <span className="text-xs font-medium text-blue-600 dark:text-blue-400 mr-auto">
            Invoicing {totalSelected} of {totalItems} items
          </span>
        )}
        <Button variant="outline" size="sm" onClick={onPrint} disabled={totalSelected === 0}>
          <Printer className="w-4 h-4" /> Print
        </Button>
        <Button size="sm" onClick={onDownload} disabled={downloading || totalSelected === 0}>
          <Download className="w-4 h-4" />
          {downloading ? "Preparing..." : "Download PDF"}
        </Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-3 text-center">
        {[
          ["Items", totalSelected, ""],
          ["Total", money(sel.total), ""],
          ["Paid", money(sel.paid), "text-green-600"],
          ["Balance", money(sel.balance), "text-red-600"],
        ].map(([label, val, cls]) => (
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
                  {["Applicant", "Country", "Type", "Applied", "Status", "Total", "Paid", "Balance"].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-gray-500 font-semibold uppercase tracking-wide">
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
                  {["Package", "Type", "Pax", "Departs", "Status", "Total", "Paid", "Balance"].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-gray-500 font-semibold uppercase tracking-wide">
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
                className="flex items-center justify-between text-sm py-1.5 px-3 bg-green-50 dark:bg-green-900/10 rounded-lg"
              >
                <div>
                  <span className="font-semibold text-green-700 dark:text-green-400">
                    {money(p.amount)}
                  </span>
                  <span className="text-xs text-gray-500 ml-2">
                    {p.passenger_name} · {p.method}
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

export default function CustomersPage() {
  const { isAdmin } = useAuth();
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
  const [viewLoading, setViewLoading] = useState(false);
  const [stmtModal, setStmtModal] = useState(null);
  const [stmtData, setStmtData] = useState(null);
  const [stmtLoading, setStmtLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [collectTicket, setCollectTicket] = useState(null);
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
      );
      downloadBlob(
        res.data,
        `statement-${customer.name.replace(/\s+/g, "-").toLowerCase()}${all ? "" : "-partial"}.pdf`,
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
      <div className="flex items-center justify-between">
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
            description="Customers are automatically saved when you create tickets."
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
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                      {format(new Date(c.created_at), "dd MMM yyyy")}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openView(c)}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openStatement(c)}
                          title="Statement (balance & payments)"
                          className="text-blue-500 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                        >
                          <FileText className="w-4 h-4" />
                        </Button>
                        {isAdmin() && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(c)}
                            className="text-red-500 hover:text-red-700 hover:bg-red-50"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
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
              <div className="grid grid-cols-2 gap-4">
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

              <div>
                <h4 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                  <Ticket className="w-4 h-4" /> Booking History (
                  {viewData.tickets.length})
                </h4>
                {viewData.tickets.length === 0 ? (
                  <p className="text-sm text-gray-400">No tickets yet</p>
                ) : (
                  <div className="space-y-2">
                    {viewData.tickets.map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
                      >
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-white">
                            {t.from_city} → {t.to_city}
                          </p>
                          <p className="text-xs text-gray-500">
                            {t.airline_name} ·{" "}
                            {t.flight_date
                              ? fmtDate(t.flight_date, "dd MMM yyyy")
                              : "—"}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-green-600">
                            ${Number(t.revenue).toFixed(2)}
                          </p>
                          <Badge
                            variant={
                              t.status === "active" ? "success" : "danger"
                            }
                            className="text-xs"
                          >
                            {t.status}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
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
              )
            }
            onDownload={() => downloadStatementPDF(stmtModal)}
            onCollect={(t) => setCollectTicket(t)}
          />
        )}
      </Modal>

      {/* Collect Payment Modal */}
      <Modal
        open={!!collectTicket}
        onClose={() => setCollectTicket(null)}
        title="Collect Payment"
        size="md"
      >
        {collectTicket && (
          <CollectForm
            ticket={collectTicket}
            onDone={() => {
              setCollectTicket(null);
              if (stmtModal) openStatement(stmtModal); // refresh statement
              load(); // refresh counts
            }}
            onCancel={() => setCollectTicket(null)}
          />
        )}
      </Modal>
    </div>
  );
}
