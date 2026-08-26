import React, { useState, useEffect, useCallback } from "react";
import { accountsAPI } from "../services/api";
import { useAuth } from "../context/AuthContext";
import { refreshAccounts } from "../components/AccountSelect";
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
} from "../components/ui";
import toast from "react-hot-toast";
import {
  Wallet,
  Plus,
  Pencil,
  ArrowRightLeft,
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Landmark,
  Smartphone,
  Store,
  AlertTriangle,
  Search,
  X,
} from "lucide-react";
import { fmtDate, todayInput } from "../utils/date";

const money = (v) =>
  `$${Number(v || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const KINDS = [
  { value: "cash", label: "Cash", icon: Banknote },
  { value: "bank", label: "Bank", icon: Landmark },
  { value: "mobile", label: "Mobile money", icon: Smartphone },
  { value: "merchant", label: "Merchant", icon: Store },
  { value: "other", label: "Other", icon: Wallet },
];
const kindMeta = (k) => KINDS.find((x) => x.value === k) || KINDS[4];

const SOURCES = [
  { value: "", label: "Everything" },
  { value: "ticket", label: "Tickets" },
  { value: "cargo", label: "Cargo" },
  { value: "visa", label: "Visas" },
  { value: "package", label: "Packages" },
  { value: "airline", label: "Airline payments" },
  { value: "agent", label: "Agent commission" },
  { value: "expense", label: "Expenses" },
  { value: "transfer_in", label: "Transfers in" },
  { value: "transfer_out", label: "Transfers out" },
];
const sourceLabel = (s) =>
  SOURCES.find((x) => x.value === s)?.label || s || "—";

// Transfers already name both of their accounts by construction, so there is
// nothing to assign. Everything else can be pointed at an account after the
// fact — which is how the pre-accounts backlog gets cleared.
const ASSIGNABLE = [
  "ticket",
  "visa",
  "package",
  "cargo",
  "airline",
  "agent",
  "expense",
];

const EMPTY_ACCOUNT = {
  name: "",
  kind: "bank",
  opening_balance: "",
  opening_date: "",
  notes: "",
  is_active: true,
};

// ── One account's card ───────────────────────────────────────────────────────

const AccountCard = ({ account, selected, onSelect, onEdit }) => {
  const Icon = kindMeta(account.kind).icon;
  const negative = Number(account.balance) < 0;
  return (
    <button
      type="button"
      onClick={() => onSelect(account)}
      className={`text-left w-full rounded-2xl border p-4 transition-all
        ${
          selected
            ? "border-blue-500 ring-2 ring-blue-500/20 bg-blue-50/50 dark:bg-blue-900/10"
            : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-blue-300"
        }
        ${!account.is_active ? "opacity-60" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="w-4 h-4 text-gray-400 shrink-0" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate">
            {account.name}
          </span>
        </div>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onEdit(account);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), onEdit(account))}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400"
        >
          <Pencil className="w-3.5 h-3.5" />
        </span>
      </div>

      <p
        className={`text-2xl font-bold mt-2 ${
          negative
            ? "text-red-600 dark:text-red-400"
            : "text-gray-900 dark:text-white"
        }`}
      >
        {money(account.balance)}
      </p>

      <div className="flex items-center gap-3 mt-2 text-xs">
        <span className="text-green-600 dark:text-green-400">
          ↓ {money(account.total_in)}
        </span>
        <span className="text-red-500 dark:text-red-400">
          ↑ {money(account.total_out)}
        </span>
      </div>
      {!account.is_active && (
        <Badge variant="default" className="mt-2">
          Inactive
        </Badge>
      )}
    </button>
  );
};

// ── Add / edit an account ────────────────────────────────────────────────────

