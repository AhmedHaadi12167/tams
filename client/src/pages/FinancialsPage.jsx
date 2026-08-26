import React, { useState, useEffect, useCallback } from "react";
import { financialsAPI, expensesAPI, taxAPI } from "../services/api";
import { useAuth } from "../context/AuthContext";
import {
  Button,
  Card,
  Badge,
  Spinner,
  Select,
  Input,
  Modal,
  Pagination,
  EmptyState,
} from "../components/ui";
import toast from "react-hot-toast";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  TrendingUp,
  Scale,
  Wallet,
  Receipt,
  Plus,
  Pencil,
  Trash2,
  Settings2,
  AlertTriangle,
  CheckCircle2,
  ArrowDownRight,
  ArrowUpRight,
  Eye,
  EyeOff,
  Landmark,
  Banknote,
} from "lucide-react";
import { format } from "date-fns";
import { fmtDate } from "../utils/date";
import AccountSelect from "../components/AccountSelect";

const COLORS = [
  "#3b82f6", "#8b5cf6", "#10b981", "#f59e0b",
  "#ef4444", "#06b6d4", "#ec4899", "#84cc16",
];

const money = (v) =>
  `$${Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v) => `${Number(v || 0).toFixed(1)}%`;
const label = (s) =>
  String(s || "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
const fmtMonth = (d) => {
  try {
    return format(new Date(d), "MMM yy");
  } catch {
    return d;
  }
};

const tooltipStyle = {
  borderRadius: "10px",
  border: "none",
  fontSize: "12px",
  boxShadow: "0 4px 20px rgba(0,0,0,0.12)",
};

const TABS = [
  { key: "pl", label: "Profit & Loss", icon: TrendingUp },
  { key: "balance", label: "Balance Sheet", icon: Scale },
  { key: "cash", label: "Cash Flow", icon: Wallet },
  { key: "receivables", label: "Receivables", icon: AlertTriangle },
  { key: "expenses", label: "Expenses", icon: Receipt },
  { key: "tax", label: "Tax", icon: Landmark },
];

// ── Statement line ───────────────────────────────────────────────────────────

const Line = ({ label: text, value, bold, indent, tone = "gray", divider }) => {
  const tones = {
    gray: "text-gray-900 dark:text-white",
    muted: "text-gray-600 dark:text-gray-400",
    green: "text-green-600 dark:text-green-400",
    red: "text-red-600 dark:text-red-400",
    // The balance sheet totals ask for "blue". Without this entry the lookup
    // returned undefined, the element got no colour class at all, and the two
    // most important figures on the page inherited a dim grey that was almost
    // invisible against a dark background.
    blue: "text-blue-600 dark:text-blue-400",
  };
  // Anything unrecognised falls back to readable rather than to nothing.
  const toneClass = tones[tone] || tones.gray;
  return (
    <div
      className={`flex items-center justify-between py-2 ${
        divider ? "border-t border-gray-200 dark:border-gray-700 mt-1 pt-3" : ""
      }`}
    >
      <span
        className={`text-sm ${indent ? "pl-5" : ""} ${
          bold ? "font-semibold text-gray-900 dark:text-white" : "text-gray-600 dark:text-gray-400"
        }`}
      >
        {text}
      </span>
      <span
        className={`text-sm tabular-nums ${bold ? "font-bold" : ""} ${toneClass}`}
      >
        {value}
      </span>
    </div>
  );
};

const Tile = ({ label: text, value, sub, tone = "gray", icon: Icon }) => {
  const tones = {
    gray: "text-gray-900 dark:text-white",
    green: "text-green-600 dark:text-green-400",
    red: "text-red-600 dark:text-red-400",
    blue: "text-blue-600 dark:text-blue-400",
    orange: "text-orange-600 dark:text-orange-400",
  };
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            {text}
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

// ── Expense form modal ───────────────────────────────────────────────────────

const EMPTY_EXPENSE = {
  category: "other",
  description: "",
  amount: "",
  expense_date: new Date().toISOString().slice(0, 10),
  vendor: "",
  payment_method: "cash",
  // Which account the money left. Expenses show up in the ledger as money
  // out of this account.
  account_id: "",
  reference: "",
  notes: "",
};

function ExpenseModal({ open, onClose, onSaved, categories, initial }) {
  const [form, setForm] = useState(EMPTY_EXPENSE);
  const [saving, setSaving] = useState(false);
  const editing = Boolean(initial?.id);

  useEffect(() => {
    if (open) {
      setForm(
        initial
          ? {
              ...EMPTY_EXPENSE,
              ...initial,
              amount: String(initial.amount ?? ""),
              expense_date: initial.expense_date
                ? String(initial.expense_date).slice(0, 10)
                : EMPTY_EXPENSE.expense_date,
              vendor: initial.vendor || "",
              reference: initial.reference || "",
              notes: initial.notes || "",
            }
          : EMPTY_EXPENSE,
      );
    }
  }, [open, initial]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.description.trim()) return toast.error("Description is required");
    if (!(Number(form.amount) > 0)) return toast.error("Amount must be greater than 0");

    setSaving(true);
    try {
      if (editing) {
        await expensesAPI.update(initial.id, form);
        toast.success("Expense updated");
      } else {
        await expensesAPI.create(form);
        toast.success("Expense recorded");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to save expense");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit expense" : "Record expense"}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select label="Category" value={form.category} onChange={set("category")}>
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
          <Input
            label="Amount"
            type="number"
            step="0.01"
            min="0"
            value={form.amount}
            onChange={set("amount")}
            placeholder="0.00"
          />
        </div>

        <Input
          label="Description"
          value={form.description}
          onChange={set("description")}
          placeholder="e.g. Office rent for August"
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Date" type="date" value={form.expense_date} onChange={set("expense_date")} />
          <AccountSelect
            direction="out"
            value={form.account_id}
            onChange={set("account_id")}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Vendor (optional)"
            value={form.vendor}
            onChange={set("vendor")}
            placeholder="Who was paid"
          />
          <Input
            label="Reference (optional)"
            value={form.reference}
            onChange={set("reference")}
            placeholder="Receipt or invoice no."
          />
        </div>

        <Input
          label="Notes (optional)"
          value={form.notes}
          onChange={set("notes")}
          placeholder="Anything worth remembering"
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {editing ? "Save changes" : "Record expense"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Opening balances modal ───────────────────────────────────────────────────

function OpeningBalancesModal({ open, onClose, onSaved }) {
  const [form, setForm] = useState({
    opening_cash: "",
    fixed_assets: "",
    liabilities: "",
    owner_capital: "",
    financials_start: "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = Object.fromEntries(
        Object.entries(form).filter(([, v]) => v !== ""),
      );
      await financialsAPI.updateOpeningBalances(payload);
      toast.success("Opening balances saved");
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Opening balances">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          The balance sheet needs a starting point — what the agency owned and
          owed before TAMS started tracking. Leave a field blank to keep its
          current value.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Opening cash" type="number" step="0.01" value={form.opening_cash} onChange={set("opening_cash")} placeholder="0.00" />
          <Input label="Fixed assets" type="number" step="0.01" value={form.fixed_assets} onChange={set("fixed_assets")} placeholder="Furniture, computers…" />
          <Input label="Existing liabilities" type="number" step="0.01" value={form.liabilities} onChange={set("liabilities")} placeholder="Loans, unpaid bills" />
          <Input label="Owner's capital" type="number" step="0.01" value={form.owner_capital} onChange={set("owner_capital")} placeholder="Auto-derived if blank" />
        </div>
        <Input label="Financials start date" type="date" value={form.financials_start} onChange={set("financials_start")} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function FinancialsPage() {
  const { hasRole } = useAuth();
  const canEditExpenses = hasRole("admin", "accountant", "super_admin");
  const canEditOpening = hasRole("admin", "super_admin");

  const [tab, setTab] = useState("pl");
  const [range, setRange] = useState({ from_date: "", to_date: "" });
  const [loading, setLoading] = useState(true);

  const [pl, setPl] = useState(null);
  const [balance, setBalance] = useState(null);
  const [cash, setCash] = useState(null);
  const [receivables, setReceivables] = useState(null);

  const [categories, setCategories] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [expenseMeta, setExpenseMeta] = useState({ total: 0, totalPages: 1, message: "" });
  const [expenseFilters, setExpenseFilters] = useState({ category: "", search: "", page: 1 });

  const [expenseModal, setExpenseModal] = useState({ open: false, initial: null });
  const [openingModal, setOpeningModal] = useState(false);
  // Receivables shows totals by default — the per-ticket list gets long fast
  const [showReceivableDetail, setShowReceivableDetail] = useState(false);

  const setRangeField = (k) => (e) => setRange((r) => ({ ...r, [k]: e.target.value }));

  // ── Load statements ───────────────────────────────────
  const loadStatements = useCallback(() => {
    setLoading(true);
    Promise.all([
      financialsAPI.profitLoss(range),
      financialsAPI.balanceSheet(range.to_date ? { as_of: range.to_date } : {}),
      financialsAPI.cashFlow(range),
      financialsAPI.receivables({ limit: 50 }),
    ])
      .then(([p, b, c, r]) => {
        setPl(p.data.data);
        setBalance(b.data.data);
        setCash(c.data.data);
        setReceivables(r.data.data);
      })
      .catch((err) =>
        toast.error(err.response?.data?.message || "Failed to load financials"),
      )
      .finally(() => setLoading(false));
  }, [range]);

  useEffect(() => {
    loadStatements();
  }, [loadStatements]);

  useEffect(() => {
    expensesAPI
      .categories()
      .then((res) => setCategories(res.data.data))
      .catch(() => {});
  }, []);

  const loadExpenses = useCallback(() => {
    expensesAPI
      .list({ ...expenseFilters, ...range, limit: 20 })
      .then((res) => {
        setExpenses(res.data.data);
        setExpenseMeta(res.data.meta ? { ...res.data.meta, message: res.data.message } : { total: 0, totalPages: 1 });
      })
      .catch(() => {});
  }, [expenseFilters, range]);

  useEffect(() => {
    loadExpenses();
  }, [loadExpenses]);

  const refreshAll = () => {
    loadStatements();
    loadExpenses();
  };

  const deleteExpense = async (id) => {
    if (!window.confirm("Delete this expense?")) return;
    try {
      await expensesAPI.delete(id);
      toast.success("Expense deleted");
      refreshAll();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to delete");
    }
  };

  // ── Render ────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Financials
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Profit &amp; loss, balance sheet, cash flow and expenses
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 uppercase">From</label>
            <Input type="date" value={range.from_date} onChange={setRangeField("from_date")} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 uppercase">To</label>
            <Input type="date" value={range.to_date} onChange={setRangeField("to_date")} />
          </div>
          <Button variant="outline" onClick={() => setRange({ from_date: "", to_date: "" })}>
            All time
          </Button>
          {canEditOpening && (
            <Button variant="outline" onClick={() => setOpeningModal(true)}>
              <Settings2 className="w-4 h-4" /> Opening balances
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-gray-700">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition ${
                active
                  ? "border-blue-600 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {/* ── PROFIT & LOSS ────────────────────────── */}
          {tab === "pl" && pl && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <Tile label="Gross Sales" value={money(pl.revenue.gross_sales)} sub={`${pl.revenue.ticket_count} tickets · ${pl.revenue.shipment_count} shipments`} tone="blue" />
                <Tile label="Gross Profit" value={money(pl.gross_profit)} sub={`Margin ${pct(pl.gross_margin_pct)}`} tone="green" />
                <Tile label="Operating Costs" value={money(pl.operating_costs.total)} sub={`Commission ${money(pl.operating_costs.agent_commission)}`} tone="orange" />
                <Tile
                  label="Net Profit"
                  value={money(pl.net_profit)}
                  sub={`Margin ${pct(pl.net_margin_pct)}`}
                  tone={pl.net_profit >= 0 ? "green" : "red"}
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Statement */}
                <Card className="p-6">
                  <h2 className="font-semibold text-gray-900 dark:text-white text-sm mb-4">
                    Income Statement
                  </h2>
                  {/* Every line of business that sold anything. A statement
                      whose rows don't add up to its own total is worse than
                      no statement — visa and package sales were inside Gross
                      Sales all along but never shown. */}
                  {[
                    ["Ticket sales", pl.revenue.ticket_sales],
                    ["Cargo sales", pl.revenue.cargo_sales],
                    ["Visa sales", pl.revenue.visa_sales],
                    ["Package sales", pl.revenue.package_sales],
                  ]
                    .filter(([, v]) => Number(v) !== 0)
                    .map(([label, v]) => (
                      <Line key={label} label={label} value={money(v)} indent />
                    ))}
                  <Line label="Gross Sales" value={money(pl.revenue.gross_sales)} bold divider />

                  {[
                    ["Airline tickets", pl.cost_of_sales.airline_tickets],
                    ["Visa fees paid", pl.cost_of_sales.visa_fees],
                    ["Package suppliers", pl.cost_of_sales.package_suppliers],
                  ]
                    .filter(([, v]) => Number(v) !== 0)
                    .map(([label, v]) => (
                      <Line
                        key={label}
                        label={`Cost of sales — ${label.toLowerCase()}`}
                        value={`(${money(v)})`}
                        indent
                        tone="red"
                      />
                    ))}
                  <Line
                    label="Total cost of sales"
                    value={`(${money(pl.cost_of_sales.total)})`}
                    tone="red"
                  />
                  <Line label="Gross Profit" value={money(pl.gross_profit)} bold tone="green" divider />

                  {pl.tax?.collected > 0 && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 py-2">
                      {money(pl.tax.collected)} of tax is inside these figures
                      and belongs to the government, not the agency. See the
                      Tax tab for what's still owed.
                    </p>
                  )}

                  {pl.cancellations?.cancelled_count > 0 && (
                    <>
                      <Line
                        label={`CANCELLATIONS (${pl.cancellations.cancelled_count} ticket${pl.cancellations.cancelled_count === 1 ? "" : "s"})`}
                        value=""
                        bold
                      />
                      <Line
                        label="Fees kept (excluding tax)"
                        value={money(pl.cancellations.fees_kept)}
                        indent
                        tone="green"
                      />
                      {pl.cancellations.unrecovered_cost > 0 && (
                        <Line
                          label="Fare paid out, not returned"
                          value={`(${money(pl.cancellations.unrecovered_cost)})`}
                          indent
                          tone="red"
                        />
                      )}
                      <Line
                        label="Net from cancellations"
                        value={money(pl.cancellations.net)}
                        indent
                        tone={pl.cancellations.net >= 0 ? "green" : "red"}
                      />
                      {pl.cancellations.written_off > 0 && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 py-2 pl-4">
                          {money(pl.cancellations.written_off)} of customer
                          balances was written off on these tickets. It is not
                          subtracted above — a cancelled sale never counted as
                          revenue, so the money was never in the profit to lose.
                        </p>
                      )}
                    </>
                  )}

                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mt-4 mb-1">
                    Operating expenses
                  </p>
                  <Line label="Agent commission" value={`(${money(pl.operating_costs.agent_commission)})`} indent tone="red" />
                  {pl.operating_costs.by_category.map((c) => (
                    <Line
                      key={c.category}
                      label={label(c.category)}
                      value={`(${money(c.amount)})`}
                      indent
                      tone="red"
                    />
                  ))}
                  {pl.operating_costs.by_category.length === 0 && (
                    <Line label="No expenses recorded" value="—" indent tone="muted" />
                  )}
                  <Line label="Total Operating Costs" value={`(${money(pl.operating_costs.total)})`} bold tone="red" divider />

                  <div className="mt-3 -mx-6 -mb-6 px-6 py-4 bg-gray-50 dark:bg-gray-700/40 rounded-b-xl">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="font-bold text-gray-900 dark:text-white">
                        Net Profit
                      </span>
                      <span
                        className={`text-xl font-bold tabular-nums ${pl.net_profit >= 0 ? "text-green-600" : "text-red-600"}`}
                      >
                        {money(pl.net_profit)}
                      </span>
                    </div>
                  </div>
                </Card>

                {/* Expense split */}
                <Card className="p-6">
                  <h2 className="font-semibold text-gray-900 dark:text-white text-sm mb-4">
                    Where the money goes
                  </h2>
                  {pl.operating_costs.by_category.length > 0 ? (
                    <ResponsiveContainer width="100%" height={280}>
                      <PieChart>
                        <Pie
                          data={pl.operating_costs.by_category.map((c) => ({
                            name: label(c.category),
                            value: c.amount,
                          }))}
                          cx="50%"
                          cy="45%"
                          innerRadius={60}
                          outerRadius={95}
                          paddingAngle={3}
                          dataKey="value"
                        >
                          {pl.operating_costs.by_category.map((_, i) => (
                            <Cell key={i} fill={COLORS[i % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={tooltipStyle} formatter={(v) => money(v)} />
                        <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-[280px] flex items-center justify-center text-sm text-gray-400 text-center px-6">
                      No expenses recorded yet. Add them under the Expenses tab
                      to see a real net profit.
                    </div>
                  )}
                </Card>
              </div>

              {/* 12-month trend */}
              {pl.trend?.length > 0 && (
                <Card className="p-6">
                  <h2 className="font-semibold text-gray-900 dark:text-white text-sm mb-5">
                    Profit trend — last 12 months
                  </h2>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={pl.trend.map((t) => ({ ...t, month: fmtMonth(t.month) }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v) => money(v)} />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="gross_profit" name="Gross profit" fill="#3b82f6" radius={[5, 5, 0, 0]} />
                      <Bar dataKey="expenses" name="Expenses" fill="#f59e0b" radius={[5, 5, 0, 0]} />
                      <Bar dataKey="net_profit" name="Net profit" fill="#10b981" radius={[5, 5, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              )}
            </div>
          )}

          {/* ── BALANCE SHEET ────────────────────────── */}
          {tab === "balance" && balance && (
            <div className="space-y-6">
              <Card className="p-4 flex items-center gap-3">
                {balance.balanced ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Balanced as of{" "}
                      <span className="font-semibold text-gray-900 dark:text-white">
                        {fmtDate(balance.as_of)}
                      </span>{" "}
                      — assets equal liabilities plus equity.
                    </p>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-5 h-5 text-orange-500 shrink-0" />
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Out of balance by{" "}
                      <span className="font-semibold text-orange-600">
                        {money(balance.difference)}
                      </span>{" "}
                      — check the opening balances.
                    </p>
                  </>
                )}
              </Card>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card className="p-6">
                  <h2 className="font-semibold text-gray-900 dark:text-white text-sm mb-4">
                    Assets
                  </h2>
                  <Line label="Cash & bank" value={money(balance.assets.cash_and_bank)} indent />
                  <Line label="Accounts receivable" value={money(balance.assets.accounts_receivable)} indent />
                  <Line label="Fixed assets" value={money(balance.assets.fixed_assets)} indent />
                  <Line label="Total Assets" value={money(balance.assets.total)} bold divider tone="blue" />
                </Card>

                <Card className="p-6">
                  <h2 className="font-semibold text-gray-900 dark:text-white text-sm mb-4">
                    Liabilities &amp; Equity
                  </h2>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
                    Liabilities
                  </p>
                  <Line label="Payable to airlines" value={money(balance.liabilities.payable_to_airlines)} indent />
                  <Line label="Agent commission payable" value={money(balance.liabilities.agent_commission_payable)} indent />
                  <Line label="Other liabilities" value={money(balance.liabilities.other_liabilities)} indent />
                  <Line label="Total Liabilities" value={money(balance.liabilities.total)} bold divider />

                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mt-4 mb-1">
                    Equity
                  </p>
                  <Line label="Owner's capital" value={money(balance.equity.owner_capital)} indent />
                  <Line label="Retained earnings" value={money(balance.equity.retained_earnings)} indent tone={balance.equity.retained_earnings >= 0 ? "green" : "red"} />
                  <Line label="Total Equity" value={money(balance.equity.total)} bold divider />

                  <Line
                    label="Total Liabilities & Equity"
                    value={money(balance.total_liabilities_and_equity)}
                    bold
                    divider
                    tone="blue"
                  />
                </Card>
              </div>

              <Card className="p-5">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                  How these numbers are built
                </p>
                <ul className="space-y-1.5">
                  {(balance.notes || []).map((nt, i) => (
                    <li key={i} className="text-sm text-gray-600 dark:text-gray-400 flex gap-2">
                      <span className="text-gray-300 dark:text-gray-600">•</span>
                      {nt}
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          )}

          {/* ── CASH FLOW ────────────────────────────── */}
          {tab === "cash" && cash && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Tile label="Cash In" value={money(cash.inflow.total)} sub={`${cash.inflow.entries} payments received`} tone="green" icon={ArrowDownRight} />
                <Tile label="Cash Out" value={money(cash.outflow.total)} sub={`${cash.outflow.entries} expenses paid`} tone="red" icon={ArrowUpRight} />
                <Tile
                  label="Net Cash Flow"
                  value={money(cash.net_cash_flow)}
                  sub={cash.net_cash_flow >= 0 ? "Positive for the period" : "Negative for the period"}
                  tone={cash.net_cash_flow >= 0 ? "green" : "red"}
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2">
                  <Card className="p-6">
                    <h2 className="font-semibold text-gray-900 dark:text-white text-sm mb-5">
                      Daily cash movement
                    </h2>
                    {cash.daily?.length > 0 ? (
                      <ResponsiveContainer width="100%" height={280}>
                        <AreaChart data={cash.daily.map((d) => ({ ...d, day: fmtDate(d.day) }))}>
                          <defs>
                            <linearGradient id="inGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                              <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="outGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#ef4444" stopOpacity={0.25} />
                              <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                          <XAxis dataKey="day" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                          <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                          <Tooltip contentStyle={tooltipStyle} formatter={(v) => money(v)} />
                          <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                          <Area type="monotone" dataKey="inflow" name="Cash in" stroke="#10b981" fill="url(#inGrad)" strokeWidth={2.5} />
                          <Area type="monotone" dataKey="outflow" name="Cash out" stroke="#ef4444" fill="url(#outGrad)" strokeWidth={2} />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-[280px] flex items-center justify-center text-gray-400 text-sm">
                        No cash movement in this period
                      </div>
                    )}
                  </Card>
                </div>

                <Card className="p-6">
                  <h2 className="font-semibold text-gray-900 dark:text-white text-sm mb-4">
                    Breakdown
                  </h2>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
                    Money in
                  </p>
                  <Line label="Ticket payments" value={money(cash.inflow.ticket_payments)} indent tone="green" />
                  <Line label="Cargo payments" value={money(cash.inflow.cargo_payments)} indent tone="green" />
                  <Line label="Total in" value={money(cash.inflow.total)} bold divider tone="green" />

                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mt-4 mb-1">
                    Money out
                  </p>
                  <Line label="Operating expenses" value={money(cash.outflow.expenses)} indent tone="red" />
                  <Line label="Total out" value={money(cash.outflow.total)} bold divider tone="red" />

                  {cash.inflow.by_method?.length > 0 && (
                    <>
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mt-4 mb-1">
                        Collected by method
                      </p>
                      {cash.inflow.by_method.map((m) => (
                        <Line key={m.method} label={label(m.method)} value={money(m.total)} indent />
                      ))}
                    </>
                  )}
                </Card>
              </div>
            </div>
          )}

          {/* ── RECEIVABLES ──────────────────────────── */}
          {tab === "receivables" && receivables && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                <Tile label="0–30 days" value={money(receivables.aging.current_0_30)} tone="green" />
                <Tile label="31–60 days" value={money(receivables.aging.days_31_60)} tone="blue" />
                <Tile label="61–90 days" value={money(receivables.aging.days_61_90)} tone="orange" />
                <Tile label="Over 90 days" value={money(receivables.aging.over_90)} tone="red" />
                <Tile label="Total Due" value={money(receivables.aging.total)} sub={`${receivables.aging.open_items} open items`} />
              </div>

              <Card className="p-6">
                <h2 className="font-semibold text-gray-900 dark:text-white text-sm mb-5">
                  Aging summary
                </h2>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={[
                      { name: "0–30", amount: receivables.aging.current_0_30 },
                      { name: "31–60", amount: receivables.aging.days_31_60 },
                      { name: "61–90", amount: receivables.aging.days_61_90 },
                      { name: "90+", amount: receivables.aging.over_90 },
                    ]}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v) => money(v)} />
                    <Bar dataKey="amount" name="Outstanding" radius={[6, 6, 0, 0]} barSize={56}>
                      {["#10b981", "#3b82f6", "#f59e0b", "#ef4444"].map((c, i) => (
                        <Cell key={i} fill={c} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Card>

              {receivables.aging.open_items === 0 ? (
                <Card>
                  <EmptyState
                    icon={CheckCircle2}
                    title="Nothing outstanding"
                    description="Every ticket and shipment is fully paid."
                  />
                </Card>
              ) : (
                <Card className="p-6">
                  <div className="flex flex-wrap items-center justify-between gap-3 gap-3 flex-wrap">
                    <div>
                      <h2 className="font-semibold text-gray-900 dark:text-white text-sm">
                        {receivables.aging.open_items} unpaid item
                        {receivables.aging.open_items === 1 ? "" : "s"}
                      </h2>
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                        {money(receivables.aging.total)} still to collect.
                        {receivables.aging.over_90 > 0 && (
                          <span className="text-red-600 dark:text-red-400">
                            {" "}
                            {money(receivables.aging.over_90)} of it is over 90 days old.
                          </span>
                        )}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => setShowReceivableDetail((v) => !v)}
                    >
                      {showReceivableDetail ? (
                        <>
                          <EyeOff className="w-4 h-4" /> Hide detail
                        </>
                      ) : (
                        <>
                          <Eye className="w-4 h-4" /> Show oldest 50
                        </>
                      )}
                    </Button>
                  </div>

                  {showReceivableDetail && (
                    <div className="overflow-x-auto mt-5 -mx-6 -mb-6">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-y border-gray-200 dark:border-gray-700">
                            {["Type", "Name", "Contact", "Issued", "Age", "Total", "Paid", "Balance"].map((h) => (
                              <th key={h} className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                          {receivables.items.map((r) => (
                            <tr key={`${r.source}-${r.source_id}`} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                              <td className="px-4 py-3">
                                <Badge variant={r.source === "ticket" ? "info" : "purple"}>{r.source}</Badge>
                              </td>
                              <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">{r.party_name}</td>
                              <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{r.party_contact || "—"}</td>
                              <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{fmtDate(r.issued_at)}</td>
                              <td className="px-4 py-3">
                                <Badge variant={r.age_days > 90 ? "danger" : r.age_days > 60 ? "warning" : "default"}>
                                  {r.age_days}d
                                </Badge>
                              </td>
                              <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{money(r.total_amount)}</td>
                              <td className="px-4 py-3 text-green-600 dark:text-green-400">{money(r.paid_amount)}</td>
                              <td className="px-4 py-3 font-semibold text-red-600">{money(r.balance)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {receivables.meta?.total > receivables.items.length && (
                        <p className="px-4 py-3 text-xs text-gray-400 border-t border-gray-100 dark:border-gray-700">
                          Showing the {receivables.items.length} oldest of{" "}
                          {receivables.meta.total}. Use the Tickets page filtered by
                          payment status to work through the rest.
                        </p>
                      )}
                    </div>
                  )}
                </Card>
              )}
            </div>
          )}

          {/* ── EXPENSES ─────────────────────────────── */}
          {tab === "expenses" && (
            <div className="space-y-6">
              <Card className="p-4">
                <div className="flex flex-wrap gap-3 items-end justify-between">
                  <div className="flex flex-wrap gap-3 items-end">
                    <Input
                      placeholder="Search description, vendor, reference…"
                      value={expenseFilters.search}
                      onChange={(e) =>
                        setExpenseFilters((f) => ({ ...f, search: e.target.value, page: 1 }))
                      }
                      className="w-64"
                    />
                    <Select
                      value={expenseFilters.category}
                      onChange={(e) =>
                        setExpenseFilters((f) => ({ ...f, category: e.target.value, page: 1 }))
                      }
                      className="w-48"
                    >
                      <option value="">All categories</option>
                      {categories.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {canEditExpenses && (
                    <Button onClick={() => setExpenseModal({ open: true, initial: null })}>
                      <Plus className="w-4 h-4" /> Record expense
                    </Button>
                  )}
                </div>
                {expenseMeta.message && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-3">
                    {expenseMeta.total} entries · {expenseMeta.message}
                  </p>
                )}
              </Card>

              <Card>
                {expenses.length === 0 ? (
                  <EmptyState
                    icon={Receipt}
                    title="No expenses recorded"
                    description="Record rent, salaries, utilities and other running costs so your net profit is real."
                    action={
                      canEditExpenses && (
                        <Button onClick={() => setExpenseModal({ open: true, initial: null })}>
                          <Plus className="w-4 h-4" /> Record expense
                        </Button>
                      )
                    }
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 dark:border-gray-700">
                          {["Date", "Category", "Description", "Vendor", "Account", "Reference", "Amount", "Recorded by", ""].map((h, i) => (
                            <th key={i} className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                        {expenses.map((e) => (
                          <tr key={e.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                            <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{fmtDate(e.expense_date)}</td>
                            <td className="px-4 py-3">
                              <Badge>{label(e.category)}</Badge>
                            </td>
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{e.description}</td>
                            <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{e.vendor || "—"}</td>
                            <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{e.account_name || label(e.payment_method)}</td>
                            <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{e.reference || "—"}</td>
                            <td className="px-4 py-3 font-semibold text-red-600 whitespace-nowrap">{money(e.amount)}</td>
                            <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{e.created_by_name || "—"}</td>
                            <td className="px-4 py-3">
                              {canEditExpenses && (
                                <div className="flex gap-1">
                                  <button
                                    onClick={() => setExpenseModal({ open: true, initial: e })}
                                    className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-gray-700"
                                  >
                                    <Pencil className="w-4 h-4" />
                                  </button>
                                  <button
                                    onClick={() => deleteExpense(e.id)}
                                    className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-gray-700"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="px-4 pb-4">
                  <Pagination
                    page={expenseFilters.page}
                    totalPages={expenseMeta.totalPages || 1}
                    onChange={(p) => setExpenseFilters((f) => ({ ...f, page: p }))}
                  />
                </div>
              </Card>
            </div>
          )}

          {tab === "tax" && <TaxPanel />}
        </>
      )}

      <ExpenseModal
        open={expenseModal.open}
        initial={expenseModal.initial}
        categories={categories}
        onClose={() => setExpenseModal({ open: false, initial: null })}
        onSaved={refreshAll}
      />
      <OpeningBalancesModal
        open={openingModal}
        onClose={() => setOpeningModal(false)}
        onSaved={refreshAll}
      />
    </div>
  );
}


// ── Tax owed to the authority ────────────────────────────────────────────────
//
// Tax arrives inside the fare and is not the agency's money. It accrues as a
// liability and leaves again when the authority is paid — so it gets the same
// treatment as an unsettled airline balance: a figure that should reach zero,
// and a payment that comes out of a real account.

function TaxPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [payOpen, setPayOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    taxAPI
      .get()
      .then((r) => setData(r.data.data))
      .catch((e) =>
        toast.error(e.response?.data?.message || "Failed to load tax"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data)
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );

  if (!data)
    return (
      <EmptyState
        icon={Landmark}
        title="Tax tracking unavailable"
        description="This needs a database update. Run migration_v15.sql."
      />
    );

  const { summary, payments, by_month } = data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Tile
          label="Tax collected"
          value={money(summary.tax_accrued)}
          sub={`On ${summary.taxed_tickets} ticket${summary.taxed_tickets === 1 ? "" : "s"}`}
          icon={Landmark}
        />
        <Tile
          label="Already paid"
          value={money(summary.tax_paid)}
          sub={summary.last_payment_at ? `Last ${fmtDate(summary.last_payment_at)}` : "Nothing paid yet"}
          tone="green"
          icon={CheckCircle2}
        />
        <Tile
          label="Still owed"
          value={money(summary.tax_owed)}
          sub={summary.tax_owed > 0 ? "Due to the tax authority" : "Fully settled"}
          tone={summary.tax_owed > 0 ? "red" : "green"}
          icon={AlertTriangle}
        />
      </div>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">
              This money is not yours to spend
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              It arrives inside the ticket price and is held until the authority
              is paid. It is not counted as revenue, and the airline is not
              credited with it.
            </p>
          </div>
          {summary.tax_owed > 0 && (
            <Button onClick={() => setPayOpen(true)}>
              <Banknote className="w-4 h-4" /> Pay tax
            </Button>
          )}
        </div>
      </Card>

      {by_month.length > 0 && (
        <Card className="overflow-hidden">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="font-semibold text-gray-900 dark:text-white text-sm">
              Tax collected by month
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Month</th>
                  <th className="text-right font-medium px-4 py-2.5">Tickets</th>
                  <th className="text-right font-medium px-4 py-2.5">Tax</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {by_month.map((m) => (
                  <tr key={m.month}>
                    <td className="px-4 py-2.5 text-gray-900 dark:text-white">
                      {fmtMonth(m.month)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-600 dark:text-gray-300">
                      {m.tickets}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold text-gray-900 dark:text-white">
                      {money(m.tax)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="font-semibold text-gray-900 dark:text-white text-sm">
            Payments made
          </h3>
        </div>
        {payments.length === 0 ? (
          <EmptyState
            icon={Landmark}
            title="No tax paid yet"
            description="When you pay the authority, record it here so the balance reflects it."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Date</th>
                  <th className="text-left font-medium px-4 py-2.5">Period</th>
                  <th className="text-left font-medium px-4 py-2.5">From</th>
                  <th className="text-left font-medium px-4 py-2.5">Reference</th>
                  <th className="text-right font-medium px-4 py-2.5">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300 whitespace-nowrap">
                      {fmtDate(p.paid_at)}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500">
                      {p.period_from || p.period_to
                        ? `${p.period_from ? fmtDate(p.period_from) : "…"} → ${p.period_to ? fmtDate(p.period_to) : "…"}`
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">
                      {p.account_name || "—"}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500">{p.reference || "—"}</td>
                    <td className="px-4 py-2.5 text-right font-semibold text-red-600 dark:text-red-400">
                      {money(p.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <PayTaxModal
        open={payOpen}
        owed={summary.tax_owed}
        onClose={() => setPayOpen(false)}
        onPaid={load}
      />
    </div>
  );
}

function PayTaxModal({ open, owed, onClose, onPaid }) {
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setAmount(owed > 0 ? Number(owed).toFixed(2) : "");
      setAccountId("");
      setPeriodFrom("");
      setPeriodTo("");
      setReference("");
    }
  }, [open, owed]);

  const submit = async (e) => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (!val || val <= 0) return toast.error("Enter a valid amount");
    if (val > Number(owed) + 0.001)
      return toast.error(`That's more than the ${money(owed)} owed`);
    if (!accountId) return toast.error("Choose the account paying the tax");

    setSaving(true);
    try {
      const res = await taxAPI.pay({
        amount: val,
        account_id: accountId,
        period_from: periodFrom || undefined,
        period_to: periodTo || undefined,
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

  return (
    <Modal open={open} onClose={onClose} title="Pay tax">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-4 text-center">
          <p className="text-2xl font-bold text-red-600">{money(owed)}</p>
          <p className="text-xs text-gray-500 mt-0.5">currently owed</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Amount *"
            type="number"
            min="0.01"
            step="0.01"
            max={owed}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <AccountSelect
            direction="out"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          />
          <Input
            label="Period from"
            type="date"
            value={periodFrom}
            onChange={(e) => setPeriodFrom(e.target.value)}
          />
          <Input
            label="Period to"
            type="date"
            value={periodTo}
            onChange={(e) => setPeriodTo(e.target.value)}
          />
        </div>

        <Input
          label="Reference (optional)"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Receipt or filing number"
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            <Banknote className="w-4 h-4" /> Pay {amount ? money(amount) : ""}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
