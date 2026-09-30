import React, { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import {
  Users,
  Plus,
  Pencil,
  ArrowDownLeft,
  ArrowUpRight,
  History,
  Trash2,
  PieChart as PieIcon,
  AlertTriangle,
} from "lucide-react";
import { Button, Card, Badge, Spinner, Input, Modal, EmptyState } from "../../components/ui";
import AccountSelect from "../../components/AccountSelect";
import { ownersAPI } from "../../services/booksApi";
import { fmtDate } from "../../utils/date";
import { money, pctText, OWNER_COLORS } from "./format";

/**
 * Owners: who owns the agency, what they put in, what they took out, and
 * their share of the profit — tied to the same numbers as the balance sheet.
 */
export default function OwnersPanel({ balance, canEdit, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState(null); // {} for new, owner for edit
  const [money_, setMoney] = useState(null); // { owner, kind }
  const [history, setHistory] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    ownersAPI
      .list()
      .then((r) => setData(r.data.data))
      .catch((e) => toast.error(e.response?.data?.message || "Couldn't load owners"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const refresh = () => { load(); onChanged?.(); };

  if (loading && !data)
    return <div className="flex justify-center py-16"><Spinner size="lg" /></div>;

  const owners = data?.owners || [];
  const totals = data?.totals || {};
  const byOwner = Object.fromEntries(
    (balance?.equity?.by_owner?.owners || []).map((o) => [o.owner_id, o]),
  );
  const eq = balance?.equity?.by_owner;
  const active = owners.filter((o) => o.is_active);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Owners &amp; capital</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Each owner's capital, drawings and share of the profit, as shown on the balance sheet
            {balance?.as_of ? ` at ${fmtDate(balance.as_of)}` : ""}.
          </p>
        </div>
        {canEdit && (
          <Button onClick={() => setEdit({})}>
            <Plus className="w-4 h-4" /> Add owner
          </Button>
        )}
      </div>

      {owners.length === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon={Users}
            title="No owners registered yet"
            description="Add each owner with their opening capital, ownership % and profit-share %. The balance sheet will then show every owner's equity — capital, drawings and their share of the profit."
            action={canEdit && <Button onClick={() => setEdit({})}><Plus className="w-4 h-4" /> Add the first owner</Button>}
          />
        </Card>
      ) : (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat label="Owners" value={active.length} sub={owners.length > active.length ? `${owners.length - active.length} inactive` : "all active"} />
            <Stat label="Capital invested" value={money(totals.opening_capital + totals.contributed)} sub={`${money(totals.contributed)} added in TAMS`} tone="blue" />
            <Stat label="Drawings" value={money(totals.withdrawn)} sub="taken out by owners" tone="orange" />
            <Stat label="Owners' equity" value={money(eq ? eq.owners.reduce((s, o) => s + o.total, 0) : totals.net_invested)} sub="capital − drawings + profit share" tone="green" />
          </div>

          {/* Split bars */}
          <Card className="p-6 space-y-5">
            <div className="flex items-center gap-2">
              <PieIcon className="w-4 h-4 text-gray-400" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">How the business is split</h3>
            </div>
            <SplitBar title="Ownership" field="ownership_pct" owners={active} total={totals.ownership_pct} />
            <SplitBar title="Profit share" field="profit_share_pct" owners={active} total={totals.profit_share_pct} />
            {(totals.ownership_pct < 99.995 || totals.profit_share_pct < 99.995) && (
              <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                The percentages don't add up to 100% yet. Profit not covered by a profit share stays as unallocated retained earnings.
              </p>
            )}
          </Card>

          {/* Owner cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {owners.map((o, i) => {
              const b = byOwner[o.id];
              return (
                <Card key={o.id} className={`p-5 ${o.is_active ? "" : "opacity-60"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold shrink-0"
                        style={{ background: OWNER_COLORS[i % OWNER_COLORS.length] }}
                      >
                        {o.name.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 dark:text-white truncate">{o.name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          Owns {pctText(o.ownership_pct)} · {pctText(o.profit_share_pct)} of profit
                          {o.joined_on ? ` · since ${fmtDate(o.joined_on)}` : ""}
                        </p>
                      </div>
                    </div>
                    {!o.is_active && <Badge>Inactive</Badge>}
                  </div>

                  <div className="mt-4 divide-y divide-gray-100 dark:divide-gray-700/60 text-sm">
                    <Row label="Opening capital" value={money(o.opening_capital)} />
                    <Row label="Capital added" value={money(b ? b.contributed : o.contributed)} tone="green" />
                    <Row label="Drawings" value={`(${money(b ? b.withdrawn : o.withdrawn)})`} tone="red" />
                    <Row label={`Profit share (${pctText(o.profit_share_pct)})`} value={b ? money(b.profit_share) : "—"} tone={b && b.profit_share < 0 ? "red" : "green"} />
                    <Row label="Equity" value={b ? money(b.total) : money(o.net_invested)} bold />
                  </div>

                  {canEdit && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => setMoney({ owner: o, kind: "contribution" })} disabled={!o.is_active}>
                        <ArrowDownLeft className="w-4 h-4" /> Capital in
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setMoney({ owner: o, kind: "withdrawal" })} disabled={!o.is_active}>
                        <ArrowUpRight className="w-4 h-4" /> Drawings
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setHistory(o)}>
                        <History className="w-4 h-4" /> History
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEdit(o)}>
                        <Pencil className="w-4 h-4" /> Edit
                      </Button>
                    </div>
                  )}
                  {!canEdit && (
                    <div className="mt-4">
                      <Button size="sm" variant="ghost" onClick={() => setHistory(o)}>
                        <History className="w-4 h-4" /> History
                      </Button>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          {eq && (Math.abs(eq.retained_brought_forward) > 0.004 || Math.abs(eq.unallocated_profit) > 0.004) && (
            <Card className="p-5 text-sm">
              <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Not assigned to an owner</h3>
              {Math.abs(eq.retained_brought_forward) > 0.004 && (
                <Row label="Retained earnings brought forward" value={money(eq.retained_brought_forward)}
                  hint="The opening position (opening cash, accounts, receivables, fixed assets less payables) minus the owners' opening capital." />
              )}
              {Math.abs(eq.unallocated_profit) > 0.004 && (
                <Row label="Unallocated profit" value={money(eq.unallocated_profit)} hint="Profit not covered by the owners' profit-share percentages." />
              )}
            </Card>
          )}
        </>
      )}

      {edit && <OwnerModal initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); }} />}
      {money_ && <OwnerMoneyModal {...money_} onClose={() => setMoney(null)} onSaved={() => { setMoney(null); refresh(); }} />}
      {history && <OwnerHistoryModal owner={history} canEdit={canEdit} onClose={() => setHistory(null)} onChanged={refresh} />}
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────

const TONES = {
  gray: "text-gray-900 dark:text-white",
  blue: "text-blue-600 dark:text-blue-400",
  green: "text-green-600 dark:text-green-400",
  orange: "text-orange-600 dark:text-orange-400",
  red: "text-red-600 dark:text-red-400",
};

function Stat({ label, value, sub, tone = "gray" }) {
  return (
    <Card className="p-5">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1.5 tabular-nums ${TONES[tone]}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{sub}</p>}
    </Card>
  );
}

function Row({ label, value, tone = "gray", bold, hint }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div>
        <span className={bold ? "font-semibold text-gray-900 dark:text-white" : "text-gray-600 dark:text-gray-400"}>{label}</span>
        {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
      </div>
      <span className={`tabular-nums ${bold ? "font-bold" : ""} ${TONES[tone]}`}>{value}</span>
    </div>
  );
}

function SplitBar({ title, field, owners, total }) {
  const rest = Math.max(100 - (total || 0), 0);
  return (
    <div>
      <div className="flex justify-between text-xs mb-1.5">
        <span className="font-medium text-gray-600 dark:text-gray-300">{title}</span>
        <span className="text-gray-500 tabular-nums">{pctText(total)} allocated</span>
      </div>
      <div className="flex h-3 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-700">
        {owners.map((o, i) =>
          o[field] > 0 ? (
            <div key={o.id} title={`${o.name}: ${pctText(o[field])}`} style={{ width: `${o[field]}%`, background: OWNER_COLORS[i % OWNER_COLORS.length] }} />
          ) : null,
        )}
        {rest > 0.001 && <div style={{ width: `${rest}%` }} />}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {owners.map((o, i) => (
          <span key={o.id} className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: OWNER_COLORS[i % OWNER_COLORS.length] }} />
            {o.name} <span className="tabular-nums text-gray-400">{pctText(o[field])}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function OwnerModal({ initial, onClose, onSaved }) {
  const editing = !!initial.id;
  const [form, setForm] = useState({
    name: initial.name || "",
    phone: initial.phone || "",
    email: initial.email || "",
    opening_capital: initial.opening_capital ?? "",
    ownership_pct: initial.ownership_pct ?? "",
    profit_share_pct: initial.profit_share_pct ?? "",
    joined_on: initial.joined_on ? String(initial.joined_on).slice(0, 10) : "",
    notes: initial.notes || "",
    is_active: initial.is_active ?? true,
  });
  const [sameShare, setSameShare] = useState(
    !editing || Number(initial.ownership_pct) === Number(initial.profit_share_pct),
  );
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => {
    const v = e.target.value;
    setForm((f) => ({ ...f, [k]: v, ...(k === "ownership_pct" && sameShare ? { profit_share_pct: v } : {}) }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { ...form, profit_share_pct: sameShare ? form.ownership_pct : form.profit_share_pct };
      if (editing) await ownersAPI.update(initial.id, body);
      else await ownersAPI.create(body);
      toast.success(editing ? "Owner updated" : `${form.name} added`);
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.message || "Couldn't save the owner");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={editing ? `Edit ${initial.name}` : "Add an owner"}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Full name *" value={form.name} onChange={set("name")} required autoFocus />
          <Input label="Phone" value={form.phone} onChange={set("phone")} />
          <Input label="Opening capital ($)" type="number" step="0.01" min="0" value={form.opening_capital} onChange={set("opening_capital")} placeholder="0.00" />
          <Input label="Owner since" type="date" value={form.joined_on} onChange={set("joined_on")} />
          <Input label="Ownership %" type="number" step="0.001" min="0" max="100" value={form.ownership_pct} onChange={set("ownership_pct")} placeholder="e.g. 30" />
          <Input label="Profit share %" type="number" step="0.001" min="0" max="100" value={sameShare ? form.ownership_pct : form.profit_share_pct} onChange={set("profit_share_pct")} disabled={sameShare} />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <input type="checkbox" checked={sameShare} onChange={(e) => setSameShare(e.target.checked)} className="rounded" />
          Profit share is the same as ownership
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Opening capital is what this owner already had in the business before TAMS — no money moves for it. Money they put in or take out later is recorded with <b>Capital in</b> and <b>Drawings</b>, through a real account.
        </p>
        <Input label="Notes" value={form.notes} onChange={set("notes")} />
        {editing && (
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} className="rounded" />
            Active owner
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>{editing ? "Save changes" : "Add owner"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function OwnerMoneyModal({ owner, kind, onClose, onSaved }) {
  const isIn = kind === "contribution";
  const [form, setForm] = useState({
    amount: "",
    account_id: "",
    occurred_at: new Date().toISOString().slice(0, 10),
    reference: "",
    note: "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));

  const submit = async (e) => {
    e.preventDefault();
    if (!(Number(form.amount) > 0)) return toast.error("Enter an amount");
    if (!form.account_id) return toast.error(isIn ? "Choose the account the money went into" : "Choose the account the money came out of");
    setSaving(true);
    try {
      const r = await ownersAPI.addTransaction(owner.id, { ...form, kind });
      toast.success(r.data.message);
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.message || "Couldn't record it");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={isIn ? `Capital from ${owner.name}` : `Drawings by ${owner.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <div className={`rounded-lg px-4 py-3 text-sm ${isIn ? "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300" : "bg-orange-50 text-orange-800 dark:bg-orange-900/20 dark:text-orange-300"}`}>
          {isIn
            ? `Money ${owner.name} is putting into the business. It increases the account below and ${owner.name}'s capital.`
            : `Money ${owner.name} is taking out of the business for personal use. It comes out of the account below and reduces ${owner.name}'s equity — it is not an expense.`}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Amount ($) *" type="number" step="0.01" min="0.01" value={form.amount} onChange={set("amount")} required autoFocus />
          <Input label="Date" type="date" value={form.occurred_at} onChange={set("occurred_at")} />
        </div>
        <AccountSelect
          direction={isIn ? "in" : "out"}
          label={isIn ? "Received into *" : "Paid out of *"}
          value={form.account_id}
          onChange={(v) => setForm((f) => ({ ...f, account_id: v?.target ? v.target.value : v }))}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Reference" value={form.reference} onChange={set("reference")} placeholder="Receipt / transfer no." />
          <Input label="Note" value={form.note} onChange={set("note")} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>{isIn ? "Record capital" : "Record drawings"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function OwnerHistoryModal({ owner, canEdit, onClose, onChanged }) {
  const [rows, setRows] = useState(null);
  const load = useCallback(() => {
    ownersAPI.transactions(owner.id).then((r) => setRows(r.data.data)).catch(() => setRows([]));
  }, [owner.id]);
  useEffect(() => { load(); }, [load]);

  const remove = async (tx) => {
    if (!window.confirm("Remove this entry? Use this only for a mistake — the account balance changes back.")) return;
    try {
      await ownersAPI.deleteTransaction(tx.id);
      toast.success("Entry removed");
      load();
      onChanged();
    } catch (err) {
      toast.error(err.response?.data?.message || "Couldn't remove it");
    }
  };

  return (
    <Modal open onClose={onClose} title={`${owner.name} — capital history`} size="lg">
      {!rows ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500 py-6 text-center">No capital or drawings recorded yet. Opening capital: {money(owner.opening_capital)}.</p>
      ) : (
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200 dark:border-gray-700">
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Account</th>
                <th className="px-2 py-2">Reference</th>
                <th className="px-2 py-2 text-right">Amount</th>
                {canEdit && <th className="px-2 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="px-2 py-2 whitespace-nowrap">{fmtDate(t.occurred_at)}</td>
                  <td className="px-2 py-2">
                    <Badge variant={t.kind === "contribution" ? "success" : "warning"}>
                      {t.kind === "contribution" ? "Capital in" : "Drawings"}
                    </Badge>
                  </td>
                  <td className="px-2 py-2">{t.account_name || "—"}</td>
                  <td className="px-2 py-2 text-gray-500">{t.reference || t.note || "—"}</td>
                  <td className={`px-2 py-2 text-right tabular-nums font-medium ${t.amount >= 0 ? "text-green-600" : "text-orange-600"}`}>
                    {t.amount >= 0 ? money(t.amount) : `(${money(-t.amount)})`}
                  </td>
                  {canEdit && (
                    <td className="px-2 py-2 text-right">
                      <button onClick={() => remove(t)} className="text-gray-400 hover:text-red-600" title="Remove (mistake)">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