function AccountModal({ open, onClose, onSaved, initial }) {
  const [form, setForm] = useState(EMPTY_ACCOUNT);
  const [saving, setSaving] = useState(false);
  const editing = Boolean(initial?.account_id || initial?.id);
  const id = initial?.account_id || initial?.id;

  useEffect(() => {
    if (!open) return;
    setForm(
      initial
        ? {
            ...EMPTY_ACCOUNT,
            ...initial,
            opening_balance: initial.opening_balance ?? "",
            opening_date: initial.opening_date || "",
            notes: initial.notes || "",
          }
        : EMPTY_ACCOUNT,
    );
  }, [open, initial]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return toast.error("Give the account a name");
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        kind: form.kind,
        opening_balance: parseFloat(form.opening_balance) || 0,
        opening_date: form.opening_date || undefined,
        notes: form.notes || undefined,
        is_active: form.is_active,
      };
      if (editing) await accountsAPI.update(id, payload);
      else await accountsAPI.create(payload);
      toast.success(editing ? "Account updated" : "Account added");
      refreshAccounts();
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to save account");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit account" : "Add account"}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Account name *"
            value={form.name}
            onChange={set("name")}
            placeholder="Premier Bank"
          />
          <Select label="Type" value={form.kind} onChange={set("kind")}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
          <Input
            label="Opening balance"
            type="number"
            step="0.01"
            value={form.opening_balance}
            onChange={set("opening_balance")}
            placeholder="0.00"
          />
          <Input
            label="Balance as at"
            type="date"
            value={form.opening_date}
            onChange={set("opening_date")}
          />
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400 -mt-1">
          The opening balance is what this account held before TAMS started
          tracking it. Leave it at zero and the balance here counts only what
          the system records from now on — which will sit below your real bank
          statement by whatever was already there.
        </p>

        <Input
          label="Notes"
          value={form.notes}
          onChange={set("notes")}
          placeholder="Account number, branch, who manages it…"
        />

        {editing && (
          <Select
            label="Status"
            value={String(form.is_active)}
            onChange={(e) =>
              setForm((f) => ({ ...f, is_active: e.target.value === "true" }))
            }
          >
            <option value="true">Active</option>
            <option value="false">Inactive — hide from payment forms</option>
          </Select>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {editing ? "Save changes" : "Add account"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Move money between accounts ──────────────────────────────────────────────

function TransferModal({ open, onClose, accounts, onDone }) {
  const [form, setForm] = useState({
    from_account_id: "",
    to_account_id: "",
    amount: "",
    fee: "",
    transferred_at: todayInput(),
    reference: "",
    note: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open)
      setForm({
        from_account_id: "",
        to_account_id: "",
        amount: "",
        fee: "",
        transferred_at: todayInput(),
        reference: "",
        note: "",
      });
  }, [open]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const from = accounts.find((a) => a.account_id === form.from_account_id);
  const amount = parseFloat(form.amount) || 0;
  const fee = parseFloat(form.fee) || 0;
  const leaving = amount + fee;
  const short = from && leaving > Number(from.balance) + 0.001;

  const submit = async (e) => {
    e.preventDefault();
    if (!form.from_account_id || !form.to_account_id)
      return toast.error("Choose both accounts");
    if (form.from_account_id === form.to_account_id)
      return toast.error("Choose two different accounts");
    if (amount <= 0) return toast.error("Enter an amount");

    setSaving(true);
    try {
      const res = await accountsAPI.transfer({
        ...form,
        amount,
        fee,
        transferred_at: form.transferred_at || undefined,
      });
      toast.success(res.data.message);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || "Transfer failed");
    } finally {
      setSaving(false);
    }
  };

  const options = accounts.filter((a) => a.is_active);

  return (
    <Modal open={open} onClose={onClose} title="Move money between accounts">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select
            label="From *"
            value={form.from_account_id}
            onChange={set("from_account_id")}
          >
            <option value="">— choose —</option>
            {options.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {a.name} ({money(a.balance)})
              </option>
            ))}
          </Select>
          <Select
            label="To *"
            value={form.to_account_id}
            onChange={set("to_account_id")}
          >
            <option value="">— choose —</option>
            {options
              .filter((a) => a.account_id !== form.from_account_id)
              .map((a) => (
                <option key={a.account_id} value={a.account_id}>
                  {a.name}
                </option>
              ))}
          </Select>
          <Input
            label="Amount *"
            type="number"
            min="0.01"
            step="0.01"
            value={form.amount}
            onChange={set("amount")}
          />
          <Input
            label="Fee charged"
            type="number"
            min="0"
            step="0.01"
            value={form.fee}
            onChange={set("fee")}
            placeholder="0.00"
          />
          <Input
            label="Date"
            type="date"
            value={form.transferred_at}
            onChange={set("transferred_at")}
          />
          <Input
            label="Reference"
            value={form.reference}
            onChange={set("reference")}
            placeholder="Optional"
          />
        </div>

        {amount > 0 && (
          <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-3 text-sm">
            <div className="flex justify-between text-gray-600 dark:text-gray-300">
              <span>Leaves {from?.name || "the sending account"}</span>
              <span className="font-semibold text-red-600">
                −{money(leaving)}
              </span>
            </div>
            <div className="flex justify-between text-gray-600 dark:text-gray-300 mt-1">
              <span>Arrives</span>
              <span className="font-semibold text-green-600">
                +{money(amount)}
              </span>
            </div>
            {fee > 0 && (
              <p className="text-xs text-gray-500 mt-2">
                The {money(fee)} fee stays with the sender and is the only real
                cost — moving your own money doesn't change what the business
                is worth.
              </p>
            )}
          </div>
        )}

        {short && (
          <div className="flex gap-2 items-start rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-800 dark:text-amber-200">
              That's more than {from.name} currently holds ({money(from.balance)}).
              Recording it anyway will leave that account negative.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            <ArrowRightLeft className="w-4 h-4" /> Record transfer
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AccountsPage() {
  const { hasRole } = useAuth();
  const canManage = hasRole("super_admin", "admin", "accountant");

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const [ledger, setLedger] = useState(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    direction: "",
    source: "",
    from_date: "",
    to_date: "",
    search: "",
    unassigned: false,
  });

  const loadAccounts = useCallback(() => {
    setLoading(true);
    accountsAPI
      .list()
      .then((r) => setData(r.data.data))
      .catch((e) =>
        toast.error(e.response?.data?.message || "Failed to load accounts"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  // Nothing loads until you've narrowed it down. A year of trading is tens of
  // thousands of movements, and dumping them on arrival is slow to fetch and
  // impossible to read. Pick an account, a date range, a type — anything.
  const hasQuery =
    Boolean(selected) ||
    filters.unassigned ||
    Boolean(filters.direction) ||
    Boolean(filters.source) ||
    Boolean(filters.from_date) ||
    Boolean(filters.to_date) ||
    Boolean(filters.search.trim());

  const loadLedger = useCallback(() => {
    if (!hasQuery) {
      setLedger(null);
      return;
    }
    setLedgerLoading(true);
    accountsAPI
      .ledger({
        page,
        limit: 50,
        account_id: selected?.account_id || undefined,
        direction: filters.direction || undefined,
        source: filters.source || undefined,
        from_date: filters.from_date || undefined,
        to_date: filters.to_date || undefined,
        search: filters.search || undefined,
        unassigned: filters.unassigned ? "true" : undefined,
      })
      .then((r) => setLedger({ ...r.data.data, meta: r.data.meta }))
      .catch(() => setLedger(null))
      .finally(() => setLedgerLoading(false));
  }, [page, selected, filters, hasQuery]);

  useEffect(() => {
    loadLedger();
  }, [loadLedger]);

  // Any filter change starts again from the first page — otherwise you can
  // land on page 4 of a result set that now has one page.
  const setFilter = (k) => (e) => {
    const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setPage(1);
    setFilters((f) => ({ ...f, [k]: v }));
  };

  /** Point an orphaned movement at an account, then refresh both panels. */
  const assign = async (movement, accountId) => {
    if (!accountId) return;
    try {
      await accountsAPI.assign({
        source: movement.source,
        movement_id: movement.movement_id,
        account_id: accountId,
      });
      toast.success("Assigned");
      loadAccounts();
      loadLedger();
    } catch (err) {
      toast.error(err.response?.data?.message || "Could not assign");
    }
  };

  const pick = (account) => {
    setPage(1);
    setSelected((cur) =>
      cur?.account_id === account.account_id ? null : account,
    );
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!data) {
    return (
      <EmptyState
        icon={Wallet}
        title="Accounts unavailable"
        description="This feature needs a database update. Run migration_v11.sql."
      />
    );
  }

  const { accounts, summary, unassigned } = data;
  const hasUnassigned = unassigned && unassigned.count > 0;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Accounts
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            What each account holds, and every movement behind it
          </p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setTransferOpen(true)}>
              <ArrowRightLeft className="w-4 h-4" /> Transfer
            </Button>
            <Button
              onClick={() => {
                setEditing(null);
                setAccountOpen(true);
              }}
            >
              <Plus className="w-4 h-4" /> Add account
            </Button>
          </div>
        )}
      </div>

      {/* ── Total held ── */}
      <Card className="p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Total across all accounts
            </p>
            <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">
              {money(summary.total_balance)}
            </p>
          </div>
          <div className="flex flex-wrap gap-6 text-sm">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Collected
              </p>
              <p className="font-semibold text-green-600 dark:text-green-400">
                {money(summary.collected)}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Paid out</p>
              <p className="font-semibold text-red-600 dark:text-red-400">
                {money(summary.paid_out)}
              </p>
            </div>
            {summary.transfer_count > 0 && (
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Moved between accounts
                </p>
                <p className="font-semibold text-gray-600 dark:text-gray-300">
                  {money(summary.transferred)}
                </p>
              </div>
            )}
          </div>
        </div>

        {summary.transfer_count > 0 && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">
            Transfers are kept out of Collected and Paid out — moving your own
            money between your own accounts is neither a sale nor a cost, so
            counting it would overstate both.
          </p>
        )}

        {Math.abs(summary.unassigned_gap) > 0.005 && (
          <div className="flex gap-2 items-start mt-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-800 dark:text-amber-200">
              Trade so far is {money(summary.collected)} in less{" "}
              {money(summary.paid_out)} out ={" "}
              <strong>{money(summary.net_trade)}</strong>, but the accounts add
              up to {money(summary.total_balance)}. The{" "}
              {money(Math.abs(summary.unassigned_gap))} difference is money with
              no account assigned yet.
            </p>
          </div>
        )}
      </Card>

      {/* ── Money with no account ── */}
      {hasUnassigned && (
        <div className="flex flex-wrap gap-3 items-center rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          <p className="text-sm text-amber-800 dark:text-amber-200 flex-1 min-w-[16rem]">
            {unassigned.count} movement{unassigned.count === 1 ? "" : "s"} —{" "}
            {money(unassigned.in)} in and {money(unassigned.out)} out — aren't
            assigned to an account, so they're missing from the balances above.
            These are usually payments recorded before accounts existed.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setSelected(null);
              setPage(1);
              setFilters((f) => ({ ...f, unassigned: true }));
            }}
          >
            Show them
          </Button>
        </div>
      )}

      {/* ── The accounts ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {accounts.map((a) => (
          <AccountCard
            key={a.account_id}
            account={a}
            selected={selected?.account_id === a.account_id}
            onSelect={pick}
            onEdit={(acct) => {
              setEditing(acct);
              setAccountOpen(true);
            }}
          />
        ))}
      </div>

      {/* ── The ledger ── */}
      <Card className="overflow-hidden">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-gray-900 dark:text-white">
                {filters.unassigned
                  ? "Unassigned movements"
                  : selected
                    ? selected.name
                    : hasQuery
                      ? "Filtered movements"
                      : "Movements"}
              </h2>
              {(selected || filters.unassigned) && (
                <button
                  onClick={() => {
                    setSelected(null);
                    setFilters((f) => ({ ...f, unassigned: false }));
                    setPage(1);
                  }}
                  className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                >
                  <X className="w-3 h-3" /> clear
                </button>
              )}
            </div>
            {ledger && (
              <div className="flex gap-4 text-sm">
                <span className="text-green-600 dark:text-green-400">
                  In {money(ledger.totals.total_in)}
                </span>
                <span className="text-red-600 dark:text-red-400">
                  Out {money(ledger.totals.total_out)}
                </span>
                <span className="font-semibold text-gray-900 dark:text-white">
                  Net {money(ledger.totals.net)}
                </span>
              </div>
            )}
          </div>

          {/* filters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-2 mt-3">
            <div className="relative col-span-2 md:col-span-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                value={filters.search}
                onChange={setFilter("search")}
                placeholder="Name or reference"
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <Select value={filters.direction} onChange={setFilter("direction")}>
              <option value="">In and out</option>
              <option value="in">Money in</option>
              <option value="out">Money out</option>
            </Select>
            <Select value={filters.source} onChange={setFilter("source")}>
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
            <Input
              type="date"
              value={filters.from_date}
              onChange={setFilter("from_date")}
            />
            <Input
              type="date"
              value={filters.to_date}
              onChange={setFilter("to_date")}
            />
          </div>
        </div>

        {!hasQuery ? (
          <EmptyState
            icon={Search}
            title="Choose what you want to see"
            description="Click an account above, or use the filters — a date range, money in or out, a type of movement, or a customer's name. Nothing loads until you narrow it down, so this page stays fast however many years of trading it holds."
          />
        ) : ledgerLoading && !ledger ? (
          <div className="p-12 flex justify-center">
            <Spinner />
          </div>
        ) : !ledger || ledger.movements.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="Nothing matches that"
            description="No movements fit these filters. Try widening the date range or clearing a filter."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">When</th>
                  <th className="text-left font-medium px-4 py-2.5">Who</th>
                  <th className="text-left font-medium px-4 py-2.5">From</th>
                  <th className="text-left font-medium px-4 py-2.5">Account</th>
                  <th className="text-right font-medium px-4 py-2.5">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {ledger.movements.map((m) => {
                  const isIn = m.direction === "in";
                  return (
                    <tr
                      key={`${m.source}-${m.movement_id}`}
                      className="hover:bg-gray-50 dark:hover:bg-gray-800/40"
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400">
                        {fmtDate(m.occurred_at)}
                      </td>
                      <td className="px-4 py-2.5">
                        <p className="text-gray-900 dark:text-white font-medium">
                          {m.party}
                        </p>
                        {(m.reference || m.note) && (
                          <p className="text-xs text-gray-400 truncate max-w-xs">
                            {m.reference || m.note}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant={isIn ? "success" : "default"}>
                          {sourceLabel(m.source)}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">
                        {m.account_name ? (
                          m.account_name
                        ) : ASSIGNABLE.includes(m.source) && canManage ? (
                          <select
                            value=""
                            onChange={(e) =>
                              assign(m, e.target.value)
                            }
                            className="text-xs rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-amber-400"
                          >
                            <option value="">Assign account…</option>
                            {accounts
                              .filter((a) => a.is_active)
                              .map((a) => (
                                <option key={a.account_id} value={a.account_id}>
                                  {a.name}
                                </option>
                              ))}
                          </select>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400">
                            Unassigned
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right font-semibold whitespace-nowrap ${
                          isIn
                            ? "text-green-600 dark:text-green-400"
                            : "text-red-600 dark:text-red-400"
                        }`}
                      >
                        <span className="inline-flex items-center gap-1">
                          {isIn ? (
                            <ArrowDownLeft className="w-3.5 h-3.5" />
                          ) : (
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          )}
                          {money(m.amount)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {ledger?.meta && ledger.meta.totalPages > 1 && (
          <div className="p-3 border-t border-gray-200 dark:border-gray-700">
            <Pagination
              page={ledger.meta.page}
              totalPages={ledger.meta.totalPages}
              onChange={setPage}
            />
          </div>
        )}
      </Card>

      <AccountModal
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        onSaved={loadAccounts}
        initial={editing}
      />
      <TransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        accounts={accounts}
        onDone={() => {
          loadAccounts();
          loadLedger();
        }}
      />
    </div>
  );
}
