import React, { useState, useEffect, useCallback } from "react";
import { packagesAPI, customersAPI } from "../services/api";
import { useAuth } from "../context/AuthContext";
import {
  Button,
  Card,
  Badge,
  Spinner,
  Input,
  Select,
  Modal,
  Pagination,
  EmptyState,
  RowsPerPage,
} from "../components/ui";
import { PAYMENT_METHODS } from "../components/tickets/TicketForm";
import toast from "react-hot-toast";
import {
  Luggage,
  Plus,
  Pencil,
  Trash2,
  Banknote,
  Eye,
  Printer,
  X,
  Wallet,
  AlertTriangle,
} from "lucide-react";
import { fmtDate, toDateInput } from "../utils/date";

const money = (v) =>
  `$${Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TYPES = [
  { value: "umrah", label: "Umrah", variant: "success" },
  { value: "hajj", label: "Hajj", variant: "purple" },
  { value: "tour", label: "Tour", variant: "info" },
  { value: "custom", label: "Custom", variant: "default" },
];
const STATUSES = [
  { value: "quoted", label: "Quoted", variant: "default" },
  { value: "confirmed", label: "Confirmed", variant: "info" },
  { value: "in_progress", label: "In progress", variant: "warning" },
  { value: "completed", label: "Completed", variant: "success" },
  { value: "cancelled", label: "Cancelled", variant: "danger" },
];
const ITEM_TYPES = [
  "visa",
  "ticket",
  "hotel",
  "transport",
  "meals",
  "guide",
  "insurance",
  "other",
];
const meta = (list, v) => list.find((x) => x.value === v) || list[0];

const EMPTY_ITEM = { item_type: "other", description: "", quantity: "1", unit_cost: "", supplier: "" };
const EMPTY = {
  package_type: "umrah",
  label: "",
  lead_name: "",
  contact_number: "",
  pilgrim_count: "1",
  departure_date: "",
  return_date: "",
  status: "quoted",
  selling_price: "",
  amount_paid: "",
  payment_method: "cash",
  notes: "",
  customer_id: "",
};

const STARTERS = {
  umrah: [
    { item_type: "visa", description: "Umrah visa", quantity: "1", unit_cost: "", supplier: "" },
    { item_type: "ticket", description: "Return flight", quantity: "1", unit_cost: "", supplier: "" },
    { item_type: "hotel", description: "Makkah + Madinah hotel", quantity: "1", unit_cost: "", supplier: "" },
    { item_type: "transport", description: "Airport and ziyarah transport", quantity: "1", unit_cost: "", supplier: "" },
  ],
  hajj: [
    { item_type: "visa", description: "Hajj visa", quantity: "1", unit_cost: "", supplier: "" },
    { item_type: "ticket", description: "Return flight", quantity: "1", unit_cost: "", supplier: "" },
    { item_type: "hotel", description: "Accommodation", quantity: "1", unit_cost: "", supplier: "" },
    { item_type: "transport", description: "Internal transport", quantity: "1", unit_cost: "", supplier: "" },
    { item_type: "meals", description: "Meals", quantity: "1", unit_cost: "", supplier: "" },
  ],
};

const Tile = ({ label, value, tone = "gray", sub }) => {
  const tones = {
    gray: "text-gray-900 dark:text-white",
    green: "text-green-600 dark:text-green-400",
    red: "text-red-600 dark:text-red-400",
    blue: "text-blue-600 dark:text-blue-400",
    orange: "text-orange-600 dark:text-orange-400",
  };
  return (
    <Card className="p-5">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1.5 ${tones[tone]}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{sub}</p>}
    </Card>
  );
};

// ── Create / edit ────────────────────────────────────────────────────────────

function PackageModal({ open, onClose, onSaved, initialId }) {
  const [form, setForm] = useState(EMPTY);
  const [items, setItems] = useState([{ ...EMPTY_ITEM }]);
  const [customers, setCustomers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const editing = Boolean(initialId);

  useEffect(() => {
    if (!open) return;
    customersAPI.list({ limit: 100 }).then((r) => setCustomers(r.data.data || [])).catch(() => {});

    if (!initialId) {
      setForm(EMPTY);
      setItems(STARTERS.umrah.map((i) => ({ ...i })));
      return;
    }
    setLoading(true);
    packagesAPI
      .get(initialId)
      .then((r) => {
        const p = r.data.data.package;
        setForm({
          ...EMPTY,
          ...p,
          pilgrim_count: String(p.pilgrim_count ?? 1),
          selling_price: p.selling_price ?? "",
          departure_date: toDateInput(p.departure_date),
          return_date: toDateInput(p.return_date),
          customer_id: p.customer_id || "",
        });
        setItems(
          (r.data.data.items || []).map((i) => ({
            item_type: i.item_type,
            description: i.description,
            quantity: String(i.quantity),
            unit_cost: String(i.unit_cost),
            supplier: i.supplier || "",
          })),
        );
      })
      .catch(() => toast.error("Failed to load package"))
      .finally(() => setLoading(false));
  }, [open, initialId]);

  const set = (k) => (e) => {
    const val = e.target.value;
    setForm((f) => ({ ...f, [k]: val }));
    // Offer a sensible starting line-up when the type changes on a new package
    if (k === "package_type" && !editing && STARTERS[val]) {
      const untouched = items.every((i) => !i.unit_cost && !i.description.trim());
      const stillDefault = items.length === 0 || untouched || items.every((i) =>
        Object.values(STARTERS).some((list) => list.some((s) => s.description === i.description)),
      );
      if (stillDefault) setItems(STARTERS[val].map((i) => ({ ...i })));
    }
  };

  const setItem = (idx, key) => (e) => {
    const val = e.target.value;
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [key]: val } : it)));
  };
  const addItem = () => setItems((p) => [...p, { ...EMPTY_ITEM }]);
  const removeItem = (idx) => setItems((p) => p.filter((_, i) => i !== idx));

  const totalCost = items.reduce(
    (s, i) => s + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_cost) || 0),
    0,
  );
  const selling = parseFloat(form.selling_price) || 0;
  const profit = selling - totalCost;
  const margin = selling > 0 ? (profit / selling) * 100 : 0;

  const submit = async (e) => {
    e.preventDefault();
    if (!form.label.trim()) return toast.error("Give the package a name");
    const filled = items.filter((i) => i.description.trim());
    if (filled.length === 0) return toast.error("Add at least one cost line");
    if (!editing && (parseFloat(form.amount_paid) || 0) > selling)
      return toast.error("Amount paid cannot exceed the agreed price");

    setSaving(true);
    try {
      const payload = { ...form, customer_id: form.customer_id || undefined, items: filled };
      if (editing) {
        await packagesAPI.update(initialId, payload);
        toast.success("Package updated");
      } else {
        await packagesAPI.create(payload);
        toast.success("Package created");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to save package");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Edit package" : "New package"} size="xl">
      {loading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Package</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Select label="Type" value={form.package_type} onChange={set("package_type")}>
                {TYPES.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
              </Select>
              <Input label="Package name *" value={form.label} onChange={set("label")} placeholder="Umrah — Ramadan 2027" />
              <Select label="Status" value={form.status} onChange={set("status")}>
                {STATUSES.map((s) => (<option key={s.value} value={s.value}>{s.label}</option>))}
              </Select>
              <Input label="Lead traveller" value={form.lead_name} onChange={set("lead_name")} placeholder="HASSAN ALI" />
              <Input label="Phone number" value={form.contact_number} onChange={set("contact_number")} placeholder="+252 61 234 5678" />
              <Input label="Travellers" type="number" min="1" value={form.pilgrim_count} onChange={set("pilgrim_count")} />
              <Input label="Departure" type="date" value={form.departure_date} onChange={set("departure_date")} />
              <Input label="Return" type="date" value={form.return_date} onChange={set("return_date")} min={form.departure_date || undefined} />
              <Select label="Link to customer" value={form.customer_id} onChange={set("customer_id")}>
                <option value="">Not linked</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>
                ))}
              </Select>
            </div>
          </div>

          {/* Cost lines */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                What it costs us
              </h3>
              <Button type="button" variant="outline" size="sm" onClick={addItem}>
                <Plus className="w-3.5 h-3.5" /> Add line
              </Button>
            </div>

            <div className="space-y-2">
              {items.map((it, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-3">
                    <Select value={it.item_type} onChange={setItem(idx, "item_type")}>
                      {ITEM_TYPES.map((t) => (
                        <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                      ))}
                    </Select>
                  </div>
                  <div className="col-span-4">
                    <Input value={it.description} onChange={setItem(idx, "description")} placeholder="Description" />
                  </div>
                  <div className="col-span-1">
                    <Input type="number" min="1" step="1" value={it.quantity} onChange={setItem(idx, "quantity")} placeholder="Qty" />
                  </div>
                  <div className="col-span-2">
                    <Input type="number" min="0" step="0.01" value={it.unit_cost} onChange={setItem(idx, "unit_cost")} placeholder="Cost" />
                  </div>
                  <div className="col-span-1 text-right text-sm font-medium text-gray-700 dark:text-gray-300 pb-2">
                    {money((parseFloat(it.quantity) || 0) * (parseFloat(it.unit_cost) || 0))}
                  </div>
                  <div className="col-span-1 pb-1">
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-gray-700"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Negotiated price */}
          <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-4">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 items-end">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Total cost</p>
                <p className="text-xl font-bold text-orange-600 dark:text-orange-400 mt-1">{money(totalCost)}</p>
              </div>
              <Input
                label="Agreed price *"
                type="number"
                min="0"
                step="0.01"
                value={form.selling_price}
                onChange={set("selling_price")}
                placeholder="Negotiated"
              />
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Profit</p>
                <p className={`text-xl font-bold mt-1 ${profit >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600"}`}>
                  {money(profit)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Margin</p>
                <p className={`text-xl font-bold mt-1 ${margin >= 0 ? "text-gray-900 dark:text-white" : "text-red-600"}`}>
                  {selling > 0 ? `${margin.toFixed(1)}%` : "—"}
                </p>
              </div>
            </div>
            {!editing && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <Input label="Deposit paid now" type="number" min="0" step="0.01" value={form.amount_paid} onChange={set("amount_paid")} placeholder="0.00" />
                <Select
                  label="Payment method"
                  value={form.payment_method}
                  onChange={set("payment_method")}
                  disabled={!(parseFloat(form.amount_paid) > 0)}
                >
                  {PAYMENT_METHODS.map((m) => (<option key={m.value} value={m.value}>{m.label}</option>))}
                </Select>
              </div>
            )}
          </div>

          <Input label="Notes" value={form.notes} onChange={set("notes")} placeholder="What was agreed" />

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={saving}>{editing ? "Save changes" : "Create package"}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ── Detail / quote ───────────────────────────────────────────────────────────

const printQuote = (pkg, items) => {
  const rows = items
    .map(
      (i, n) => `<tr><td>${n + 1}</td><td>${i.item_type}</td><td>${i.description}</td>
        <td>${i.quantity}</td><td>$${Number(i.unit_cost).toFixed(2)}</td>
        <td>$${Number(i.line_cost).toFixed(2)}</td></tr>`,
    )
    .join("");
  const html = `<!DOCTYPE html><html><head><title>Package — ${pkg.label}</title><style>
    body{font-family:Arial,sans-serif;margin:32px;color:#111}
    h1{font-size:20px;margin:0 0 4px;text-align:center}
    .sub{text-align:center;color:#666;font-size:12px;margin-bottom:20px}
    .info{font-size:13px;margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px}
    th{background:#1d4ed8;color:#fff;text-align:left;padding:6px}
    td{padding:6px;border-bottom:1px solid #e5e7eb}
    tr:nth-child(even) td{background:#f8faff}
    .tot{display:flex;gap:10px;margin-top:16px}
    .box{flex:1;border:1px solid #c7d7ff;background:#f8faff;border-radius:8px;padding:10px}
    .box .l{font-size:10px;color:#1d4ed8;font-weight:bold;text-transform:uppercase}
    .box .v{font-size:18px;font-weight:bold}
    @media print{body{margin:12mm}}
  </style></head><body>
    <h1>${pkg.label}</h1>
    <p class="sub">${String(pkg.package_type).toUpperCase()} package · Generated ${new Date().toLocaleString("en-GB")}</p>
    <p class="info"><strong>${pkg.lead_name || pkg.customer_name || "—"}</strong>
      ${pkg.contact_number ? " · " + pkg.contact_number : ""}
      · ${pkg.pilgrim_count} traveller(s)
      ${pkg.departure_date ? " · Departs " + new Date(pkg.departure_date).toLocaleDateString("en-GB") : ""}</p>
    <table><thead><tr><th>#</th><th>Type</th><th>Description</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="tot">
      <div class="box"><div class="l">Package price</div><div class="v">$${Number(pkg.selling_price).toFixed(2)}</div></div>
      <div class="box"><div class="l">Paid</div><div class="v" style="color:#15803d">$${Number(pkg.amount_paid).toFixed(2)}</div></div>
      <div class="box"><div class="l">Balance</div><div class="v" style="color:#b91c1c">$${(Number(pkg.selling_price) - Number(pkg.amount_paid)).toFixed(2)}</div></div>
    </div>
    <script>window.onload=function(){window.print()}</script>
  </body></html>`;
  const win = window.open("", "_blank");
  if (!win) return toast.error("Allow pop-ups to print");
  win.document.write(html);
  win.document.close();
};

function DetailModal({ open, onClose, packageId, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!packageId) return;
    setLoading(true);
    packagesAPI
      .get(packageId)
      .then((r) => setData(r.data.data))
      .catch(() => toast.error("Failed to load package"))
      .finally(() => setLoading(false));
  }, [packageId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} title="Package detail" size="lg">
      {loading || !data ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{data.package.label}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {data.package.lead_name || data.package.customer_name || "—"}
                {data.package.contact_number ? ` · ${data.package.contact_number}` : ""}
                {` · ${data.package.pilgrim_count} traveller(s)`}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => printQuote(data.package, data.items)}>
              <Printer className="w-4 h-4" /> Print quote
            </Button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              ["Cost", money(data.package.total_cost), "text-orange-600"],
              ["Price", money(data.package.selling_price), "text-gray-900 dark:text-white"],
              ["Profit", money(data.package.revenue), Number(data.package.revenue) >= 0 ? "text-green-600" : "text-red-600"],
              ["Balance", money(Number(data.package.selling_price) - Number(data.package.amount_paid)), "text-red-600"],
            ].map(([l, v, cls]) => (
              <div key={l} className="px-3 py-2 rounded-xl bg-gray-50 dark:bg-gray-700/40">
                <p className="text-xs text-gray-500 uppercase">{l}</p>
                <p className={`text-base font-bold ${cls}`}>{v}</p>
              </div>
            ))}
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Cost lines</h4>
            <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {data.items.map((i) => (
                    <tr key={i.id}>
                      <td className="px-3 py-2"><Badge>{i.item_type}</Badge></td>
                      <td className="px-3 py-2 text-gray-900 dark:text-white">{i.description}</td>
                      <td className="px-3 py-2 text-gray-500 text-right">{i.quantity} × {money(i.unit_cost)}</td>
                      <td className="px-3 py-2 text-right font-semibold text-gray-900 dark:text-white">{money(i.line_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {data.payments.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Payments</h4>
              <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {data.payments.map((p) => (
                      <tr key={p.id}>
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(p.created_at, "dd MMM yyyy HH:mm")}</td>
                        <td className="px-3 py-2 font-semibold text-green-600">{money(p.amount)}</td>
                        <td className="px-3 py-2 text-gray-500 capitalize">{p.method}</td>
                        <td className="px-3 py-2 text-gray-500">{p.collected_by_name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── Collect ──────────────────────────────────────────────────────────────────

function CollectModal({ open, onClose, pkg, onDone }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [saving, setSaving] = useState(false);
  const balance = pkg ? Number(pkg.selling_price) - Number(pkg.amount_paid) : 0;

  useEffect(() => {
    if (open) { setAmount(balance > 0 ? balance.toFixed(2) : ""); setMethod("cash"); }
  }, [open, balance]);

  const submit = async (e) => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (!val || val <= 0) return toast.error("Enter a valid amount");
    if (val > balance + 0.001) return toast.error(`Amount exceeds balance (${money(balance)})`);
    setSaving(true);
    try {
      const res = await packagesAPI.addPayment(pkg.id, { amount: val, method });
      toast.success(res.data.message);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to collect");
    } finally {
      setSaving(false);
    }
  };

  if (!pkg) return null;
  return (
    <Modal open={open} onClose={onClose} title="Collect payment">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-4 text-center">
          <p className="text-sm text-gray-600 dark:text-gray-300">{pkg.label}</p>
          <p className="text-2xl font-bold text-red-600 mt-1">{money(balance)}</p>
          <p className="text-xs text-gray-400 mt-0.5">outstanding</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Amount *" type="number" min="0.01" step="0.01" max={balance} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Select label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
            {PAYMENT_METHODS.map((m) => (<option key={m.value} value={m.value}>{m.label}</option>))}
          </Select>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}><Banknote className="w-4 h-4" /> Collect</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PackagesPage() {
  const { hasRole } = useAuth();
  const canWrite = hasRole("admin", "agent");
  const canDelete = hasRole("admin");

  const [data, setData] = useState(null);
  const [pageMeta, setPageMeta] = useState({ total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [filters, setFilters] = useState({ search: "", package_type: "", status: "", only_due: false });

  const [modal, setModal] = useState({ open: false, id: null });
  const [detail, setDetail] = useState(null);
  const [collect, setCollect] = useState(null);

  const setFilter = (k) => (e) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    packagesAPI
      .list({ ...filters, page, limit })
      .then((r) => { setData(r.data.data); setPageMeta(r.data.meta); })
      .catch((err) => setError(err.response?.data?.message || "Failed to load packages"))
      .finally(() => setLoading(false));
  }, [filters, page, limit]);

  useEffect(() => { load(); }, [load]);

  const remove = async (p) => {
    if (!window.confirm(`Delete "${p.label}"?`)) return;
    try {
      await packagesAPI.delete(p.id);
      toast.success("Package deleted");
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to delete");
    }
  };

  const packages = data?.packages || [];
  const s = data?.summary || {};

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Packages</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Hajj, Umrah and custom bundles · {pageMeta.total} package{pageMeta.total === 1 ? "" : "s"}
            {s.total_travellers ? ` · ${s.total_travellers} traveller(s)` : ""}
          </p>
        </div>
        {canWrite && (
          <Button onClick={() => setModal({ open: true, id: null })}>
            <Plus className="w-4 h-4" /> New package
          </Button>
        )}
      </div>

      {error ? (
        <Card className="p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-gray-900 dark:text-white">Couldn't load packages</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{error}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile label="Package sales" value={money(s.total_sales)} tone="blue" />
            <Tile label="Total cost" value={money(s.total_cost)} tone="orange" />
            <Tile label="Profit" value={money(s.total_revenue)} tone="green" />
            <Tile label="Balance due" value={money(s.total_balance)} tone={s.total_balance > 0 ? "red" : "green"} sub={`${money(s.total_collected)} collected`} />
          </div>

          <Card className="p-4">
            <div className="flex flex-wrap gap-3 items-center">
              <Input placeholder="Search name, traveller, phone…" value={filters.search} onChange={setFilter("search")} className="flex-1 min-w-48" />
              <Select value={filters.package_type} onChange={setFilter("package_type")} className="w-36">
                <option value="">All types</option>
                {TYPES.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
              </Select>
              <Select value={filters.status} onChange={setFilter("status")} className="w-40">
                <option value="">All statuses</option>
                {STATUSES.map((st) => (<option key={st.value} value={st.value}>{st.label}</option>))}
              </Select>
              <button
                onClick={() => { setFilters((f) => ({ ...f, only_due: !f.only_due })); setPage(1); }}
                className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                  filters.only_due
                    ? "bg-red-50 border-red-300 text-red-600 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400"
                    : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300"
                }`}
              >
                <Wallet className="w-4 h-4" /> Unpaid only
              </button>
              <RowsPerPage value={limit} onChange={(n) => { setLimit(n); setPage(1); }} />
            </div>
          </Card>

          <Card>
            {loading ? (
              <div className="flex justify-center py-16"><Spinner size="lg" /></div>
            ) : packages.length === 0 ? (
              <EmptyState
                icon={Luggage}
                title="No packages yet"
                description="Build a Hajj or Umrah package from its cost lines, then quote the customer your price."
                action={canWrite && (
                  <Button onClick={() => setModal({ open: true, id: null })}>
                    <Plus className="w-4 h-4" /> New package
                  </Button>
                )}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      {["Package", "Type", "Lead traveller", "Departs", "Pax", "Status", "Cost", "Price", "Profit", "Paid", "Balance", ""].map((h, i) => (
                        <th key={i} className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                    {packages.map((p) => {
                      const balance = Number(p.selling_price) - Number(p.amount_paid);
                      const tm = meta(TYPES, p.package_type);
                      const sm = meta(STATUSES, p.status);
                      return (
                        <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                          <td className="px-4 py-3">
                            <p className="font-medium text-gray-900 dark:text-white">{p.label}</p>
                            <p className="text-xs text-gray-400">{p.item_count} line(s)</p>
                          </td>
                          <td className="px-4 py-3"><Badge variant={tm.variant}>{tm.label}</Badge></td>
                          <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                            {p.lead_name || p.customer_name || "—"}
                            {p.contact_number && <p className="text-xs text-gray-400">{p.contact_number}</p>}
                          </td>
                          <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{fmtDate(p.departure_date)}</td>
                          <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{p.pilgrim_count}</td>
                          <td className="px-4 py-3"><Badge variant={sm.variant}>{sm.label}</Badge></td>
                          <td className="px-4 py-3 text-orange-600 dark:text-orange-400">{money(p.total_cost)}</td>
                          <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{money(p.selling_price)}</td>
                          <td className={`px-4 py-3 font-semibold ${Number(p.revenue) >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600"}`}>{money(p.revenue)}</td>
                          <td className="px-4 py-3 text-green-600 dark:text-green-400">{money(p.amount_paid)}</td>
                          <td className={`px-4 py-3 font-semibold ${balance > 0 ? "text-red-600" : "text-gray-400"}`}>{money(balance)}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              <button onClick={() => setDetail(p.id)} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-gray-700">
                                <Eye className="w-4 h-4" />
                              </button>
                              {balance > 0 && (
                                <Button size="sm" onClick={() => setCollect(p)}>
                                  <Banknote className="w-3.5 h-3.5" /> Collect
                                </Button>
                              )}
                              {canWrite && (
                                <button onClick={() => setModal({ open: true, id: p.id })} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-gray-700">
                                  <Pencil className="w-4 h-4" />
                                </button>
                              )}
                              {canDelete && (
                                <button onClick={() => remove(p)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-gray-700">
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="px-4 pb-4">
              <Pagination page={page} totalPages={pageMeta.totalPages} onChange={setPage} />
            </div>
          </Card>
        </>
      )}

      <PackageModal
        open={modal.open}
        initialId={modal.id}
        onClose={() => setModal({ open: false, id: null })}
        onSaved={load}
      />
      <DetailModal open={Boolean(detail)} packageId={detail} onClose={() => setDetail(null)} onChanged={load} />
      <CollectModal open={Boolean(collect)} pkg={collect} onClose={() => setCollect(null)} onDone={load} />
    </div>
  );
}
