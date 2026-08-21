import React, { useState, useEffect, useCallback } from "react";
import { groupBookingsAPI, customersAPI, downloadBlob } from "../services/api";
import { useAuth } from "../context/AuthContext";
import {
  Button,
  Card,
  Badge,
  Spinner,
  EmptyState,
  Pagination,
  Input,
  Select,
  Modal,
  RowsPerPage,
} from "../components/ui";
import { PAYMENT_METHODS } from "../components/tickets/TicketForm";
import toast from "react-hot-toast";
import {
  Users,
  Plus,
  Trash2,
  Eye,
  Building2,
  UserCheck,
  ChevronDown,
  ChevronUp,
  Copy,
  X,
  Search,
  Pencil,
  Printer,
  Download,
} from "lucide-react";
import { format } from "date-fns";
import { fmtDate } from "../utils/date";

// ─── Constants ────────────────────────────────────────────────────────────────

const EMPTY_TICKET = {
  passenger_name: "",
  ticket_type: "LOCAL",
  from_city: "",
  to_city: "",
  flight_date: "",
  return_date: "",
  airline_name: "",
  ticket_reference: "",
  base_price: "",
  tax: "",
  surcharge: "",
  cost_price: "",
  selling_price: "",
  contact_number: "",
  passport_number: "",
  nationality: "",
  visa_type: "",
};

