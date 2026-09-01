import React, { useState, useEffect, useCallback } from "react";
import { ticketsAPI } from "../services/api";
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
import TicketForm from "../components/tickets/TicketForm";
import toast from "react-hot-toast";
import {
  Ticket,
  Plus,
  Search,
  Eye,
  Pencil,
  Trash2,
  Filter,
  Banknote,
  Loader2,
  ClipboardList,
  Printer,
  Plane,
  Ban,
} from "lucide-react";
import { format } from "date-fns";
import { fmtDate } from "../utils/date";
import AccountSelect from "../components/AccountSelect";
import { openPrintWindow } from "../utils/printWindow";

const statusVariant = {
  active: "success",
  cancelled: "danger",
  refunded: "warning",
};
const typeVariant = { LOCAL: "info", INTERNATIONAL: "purple" };
const paymentVariant = { paid: "success", partial: "warning", unpaid: "danger" };

/**
 * What the customer still owes.
 *
 * A written-off amount is money the agency decided not to chase when the
 * ticket was cancelled. It is settled — just not by being paid — so it has to
 * come off the balance. Leaving it in showed a cancelled booking as still
 * owing hundreds, which is exactly the debt the write-off was meant to clear.
 */
const balanceOf = (t) =>
  Math.round(
    ((parseFloat(t.selling_price) || 0) -
      (parseFloat(t.amount_paid) || 0) -
      (parseFloat(t.written_off) || 0)) * 100,
  ) / 100;

/** A cancelled ticket is finished with, however it was settled. */
const isSettled = (t) => t.status === "cancelled" || balanceOf(t) <= 0.001;

/**
 * How a cancelled ticket was settled — every line of it.
 *
 * One cancellation can do three things at once: hand some money back, keep
 * some as a fee, and forgive whatever was still owed. Showing only the first
 * of those that happens to be non-zero is how a refund gets paid a second
 * time, so this returns them all.
 */
const settlementLines = (t) => {
  const lines = [];
  const refunded = parseFloat(t.refunded_amount) || 0;
  const kept = parseFloat(t.cancellation_fee) || 0;
  const written = parseFloat(t.written_off) || 0;
  if (refunded > 0) lines.push(`$${refunded.toFixed(2)} refunded`);
  if (kept > 0) lines.push(`$${kept.toFixed(2)} kept as fee`);
  if (written > 0) lines.push(`$${written.toFixed(2)} written off`);
  return lines.length ? lines : ["Nothing owed either way"];
};

