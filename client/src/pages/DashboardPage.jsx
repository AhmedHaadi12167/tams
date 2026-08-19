import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { reportsAPI } from "../services/api";
import { useAuth } from "../context/AuthContext";
import { Spinner } from "../components/ui";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  PieChart,
  Pie,
} from "recharts";
import {
  CalendarCheck,
  UserPlus,
  Wallet,
  CircleDollarSign,
  Plane,
  MapPin,
  Building2,
  ChevronRight,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { format } from "date-fns";

// ── Design tokens ────────────────────────────────────────────────────────────
// Soft blue palette: one accent hue, tinted surfaces, monochrome data shades.

const ACCENT = "#3b82f6";
const DONUT_SHADES = ["#1d4ed8", "#3b82f6", "#7dabf8", "#bfd7fd", "#e3edfe"];
const BAR_SHADES = ["#3b82f6", "#5b95f7", "#7dabf8", "#9ec1fa", "#bfd7fd", "#d9e7fe"];

const CARD =
  "bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700/60 shadow-[0_1px_3px_rgba(16,24,40,0.04)]";

const num = (v) => Number(v || 0);
const money = (v) =>
  `$${num(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const money2 = (v) =>
  `$${num(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (v) => num(v).toLocaleString("en-US");

// ── Delta pill ───────────────────────────────────────────────────────────────

const Delta = ({ value, invert }) => {
  if (value === null || value === undefined) return null;
  // For "outstanding balance", going up is bad — invert the colour meaning.
  const good = invert ? value <= 0 : value >= 0;
  const Icon = value >= 0 ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-semibold ${
        good
          ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400"
          : "bg-rose-50 text-rose-500 dark:bg-rose-900/20 dark:text-rose-400"
      }`}
    >
      <Icon className="w-3 h-3" />
      {value > 0 ? "+" : ""}
      {value}%
    </span>
  );
};

// ── KPI card ─────────────────────────────────────────────────────────────────

const Kpi = ({ label, value, icon: Icon, tint, delta, invert }) => (
  <div className={`${CARD} p-5`}>
    <div className="flex items-center gap-4">
      <div className={`w-12 h-12 rounded-2xl grid place-items-center shrink-0 ${tint}`}>
        <Icon className="w-[22px] h-[22px]" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-gray-400 dark:text-gray-500 font-medium truncate">
          {label}
        </p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <p className="text-[26px] leading-none font-bold text-gray-900 dark:text-white tracking-tight">
            {value}
          </p>
          <Delta value={delta} invert={invert} />
        </div>
      </div>
    </div>
  </div>
);

// ── Card shell with pill "dropdown" in the header ────────────────────────────

const Panel = ({ title, pill, onPillChange, pillOptions, action, children, className = "" }) => (
  <div className={`${CARD} p-6 ${className}`}>
    <div className="flex items-center justify-between gap-3 mb-6">
      <h2 className="font-semibold text-gray-900 dark:text-white text-[15px]">
        {title}
      </h2>
      {pillOptions ? (
        <div className="relative">
          <select
            value={pill}
            onChange={onPillChange}
            className="appearance-none bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-lg pl-3 pr-7 py-1.5 cursor-pointer focus:outline-none transition"
          >
            {pillOptions.map((o) => (
              <option key={o.value} value={o.value} className="text-gray-900">
                {o.label}
              </option>
            ))}
          </select>
          <ChevronRight className="w-3 h-3 text-white absolute right-2 top-1/2 -translate-y-1/2 rotate-90 pointer-events-none" />
        </div>
      ) : (
        action
      )}
    </div>
    {children}
  </div>
);

const NoData = ({ height = 240 }) => (
  <div
    className="flex items-center justify-center text-sm text-gray-300 dark:text-gray-600"
    style={{ height }}
  >
    No data for this period
  </div>
);

// ── Chart tooltip matching the reference ─────────────────────────────────────

const ChartTip = ({ active, payload, label, formatter }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl bg-gray-900 text-white px-3 py-2 shadow-lg">
      <p className="text-sm font-bold leading-tight">
        {formatter ? formatter(payload[0].value) : payload[0].value}
      </p>
      <p className="text-[10px] text-gray-400 mt-0.5">{label}</p>
    </div>
  );
};

// ── Legend list beside the donut ─────────────────────────────────────────────

const DonutLegend = ({ data, total, sub }) => (
  <div className="space-y-3.5">
    {data.map((d, i) => (
      <div key={d.name} className="flex items-start gap-2.5">
        <span
          className="w-2.5 h-2.5 rounded-full mt-1 shrink-0"
          style={{ background: DONUT_SHADES[i % DONUT_SHADES.length] }}
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-tight truncate">
            {d.name}{" "}
            <span className="text-gray-400 font-normal">
              ({total > 0 ? Math.round((d.value / total) * 100) : 0}%)
            </span>
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            {sub(d)}
          </p>
        </div>
      </div>
    ))}
  </div>
);

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [period, setPeriod] = useState("month");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    reportsAPI
      .dashboard({ period })
      .then((res) => setData(res.data.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [period]);

  if (loading)
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );

  if (error)
    return (
      <div className="flex items-center justify-center h-64 text-center">
        <div>
          <p className="text-rose-500 font-medium">Failed to load dashboard</p>
          <p className="text-sm text-gray-400 mt-1">{error}</p>
        </div>
      </div>
    );

  if (!data) return null;

  const s = data.summary || {};
  const d = data.deltas || {};
  const isSuperAdmin = data.isSuperAdmin === true;

  const periodOptions = [
    { value: "today", label: "Today" },
    { value: "week", label: "This Week" },
    { value: "month", label: "This Month" },
    { value: "all", label: "All Time" },
  ];
  const periodLabel =
    periodOptions.find((o) => o.value === period)?.label || "This Month";

  // ── Chart data ─────────────────────────────────────────
  const trend = (data.chart || [])
    .map((x) => {
      try {
        return {
          date: format(new Date(x.date), "MMM d"),
          revenue: parseFloat(x.revenue) || 0,
          tickets: parseInt(x.tickets) || 0,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const routes = (data.topRoutes || []).slice(0, 5).map((r) => ({
    name: r.route,
    value: parseInt(r.bookings) || 0,
  }));

  const airlines = (data.topAirlines || []).slice(0, 5).map((a) => ({
    name: a.airline_name,
    value: parseInt(a.tickets) || 0,
    revenue: parseFloat(a.revenue) || 0,
  }));

  const businesses = (data.topBusinesses || []).slice(0, 5).map((b) => ({
    name: b.business_name,
    value: parseInt(b.tickets_this_month) || 0,
    revenue: parseFloat(b.revenue_this_month) || 0,
  }));

  // Donut = top destinations (where people actually fly to)
  const destSource = isSuperAdmin ? businesses : routes;
  const destTotal = destSource.reduce((a, b) => a + b.value, 0);

  const barSource = isSuperAdmin ? businesses : airlines;
  const recent = data.recentTickets || [];

  const titles = {
    super_admin: "Dashboard",
    admin: "Dashboard",
    agent: "My Dashboard",
    accountant: "Finance Dashboard",
  };

  const kpis = isSuperAdmin
    ? [
        { label: "Total Bookings", value: count(s.total_tickets), icon: CalendarCheck, tint: "bg-blue-50 text-blue-500 dark:bg-blue-900/20 dark:text-blue-400", delta: d.total_tickets },
        { label: "Active Agencies", value: count(s.active_businesses), icon: Building2, tint: "bg-indigo-50 text-indigo-500 dark:bg-indigo-900/20 dark:text-indigo-400", delta: null },
        { label: "Total Earnings", value: money(s.total_revenue), icon: CircleDollarSign, tint: "bg-emerald-50 text-emerald-500 dark:bg-emerald-900/20 dark:text-emerald-400", delta: d.total_revenue },
        { label: "Outstanding", value: money(s.unpaid_money), icon: Wallet, tint: "bg-amber-50 text-amber-500 dark:bg-amber-900/20 dark:text-amber-400", delta: d.unpaid_money, invert: true },
      ]
    : [
        { label: "Total Bookings", value: count(s.total_tickets), icon: CalendarCheck, tint: "bg-blue-50 text-blue-500 dark:bg-blue-900/20 dark:text-blue-400", delta: d.total_tickets },
        { label: "Money Collected", value: money(s.collected_money), icon: UserPlus, tint: "bg-indigo-50 text-indigo-500 dark:bg-indigo-900/20 dark:text-indigo-400", delta: d.collected_money },
        { label: "Total Earnings", value: money(s.total_revenue), icon: CircleDollarSign, tint: "bg-emerald-50 text-emerald-500 dark:bg-emerald-900/20 dark:text-emerald-400", delta: d.total_revenue },
        { label: "Outstanding", value: money(s.unpaid_money), icon: Wallet, tint: "bg-amber-50 text-amber-500 dark:bg-amber-900/20 dark:text-amber-400", delta: d.unpaid_money, invert: true },
      ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-[22px] font-bold text-gray-900 dark:text-white tracking-tight">
          {titles[user?.role] || "Dashboard"}
        </h1>
        <div className="relative">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="appearance-none bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 text-sm rounded-xl pl-4 pr-9 py-2 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            {periodOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <ChevronRight className="w-3.5 h-3.5 text-gray-400 absolute right-3 top-1/2 -translate-y-1/2 rotate-90 pointer-events-none" />
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {kpis.map((k) => (
          <Kpi key={k.label} {...k} />
        ))}
      </div>

      {/* Revenue overview + destinations */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <Panel
          title="Revenue Overview"
          pill={period}
          pillOptions={periodOptions}
          onPillChange={(e) => setPeriod(e.target.value)}
          className="lg:col-span-3"
        >
          {trend.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={trend} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ACCENT} stopOpacity={0.16} />
                    <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="4 4"
                  stroke="rgba(148,163,184,0.22)"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "#94a3b8" }}
                  tickLine={false}
                  axisLine={false}
                  dy={8}
                  minTickGap={20}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#94a3b8" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `$${v >= 1000 ? `${v / 1000}k` : v}`}
                />
                <Tooltip
                  cursor={{ stroke: ACCENT, strokeWidth: 1, strokeDasharray: "4 4" }}
                  content={<ChartTip formatter={money2} />}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke={ACCENT}
                  strokeWidth={2.5}
                  fill="url(#revFill)"
                  dot={false}
                  activeDot={{
                    r: 5,
                    fill: "#fff",
                    stroke: ACCENT,
                    strokeWidth: 3,
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <NoData height={250} />
          )}
        </Panel>

        <Panel
          title={isSuperAdmin ? "Top Agencies" : "Top Destinations"}
          action={
            <span className="text-xs font-semibold text-blue-500 bg-blue-50 dark:bg-blue-900/20 px-3 py-1.5 rounded-lg">
              {periodLabel}
            </span>
          }
          className="lg:col-span-2"
        >
          {destSource.length > 0 ? (
            <div className="flex items-center gap-4">
              <div className="shrink-0">
                <PieChart width={148} height={148}>
                  <Pie
                    data={destSource}
                    cx={70}
                    cy={70}
                    innerRadius={44}
                    outerRadius={68}
                    paddingAngle={2}
                    dataKey="value"
                    stroke="none"
                  >
                    {destSource.map((_, i) => (
                      <Cell key={i} fill={DONUT_SHADES[i % DONUT_SHADES.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTip />} />
                </PieChart>
              </div>
              <div className="min-w-0 flex-1">
                <DonutLegend
                  data={destSource}
                  total={destTotal}
                  sub={(x) =>
                    isSuperAdmin
                      ? `${x.value} bookings`
                      : `${x.value} passenger${x.value === 1 ? "" : "s"}`
                  }
                />
              </div>
            </div>
          ) : (
            <NoData height={180} />
          )}
        </Panel>
      </div>

      {/* Airlines + recent activity */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <Panel
          title={isSuperAdmin ? "Bookings by Agency" : "Bookings by Airline"}
          action={
            !isSuperAdmin && (
              <Link
                to="/airlines"
                className="text-xs font-semibold text-blue-500 hover:text-blue-600 bg-blue-50 dark:bg-blue-900/20 px-3 py-1.5 rounded-lg"
              >
                View all
              </Link>
            )
          }
          className="lg:col-span-3"
        >
          {barSource.length > 0 ? (
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={barSource} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid
                  strokeDasharray="4 4"
                  stroke="rgba(148,163,184,0.22)"
                  vertical={false}
                />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "#94a3b8" }}
                  tickLine={false}
                  axisLine={false}
                  dy={6}
                  interval={0}
                  tickFormatter={(v) => (v?.length > 12 ? `${v.slice(0, 11)}…` : v)}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#94a3b8" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  cursor={{ fill: "rgba(59,130,246,0.06)" }}
                  content={<ChartTip />}
                />
                <Bar dataKey="value" radius={[8, 8, 8, 8]} barSize={34}>
                  {barSource.map((_, i) => (
                    <Cell key={i} fill={BAR_SHADES[i % BAR_SHADES.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <NoData height={230} />
          )}
        </Panel>

        <Panel
          title="Recent Bookings"
          action={
            <Link
              to="/tickets"
              className="text-xs font-semibold text-blue-500 hover:text-blue-600 bg-blue-50 dark:bg-blue-900/20 px-3 py-1.5 rounded-lg"
            >
              View all
            </Link>
          }
          className="lg:col-span-2"
        >
          {recent.length > 0 ? (
            <div className="space-y-1 -my-1">
              {recent.slice(0, 5).map((t, i) => (
                <div key={t.id || i} className="flex items-center gap-3 py-2.5">
                  <div className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/20 grid place-items-center shrink-0">
                    <Plane className="w-4 h-4 text-blue-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate leading-tight">
                      {t.passenger_name}
                    </p>
                    <p className="text-xs text-gray-400 dark:text-gray-500 truncate mt-0.5 flex items-center gap-1">
                      <MapPin className="w-3 h-3 shrink-0" />
                      {t.from_city} → {t.to_city}
                    </p>
                  </div>
                  <p className="text-sm font-bold text-gray-900 dark:text-white shrink-0">
                    {money(t.selling_price)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <NoData height={180} />
          )}
        </Panel>
      </div>
    </div>
  );
}