const GROUP_TYPE_META = {
  company: {
    label: "Company",
    icon: Building2,
    color: "purple",
    desc: "Employees travelling on behalf of a company",
  },
  family: {
    label: "Family",
    icon: UserCheck,
    color: "info",
    desc: "Family members booked by one customer",
  },
  individual: {
    label: "Individual",
    icon: Users,
    color: "success",
    desc: "Multiple solo passengers in one session",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const statusVariant = {
  active: "success",
  cancelled: "danger",
  refunded: "warning",
};

const groupTypeBadge = {
  company: "purple",
  family: "info",
  individual: "success",
};

function formatMoney(v) {
  return `$${Number(v || 0).toFixed(2)}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TicketRow({
  index,
  ticket,
  onChange,
  onRemove,
  onClone,
  sharedRoute,
  setShared,
}) {
  const isInt = ticket.ticket_type === "INTERNATIONAL";
  const [expanded, setExpanded] = useState(true);

  // Same pricing rule as the single-ticket form:
  //   cost    = base + tax          (what we pay the airline)
  //   selling = base + tax + surcharge  (what the customer pays)
  const set = (field) => (e) => {
    const val = e.target.value;
    const updated = { ...ticket, [field]: val };

    if (["base_price", "tax", "surcharge"].includes(field)) {
      const base = parseFloat(field === "base_price" ? val : updated.base_price) || 0;
      const tax = parseFloat(field === "tax" ? val : updated.tax) || 0;
      const surcharge = parseFloat(field === "surcharge" ? val : updated.surcharge) || 0;
      updated.cost_price = (base + tax).toFixed(2);
      updated.selling_price = (base + tax + surcharge).toFixed(2);
    }

    onChange(index, updated);
  };

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      {/* Row header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-800/60">
        <span className="w-7 h-7 flex items-center justify-center rounded-full bg-blue-600 text-white text-xs font-bold shrink-0">
          {index + 1}
        </span>
        <span className="font-medium text-gray-800 dark:text-gray-200 flex-1 truncate">
          {ticket.passenger_name || "Passenger " + (index + 1)}
        </span>

        <Select
          value={ticket.ticket_type}
          onChange={set("ticket_type")}
          className="w-36 text-xs"
        >
          <option value="LOCAL">LOCAL</option>
          <option value="INTERNATIONAL">INTERNATIONAL</option>
        </Select>

        <button
          type="button"
          onClick={() => onClone(index)}
          title="Clone row"
          className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-blue-500 transition"
        >
          <Copy className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 transition"
        >
          {expanded ? (
            <ChevronUp className="w-4 h-4" />
          ) : (
            <ChevronDown className="w-4 h-4" />
          )}
        </button>
        <button
          type="button"
          onClick={() => onRemove(index)}
          className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-gray-400 hover:text-red-500 transition"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Row body */}
      {expanded && (
        <div className="p-4 grid grid-cols-2 md:grid-cols-3 gap-3">
          {/* Passenger name */}
          <div className="col-span-2 md:col-span-1">
            <label className="field-label">Passenger Name *</label>
            <Input
              value={ticket.passenger_name}
              onChange={set("passenger_name")}
              placeholder="Full name"
            />
          </div>

          <div>
            <label className="field-label">Contact</label>
            <Input
              value={ticket.contact_number}
              onChange={set("contact_number")}
              placeholder="+252..."
            />
          </div>

          {/* Shared route toggle */}
          <div className="col-span-2 md:col-span-3">
            <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 cursor-pointer select-none">
              <input
                type="checkbox"
                className="accent-blue-600"
                checked={sharedRoute}
                onChange={(e) => setShared(e.target.checked)}
              />
              Use shared route for all passengers
            </label>
          </div>

          <div>
            <label className="field-label">From *</label>
            <Input
              value={ticket.from_city}
              onChange={set("from_city")}
              placeholder="Mogadishu"
              disabled={sharedRoute && index > 0}
            />
          </div>
          <div>
            <label className="field-label">To *</label>
            <Input
              value={ticket.to_city}
              onChange={set("to_city")}
              placeholder="Dubai"
              disabled={sharedRoute && index > 0}
            />
          </div>
          <div>
            <label className="field-label">Flight Date *</label>
            <Input
              type="date"
              value={ticket.flight_date}
              onChange={set("flight_date")}
              disabled={sharedRoute && index > 0}
            />
          </div>
          <div>
            <label className="field-label">Return Date (round trip)</label>
            <Input
              type="date"
              value={ticket.return_date}
              onChange={set("return_date")}
              min={ticket.flight_date || undefined}
            />
          </div>
          <div>
            <label className="field-label">Airline *</label>
            <Input
              value={ticket.airline_name}
              onChange={set("airline_name")}
              placeholder="Turkish Airlines"
              disabled={sharedRoute && index > 0}
            />
          </div>

          <div>
            <label className="field-label">Reference</label>
            <Input
              value={ticket.ticket_reference}
              onChange={set("ticket_reference")}
              placeholder="TK0012"
            />
          </div>

          {/* ── Pricing (same breakdown as single ticket booking) ── */}
          <div className="col-span-2 md:col-span-3 mt-1">
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
              Pricing
            </p>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <div>
                <label className="field-label">Base price</label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={ticket.base_price}
                  onChange={set("base_price")}
                  placeholder="200"
                />
              </div>
              <div>
                <label className="field-label">Tax</label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={ticket.tax}
                  onChange={set("tax")}
                  placeholder="10"
                />
              </div>
              <div>
                <label className="field-label">Surcharge</label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={ticket.surcharge}
                  onChange={set("surcharge")}
                  placeholder="10"
                />
              </div>
              <div>
                <label className="field-label">Total</label>
                <div className="px-3 py-2 rounded-lg border bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-sm text-gray-600 dark:text-gray-300">
                  ${ticket.selling_price || "0.00"}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="field-label">Cost price (Base + Tax) *</label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={ticket.cost_price}
                  onChange={set("cost_price")}
                  placeholder="210.00"
                />
              </div>
              <div>
                <label className="field-label">Selling price (Total) *</label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={ticket.selling_price}
                  onChange={set("selling_price")}
                  placeholder="220.00"
                />
              </div>
              <div>
                <label className="field-label">Revenue (profit)</label>
                <div
                  className={`px-3 py-2 rounded-lg border text-sm font-semibold ${
                    parseFloat(ticket.selling_price || 0) -
                      parseFloat(ticket.cost_price || 0) >
                    0
                      ? "bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400"
                      : parseFloat(ticket.selling_price || 0) -
                            parseFloat(ticket.cost_price || 0) <
                          0
                        ? "bg-red-50 border-red-200 text-red-700"
                        : "bg-gray-50 border-gray-200 text-gray-500 dark:bg-gray-700 dark:border-gray-600"
                  }`}
                >
                  {ticket.cost_price && ticket.selling_price
                    ? formatMoney(
                        parseFloat(ticket.selling_price || 0) -
                          parseFloat(ticket.cost_price || 0),
                      )
                    : "$—"}
                </div>
              </div>
            </div>
          </div>

          {/* International fields */}
          {isInt && (
            <>
              <div>
                <label className="field-label">Passport No.</label>
                <Input
                  value={ticket.passport_number}
                  onChange={set("passport_number")}
                  placeholder="A12345678"
                />
              </div>
              <div>
                <label className="field-label">Nationality</label>
                <Input
                  value={ticket.nationality}
                  onChange={set("nationality")}
                  placeholder="Somali"
                />
              </div>
              <div>
                <label className="field-label">Visa Type</label>
                <Input
                  value={ticket.visa_type}
                  onChange={set("visa_type")}
                  placeholder="Tourist / Work..."
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Print group statement ───────────────────────────────────────────────────

const printGroupStatement = (group) => {
  const passengers = group.passengers || [];
  const fmt = (d) => (d ? format(new Date(d), "dd MMM yyyy") : "—");
  const rows = passengers
    .map(
      (p, i) => `<tr>
        <td>${i + 1}</td>
        <td>${p.passenger_name}</td>
        <td>${p.from_city} → ${p.to_city}${p.trip_type === "round_trip" ? " ⇄" : ""}</td>
        <td>${fmt(p.flight_date)}${p.return_date ? "<br/>⇄ " + fmt(p.return_date) : ""}</td>
        <td>${p.airline_name || "—"}</td>
        <td>${p.ticket_type}</td>
        <td>${formatMoney(p.selling_price)}</td>
        <td>${formatMoney(p.amount_paid)}</td>
        <td>${formatMoney(p.balance)}</td>
        <td class="st-${p.payment_status || "unpaid"}">${(p.payment_status || "unpaid").toUpperCase()}</td>
      </tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html><html><head><title>Group Booking — ${group.group_label || ""}</title>
    <style>
      body{font-family:Arial,sans-serif;margin:32px;color:#111}
      h1{font-size:20px;margin:0 0 4px;text-align:center}
      .sub{text-align:center;color:#666;font-size:12px;margin-bottom:16px}
      .boxes{display:flex;gap:10px;margin-bottom:20px}
      .box{flex:1;border:1px solid #c7d7ff;background:#f8faff;border-radius:8px;padding:10px}
      .box .l{font-size:10px;color:#1d4ed8;font-weight:bold;text-transform:uppercase}
      .box .v{font-size:16px;font-weight:bold}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th{background:#1d4ed8;color:#fff;text-align:left;padding:6px}
      td{padding:6px;border-bottom:1px solid #e5e7eb}
      tr:nth-child(even) td{background:#f8faff}
      .st-paid{color:#15803d;font-weight:bold}.st-partial{color:#b45309;font-weight:bold}.st-unpaid{color:#b91c1c;font-weight:bold}
      @media print{body{margin:12mm}}
    </style></head><body>
    <h1>Group Booking Statement</h1>
    <p class="sub"><strong>${group.group_label || "—"}</strong> · Customer: ${group.customer_display_name}
      ${group.customer_phone ? " · " + group.customer_phone : ""} · Type: ${group.group_type}
      · Booked by: ${group.created_by_name}</p>
    <div class="boxes">
      <div class="box"><div class="l">Passengers</div><div class="v">${group.ticket_count}</div></div>
      <div class="box"><div class="l">Total Selling</div><div class="v">${formatMoney(group.total_selling_price)}</div></div>
      <div class="box"><div class="l">Total Revenue</div><div class="v">${formatMoney(group.total_revenue)}</div></div>
      <div class="box"><div class="l">Total Paid</div><div class="v" style="color:#15803d">${formatMoney(group.total_paid)}</div></div>
      <div class="box"><div class="l">Balance Due</div><div class="v" style="color:#b91c1c">${formatMoney(group.total_balance)}</div></div>
    </div>
    <table><thead><tr><th>#</th><th>Passenger</th><th>Route</th><th>Flight</th><th>Airline</th><th>Type</th><th>Selling</th><th>Paid</th><th>Balance</th><th>Payment</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=function(){window.print()}</script>
    </body></html>`;

  const win = window.open("", "_blank");
  if (!win) return toast.error("Allow pop-ups to print the statement");
  win.document.write(html);
  win.document.close();
};

// ─── Group Statement Modal ────────────────────────────────────────────────────

function GroupStatementModal({ group, onClose }) {
  const [downloading, setDownloading] = useState(false);
  if (!group) return null;
  const passengers = group.passengers || [];

  const downloadPDF = async () => {
    setDownloading(true);
    try {
      const res = await groupBookingsAPI.exportPDF(group.group_id);
      downloadBlob(
        res.data,
        `group-booking-${(group.group_label || "group").replace(/\s+/g, "-").toLowerCase()}.pdf`,
      );
    } catch {
      toast.error("Failed to download PDF");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Print / PDF actions */}
      <div className="flex gap-2 justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => printGroupStatement(group)}
        >
          <Printer className="w-4 h-4" /> Print
        </Button>
        <Button size="sm" onClick={downloadPDF} disabled={downloading}>
          <Download className="w-4 h-4" />
          {downloading ? "Preparing..." : "Download PDF"}
        </Button>
      </div>

      {/* Header info */}
      <div className="grid grid-cols-2 gap-4 text-sm">
        {[
          ["Group", group.group_label],
          ["Type", group.group_type],
          ["Customer", group.customer_display_name],
          ["Phone", group.customer_phone || "—"],
          [
            "Route",
            group.from_city ? `${group.from_city} → ${group.to_city}` : "—",
          ],
          [
            "Date",
            group.flight_date
              ? fmtDate(group.flight_date, "dd MMM yyyy")
              : "—",
          ],
          ["Airline", group.airline_name || "—"],
          ["Booked by", group.created_by_name],
        ].map(([label, val]) => (
          <div
            key={label}
            className="flex justify-between py-1.5 border-b border-gray-100 dark:border-gray-700/40 last:border-0"
          >
            <span className="text-gray-500 dark:text-gray-400">{label}</span>
            <span className="font-medium text-gray-900 dark:text-white capitalize">
              {val}
            </span>
          </div>
        ))}
      </div>

      {/* Passengers table */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
          Passengers ({passengers.length})
        </h3>
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800">
                {[
                  "#",
                  "Passenger",
                  "Route",
                  "Date",
                  "Type",
                  "Selling",
                  "Revenue",
                  "Paid",
                  "Balance",
                  "Payment",
                  "Status",
                ].map((h) => (
                  <th
                    key={h}
                    className="text-left px-3 py-2 text-gray-500 dark:text-gray-400 font-semibold uppercase tracking-wide"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/40">
              {passengers.map((p, i) => (
                <tr
                  key={p.ticket_id}
                  className="hover:bg-gray-50 dark:hover:bg-gray-700/20"
                >
                  <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                  <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                    {p.passenger_name}
                  </td>
                  <td className="px-3 py-2 text-gray-500">
                    {p.from_city} → {p.to_city}
                  </td>
                  <td className="px-3 py-2 text-gray-500">
                    {p.flight_date
                      ? fmtDate(p.flight_date, "dd MMM yy")
                      : "—"}
                    {p.return_date && (
                      <p className="text-gray-400">
                        ⇄ {fmtDate(p.return_date, "dd MMM yy")}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={p.ticket_type === "LOCAL" ? "info" : "purple"}
                    >
                      {p.ticket_type}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 font-medium">
                    {formatMoney(p.selling_price)}
                  </td>
                  <td
                    className={`px-3 py-2 font-semibold ${
                      parseFloat(p.revenue) >= 0
                        ? "text-green-600 dark:text-green-400"
                        : "text-red-500"
                    }`}
                  >
                    {formatMoney(p.revenue)}
                  </td>
                  <td className="px-3 py-2 text-green-600 font-medium">
                    {formatMoney(p.amount_paid)}
                  </td>
                  <td className="px-3 py-2 text-red-600 font-semibold">
                    {formatMoney(p.balance)}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={
                        p.payment_status === "paid"
                          ? "success"
                          : p.payment_status === "partial"
                            ? "warning"
                            : "danger"
                      }
                    >
                      {p.payment_status || "unpaid"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={statusVariant[p.status]}>{p.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Totals */}
      <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-4 grid grid-cols-5 gap-4 text-center">
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Tickets
          </p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {group.ticket_count}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Total Selling
          </p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {formatMoney(group.total_selling_price)}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Total Revenue
          </p>
          <p
            className={`text-2xl font-bold ${
              parseFloat(group.total_revenue) >= 0
                ? "text-green-600 dark:text-green-400"
                : "text-red-500"
            }`}
          >
            {formatMoney(group.total_revenue)}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Total Paid
          </p>
          <p className="text-2xl font-bold text-green-600 dark:text-green-400">
            {formatMoney(group.total_paid)}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Balance Due
          </p>
          <p className="text-2xl font-bold text-red-600">
            {formatMoney(group.total_balance)}
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

// ─── Group Booking Form ───────────────────────────────────────────────────────

function GroupBookingForm({ onSave, onCancel }) {
  const [step, setStep] = useState(1); // 1 = meta, 2 = tickets
  const [customers, setCustomers] = useState([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [groupType, setGroupType] = useState("company");
  const [customerId, setCustomerId] = useState("");
  const [groupLabel, setGroupLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [tickets, setTickets] = useState([{ ...EMPTY_TICKET }]);
  const [sharedRoute, setSharedRoute] = useState(true);
  const [amountPaid, setAmountPaid] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load customers for the dropdown
  useEffect(() => {
    customersAPI
      .list({ search: customerSearch, limit: 30 })
      .then((r) => setCustomers(r.data.data || []))
      .catch(console.error);
  }, [customerSearch]);

  // Search and pick in one action: an exact phone match wins, otherwise a
  // single result is selected outright. Only ambiguous searches need the list.
  const runCustomerSearch = useCallback(async () => {
    const term = customerSearch.trim();
    if (!term) return toast.error("Type a name or phone number first");

    setSearching(true);
    try {
      const res = await customersAPI.list({ search: term, limit: 30 });
      const found = res.data.data || [];
      setCustomers(found);

      if (found.length === 0) {
        toast.error(`No customer found for "${term}"`);
        setCustomerId("");
        return;
      }

      const digits = term.replace(/[^0-9]/g, "");
      const byPhone =
        digits.length >= 3
          ? found.filter(
              (c) => (c.phone || "").replace(/[^0-9]/g, "") === digits,
            )
          : [];

      const pick =
        byPhone.length === 1
          ? byPhone[0]
          : found.length === 1
            ? found[0]
            : null;

      if (pick) {
        setCustomerId(pick.id);
        toast.success(`Selected ${pick.company_name || pick.name}`);
      } else {
        setCustomerId("");
        toast(`${found.length} matches — pick one from the list`, {
          icon: "🔎",
        });
      }
    } catch {
      toast.error("Customer search failed");
    } finally {
      setSearching(false);
    }
  }, [customerSearch]);

  // When shared route is on, sync route fields from ticket[0] to all others
  const handleTicketChange = useCallback(
    (index, updated) => {
      setTickets((prev) => {
        const next = [...prev];
        next[index] = updated;

        if (sharedRoute && index === 0) {
          const routeFields = [
            "from_city",
            "to_city",
            "flight_date",
            "airline_name",
          ];
          for (let i = 1; i < next.length; i++) {
            const t = { ...next[i] };
            routeFields.forEach((f) => (t[f] = updated[f]));
            next[i] = t;
          }
        }
        return next;
      });
    },
    [sharedRoute],
  );

  const addTicket = () =>
    setTickets((prev) => {
      const base = sharedRoute && prev.length > 0 ? prev[0] : EMPTY_TICKET;
      return [
        ...prev,
        {
          ...EMPTY_TICKET,
          from_city: base.from_city,
          to_city: base.to_city,
          flight_date: base.flight_date,
          airline_name: base.airline_name,
          ticket_type: base.ticket_type,
        },
      ];
    });

  const removeTicket = (i) =>
    setTickets((prev) => prev.filter((_, idx) => idx !== i));

  const cloneTicket = (i) =>
    setTickets((prev) => {
      const cloned = { ...prev[i], passenger_name: "", ticket_reference: "" };
      const next = [...prev];
      next.splice(i + 1, 0, cloned);
      return next;
    });

  // Totals preview
  const totalCost = tickets.reduce(
    (s, t) => s + parseFloat(t.cost_price || 0),
    0,
  );
  const totalSelling = tickets.reduce(
    (s, t) => s + parseFloat(t.selling_price || 0),
    0,
  );
  const totalRevenue = totalSelling - totalCost;

  const handleSubmit = async () => {
    if (!customerId) {
      toast.error("Please select a customer");
      return;
    }
    const invalid = tickets.find(
      (t) =>
        !t.passenger_name ||
        !t.from_city ||
        !t.to_city ||
        !t.flight_date ||
        !t.airline_name ||
        !t.cost_price ||
        !t.selling_price,
    );
    if (invalid) {
      toast.error("Fill all required fields for every passenger");
      return;
    }

    setSaving(true);
    try {
      const paidNow = parseFloat(amountPaid) || 0;
      if (paidNow > totalSelling) {
        toast.error("Amount paid cannot exceed the total selling price");
        setSaving(false);
        return;
      }
      await groupBookingsAPI.create({
        customer_id: customerId,
        group_type: groupType,
        group_label: groupLabel || undefined,
        notes: notes || undefined,
        amount_paid: paidNow,
        payment_method: paymentMethod,
        tickets,
      });
      toast.success(`Group booking created — ${tickets.length} ticket(s)`);
      onSave();
    } catch (err) {
      toast.error(
        err?.response?.data?.message || "Failed to create group booking",
      );
    } finally {
      setSaving(false);
    }
  };

  const selectedCustomer = customers.find((c) => c.id === customerId);

  return (
    <div className="space-y-6">
      {/* ── Step 1: Group meta ── */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          1. Group Details
        </h3>

        {/* Group type selector */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          {Object.entries(GROUP_TYPE_META).map(([key, meta]) => {
            const Icon = meta.icon;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setGroupType(key)}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 text-center transition-all ${
                  groupType === key
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300"
                    : "border-gray-200 dark:border-gray-700 text-gray-500 hover:border-gray-300"
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="text-xs font-semibold">{meta.label}</span>
                <span className="text-[10px] text-gray-400 leading-tight">
                  {meta.desc}
                </span>
              </button>
            );
          })}
        </div>

        {/* Customer selector */}
        <div className="mb-3">
          <label className="field-label">
            {groupType === "company"
              ? "Company / Customer *"
              : "Lead Customer *"}
          </label>
          <div className="flex gap-2 mb-1">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                className="pl-8 w-full"
                placeholder="Type a phone number or name, then Search"
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runCustomerSearch();
                  }
                }}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={runCustomerSearch}
              disabled={searching || !customerSearch.trim()}
            >
              {searching ? <Spinner size="sm" /> : <Search className="w-4 h-4" />}
              Search
            </Button>
          </div>
          <Select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">— Select customer —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.customer_type === "company"
                  ? `🏢 ${c.company_name} (${c.name})`
                  : `👤 ${c.name}`}
                {c.phone ? ` · ${c.phone}` : ""}
              </option>
            ))}
          </Select>
          {selectedCustomer && (
            <p className="mt-1 text-xs text-gray-400">
              {selectedCustomer.customer_type === "company"
                ? `Company: ${selectedCustomer.company_name}`
                : "Individual customer"}{" "}
              · {selectedCustomer.phone || "No phone"}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="field-label">Group Label</label>
            <Input
              value={groupLabel}
              onChange={(e) => setGroupLabel(e.target.value)}
              placeholder="e.g. Dahabshiil Staff — Dubai June"
            />
          </div>
          <div>
            <label className="field-label">Notes</label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Internal notes..."
            />
          </div>
        </div>
      </div>

      <hr className="border-gray-200 dark:border-gray-700" />

      {/* ── Step 2: Passengers ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            2. Passengers ({tickets.length})
          </h3>
          <Button size="sm" onClick={addTicket}>
            <Plus className="w-3.5 h-3.5" /> Add Passenger
          </Button>
        </div>

        <div className="space-y-3">
          {tickets.map((ticket, i) => (
            <TicketRow
              key={i}
              index={i}
              ticket={ticket}
              onChange={handleTicketChange}
              onRemove={removeTicket}
              onClone={cloneTicket}
              sharedRoute={sharedRoute}
              setShared={setSharedRoute}
            />
          ))}
        </div>
      </div>

      {/* ── Totals + Payment ── */}
      {tickets.length > 0 && (
        <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-4 space-y-4">
          <div className="grid grid-cols-3 gap-4 text-center text-sm">
            <div>
              <p className="text-gray-400 text-xs uppercase tracking-wide">
                Passengers
              </p>
              <p className="font-bold text-gray-900 dark:text-white text-lg">
                {tickets.length}
              </p>
            </div>
            <div>
              <p className="text-gray-400 text-xs uppercase tracking-wide">
                Total Selling
              </p>
              <p className="font-bold text-gray-900 dark:text-white text-lg">
                {formatMoney(totalSelling)}
              </p>
            </div>
            <div>
              <p className="text-gray-400 text-xs uppercase tracking-wide">
                Total Revenue
              </p>
              <p
                className={`font-bold text-lg ${
                  totalRevenue >= 0
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-500"
                }`}
              >
                {formatMoney(totalRevenue)}
              </p>
            </div>
          </div>

          {/* Payment from the customer/company who booked */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end border-t border-gray-200 dark:border-gray-700 pt-4">
            <div>
              <label className="field-label">
                Amount paid now (by customer/company)
              </label>
              <Input
                type="number"
                min="0"
                step="0.01"
                max={totalSelling || undefined}
                value={amountPaid}
                onChange={(e) => setAmountPaid(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="field-label">Payment method</label>
              <Select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                disabled={!(parseFloat(amountPaid) > 0)}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="text-center">
              <p className="text-gray-400 text-xs uppercase tracking-wide">
                Balance Due
              </p>
              <p
                className={`font-bold text-lg ${
                  totalSelling - (parseFloat(amountPaid) || 0) > 0
                    ? "text-red-600"
                    : "text-green-600 dark:text-green-400"
                }`}
              >
                {formatMoney(totalSelling - (parseFloat(amountPaid) || 0))}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Actions ── */}
      <div className="flex justify-end gap-3 pt-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={saving}>
          {saving ? (
            <Spinner size="sm" />
          ) : (
            <>
              <Users className="w-4 h-4" /> Book {tickets.length} Ticket
              {tickets.length !== 1 ? "s" : ""}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function GroupBookingsPage() {
  const { canWrite } = useAuth();
  const [groups, setGroups] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    search: "",
    group_type: "",
    page: 1,
    limit: 10,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [viewGroup, setViewGroup] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    groupBookingsAPI
      .list(filters)
      .then((r) => {
        setGroups(r.data.data);
        setMeta(r.data.meta);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const setFilter = (key) => (e) =>
    setFilters((f) => ({ ...f, [key]: e.target.value, page: 1 }));

  const openStatement = async (group) => {
    setViewLoading(true);
    try {
      const r = await groupBookingsAPI.get(group.id);
      setViewGroup(r.data.data);
    } catch {
      toast.error("Failed to load group statement");
    } finally {
      setViewLoading(false);
    }
  };

  const handleDelete = async (group) => {
    if (
      !window.confirm(
        `Delete group booking "${group.group_label}"? All ${group.ticket_count} tickets will be unlinked.`,
      )
    )
      return;
    try {
      await groupBookingsAPI.delete(group.id);
      toast.success("Group booking deleted");
      load();
    } catch {
      toast.error("Failed to delete");
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Users className="w-6 h-6 text-blue-500" />
            Group Bookings
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {meta.total} total groups — company employees &amp; family bookings
          </p>
        </div>
        {canWrite() && (
          <Button onClick={() => setCreateOpen(true)} size="lg">
            <Plus className="w-4 h-4" /> New Group Booking
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-48">
            <Input
              placeholder="Search by label or customer..."
              value={filters.search}
              onChange={setFilter("search")}
            />
          </div>
          <Select
            value={filters.group_type}
            onChange={setFilter("group_type")}
            className="w-36"
          >
            <option value="">All types</option>
            <option value="company">Company</option>
            <option value="family">Family</option>
            <option value="individual">Individual</option>
          </Select>
          <Button
            variant="outline"
            onClick={() =>
              setFilters({
                search: "",
                group_type: "",
                page: 1,
                limit: filters.limit,
              })
            }
          >
            Clear
          </Button>
          <RowsPerPage
            value={filters.limit}
            onChange={(n) => setFilters((f) => ({ ...f, limit: n, page: 1 }))}
          />
        </div>
      </Card>

      {/* Table */}
      <Card>
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner size="lg" />
          </div>
        ) : groups.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No group bookings yet"
            description="Create your first group booking for a company or family."
            action={
              canWrite() && (
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="w-4 h-4" /> New Group Booking
                </Button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  {[
                    "Group / Customer",
                    "Type",
                    "Route",
                    "Date",
                    "Tickets",
                    "Total Revenue",
                    "Booked by",
                    "",
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide px-4 py-3"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {groups.map((g) => (
                  <tr
                    key={g.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900 dark:text-white">
                        {g.group_label || "—"}
                      </p>
                      <p className="text-xs text-gray-400">
                        {g.customer_display_name}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={groupTypeBadge[g.group_type]}>
                        {g.group_type}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {g.from_city && g.to_city
                        ? `${g.from_city} → ${g.to_city}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {g.flight_date
                        ? fmtDate(g.flight_date, "dd MMM yyyy")
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs font-bold">
                        <Users className="w-3 h-3" />
                        {g.ticket_count}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`font-semibold ${
                          parseFloat(g.total_revenue) >= 0
                            ? "text-green-600 dark:text-green-400"
                            : "text-red-600"
                        }`}
                      >
                        {formatMoney(g.total_revenue)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                      {g.created_by_name}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openStatement(g)}
                          title="View statement"
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        {canWrite() && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(g)}
                            className="text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
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
            page={filters.page}
            totalPages={meta.totalPages}
            onChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          />
        </div>
      </Card>

      {/* Create Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New Group Booking"
        size="xl"
      >
        <GroupBookingForm
          onSave={() => {
            setCreateOpen(false);
            load();
          }}
          onCancel={() => setCreateOpen(false)}
        />
      </Modal>

      {/* Statement Modal */}
      <Modal
        open={!!viewGroup || viewLoading}
        onClose={() => setViewGroup(null)}
        title="Group Booking Statement"
        size="xl"
      >
        {viewLoading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : (
          <GroupStatementModal
            group={viewGroup}
            onClose={() => setViewGroup(null)}
          />
        )}
      </Modal>
    </div>
  );
}