// ─── Cancel & Refund ─────────────────────────────────────────────────────────
//
// Three amounts, and they don't depend on each other: what goes back to the
// customer, what the agency keeps, and what the airline returns. The form
// shows the fee being computed as you type, because "how much am I actually
// keeping?" is the question people get wrong under pressure.
function CancelTicketForm({ ticket, onDone, onCancel }) {
  const paid = parseFloat(ticket.amount_paid) || 0;
  const airlinePaid = parseFloat(ticket.airline_paid) || 0;

  const [refund, setRefund] = useState(
    Math.max(paid - (parseFloat(ticket.tax) || 0), 0).toFixed(2),
  );
  const [airlineRefund, setAirlineRefund] = useState("0.00");
  const [accountId, setAccountId] = useState("");
  const [airlineAccountId, setAirlineAccountId] = useState("");
  const [reason, setReason] = useState("");
  const [writeOff, setWriteOff] = useState(true);
  // Ticked only when the airline hands the tax back with the fare. Left
  // alone, the tax stays owed to the government and cannot be refunded.
  const [refundTax, setRefundTax] = useState(false);
  const [saving, setSaving] = useState(false);

  // What the customer still owes on a journey that won't happen.
  const outstanding =
    Math.round(Math.max((parseFloat(ticket.selling_price) || 0) - paid, 0) * 100) / 100;

  // The government's share of what the customer paid. It is owed whether or
  // not anyone flies, so it is not the agency's to give back.
  const tax = Math.round((parseFloat(ticket.tax) || 0) * 100) / 100;
  const refundable =
    Math.round(Math.max(paid - (refundTax ? 0 : tax), 0) * 100) / 100;

  const refundVal = parseFloat(refund) || 0;
  const airlineVal = parseFloat(airlineRefund) || 0;
  const kept = Math.round((paid - refundVal) * 100) / 100;
  // The tax inside what's kept isn't earned — it's held for the government.
  const taxRetained = refundTax ? 0 : Math.min(tax, Math.max(kept, 0));
  const fee = Math.round((kept - taxRetained) * 100) / 100;
  const tooMuch = refundVal > refundable + 0.001;
  const airlineTooMuch = airlineVal > airlinePaid + 0.001;

  const submit = async (e) => {
    e.preventDefault();
    if (tooMuch)
      return toast.error(
        `You can't refund more than $${refundable.toFixed(2)}`,
      );
    if (airlineTooMuch)
      return toast.error(
        `The airline can't return more than the $${airlinePaid.toFixed(2)} you paid them`,
      );
    setSaving(true);
    try {
      const res = await ticketsAPI.cancel(ticket.id, {
        refund_amount: refundVal,
        airline_refund: airlineVal,
        account_id: accountId || undefined,
        airline_account_id: airlineAccountId || undefined,
        write_off: outstanding > 0 ? writeOff : undefined,
        refund_tax: refundTax || undefined,
        reason: reason || undefined,
      });
      toast.success(res.data.message);
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.message || "Could not cancel the ticket");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-4">
        <p className="text-sm font-medium text-gray-900 dark:text-white">
          {ticket.passenger_name}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {ticket.from_city} → {ticket.to_city} · {fmtDate(ticket.flight_date)}
        </p>
        <div className="flex gap-6 mt-2 text-sm">
          <span className="text-gray-600 dark:text-gray-300">
            Customer paid{" "}
            <strong className="text-gray-900 dark:text-white">
              ${paid.toFixed(2)}
            </strong>
          </span>
          {airlinePaid > 0 && (
            <span className="text-gray-600 dark:text-gray-300">
              Paid to airline{" "}
              <strong className="text-gray-900 dark:text-white">
                ${airlinePaid.toFixed(2)}
              </strong>
            </span>
          )}
          {tax > 0 && (
            <span className="text-gray-600 dark:text-gray-300">
              Of which tax{" "}
              <strong className="text-gray-900 dark:text-white">
                ${tax.toFixed(2)}
              </strong>
            </span>
          )}
        </div>
      </div>

      {/* Customer side */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label="Refund to customer"
          type="number"
          min="0"
          step="0.01"
          max={refundable}
          value={refund}
          onChange={(e) => setRefund(e.target.value)}
          error={
            tooMuch ? `More than the $${refundable.toFixed(2)} refundable` : undefined
          }
          hint={
            tax > 0 && !refundTax
              ? `$${paid.toFixed(2)} paid less $${tax.toFixed(2)} tax`
              : undefined
          }
        />
        <AccountSelect
          direction="out"
          label="Refund from"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        />
      </div>

      {tax > 0 && (
        <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3">
          <p className="text-sm text-blue-900 dark:text-blue-100">
            <strong>${tax.toFixed(2)}</strong> of this ticket is government
            tax. It is owed whether or not the passenger flies, so it is not
            refundable and stays in the Tax section.
          </p>
          <label className="flex items-start gap-2.5 cursor-pointer mt-2">
            <input
              type="checkbox"
              checked={refundTax}
              onChange={(e) => {
                const on = e.target.checked;
                setRefundTax(on);
                setRefund(Math.max(paid - (on ? 0 : tax), 0).toFixed(2));
              }}
              className="mt-0.5 rounded"
            />
            <span className="text-sm text-blue-900 dark:text-blue-100">
              The airline returned the tax as well
              <span className="block text-xs text-blue-700 dark:text-blue-300 mt-0.5">
                Usually only when the airline cancelled the flight. Ticking
                this clears the ${tax.toFixed(2)} from what you owe the
                government and lets the whole ${paid.toFixed(2)} go back.
              </span>
            </span>
          </label>
        </div>
      )}

      {fee !== 0 && !tooMuch && (
        <div className="rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-3 py-2">
          <p className="text-sm text-green-800 dark:text-green-200">
            You keep <strong>${fee.toFixed(2)}</strong> as a cancellation fee.
            The sale stops counting, but this stays as income.
            {taxRetained > 0 && (
              <span className="block mt-1">
                The other ${taxRetained.toFixed(2)} you're holding is tax, not
                income — it goes to the government.
              </span>
            )}
          </p>
        </div>
      )}

      {/* Airline side */}
      {airlinePaid > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1 border-t border-gray-200 dark:border-gray-700">
          <Input
            label="Airline refunds you"
            type="number"
            min="0"
            step="0.01"
            max={airlinePaid}
            value={airlineRefund}
            onChange={(e) => setAirlineRefund(e.target.value)}
            error={
              airlineTooMuch
                ? `More than the $${airlinePaid.toFixed(2)} you paid`
                : undefined
            }
          />
          <AccountSelect
            direction="in"
            label="Refund into"
            value={airlineAccountId}
            onChange={(e) => setAirlineAccountId(e.target.value)}
          />
        </div>
      )}

      {/* Still owing on a cancelled journey */}
      {outstanding > 0 && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={writeOff}
              onChange={(e) => setWriteOff(e.target.checked)}
              className="mt-0.5 rounded"
            />
            <span className="text-sm text-amber-900 dark:text-amber-100">
              Write off the{" "}
              <strong>${outstanding.toFixed(2)}</strong> still owed — the
              customer pays nothing more.
              <span className="block text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                No money moves. The amount is recorded as a loss so it shows in
                your profit rather than disappearing. Untick to keep chasing it.
              </span>
            </span>
          </label>
        </div>
      )}

      <Input
        label="Reason (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Passenger changed plans, flight cancelled…"
      />

      <div className="flex gap-3 justify-end pt-1">
        <Button type="button" variant="outline" onClick={onCancel}>
          Keep ticket
        </Button>
        <Button type="submit" variant="danger" loading={saving}>
          <Ban className="w-4 h-4" /> Cancel ticket
        </Button>
      </div>
    </form>
  );
}

