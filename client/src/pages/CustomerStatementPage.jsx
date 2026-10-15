import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { customersAPI, downloadBlob } from "../services/api";
import { useAuth } from "../context/AuthContext";
import {
  Button,
  Card,
  Spinner,
  EmptyState,
  Input,
  Modal,
  Badge,
} from "../components/ui";
import toast from "react-hot-toast";
import {
  ArrowLeft,
  FileText,
  Printer,
  Download,
  Banknote,
  Share2,
  Eye,
  MessageCircle,
  Mail,
} from "lucide-react";
import { fmtDate } from "../utils/date";
import {
  CollectForm,
  printStatement,
  printPaymentReceipt,
} from "./CustomersPage";

const money = (v) => `$${Number(v || 0).toFixed(2)}`;
const payBadge = { paid: "success", partial: "warning", unpaid: "danger" };

// ─── Every service the customer bought, as one list of invoices ─────────────
//
// The codes and number format match the server's (customerController.js),
// so the number on screen is the number printed on the PDF.
const KINDS = [
  {
    key: "tickets",
    code: "TK",
    label: "Flight",
    param: "ticket_ids",
    collect: (r) => (r.status === "active" ? "ticket" : null),
    who: (r) => r.passenger_name,
    describe: (r) =>
      `${r.from_city} → ${r.to_city}${r.trip_type === "round_trip" ? " (return)" : ""}`,
    detail: (r) =>
      [r.airline_name, r.flight_date && `Flies ${fmtDate(r.flight_date)}`]
        .filter(Boolean)
        .join(" · "),
    date: (r) => r.booked_date,
  },
  {
    key: "visas",
    code: "VS",
    label: "Visa",
    param: "visa_ids",
    collect: () => "visa",
    who: (r) => r.applicant_name,
    describe: (r) =>
      `${r.destination_country}${r.visa_type ? `, ${r.visa_type}` : ""}`,
    detail: (r) => r.reference || "",
    date: (r) => r.issued_date,
  },
  {
    key: "packages",
    code: "PK",
    label: "Package",
    param: "package_ids",
    collect: () => "package",
    who: (r) => r.lead_name || r.label,
    describe: (r) => r.label,
    detail: (r) =>
      [r.package_type, r.departure_date && `Departs ${fmtDate(r.departure_date)}`]
        .filter(Boolean)
        .join(" · "),
    date: (r) => r.issued_date,
  },
  {
    key: "cargo",
    code: "CG",
    label: "Cargo",
    param: "cargo_ids",
    collect: () => null,
    who: (r) => r.receiver_name || r.sender_name,
    describe: (r) => `${r.from_city} → ${r.to_city}`,
    detail: (r) => r.tracking_number || r.item_description || "",
    date: (r) => r.shipped_date,
  },
  {
    key: "opening_balances",
    code: "OB",
    label: "Opening balance",
    param: "opening_ids",
    collect: () => "opening",
    who: () => null,
    describe: (r) => r.reason,
    detail: (r) => String(r.service_type || "").replace(/_/g, " "),
    date: (r) => r.entry_date,
  },
];

const invoiceNo = (code, id) =>
  `INV-${code}-${String(id || "")
    .replace(/-/g, "")
    .slice(-6)
    .toUpperCase()}`;

