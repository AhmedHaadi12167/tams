import React, { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import {
  BookOpen,
  ListTree,
  Scale,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  Search,
  ArrowRight,
} from "lucide-react";
import { Card, Badge, Spinner, Select, Pagination } from "../../components/ui";
import { booksAPI } from "../../services/booksApi";
import { fmtDate } from "../../utils/date";
import { money, acct, sourceLabel } from "./format";

/**
 * The books — generated automatically from every booking, payment, refund,
 * expense, transfer, deposit, opening balance and owner movement.
 *
 *   Trial balance    every account, debits = credits
 *   General ledger   one account, line by line, with a running balance
 *   Journal          every event and its balanced debit/credit lines
 */
const VIEWS = [
  { key: "tb", label: "Trial balance", icon: Scale },
  { key: "gl", label: "General ledger", icon: ListTree },
  { key: "journal", label: "Journal", icon: BookOpen },
];

const TYPE_ORDER = ["asset", "liability", "equity", "income", "expense"];

// Opening balances are dated at the start of time so they come first in
// every ledger; show them as "Opening" rather than a 1970 date.
const when = (d) => (new Date(d).getFullYear() < 1971 ? "Opening" : fmtDate(d));
const TYPE_LABEL = { asset: "Assets", liability: "Liabilities", equity: "Equity", income: "Income", expense: "Expenses" };

export default function BooksPanel({ range }) {
  const [view, setView] = useState("tb");
  const [ledger, setLedger] = useState({ code: "1000", party_id: "" });

  const openLedger = (code, party_id = "") => {
    setLedger({ code, party_id });
    setView("gl");
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Books</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Written automatically from every transaction — nobody types a journal entry, so the books always match the bookings.
          </p>
        </div>
        <div className="inline-flex rounded-lg bg-gray-100 dark:bg-gray-800 p-1">
          {VIEWS.map((v) => {
            const Icon = v.icon;
            const on = view === v.key;
            return (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition ${
                  on
                    ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
                }`}
              >
                <Icon className="w-4 h-4" /> {v.label}
              </button>
            );
          })}
        </div>
      </div>

      {view === "tb" && <TrialBalance asOf={range.to_date} onOpen={openLedger} />}
      {view === "gl" && <GeneralLedger range={range} initial={ledger} />}
      {view === "journal" && <Journal range={range} />}
    </div>
  );
}

// ── Trial balance ─────────────────────────────────────────────────────────

function TrialBalance({ asOf, onOpen }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState({ 1000: true });

  useEffect(() => {
    setData(null);
    booksAPI
      .trialBalance(asOf ? { as_of: asOf } : {})
      .then((r) => setData(r.data.data))
      .catch((e) => toast.error(e.response?.data?.message || "Couldn't load the trial balance"));
  }, [asOf]);

  if (!data) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>;

  const groups = TYPE_ORDER.map((t) => ({
    type: t,
    rows: data.rows.filter((r) => r.type === t && (r.debit || r.credit || r.total_debits || r.total_credits)),
  })).filter((g) => g.rows.length);

  const s = data.summary;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {[
          ["Assets", s.assets, "blue"],
          ["Liabilities", s.liabilities, "orange"],
          ["Equity", s.equity, "purple"],
          ["Income", s.income, "green"],
          ["Expenses", s.expenses, "red"],
          ["Net profit", s.net_profit, s.net_profit >= 0 ? "green" : "red"],
        ].map(([l, v, tone]) => (
          <Card key={l} className="px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{l}</p>
            <p className={`text-lg font-bold tabular-nums mt-0.5 ${toneClass(tone)}`}>{money(v)}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-gray-100 dark:border-gray-700">
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white text-sm">Trial balance</h3>
            <p className="text-xs text-gray-500">As at {fmtDate(data.as_of)}</p>
          </div>
          {data.totals.balanced ? (
            <Badge variant="success"><CheckCircle2 className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />Debits equal credits</Badge>
          ) : (
            <Badge variant="danger"><AlertTriangle className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />Out by {money(data.totals.difference)}</Badge>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 bg-gray-50 dark:bg-gray-800/60">
                <th className="px-5 py-2.5 w-20">Code</th>
                <th className="px-3 py-2.5">Account</th>
                <th className="px-3 py-2.5 text-right">Debit</th>
                <th className="px-5 py-2.5 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <React.Fragment key={g.type}>
                  <tr>
                    <td colSpan={4} className="px-5 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                      {TYPE_LABEL[g.type]}
                    </td>
                  </tr>
                  {g.rows.map((r) => {
                    const expandable = r.detail?.length > 0;
                    const isOpen = open[r.code];
                    return (
                      <React.Fragment key={r.code}>
                        <tr className="border-t border-gray-100 dark:border-gray-700/50 hover:bg-gray-50/70 dark:hover:bg-gray-800/40">
                          <td className="px-5 py-2 text-gray-400 tabular-nums">{r.code}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5">
                              {expandable ? (
                                <button onClick={() => setOpen((o) => ({ ...o, [r.code]: !o[r.code] }))} className="text-gray-400 hover:text-gray-700">
                                  {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                </button>
                              ) : <span className="w-4" />}
                              <button onClick={() => onOpen(r.code)} className="text-gray-800 dark:text-gray-200 hover:text-blue-600 dark:hover:text-blue-400 text-left">
                                {r.name}
                              </button>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.debit ? money(r.debit) : ""}</td>
                          <td className="px-5 py-2 text-right tabular-nums">{r.credit ? money(r.credit) : ""}</td>
                        </tr>
                        {expandable && isOpen && r.detail.map((d) => (
                          <tr key={r.code + d.label} className="text-xs text-gray-500">
                            <td />
                            <td className="px-3 py-1 pl-12">
                              {r.code === "1000" ? (
                                <button onClick={() => onOpen("1000", d.party_id || "none")} className="hover:text-blue-600">{d.label}</button>
                              ) : d.label}
                            </td>
                            <td className="px-3 py-1 text-right tabular-nums">{d.balance >= 0 && (r.type === "asset" || r.type === "expense") ? money(d.balance) : ""}</td>
                            <td className="px-5 py-1 text-right tabular-nums">{d.balance < 0 || !(r.type === "asset" || r.type === "expense") ? money(Math.abs(d.balance)) : ""}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-300 dark:border-gray-600 font-bold text-gray-900 dark:text-white">
                <td className="px-5 py-3" />
                <td className="px-3 py-3">Total</td>
                <td className="px-3 py-3 text-right tabular-nums">{money(data.totals.debit)}</td>
                <td className="px-5 py-3 text-right tabular-nums">{money(data.totals.credit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Click any account to see every line behind it in the general ledger.
      </p>
    </div>
  );
}

// ── General ledger ────────────────────────────────────────────────────────

function GeneralLedger({ range, initial }) {
  const [chart, setChart] = useState([]);
  const [code, setCode] = useState(initial.code || "1000");
  const [party, setParty] = useState(initial.party_id || "");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [accounts, setAccounts] = useState([]);

  useEffect(() => { setCode(initial.code || "1000"); setParty(initial.party_id || ""); setPage(1); }, [initial]);
  useEffect(() => {
    booksAPI.chart().then((r) => setChart(r.data.data)).catch(() => {});
    booksAPI.trialBalance({}).then((r) => {
      const cash = r.data.data.rows.find((x) => x.code === "1000");
      setAccounts(cash?.detail || []);
    }).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setData(null);
    const params = { code, page, limit: 100 };
    if (party) params.party_id = party;
    if (range.from_date) params.from_date = range.from_date;
    if (range.to_date) params.to_date = range.to_date;
    booksAPI.generalLedger(params).then((r) => setData(r.data.data))
      .catch((e) => toast.error(e.response?.data?.message || "Couldn't load the ledger"));
  }, [code, party, page, range]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-72">
            <Select label="Account" value={code} onChange={(e) => { setCode(e.target.value); setParty(""); setPage(1); }}>
              {chart.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
            </Select>
          </div>
          {code === "1000" && (
            <div className="w-full sm:w-60">
              <Select label="Payment account" value={party} onChange={(e) => { setParty(e.target.value); setPage(1); }}>
                <option value="">All accounts</option>
                {accounts.map((a) => <option key={a.label} value={a.party_id || "none"}>{a.label}</option>)}
              </Select>
            </div>
          )}
          <p className="text-xs text-gray-500 pb-2">
            {range.from_date || range.to_date ? `${range.from_date ? fmtDate(range.from_date) : "Start"} → ${range.to_date ? fmtDate(range.to_date) : "today"}` : "All time"} · change the dates at the top of the page
          </p>
        </div>
      </Card>

      {!data ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-gray-100 dark:bg-gray-700">
            {[
              ["Opening balance", data.opening_balance],
              ["Debits", data.totals.debit],
              ["Credits", data.totals.credit],
              ["Closing balance", data.closing_balance],
            ].map(([l, v]) => (
              <div key={l} className="bg-white dark:bg-gray-800 px-4 py-3">
                <p className="text-[11px] uppercase tracking-wide text-gray-500">{l}</p>
                <p className="text-base font-semibold tabular-nums text-gray-900 dark:text-white">{acct(v)}</p>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500 bg-gray-50 dark:bg-gray-800/60">
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-3 py-2.5">Description</th>
                  <th className="px-3 py-2.5">Party</th>
                  <th className="px-3 py-2.5 text-right">Debit</th>
                  <th className="px-3 py-2.5 text-right">Credit</th>
                  <th className="px-4 py-2.5 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {data.lines.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">No entries in this period.</td></tr>
                )}
                {data.lines.map((l, i) => (
                  <tr key={i} className="hover:bg-gray-50/70 dark:hover:bg-gray-800/40">
                    <td className="px-4 py-2 whitespace-nowrap text-gray-500">{when(l.entry_at)}</td>
                    <td className="px-3 py-2">
                      <p className="text-gray-800 dark:text-gray-200">{l.memo}</p>
                      <p className="text-[11px] text-gray-400">{sourceLabel(l.source)}{l.detail ? ` · ${l.detail}` : ""}</p>
                    </td>
                    <td className="px-3 py-2 text-gray-500">{l.party_name || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.debit ? money(l.debit) : ""}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.credit ? money(l.credit) : ""}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium text-gray-900 dark:text-white">{acct(l.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.meta.totalPages > 1 && (
            <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-700">
              <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ── Journal ───────────────────────────────────────────────────────────────

function Journal({ range }) {
  const [page, setPage] = useState(1);
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => { setQ(search); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setData(null);
    const params = { page, limit: 20 };
    if (source) params.source = source;
    if (q) params.search = q;
    if (range.from_date) params.from_date = range.from_date;
    if (range.to_date) params.to_date = range.to_date;
    booksAPI.journal(params).then((r) => setData(r.data.data))
      .catch((e) => toast.error(e.response?.data?.message || "Couldn't load the journal"));
  }, [page, source, q, range]);

  const sources = [
    ["", "All transactions"],
    ["ticket", "Tickets"],
    ["visa", "Visas"],
    ["package", "Packages"],
    ["cargo", "Cargo"],
    ["airline", "Airline payments"],
    ["deposit", "Deposits"],
    ["expense", "Expenses"],
    ["transfer", "Transfers"],
    ["tax", "Tax"],
    ["agent", "Agent commission"],
    ["opening", "Opening balances"],
    ["owner", "Owners"],
  ];

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, passenger, reference…"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="w-full sm:w-56">
            <Select value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }}>
              {sources.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
          {data && <p className="text-xs text-gray-500 pb-2">{data.meta.total} transaction{data.meta.total === 1 ? "" : "s"}</p>}
        </div>
      </Card>

      {!data ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : data.entries.length === 0 ? (
        <Card className="p-10 text-center text-sm text-gray-400">No transactions match.</Card>
      ) : (
        <div className="space-y-3">
          {data.entries.map((e) => (
            <Card key={`${e.source}-${e.source_id}-${e.entry_at}`} className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-gray-50/80 dark:bg-gray-800/60">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs text-gray-500 whitespace-nowrap">{when(e.entry_at)}</span>
                  <Badge variant="info">{sourceLabel(e.source)}</Badge>
                  <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{e.memo}</span>
                </div>
                <span className="text-sm font-semibold tabular-nums text-gray-700 dark:text-gray-200">{money(e.total)}</span>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {e.lines.map((l, i) => (
                    <tr key={i} className="border-t border-gray-100 dark:border-gray-700/50">
                      <td className={`py-1.5 ${l.credit ? "pl-12" : "pl-4"} pr-3`}>
                        <span className="text-gray-400 tabular-nums mr-2">{l.code}</span>
                        <span className="text-gray-800 dark:text-gray-200">{l.account_name}</span>
                        {(l.party_name || l.detail) && (
                          <span className="text-gray-400"> <ArrowRight className="w-3 h-3 inline -mt-0.5" /> {l.party_name || l.detail}</span>
                        )}
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums w-32">{l.debit ? money(l.debit) : ""}</td>
                      <td className="py-1.5 px-4 text-right tabular-nums w-32 text-gray-500">{l.credit ? money(l.credit) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
          {data.meta.totalPages > 1 && <Pagination page={page} totalPages={data.meta.totalPages} onChange={setPage} />}
        </div>
      )}
    </div>
  );
}

function toneClass(t) {
  return {
    blue: "text-blue-600 dark:text-blue-400",
    orange: "text-orange-600 dark:text-orange-400",
    purple: "text-purple-600 dark:text-purple-400",
    green: "text-green-600 dark:text-green-400",
    red: "text-red-600 dark:text-red-400",
  }[t] || "text-gray-900 dark:text-white";
}