// ─── Collect Payment Modal ───────────────────────────────────────────────────
function CollectPaymentForm({ ticket, onDone, onCancel }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  // Which account the money lands in — the Accounts balance depends on it.
  const [accountId, setAccountId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const balance = balanceOf(ticket);

  const submit = async (e) => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (!val || val <= 0) return toast.error("Enter a valid amount");
    if (val > balance + 0.001)
      return toast.error(`Amount exceeds balance ($${balance.toFixed(2)})`);
    setSaving(true);
    try {
      await ticketsAPI.addPayment(ticket.id, { amount: val, method, account_id: accountId || undefined, note });
      toast.success(`$${val.toFixed(2)} collected from ${ticket.passenger_name}`);
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to collect payment");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-center">
        <div>
          <p className="text-xs text-gray-500 uppercase">Total</p>
          <p className="font-bold text-gray-900 dark:text-white">
            ${Number(ticket.selling_price).toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500 uppercase">Paid</p>
          <p className="font-bold text-green-600">
            ${Number(ticket.amount_paid || 0).toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500 uppercase">Balance</p>
          <p className="font-bold text-red-600">${balance.toFixed(2)}</p>
        </div>
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
      <Input
        label="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. paid by brother"
      />
      <div className="flex gap-3 justify-end pt-1">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              <Banknote className="w-4 h-4" /> Collect Payment
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

// ─── Flight Manifest ─────────────────────────────────────────────────────────
// Who is flying and how to reach them. Defaults to tomorrow, because that is
// the call list you make at the end of today.

const printManifest = (rows, summary, label) => {
  const body = rows
    .map(
      (p, i) => `<tr>
        <td>${i + 1}</td>
        <td>${p.passenger_name}</td>
        <td>${p.phone || "—"}</td>
        <td>${p.from_city} → ${p.to_city}</td>
        <td>${p.airline_name}</td>
        <td>${p.ticket_reference || "—"}</td>
        <td>${p.ticket_type === "INTERNATIONAL" ? "INTL" : "LOCAL"}</td>
        <td class="${Number(p.balance) > 0 ? "due" : ""}">$${Number(p.balance).toFixed(2)}</td>
      </tr>`,
    )
    .join("");
  const html = `<!DOCTYPE html><html><head><title>Flight manifest — ${label}</title><style>
    body{font-family:Arial,sans-serif;margin:28px;color:#111}
    h1{font-size:19px;margin:0 0 4px;text-align:center}
    .sub{text-align:center;color:#666;font-size:12px;margin-bottom:18px}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th{background:#1d4ed8;color:#fff;text-align:left;padding:6px}
    td{padding:6px;border-bottom:1px solid #e5e7eb}
    tr:nth-child(even) td{background:#f8faff}
    .due{color:#b91c1c;font-weight:bold}
    @media print{body{margin:10mm}}
  </style></head><body>
    <h1>Flight manifest</h1>
    <p class="sub">${label} · ${summary.passengers} passenger(s) · ${summary.airlines} airline(s)
      ${summary.balance_due > 0 ? ` · $${Number(summary.balance_due).toFixed(2)} still to collect` : ""}</p>
    <table><thead><tr><th>#</th><th>Passenger</th><th>Phone</th><th>Route</th><th>Airline</th><th>Ref</th><th>Type</th><th>Balance</th></tr></thead>
    <tbody>${body}</tbody></table>
  </body></html>`;
  const win = openPrintWindow(html);
  if (!win) return toast.error("Allow pop-ups to print the manifest");
};

function ManifestModal({ open, onClose }) {
  const [when, setWhen] = useState("tomorrow");
  const [date, setDate] = useState("");
  const [includeReturns, setIncludeReturns] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (when === "date" && !date) return;
    setLoading(true);
    ticketsAPI
      .manifest({ when, date, include_returns: includeReturns })
      .then((r) => setData(r.data.data))
      .catch((err) =>
        toast.error(err.response?.data?.message || "Failed to load manifest"),
      )
      .finally(() => setLoading(false));
  }, [when, date, includeReturns]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const rows = data?.passengers || [];
  const summary = data?.summary || {};
  const label =
    when === "today"
      ? `Today, ${format(new Date(), "dd MMM yyyy")}`
      : when === "tomorrow"
        ? `Tomorrow, ${format(new Date(Date.now() + 86400000), "dd MMM yyyy")}`
        : date
          ? fmtDate(date)
          : "Pick a date";

  return (
    <Modal open={open} onClose={onClose} title="Flight manifest" size="xl">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3 items-end">
          <Select value={when} onChange={(e) => setWhen(e.target.value)} className="w-40">
            <option value="tomorrow">Tomorrow</option>
            <option value="today">Today</option>
            <option value="date">Pick a date</option>
          </Select>
          {when === "date" && (
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          )}
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 pb-2">
            <input
              type="checkbox"
              checked={includeReturns}
              onChange={(e) => setIncludeReturns(e.target.checked)}
              className="rounded"
            />
            Include return legs
          </label>
          <div className="flex-1" />
          <Button
            variant="outline"
            disabled={rows.length === 0}
            onClick={() => printManifest(rows, summary, label)}
          >
            <Printer className="w-4 h-4" /> Print
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : rows.length === 0 ? (
          <div className="py-14 text-center">
            <Plane className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
            <p className="text-gray-500 dark:text-gray-400 font-medium">
              No flights on {label.toLowerCase()}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              {[
                ["Passengers", summary.passengers, "text-gray-900 dark:text-white"],
                ["Airlines", summary.airlines, "text-gray-900 dark:text-white"],
                ["Not fully paid", summary.unpaid, summary.unpaid > 0 ? "text-red-600" : "text-gray-400"],
                ["To collect", `$${Number(summary.balance_due || 0).toFixed(2)}`, summary.balance_due > 0 ? "text-red-600" : "text-gray-400"],
              ].map(([l, v, cls]) => (
                <div key={l} className="px-3 py-2 rounded-xl bg-gray-50 dark:bg-gray-700/40">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">{l}</p>
                  <p className={`text-lg font-bold ${cls}`}>{v}</p>
                </div>
              ))}
            </div>

            {summary.missing_phone > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {summary.missing_phone} passenger(s) have no phone number on file.
              </p>
            )}

            <div className="overflow-x-auto max-h-[50vh] overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-xl">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white dark:bg-gray-800">
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    {["Passenger", "Phone", "Route", "Airline", "Ref", "Type", "Balance"].map((h) => (
                      <th key={h} className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                  {rows.map((p) => (
                    <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white whitespace-nowrap">
                        {p.passenger_name}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {p.phone ? (
                          <a href={`tel:${p.phone}`} className="text-blue-600 hover:underline">{p.phone}</a>
                        ) : (
                          <span className="text-amber-600">missing</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                        {p.from_city} → {p.to_city}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">{p.airline_name}</td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">{p.ticket_reference || "—"}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant={typeVariant[p.ticket_type]}>{p.ticket_type}</Badge>
                      </td>
                      <td className={`px-4 py-2.5 font-semibold ${Number(p.balance) > 0 ? "text-red-600" : "text-gray-400"}`}>
                        ${Number(p.balance).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

export default function TicketsPage() {
  const { canWrite, hasRole } = useAuth();
  // Cancelling pays money back out, so it needs more than write access.
  const canCancel = hasRole("super_admin", "admin", "accountant");
  const [tickets, setTickets] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    search: "",
    ticket_type: "",
    status: "",
    payment_status: "",
    page: 1,
    limit: 10,
  });
  const [modal, setModal] = useState({ open: false, mode: null, ticket: null });
  const [payModal, setPayModal] = useState(null); // ticket being paid
  const [cancelModal, setCancelModal] = useState(null); // ticket being cancelled
  const [payments, setPayments] = useState([]); // history in view modal
  const [manifestOpen, setManifestOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    ticketsAPI
      .list(filters)
      .then((res) => {
        setTickets(res.data.data);
        setMeta(res.data.meta);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const setFilter = (key) => (e) =>
    setFilters((f) => ({ ...f, [key]: e.target.value, page: 1 }));

  const handleDelete = async (ticket) => {
    if (!window.confirm(`Delete ticket for ${ticket.passenger_name}?`)) return;
    try {
      await ticketsAPI.delete(ticket.id);
      toast.success("Ticket deleted");
      load();
    } catch {
      toast.error("Failed to delete ticket");
    }
  };

  const openView = (ticket) => {
    setModal({ open: true, mode: "view", ticket });
    setPayments([]);
    ticketsAPI
      .payments(ticket.id)
      .then((r) => setPayments(r.data.data || []))
      .catch(() => {});
  };
  const openEdit = (ticket) => setModal({ open: true, mode: "edit", ticket });
  const openCreate = () =>
    setModal({ open: true, mode: "create", ticket: null });
  const closeModal = () => setModal({ open: false, mode: null, ticket: null });

  const handleSave = () => {
    closeModal();
    load();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Tickets
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {meta.total} total tickets
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="lg" onClick={() => setManifestOpen(true)}>
            <ClipboardList className="w-4 h-4" /> Manifest
          </Button>
          {canWrite() && (
            <Button onClick={openCreate} size="lg">
              <Plus className="w-4 h-4" /> New Ticket
            </Button>
          )}
        </div>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-48">
            <Input
              placeholder="Search passenger, phone number, route, reference..."
              value={filters.search}
              onChange={setFilter("search")}
            />
          </div>
          <Select
            value={filters.ticket_type}
            onChange={setFilter("ticket_type")}
            className="w-36"
          >
            <option value="">All types</option>
            <option value="LOCAL">Local</option>
            <option value="INTERNATIONAL">International</option>
          </Select>
          <Select
            value={filters.status}
            onChange={setFilter("status")}
            className="w-36"
          >
            <option value="">All status</option>
            <option value="active">Active</option>
            <option value="cancelled">Cancelled</option>
            <option value="refunded">Refunded</option>
          </Select>
          <Select
            value={filters.payment_status}
            onChange={setFilter("payment_status")}
            className="w-36"
          >
            <option value="">All payments</option>
            <option value="unpaid">Unpaid</option>
            <option value="partial">Partial</option>
            <option value="paid">Paid</option>
          </Select>
          <Button
            variant="outline"
            onClick={() =>
              setFilters({
                search: "",
                ticket_type: "",
                status: "",
                payment_status: "",
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
        ) : tickets.length === 0 ? (
          <EmptyState
            icon={Ticket}
            title="No tickets found"
            description="Create your first ticket or adjust your filters."
            action={
              canWrite() && (
                <Button onClick={openCreate}>
                  <Plus className="w-4 h-4" /> New Ticket
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
                    "Passenger",
                    "Route",
                    "Airline",
                    "Date",
                    "Type",
                    "Revenue",
                    "Payment",
                    "Status",
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
                {tickets.map((ticket) => (
                  <tr
                    key={ticket.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-gray-900 dark:text-white">
                          {ticket.passenger_name}
                        </p>
                        {ticket.ticket_reference && (
                          <p className="text-xs text-gray-400 font-mono">
                            {ticket.ticket_reference}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {ticket.from_city} → {ticket.to_city}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {ticket.airline_name}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {ticket.flight_date
                        ? fmtDate(ticket.flight_date, "dd MMM yyyy")
                        : "—"}
                      {ticket.trip_type === "round_trip" &&
                        ticket.return_date && (
                          <p className="text-xs text-gray-400">
                            ⇄{" "}
                            {format(
                              new Date(ticket.return_date),
                              "dd MMM yyyy",
                            )}
                          </p>
                        )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={typeVariant[ticket.ticket_type]}>
                        {ticket.ticket_type}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`font-semibold ${parseFloat(ticket.revenue) >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600"}`}
                      >
                        ${Number(ticket.revenue).toFixed(2)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={
                          ticket.status === "cancelled"
                            ? "default"
                            : paymentVariant[ticket.payment_status] || "danger"
                        }
                      >
                        {ticket.status === "cancelled"
                          ? "settled"
                          : ticket.payment_status || "unpaid"}
                      </Badge>
                      {ticket.status === "cancelled" ? (
                        <span className="block text-xs text-gray-400 mt-0.5">
                          {settlementLines(ticket).map((l) => (
                            <span key={l} className="block">
                              {l}
                            </span>
                          ))}
                        </span>
                      ) : balanceOf(ticket) > 0 && (
                        <p className="text-xs text-red-500 font-semibold mt-0.5">
                          Bal: ${balanceOf(ticket).toFixed(2)}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant[ticket.status]}>
                        {ticket.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openView(ticket)}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        {!isSettled(ticket) &&
                          ticket.status === "active" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setPayModal(ticket)}
                              title="Collect payment"
                              className="text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20"
                            >
                              <Banknote className="w-4 h-4" />
                            </Button>
                          )}
                        {ticket.status === "active" && canCancel && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCancelModal(ticket)}
                            title="Cancel and refund"
                            className="text-orange-500 hover:text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-900/20"
                          >
                            <Ban className="w-4 h-4" />
                          </Button>
                        )}
                        {canWrite() && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(ticket)}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(ticket)}
                              className="text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </>
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

      {/* Create/Edit Modal */}
      <Modal
        open={modal.open && modal.mode !== "view"}
        onClose={closeModal}
        title={modal.mode === "create" ? "New Ticket" : "Edit Ticket"}
        size="lg"
      >
        <TicketForm
          initial={modal.ticket || {}}
          mode={modal.mode}
          onSave={handleSave}
          onCancel={closeModal}
        />
      </Modal>

      {/* Cancel & Refund Modal */}
      <Modal
        open={!!cancelModal}
        onClose={() => setCancelModal(null)}
        title={cancelModal ? `Cancel ticket — ${cancelModal.passenger_name}` : ""}
        size="lg"
      >
        {cancelModal && (
          <CancelTicketForm
            ticket={cancelModal}
            onDone={() => {
              setCancelModal(null);
              load();
            }}
            onCancel={() => setCancelModal(null)}
          />
        )}
      </Modal>

      {/* Collect Payment Modal */}
      <Modal
        open={!!payModal}
        onClose={() => setPayModal(null)}
        title={payModal ? `Collect Payment — ${payModal.passenger_name}` : ""}
        size="md"
      >
        {payModal && (
          <CollectPaymentForm
            ticket={payModal}
            onDone={() => {
              setPayModal(null);
              load();
            }}
            onCancel={() => setPayModal(null)}
          />
        )}
      </Modal>

      {/* View Modal */}
      <Modal
        open={modal.open && modal.mode === "view"}
        onClose={closeModal}
        title="Ticket Details"
        size="md"
      >
        {modal.ticket && (
          <div className="space-y-4">
            {[
              ["Passenger", modal.ticket.passenger_name],
              ["Contact", modal.ticket.contact_number || "—"],
              ["Route", `${modal.ticket.from_city} → ${modal.ticket.to_city}`],
              ["Airline", modal.ticket.airline_name],
              [
                "Flight Date",
                modal.ticket.flight_date
                  ? fmtDate(modal.ticket.flight_date, "dd MMMM yyyy")
                  : "—",
              ],
              [
                "Trip",
                modal.ticket.trip_type === "round_trip"
                  ? "Round trip (Go & Back)"
                  : "One way",
              ],
              ...(modal.ticket.trip_type === "round_trip"
                ? [
                    [
                      "Return Date",
                      modal.ticket.return_date
                        ? format(
                            new Date(modal.ticket.return_date),
                            "dd MMMM yyyy",
                          )
                        : "—",
                    ],
                  ]
                : []),
              [
                "Booked Date",
                modal.ticket.created_at
                  ? format(
                      new Date(modal.ticket.created_at),
                      "dd MMMM yyyy HH:mm",
                    )
                  : "—",
              ],
              ["Reference", modal.ticket.ticket_reference || "—"],
              ["Type", modal.ticket.ticket_type],
              ["Status", modal.ticket.status],
              ["Cost Price", `$${Number(modal.ticket.cost_price).toFixed(2)}`],
              [
                "Selling Price",
                `$${Number(modal.ticket.selling_price).toFixed(2)}`,
              ],
              [
                "Commission",
                `$${Number(modal.ticket.agent_commission || 0).toFixed(2)}`,
              ],
              ...(Number(modal.ticket.tax) > 0
                ? [
                    [
                      "Tax (government)",
                      `$${Number(modal.ticket.tax).toFixed(2)}` +
                        (Number(modal.ticket.tax_refunded) > 0
                          ? " — returned by the airline"
                          : modal.ticket.status === "cancelled"
                            ? " — still owed, not refundable"
                            : ""),
                    ],
                  ]
                : []),
              [
                modal.ticket.status === "cancelled"
                  ? "Revenue (kept less fare lost)"
                  : "Revenue (net)",
                `$${Number(modal.ticket.revenue).toFixed(2)}`,
              ],
              [
                "Amount Paid",
                `$${Number(modal.ticket.amount_paid || 0).toFixed(2)}`,
              ],
              modal.ticket.status === "cancelled"
                ? ["Settled by", settlementLines(modal.ticket).join(" · ")]
                : ["Balance", `$${balanceOf(modal.ticket).toFixed(2)}`],
              [
                "Payment Status",
                (modal.ticket.payment_status || "unpaid").toUpperCase(),
              ],
              ...(modal.ticket.ticket_type === "INTERNATIONAL"
                ? [
                    ["Passport", modal.ticket.passport_number || "—"],
                    ["Nationality", modal.ticket.nationality || "—"],
                    ["Visa Type", modal.ticket.visa_type || "—"],
                  ]
                : []),
              ["Agent", modal.ticket.agent_name || "—"],
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700/50 last:border-0"
              >
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {label}
                </span>
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  {value}
                </span>
              </div>
            ))}

            {/* Payment history */}
            {payments.length > 0 && (
              <div className="pt-2">
                <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
                  <Banknote className="w-4 h-4 text-green-600" /> Payment
                  History ({payments.length})
                </h4>
                <div className="space-y-1.5">
                  {payments.map((p) => (
                    <div
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-3 text-sm py-1.5 px-3 bg-green-50 dark:bg-green-900/10 rounded-lg"
                    >
                      <div>
                        <span className="font-semibold text-green-700 dark:text-green-400">
                          ${Number(p.amount).toFixed(2)}
                        </span>
                        <span className="text-xs text-gray-500 ml-2 capitalize">
                          {p.account_name || p.method}
                        </span>
                      </div>
                      <div className="text-right text-xs text-gray-500">
                        <p>{p.collected_by_name}</p>
                        <p>
                          {format(new Date(p.created_at), "dd MMM yyyy HH:mm")}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!isSettled(modal.ticket) &&
              modal.ticket.status === "active" && (
                <Button
                  onClick={() => {
                    const t = modal.ticket;
                    closeModal();
                    setPayModal(t);
                  }}
                  className="w-full"
                >
                  <Banknote className="w-4 h-4" /> Collect Payment ($
                  {balanceOf(modal.ticket).toFixed(2)} due)
                </Button>
              )}
          </div>
        )}
      </Modal>

      <ManifestModal open={manifestOpen} onClose={() => setManifestOpen(false)} />
    </div>
  );
}