const buildInvoices = (data) => {
  const out = [];
  KINDS.forEach((k) => {
    (data[k.key] || []).forEach((r) => {
      const opening = k.key === "opening_balances";
      const total = Number(opening ? r.amount : r.selling_price) || 0;
      const paid = Number(opening ? r.paid_amount : r.amount_paid) || 0;
      const balance = Number(r.balance) || 0;
      out.push({
        key: `${k.key}:${r.id}`,
        kind: k,
        record: r,
        number: invoiceNo(k.code, r.id),
        who: k.who(r) || data.customer.name,
        description: k.describe(r),
        detail: k.detail(r),
        date: k.date(r),
        total,
        paid,
        balance,
        status:
          r.payment_status ||
          (balance <= 0.001 ? "paid" : paid > 0.001 ? "partial" : "unpaid"),
        // A seat on somebody else's booking: listed, but not theirs to pay.
        notBilled: r.billed_to_me === false,
      });
    });
  });
  return out.sort(
    (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime(),
  );
};

/** The selection, in the shape the PDF endpoint takes: every kind named. */
const selectionOf = (invoices) => {
  const sel = Object.fromEntries(KINDS.map((k) => [k.param, []]));
  invoices.forEach((inv) => sel[inv.kind.param].push(inv.record.id));
  return sel;
};

/** Digits for wa.me. A local 0-number is read as Somali (+252). */
const whatsappNumber = (phone) => {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = `252${d.slice(1)}`;
  return d;
};

const slug = (s) =>
  String(s || "customer")
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase();

// ─── Share selected invoices ─────────────────────────────────────────────────
function ShareModal({ open, onClose, customer, business, invoices, file }) {
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (!open) return;
    setPhone(whatsappNumber(customer.phone));
    setEmail(customer.email || "");
  }, [open, customer]);

  const billed = invoices.filter((i) => !i.notBilled);
  const total = billed.reduce((a, i) => a + i.total, 0);
  const due = billed.reduce((a, i) => a + i.balance, 0);
  const n = invoices.length;

  const message = [
    `Hello ${customer.name},`,
    "",
    `Please find attached ${n === 1 ? "your invoice" : `${n} invoices`} (${invoices
      .map((i) => i.number)
      .join(", ")}).`,
    `Total: ${money(total)}`,
    `Balance due: ${money(due)}`,
    "",
    business?.name || "",
  ]
    .join("\n")
    .trim();

  const canNativeShare =
    !!file &&
    typeof navigator !== "undefined" &&
    navigator.canShare?.({ files: [file] });

  const download = () => file && downloadBlob(file, file.name);

  const nativeShare = async () => {
    try {
      await navigator.share({
        files: [file],
        title: file.name,
        text: message,
      });
      onClose();
    } catch (err) {
      if (err?.name !== "AbortError") toast.error("Could not open sharing");
    }
  };

  const viaWhatsApp = () => {
    download();
    window.open(
      `https://wa.me/${phone}?text=${encodeURIComponent(message)}`,
      "_blank",
      "noopener",
    );
  };

  const viaEmail = () => {
    download();
    const subject = `${n === 1 ? "Invoice" : "Invoices"} from ${business?.name || "us"}`;
    window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(message)}`;
  };

  return (
    <Modal open={open} onClose={onClose} title="Share invoices" size="sm">
      <div className="space-y-4">
        <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-3 text-sm">
          <p className="font-medium text-gray-900 dark:text-white">
            {n} invoice{n === 1 ? "" : "s"} · {money(total)}
          </p>
          <p className={due > 0.001 ? "text-red-600" : "text-green-600"}>
            {money(due)} due
          </p>
        </div>

        {!file ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : (
          <>
            {canNativeShare && (
              <Button className="w-full justify-center" onClick={nativeShare}>
                <Share2 className="w-4 h-4" /> Share PDF…
              </Button>
            )}
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Input
                  label="WhatsApp number"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                  placeholder="252618344223"
                />
              </div>
              <Button
                variant="outline"
                onClick={viaWhatsApp}
                disabled={!phone}
              >
                <MessageCircle className="w-4 h-4" /> WhatsApp
              </Button>
            </div>
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Input
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button variant="outline" onClick={viaEmail} disabled={!email}>
                <Mail className="w-4 h-4" /> Email
              </Button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              WhatsApp and Email open with the message written for you, and
              the PDF is downloaded so you can attach it.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function CustomerStatementPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const from = params.get("from") || "";
  const to = params.get("to") || "";

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const [paper, setPaper] = useState("A4");
  const [busy, setBusy] = useState(null);
  const [collectTarget, setCollectTarget] = useState(null);
  const [share, setShare] = useState(null); // { invoices, file }

  const range = useMemo(
    () => ({ from: from || undefined, to: to || undefined }),
    [from, to],
  );

  const load = useCallback(() => {
    setLoading(true);
    customersAPI
      .statement(id, undefined, range)
      .then((res) => setData(res.data.data))
      .catch(() => toast.error("Failed to load statement"))
      .finally(() => setLoading(false));
  }, [id, range]);

  useEffect(() => {
    load();
  }, [load]);

  const invoices = useMemo(() => (data ? buildInvoices(data) : []), [data]);

  // A new range can drop invoices that were ticked; forget those.
  useEffect(() => {
    const keys = new Set(invoices.map((i) => i.key));
    setSelected((prev) => new Set([...prev].filter((k) => keys.has(k))));
  }, [invoices]);

  const setRange = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const picked = invoices.filter((i) => selected.has(i.key));
  const allPicked = invoices.length > 0 && picked.length === invoices.length;
  const toggle = (key) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const toggleAll = () =>
    setSelected(allPicked ? new Set() : new Set(invoices.map((i) => i.key)));

  const invoicesPdf = async (list) => {
    const res = await customersAPI.invoicesPDF(id, selectionOf(list), paper);
    const name =
      list.length === 1
        ? `${list[0].number.toLowerCase()}.pdf`
        : `invoices-${slug(data.customer.name)}.pdf`;
    return new File([res.data], name, { type: "application/pdf" });
  };

  // Opened before the request so the browser treats it as the click's own
  // window rather than a popup, then pointed at the PDF once it arrives.
  const openPdf = async (list, tag) => {
    const win = window.open("", "_blank");
    if (!win) return toast.error("Allow pop-ups to view the invoice");
    win.document.title = "Preparing invoice…";
    setBusy(tag);
    try {
      const file = await invoicesPdf(list);
      win.location.href = URL.createObjectURL(file);
    } catch {
      win.close();
      toast.error("Could not prepare the invoice");
    } finally {
      setBusy(null);
    }
  };

  const downloadPicked = async () => {
    setBusy("download");
    try {
      const file = await invoicesPdf(picked);
      downloadBlob(file, file.name);
    } catch {
      toast.error("Could not prepare the PDF");
    } finally {
      setBusy(null);
    }
  };

  const sharePicked = async () => {
    const list = picked;
    setShare({ invoices: list, file: null });
    try {
      const file = await invoicesPdf(list);
      setShare((s) => (s ? { ...s, file } : s));
    } catch {
      setShare(null);
      toast.error("Could not prepare the PDF");
    }
  };

  const downloadStatement = async () => {
    setBusy("statement");
    try {
      const res = await customersAPI.statementPDF(id, undefined, paper, range);
      downloadBlob(
        res.data,
        `statement-${slug(data.customer.name)}-${paper.toLowerCase()}.pdf`,
      );
    } catch {
      toast.error("Failed to download PDF");
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return (
      <div className="flex justify-center py-16">
        {loading ? (
          <Spinner size="lg" />
        ) : (
          <EmptyState icon={FileText} title="Statement not found" />
        )}
      </div>
    );
  }

  const { customer, summary, payments = [] } = data;
  const held = Number(summary.deposit_held) || 0;
  const netDue = Number(summary.net_due) || 0;
  const tiles = [
    ["Services", summary.item_count, ""],
    ["Billed", money(summary.total_amount), ""],
    ["Paid", money(summary.total_paid), "text-green-600"],
    ["Balance", money(summary.total_balance), "text-red-600"],
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
  const pickedBilled = picked.filter((i) => !i.notBilled);
  const pickedDue = pickedBilled.reduce((a, i) => a + i.balance, 0);
  const received = payments.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const th =
    "text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            to="/customers"
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <ArrowLeft className="w-4 h-4" /> Customers
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
            {customer.name}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {[customer.phone, customer.email].filter(Boolean).join(" · ") ||
              "Customer statement"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              printStatement(
                data,
                user ? { name: user.name, role: user.title || user.role } : null,
                paper,
              )
            }
          >
            <Printer className="w-4 h-4" /> Print statement
          </Button>
          <Button
            size="sm"
            onClick={downloadStatement}
            loading={busy === "statement"}
          >
            <Download className="w-4 h-4" /> Statement PDF
          </Button>
        </div>
      </div>

      {/* Date range */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Input
            label="From"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setRange("from", e.target.value)}
          />
          <Input
            label="To"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setRange("to", e.target.value)}
          />
          {(from || to) && (
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              Clear
            </Button>
          )}
          {loading && <Spinner size="sm" className="mb-2.5" />}
          <p className="text-sm text-gray-500 dark:text-gray-400 ml-auto mb-2">
            {from || to
              ? `${from ? fmtDate(from) : "Start"} – ${to ? fmtDate(to) : "today"}`
              : "All time"}
          </p>
        </div>
      </Card>

      {/* Summary */}
      <div
        className={`grid gap-3 text-center grid-cols-2 ${
          tiles.length > 4 ? "sm:grid-cols-3 lg:grid-cols-6" : "sm:grid-cols-4"
        }`}
      >
        {tiles.map(([label, val, cls]) => (
          <Card key={label} className="p-3">
            <p className="text-xs text-gray-500 uppercase tracking-wide">
              {label}
            </p>
            <p className={`text-lg font-bold text-gray-900 dark:text-white ${cls}`}>
              {val}
            </p>
          </Card>
        ))}
      </div>

      {/* Invoices */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <FileText className="w-4 h-4" /> Invoices ({invoices.length})
          </h2>
          {picked.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {picked.length} selected · {money(pickedDue)} due
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => openPdf(picked, "print")}
                loading={busy === "print"}
              >
                <Printer className="w-4 h-4" /> Print
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={downloadPicked}
                loading={busy === "download"}
              >
                <Download className="w-4 h-4" /> Download
              </Button>
              <Button size="sm" onClick={sharePicked}>
                <Share2 className="w-4 h-4" /> Share
              </Button>
            </div>
          )}
        </div>

        {invoices.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No invoices"
            description={
              from || to
                ? "Nothing was sold to this customer in this date range."
                : "Nothing has been sold to this customer yet."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="px-4 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={allPicked}
                      ref={(el) => {
                        if (el)
                          el.indeterminate = picked.length > 0 && !allPicked;
                      }}
                      onChange={toggleAll}
                      className="rounded cursor-pointer"
                      title="Select all"
                    />
                  </th>
                  {[
                    "Invoice",
                    "Service",
                    "Date",
                    "Total",
                    "Paid",
                    "Balance",
                    "Status",
                    "",
                  ].map((h, i) => (
                    <th key={h || i} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {invoices.map((inv) => {
                  const collectKind = inv.kind.collect(inv.record);
                  return (
                    <tr
                      key={inv.key}
                      className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(inv.key)}
                          onChange={() => toggle(inv.key)}
                          className="rounded cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <p className="font-medium text-gray-900 dark:text-white">
                          {inv.number}
                        </p>
                        <p className="text-xs text-gray-500">
                          {inv.kind.label}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-gray-900 dark:text-white">
                          {inv.description}
                        </p>
                        <p className="text-xs text-gray-500">
                          {[inv.who !== customer.name && inv.who, inv.detail]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                        {fmtDate(inv.date)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {money(inv.total)}
                      </td>
                      <td className="px-4 py-3 text-green-600 whitespace-nowrap">
                        {money(inv.paid)}
                      </td>
                      <td
                        className={`px-4 py-3 font-semibold whitespace-nowrap ${
                          inv.balance > 0.001 ? "text-red-600" : "text-gray-400"
                        }`}
                      >
                        {money(inv.balance)}
                      </td>
                      <td className="px-4 py-3">
                        {inv.notBilled ? (
                          <Badge>not billed</Badge>
                        ) : (
                          <Badge variant={payBadge[inv.status] || "danger"}>
                            {inv.status}
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          {collectKind &&
                            !inv.notBilled &&
                            inv.balance > 0.001 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setCollectTarget({
                                    kind: collectKind,
                                    record: inv.record,
                                  })
                                }
                                title="Collect payment"
                                className="text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20"
                              >
                                <Banknote className="w-4 h-4" />
                              </Button>
                            )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openPdf([inv], inv.key)}
                            loading={busy === inv.key}
                            title="View invoice"
                          >
                            {busy !== inv.key && <Eye className="w-4 h-4" />}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Payments */}
      <Card>
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Banknote className="w-4 h-4" /> Payments ({payments.length})
          </h2>
          <span className="text-sm font-semibold text-green-600">
            {money(received)} received
          </span>
        </div>
        {payments.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
            No payments {from || to ? "in this date range" : "recorded yet"}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  {["Date", "Amount", "Paid by", "For", "Account", "Received by", ""].map(
                    (h, i) => (
                      <th key={h || i} className={th}>
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      {fmtDate(p.created_at, "dd MMM yyyy HH:mm")}
                    </td>
                    <td
                      className={`px-4 py-3 font-semibold whitespace-nowrap ${
                        Number(p.amount) < 0 ? "text-red-600" : "text-green-600"
                      }`}
                    >
                      {money(p.amount)}
                    </td>
                    <td className="px-4 py-3 text-gray-900 dark:text-white">
                      {p.payer_name || customer.name}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {p.opening_item_id
                        ? "Opening balance"
                        : p.passenger_name || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {p.account_name || p.method || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {p.collected_by_name || "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => printPaymentReceipt(p, customer)}
                        title="Print receipt"
                      >
                        <Printer className="w-4 h-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

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
              load();
            }}
            onCancel={() => setCollectTarget(null)}
          />
        )}
      </Modal>

      <ShareModal
        open={!!share}
        onClose={() => setShare(null)}
        customer={customer}
        business={data.business}
        invoices={share?.invoices || []}
        file={share?.file || null}
      />
    </div>
  );
}
