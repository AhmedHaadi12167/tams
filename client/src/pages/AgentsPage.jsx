import React, { useState, useEffect, useCallback } from "react";
import { agentsAPI } from "../services/api";
import { useAuth } from "../context/AuthContext";
import {
  Button,
  Card,
  Badge,
  Spinner,
  Input,
  Select,
  Modal,
  EmptyState,
} from "../components/ui";
import { PAYMENT_METHODS } from "../components/tickets/TicketForm";
import toast from "react-hot-toast";
import {
  UserRound,
  Plus,
  Pencil,
  Trash2,
  Banknote,
  Phone,
  ArrowLeft,
  AlertTriangle,
  Wallet,
  CheckCircle2,
} from "lucide-react";
import { fmtDate } from "../utils/date";

const money = (v) =>
  `$${Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const EMPTY_AGENT = {
  name: "",
  phone: "",
  email: "",
  id_number: "",
  notes: "",
  is_active: true,
};

const Tile = ({ label, value, sub, tone = "gray", icon: Icon }) => {
  const tones = {
    gray: "text-gray-900 dark:text-white",
    green: "text-green-600 dark:text-green-400",
    red: "text-red-600 dark:text-red-400",
    blue: "text-blue-600 dark:text-blue-400",
  };
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            {label}
          </p>
          <p className={`text-2xl font-bold mt-1.5 ${tones[tone]}`}>{value}</p>
          {sub && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{sub}</p>
          )}
        </div>
        {Icon && <Icon className="w-5 h-5 text-gray-300 dark:text-gray-600 shrink-0" />}
      </div>
    </Card>
  );
};

// ── Agent add / edit ─────────────────────────────────────────────────────────

function AgentModal({ open, onClose, onSaved, initial }) {
  const [form, setForm] = useState(EMPTY_AGENT);
  const [saving, setSaving] = useState(false);
  const editing = Boolean(initial?.id);

  useEffect(() => {
    if (open) setForm(initial ? { ...EMPTY_AGENT, ...initial } : EMPTY_AGENT);
  }, [open, initial]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return toast.error("Agent name is required");
    setSaving(true);
    try {
      if (editing) {
        await agentsAPI.update(initial.id, form);
        toast.success("Agent updated");
      } else {
        await agentsAPI.create(form);
        toast.success("Agent added");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to save agent");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Edit agent" : "Add agent"}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Full name *" value={form.name} onChange={set("name")} placeholder="Ahmed Hassan" />
          <Input label="Phone number" value={form.phone} onChange={set("phone")} placeholder="+252 61 234 5678" />
          <Input label="Email" type="email" value={form.email} onChange={set("email")} placeholder="optional" />
          <Input label="ID number" value={form.id_number} onChange={set("id_number")} placeholder="optional" />
        </div>
        <Input label="Notes" value={form.notes} onChange={set("notes")} placeholder="How you know them, terms agreed…" />
        {editing && (
          <Select
            label="Status"
            value={String(form.is_active)}
            onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.value === "true" }))}
          >
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>{editing ? "Save changes" : "Add agent"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Pay commission ───────────────────────────────────────────────────────────

function PayModal({ open, onClose, agent, onPaid }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const balance = Number(agent?.balance) || 0;

  useEffect(() => {
    if (open) {
      setAmount(balance > 0 ? balance.toFixed(2) : "");
      setMethod("cash");
      setReference("");
    }
  }, [open, balance]);

  const submit = async (e) => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (!val || val <= 0) return toast.error("Enter a valid amount");
    if (val > balance + 0.001)
      return toast.error(`Amount exceeds what is owed (${money(balance)})`);
    setSaving(true);
    try {
      const res = await agentsAPI.pay(agent.agent_id || agent.id, {
        amount: val,
        method,
        reference: reference || undefined,
      });
      toast.success(res.data.message);
      onPaid();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || "Payment failed");
    } finally {
      setSaving(false);
    }
  };

  if (!agent) return null;

  return (
    <Modal open={open} onClose={onClose} title="Pay commission">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-4 text-center">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {agent.agent_name || agent.name}
            {agent.phone ? ` · ${agent.phone}` : ""}
          </p>
          <p className="text-2xl font-bold text-red-600 mt-1">{money(balance)}</p>
          <p className="text-xs text-gray-400 mt-0.5">outstanding commission</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Amount to pay *"
            type="number"
            min="0.01"
            step="0.01"
            max={balance}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Select label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </Select>
        </div>
        <Input
          label="Reference (optional)"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Transfer or receipt number"
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>
            <Banknote className="w-4 h-4" /> Pay {amount ? money(amount) : ""}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Agent detail ─────────────────────────────────────────────────────────────

function AgentDetail({ agentId, onBack, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [payOpen, setPayOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    agentsAPI
      .get(agentId)
      .then((r) => setData(r.data.data))
      .catch((err) => toast.error(err.response?.data?.message || "Failed to load agent"))
      .finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data)
    return <div className="flex justify-center py-20"><Spinner size="lg" /></div>;
  if (!data) return null;

  const { agent, account, tickets, payments } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{agent.name}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
              {agent.phone ? (<><Phone className="w-3.5 h-3.5" /> {agent.phone}</>) : "No phone on file"}
              {!agent.is_active && <Badge variant="danger">Inactive</Badge>}
            </p>
          </div>
        </div>
        {account.balance > 0 && (
          <Button onClick={() => setPayOpen(true)}>
            <Banknote className="w-4 h-4" /> Pay {money(account.balance)}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile label="Tickets credited" value={account.ticket_count} tone="blue" />
        <Tile label="Commission earned" value={money(account.commission_earned)} />
        <Tile label="Already paid" value={money(account.commission_paid)} tone="green" />
        <Tile
          label="Still owed"
          value={money(account.balance)}
          tone={account.balance > 0 ? "red" : "green"}
        />
      </div>

      <Card>
        <h2 className="font-semibold text-gray-900 dark:text-white text-sm px-6 pt-6 pb-3">
          Tickets earning commission
        </h2>
        {tickets.length === 0 ? (
          <EmptyState icon={UserRound} title="No tickets yet" description="Assign this agent on a ticket to credit them commission." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-gray-200 dark:border-gray-700">
                  {["Passenger", "Route", "Flight", "Airline", "Ticket price", "Commission", "Booked by"].map((h) => (
                    <th key={h} className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {tickets.map((t) => (
                  <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">{t.passenger_name}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{t.from_city} → {t.to_city}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{fmtDate(t.flight_date)}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{t.airline_name}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{money(t.selling_price)}</td>
                    <td className="px-4 py-3 font-semibold text-purple-600 dark:text-purple-400">{money(t.agent_commission)}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{t.booked_by || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="font-semibold text-gray-900 dark:text-white text-sm px-6 pt-6 pb-3">
          Payment history
        </h2>
        {payments.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-gray-400">Nothing paid out yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-gray-200 dark:border-gray-700">
                  {["Date", "Amount", "Method", "Reference", "Paid by", "Note"].map((h) => (
                    <th key={h} className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{fmtDate(p.created_at, "dd MMM yyyy HH:mm")}</td>
                    <td className="px-4 py-3 font-semibold text-green-600 dark:text-green-400">{money(p.amount)}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 capitalize">{p.method}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{p.reference || "—"}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{p.paid_by_name}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{p.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <PayModal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        agent={{ ...agent, balance: account.balance, agent_id: agent.id }}
        onPaid={() => { load(); onChanged(); }}
      />
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const { hasRole } = useAuth();
  const canManage = hasRole("admin", "super_admin");

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [onlyDue, setOnlyDue] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [selected, setSelected] = useState(null);
  const [agentModal, setAgentModal] = useState({ open: false, initial: null });
  const [payAgent, setPayAgent] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    agentsAPI
      .list({ search, only_due: onlyDue, include_inactive: includeInactive })
      .then((r) => setData(r.data.data))
      .catch((err) => {
        const msg = err.response?.data?.message || "Failed to load agents";
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, [search, onlyDue, includeInactive]);

  useEffect(() => { load(); }, [load]);

  const remove = async (agent) => {
    if (!window.confirm(`Delete ${agent.agent_name}?`)) return;
    try {
      await agentsAPI.delete(agent.agent_id);
      toast.success("Agent deleted");
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to delete");
    }
  };

  if (selected)
    return (
      <AgentDetail agentId={selected} onBack={() => setSelected(null)} onChanged={load} />
    );

  const agents = data?.agents || [];
  const totals = data?.totals || {};

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Agents</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            External people who bring you customers and earn commission
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setAgentModal({ open: true, initial: null })}>
            <Plus className="w-4 h-4" /> Add agent
          </Button>
        )}
      </div>

      {error ? (
        <Card className="p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-gray-900 dark:text-white">Couldn't load agents</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{error}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile label="Agents" value={totals.total_agents ?? 0} tone="blue" icon={UserRound} />
            <Tile label="Commission earned" value={money(totals.earned)} />
            <Tile label="Paid out" value={money(totals.paid)} tone="green" />
            <Tile
              label="Still owed"
              value={money(totals.balance)}
              sub={`${totals.agents_owing ?? 0} agent(s) waiting`}
              tone={totals.balance > 0 ? "red" : "green"}
              icon={Wallet}
            />
          </div>

          <Card className="p-4">
            <div className="flex flex-wrap gap-3 items-center">
              <Input
                placeholder="Search by name or phone…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 min-w-48"
              />
              <button
                onClick={() => setOnlyDue((v) => !v)}
                className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                  onlyDue
                    ? "bg-red-50 border-red-300 text-red-600 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400"
                    : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300"
                }`}
              >
                <Wallet className="w-4 h-4" /> Owed only
              </button>
              <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={includeInactive}
                  onChange={(e) => setIncludeInactive(e.target.checked)}
                  className="rounded"
                />
                Show inactive
              </label>
            </div>
          </Card>

          <Card>
            {loading ? (
              <div className="flex justify-center py-16"><Spinner size="lg" /></div>
            ) : agents.length === 0 ? (
              <EmptyState
                icon={UserRound}
                title="No agents yet"
                description="Add the people who refer customers to you, then credit them on a ticket."
                action={canManage && (
                  <Button onClick={() => setAgentModal({ open: true, initial: null })}>
                    <Plus className="w-4 h-4" /> Add agent
                  </Button>
                )}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      {["Agent", "Phone", "Tickets", "Earned", "Paid", "Still owed", ""].map((h, i) => (
                        <th key={i} className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                    {agents.map((a) => (
                      <tr
                        key={a.agent_id}
                        className="hover:bg-blue-50/50 dark:hover:bg-gray-700/30 cursor-pointer"
                        onClick={() => setSelected(a.agent_id)}
                      >
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-900 dark:text-white whitespace-nowrap">{a.agent_name}</p>
                          {!a.is_active && <Badge variant="danger">Inactive</Badge>}
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{a.phone || "—"}</td>
                        <td className="px-4 py-3"><Badge variant="info">{a.ticket_count}</Badge></td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{money(a.commission_earned)}</td>
                        <td className="px-4 py-3 text-green-600 dark:text-green-400">{money(a.commission_paid)}</td>
                        <td className="px-4 py-3">
                          {a.balance > 0 ? (
                            <span className="font-semibold text-red-600 dark:text-red-400">{money(a.balance)}</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-gray-400">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Settled
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            {a.balance > 0 && (
                              <Button size="sm" onClick={() => setPayAgent(a)}>
                                <Banknote className="w-3.5 h-3.5" /> Pay
                              </Button>
                            )}
                            {canManage && (
                              <>
                                <button
                                  onClick={() =>
                                    setAgentModal({
                                      open: true,
                                      initial: {
                                        id: a.agent_id,
                                        name: a.agent_name,
                                        phone: a.phone || "",
                                        is_active: a.is_active,
                                      },
                                    })
                                  }
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-gray-700"
                                >
                                  <Pencil className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => remove(a)}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-gray-700"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
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
          </Card>
        </>
      )}

      <AgentModal
        open={agentModal.open}
        initial={agentModal.initial}
        onClose={() => setAgentModal({ open: false, initial: null })}
        onSaved={load}
      />
      <PayModal
        open={Boolean(payAgent)}
        agent={payAgent}
        onClose={() => setPayAgent(null)}
        onPaid={load}
      />
    </div>
  );
}
