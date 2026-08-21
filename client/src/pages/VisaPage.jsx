import React, { useState, useEffect, useCallback } from "react";
import { visasAPI, customersAPI } from "../services/api";
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
  Stamp,
  Plus,
  Pencil,
  Trash2,
  Banknote,
  Eye,
  Wallet,
  AlertTriangle,
} from "lucide-react";
import { fmtDate, toDateInput } from "../utils/date";

const money = (v) =>
  `$${Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUSES = [
  { value: "applied", label: "Applied", variant: "info" },
  { value: "processing", label: "Processing", variant: "warning" },
  { value: "approved", label: "Approved", variant: "success" },
  { value: "rejected", label: "Rejected", variant: "danger" },
  { value: "collected", label: "Collected", variant: "purple" },
  { value: "cancelled", label: "Cancelled", variant: "default" },
];
const statusMeta = (s) => STATUSES.find((x) => x.value === s) || STATUSES[0];

const EMPTY = {
  applicant_name: "",
  contact_number: "",
  passport_number: "",
  nationality: "",
  destination_country: "",
  visa_type: "",
  reference: "",
  applied_date: new Date().toISOString().slice(0, 10),
  decision_date: "",
  expiry_date: "",
  status: "applied",
  cost_price: "",
  service_fee: "",
  amount_paid: "",
  payment_method: "cash",
  notes: "",
  customer_id: "",
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

// ── Add / edit ───────────────────────────────────────────────────────────────

function VisaModal({ open, onClose, onSaved, initial }) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [customers, setCustomers] = useState([]);
  const editing = Boolean(initial?.id);

  useEffect(() => {
    if (!open) return;
    setForm(
      initial
        ? {
            ...EMPTY,
            ...initial,
            applied_date: toDateInput(initial.applied_date),
            decision_date: toDateInput(initial.decision_date),
            expiry_date: toDateInput(initial.expiry_date),
            cost_price: initial.cost_price ?? "",
            service_fee:
              initial.selling_price !== undefined && initial.cost_price !== undefined
                ? String(
                    Math.round(
                      (Number(initial.selling_price) - Number(initial.cost_price)) * 100,
                    ) / 100,
                  )
                : "",
            amount_paid: initial.amount_paid ?? "",
            customer_id: initial.customer_id || "",
          }
        : EMPTY,
    );
    customersAPI
      .list({ limit: 100 })
      .then((r) => setCustomers(r.data.data || []))
      .catch(() => {});
  }, [open, initial]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // The customer pays our cost plus our commission. Never entered by hand,
  // so the two can't disagree.
  const totalCharged =
    (parseFloat(form.cost_price) || 0) + (parseFloat(form.service_fee) || 0);
  const balanceDue = totalCharged - (parseFloat(form.amount_paid) || 0);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.applicant_name.trim()) return toast.error("Applicant name is required");
    if (!form.destination_country.trim()) return toast.error("Destination country is required");
    if (!editing && (parseFloat(form.amount_paid) || 0) > totalCharged)
      return toast.error("Amount paid cannot exceed the total charged");

    setSaving(true);
    try {
      const payload = {
        ...form,
        // The server stores cost and total; commission is the difference
        selling_price: totalCharged,
        customer_id: form.customer_id || undefined,
      };
      if (editing) {
        await visasAPI.update(initial.id, payload);
        toast.success("Visa application updated");
      } else {
        await visasAPI.create(payload);
        toast.success("Visa application recorded");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Edit visa application" : "New visa application"} size="lg">
      <form onSubmit={submit} className="space-y-5">
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Applicant</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Full name *" value={form.applicant_name} onChange={set("applicant_name")} placeholder="HASSAN ALI" />
            <Input label="Phone number" value={form.contact_number} onChange={set("contact_number")} placeholder="+252 61 234 5678" />
            <Input label="Passport number" value={form.passport_number} onChange={set("passport_number")} placeholder="A12345678" />
            <Input label="Nationality" value={form.nationality} onChange={set("nationality")} placeholder="Somali" />
          </div>
          <div className="mt-4">
            <Select label="Link to customer (optional)" value={form.customer_id} onChange={set("customer_id")}>
              <option value="">Not linked</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.phone ? ` · ${c.phone}` : ""}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Visa</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input label="Destination country *" value={form.destination_country} onChange={set("destination_country")} placeholder="Saudi Arabia" />
            <Input label="Visa type" value={form.visa_type} onChange={set("visa_type")} placeholder="Umrah / Work / Visit" />
            <Input label="Reference" value={form.reference} onChange={set("reference")} placeholder="Application no." />
            <Input label="Applied date" type="date" value={form.applied_date} onChange={set("applied_date")} />
            {editing && <Input label="Decision date" type="date" value={form.decision_date} onChange={set("decision_date")} />}
            <Input label="Visa expiry" type="date" value={form.expiry_date} onChange={set("expiry_date")} />
            <Select label="Status" value={form.status} onChange={set("status")}>
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </Select>
          </div>
        </div>

        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Money</h3>
          {/* Enter what it costs and what you add — the total is never typed */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input
              label="Our cost (embassy fee)"
              type="number" min="0" step="0.01"
              value={form.cost_price}
              onChange={set("cost_price")}
              placeholder="0.00"
            />
            <Input
              label="Your commission *"
              type="number" min="0" step="0.01"
              value={form.service_fee}
              onChange={set("service_fee")}
              placeholder="0.00"
            />
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Total charged to customer
              </label>
              <div className="px-3 py-2 rounded-lg border text-sm font-bold bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-900/20 dark:border-blue-800 dark:text-blue-300">
                {money(totalCharged)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
            <Input
              label="Amount paid now"
              type="number" min="0" step="0.01"
              max={editing ? undefined : totalCharged || undefined}
              value={form.amount_paid}
              onChange={set("amount_paid")}
              placeholder="0.00"
              disabled={editing}
            />
            <Select
              label="Payment method"
              value={form.payment_method}
              onChange={set("payment_method")}
              disabled={editing || !(parseFloat(form.amount_paid) > 0)}
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </Select>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Balance
              </label>
              <div className={`px-3 py-2 rounded-lg border text-sm font-semibold ${
                balanceDue > 0
                  ? "bg-red-50 border-red-200 text-red-600 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400"
                  : "bg-green-50 border-green-200 text-green-600 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400"
              }`}>
                {money(balanceDue)}
              </div>
            </div>
          </div>

          {editing && (
            <p className="text-xs text-gray-400 mt-3">
              Payments are managed with the Collect button, so the ledger stays accurate.
            </p>
          )}
        </div>

        <Input label="Notes" value={form.notes} onChange={set("notes")} placeholder="Anything worth remembering" />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>{editing ? "Save changes" : "Record application"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Collect payment ──────────────────────────────────────────────────────────

function CollectModal({ open, onClose, visa, onDone }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [saving, setSaving] = useState(false);
  const balance = visa ? Number(visa.selling_price) - Number(visa.amount_paid) : 0;

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
      const res = await visasAPI.addPayment(visa.id, { amount: val, method });
      toast.success(res.data.message);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to collect");
    } finally {
      setSaving(false);
    }
  };

  if (!visa) return null;
  return (
    <Modal open={open} onClose={onClose} title="Collect payment">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-4 text-center">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {visa.applicant_name} · {visa.destination_country}
          </p>
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

export default function VisaPage() {
  const { hasRole } = useAuth();
  const canWrite = hasRole("admin", "agent");
  const canDelete = hasRole("admin");

  const [data, setData] = useState(null);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [filters, setFilters] = useState({ search: "", status: "", country: "", only_due: false });

  const [modal, setModal] = useState({ open: false, initial: null });
  const [collect, setCollect] = useState(null);
  const [view, setView] = useState(null);

  const setFilter = (k) => (e) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    visasAPI
      .list({ ...filters, page, limit })
      .then((r) => { setData(r.data.data); setMeta(r.data.meta); })
      .catch((err) => setError(err.response?.data?.message || "Failed to load visa applications"))
      .finally(() => setLoading(false));
  }, [filters, page, limit]);

  useEffect(() => { load(); }, [load]);

  const remove = async (v) => {
    if (!window.confirm(`Delete the visa application for ${v.applicant_name}?`)) return;
    try {
      await visasAPI.delete(v.id);
      toast.success("Deleted");
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to delete");
    }
  };

  const visas = data?.visas || [];
  const s = data?.summary || {};

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Visa services</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {meta.total} application{meta.total === 1 ? "" : "s"}
          </p>
        </div>
        {canWrite && (
          <Button onClick={() => setModal({ open: true, initial: null })}>
            <Plus className="w-4 h-4" /> New application
          </Button>
        )}
      </div>

      {error ? (
        <Card className="p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-gray-900 dark:text-white">Couldn't load visa applications</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{error}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile label="Charged" value={money(s.total_charged)} tone="blue" />
            <Tile label="Our cost" value={money(s.total_cost)} tone="orange" />
            <Tile label="Commission earned" value={money(s.total_revenue)} tone="green" />
            <Tile label="Balance due" value={money(s.total_balance)} tone={s.total_balance > 0 ? "red" : "green"} sub={`${money(s.total_collected)} collected`} />
          </div>

          <Card className="p-4">
            <div className="flex flex-wrap gap-3 items-center">
              <Input placeholder="Search name, passport, phone…" value={filters.search} onChange={setFilter("search")} className="flex-1 min-w-48" />
              <Select value={filters.status} onChange={setFilter("status")} className="w-40">
                <option value="">All statuses</option>
                {STATUSES.map((st) => (<option key={st.value} value={st.value}>{st.label}</option>))}
              </Select>
              <Select value={filters.country} onChange={setFilter("country")} className="w-44">
                <option value="">All countries</option>
                {(data?.countries || []).map((c) => (<option key={c} value={c}>{c}</option>))}
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
            ) : visas.length === 0 ? (
              <EmptyState
                icon={Stamp}
                title="No visa applications"
                description="Record a visa you are handling for a customer and track the fee you charge."
                action={canWrite && (
                  <Button onClick={() => setModal({ open: true, initial: null })}>
                    <Plus className="w-4 h-4" /> New application
                  </Button>
                )}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      {["Applicant", "Phone", "Destination", "Type", "Applied", "Status", "Cost", "Charged", "Commission", "Paid", "Balance", ""].map((h, i) => (
                        <th key={i} className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                    {visas.map((v) => {
                      const balance = Number(v.selling_price) - Number(v.amount_paid);
                      const st = statusMeta(v.status);
                      return (
                        <tr key={v.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                          <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">{v.applicant_name}</td>
                          <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{v.contact_number || "—"}</td>
                          <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{v.destination_country}</td>
                          <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{v.visa_type || "—"}</td>
                          <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{fmtDate(v.applied_date)}</td>
                          <td className="px-4 py-3"><Badge variant={st.variant}>{st.label}</Badge></td>
                          <td className="px-4 py-3 text-orange-600 dark:text-orange-400">{money(v.cost_price)}</td>
                          <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{money(v.selling_price)}</td>
                          <td className="px-4 py-3 font-semibold text-green-600 dark:text-green-400">{money(v.revenue)}</td>
                          <td className="px-4 py-3 text-green-600 dark:text-green-400">{money(v.amount_paid)}</td>
                          <td className={`px-4 py-3 font-semibold ${balance > 0 ? "text-red-600" : "text-gray-400"}`}>{money(balance)}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              <button onClick={() => setView(v)} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-gray-700">
                                <Eye className="w-4 h-4" />
                              </button>
                              {balance > 0 && (
                                <Button size="sm" onClick={() => setCollect(v)}>
                                  <Banknote className="w-3.5 h-3.5" /> Collect
                                </Button>
                              )}
                              {canWrite && (
                                <button onClick={() => setModal({ open: true, initial: v })} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-gray-700">
                                  <Pencil className="w-4 h-4" />
                                </button>
                              )}
                              {canDelete && (
                                <button onClick={() => remove(v)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-gray-700">
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
              <Pagination page={page} totalPages={meta.totalPages} onChange={setPage} />
            </div>
          </Card>
        </>
      )}

      <VisaModal
        open={modal.open}
        initial={modal.initial}
        onClose={() => setModal({ open: false, initial: null })}
        onSaved={load}
      />
      <CollectModal open={Boolean(collect)} visa={collect} onClose={() => setCollect(null)} onDone={load} />

      <Modal open={Boolean(view)} onClose={() => setView(null)} title="Visa application">
        {view && (
          <div className="space-y-2">
            {[
              ["Applicant", view.applicant_name],
              ["Phone", view.contact_number || "—"],
              ["Passport", view.passport_number || "—"],
              ["Nationality", view.nationality || "—"],
              ["Destination", view.destination_country],
              ["Visa type", view.visa_type || "—"],
              ["Reference", view.reference || "—"],
              ["Applied", fmtDate(view.applied_date)],
              ["Decision", fmtDate(view.decision_date)],
              ["Expiry", fmtDate(view.expiry_date)],
              ["Status", statusMeta(view.status).label],
              ["Our cost", money(view.cost_price)],
              ["Charged", money(view.selling_price)],
              ["Commission", money(view.revenue)],
              ["Paid", money(view.amount_paid)],
              ["Balance", money(Number(view.selling_price) - Number(view.amount_paid))],
              ["Recorded by", view.created_by_name || "—"],
              ["Notes", view.notes || "—"],
            ].map(([k, val]) => (
              <div key={k} className="flex justify-between py-1.5 border-b border-gray-100 dark:border-gray-700/60">
                <span className="text-sm text-gray-500 dark:text-gray-400">{k}</span>
                <span className="text-sm font-medium text-gray-900 dark:text-white text-right">{val}</span>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
