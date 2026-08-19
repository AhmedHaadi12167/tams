import React, { useState, useEffect, useCallback } from "react";
import { airlinesAPI, downloadBlob } from "../services/api";
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
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  Plane,
  FileText,
  ArrowLeft,
  Trophy,
  Users,
  MapPin,
  ChevronRight,
  Merge,
  AlertTriangle,
  Pencil,
  Tags,
  X,
} from "lucide-react";
import { format } from "date-fns";

const COLORS = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4"];

const money = (v) =>
  `$${Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => {
  if (!d) return "—";
  try {
    return format(new Date(d), "dd MMM yyyy");
  } catch {
    return "—";
  }
};

const EMPTY_FILTERS = {
  from_date: "",
  to_date: "",
  ticket_type: "",
  airline_name: "",
  date_basis: "booked",
};

// ── Summary tile ─────────────────────────────────────────────────────────────

const Tile = ({ label, value, tone = "gray" }) => {
  const tones = {
    gray: "text-gray-900 dark:text-white",
    green: "text-green-600 dark:text-green-400",
    red: "text-red-600 dark:text-red-400",
    blue: "text-blue-600 dark:text-blue-400",
    orange: "text-orange-600 dark:text-orange-400",
  };
  return (
    <div className="px-4 py-3 rounded-xl bg-gray-50 dark:bg-gray-700/40">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        {label}
      </p>
      <p className={`text-lg font-bold mt-1 ${tones[tone]}`}>{value}</p>
    </div>
  );
};

// ── Passenger drill-down ─────────────────────────────────────────────────────

function AirlineDetail({ airline, filters, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setLoading(true);
    airlinesAPI
      .passengers(airline, { ...filters, page, limit: 50 })
      .then((res) => setData(res.data.data))
      .catch(() => toast.error("Failed to load airline detail"))
      .finally(() => setLoading(false));
  }, [airline, filters, page]);

  const exportPDF = async () => {
    setExporting(true);
    try {
      const res = await airlinesAPI.exportPDF(airline, filters);
      downloadBlob(
        res.data,
        `airline-${airline.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.pdf`,
      );
      toast.success("PDF downloaded");
    } catch {
      toast.error("Export failed");
    } finally {
      setExporting(false);
    }
  };

  if (loading && !data)
    return (
      <div className="flex justify-center py-20">
        <Spinner size="lg" />
      </div>
    );

  const s = data?.summary || {};
  const passengers = data?.passengers || [];
  const routes = data?.routes || [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              {airline}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {s.tickets} ticket{s.tickets === 1 ? "" : "s"} · {s.passengers}{" "}
              passenger{s.passengers === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <Button variant="outline" loading={exporting} onClick={exportPDF}>
          <FileText className="w-4 h-4" /> Export PDF
        </Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Tile label="Tickets" value={s.tickets ?? 0} tone="blue" />
        <Tile label="Passengers" value={s.passengers ?? 0} />
        <Tile label="Total Sales" value={money(s.total_sales)} />
        <Tile label="Airline Cost" value={money(s.total_cost)} tone="orange" />
        <Tile label="Revenue" value={money(s.total_revenue)} tone="green" />
        <Tile label="Balance Due" value={money(s.total_balance)} tone="red" />
      </div>

      {/* Routes */}
      {routes.length > 0 && (
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-5">
            <MapPin className="w-4 h-4 text-green-600" />
            <h2 className="font-semibold text-gray-900 dark:text-white text-sm">
              Where they fly
            </h2>
          </div>
          <ResponsiveContainer width="100%" height={Math.max(180, routes.length * 32)}>
            <BarChart
              data={routes.map((r) => ({ name: r.route, tickets: r.tickets, revenue: r.revenue }))}
              layout="vertical"
              margin={{ left: 10, right: 20 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ borderRadius: "10px", border: "none", fontSize: "12px", boxShadow: "0 4px 20px rgba(0,0,0,0.12)" }}
                formatter={(v, n) => (n === "revenue" ? [money(v), "Revenue"] : [v, "Tickets"])}
              />
              <Bar dataKey="tickets" name="tickets" radius={[0, 6, 6, 0]} barSize={16}>
                {routes.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Passengers */}
      <Card>
        <div className="flex items-center gap-2 px-6 pt-6 pb-4">
          <Users className="w-4 h-4 text-blue-600" />
          <h2 className="font-semibold text-gray-900 dark:text-white text-sm">
            Passengers
          </h2>
        </div>
        {loading ? (
          <div className="flex justify-center py-16">
            <Spinner size="lg" />
          </div>
        ) : passengers.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No passengers"
            description="No tickets sold on this airline for the selected filters."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  {[
                    "Passenger",
                    "Phone",
                    "Route",
                    "Flight Date",
                    "Type",
                    "Ref",
                    "Total",
                    "Paid",
                    "Balance",
                    "Revenue",
                    "Agent",
                    "Payment",
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {passengers.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">
                      {p.passenger_name}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      {p.contact_number || p.customer_phone || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      {p.from_city} → {p.to_city}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      {fmtDate(p.flight_date)}
                      {p.trip_type === "round_trip" && p.return_date && (
                        <p className="text-xs text-gray-400">⇄ {fmtDate(p.return_date)}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={p.ticket_type === "LOCAL" ? "info" : "purple"}>
                        {p.ticket_type}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {p.ticket_reference || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {money(p.selling_price)}
                    </td>
                    <td className="px-4 py-3 text-green-600 dark:text-green-400">
                      {money(p.amount_paid)}
                    </td>
                    <td
                      className={`px-4 py-3 font-semibold ${Number(p.balance) > 0 ? "text-red-600" : "text-gray-400"}`}
                    >
                      {money(p.balance)}
                    </td>
                    <td className="px-4 py-3 font-semibold text-green-600 dark:text-green-400">
                      {money(p.revenue)}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      {p.agent_name || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={
                          p.payment_status === "paid"
                            ? "success"
                            : p.payment_status === "partial"
                              ? "warning"
                              : "danger"
                        }
                      >
                        {p.payment_status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-4 pb-4">
          <Pagination
            page={page}
            totalPages={data?.meta?.totalPages || 1}
            onChange={setPage}
          />
        </div>
      </Card>
    </div>
  );
}

// ── Manage modal: rename + merge duplicates ──────────────────────────────────

function ManageModal({ open, onClose, onChanged }) {
  const [master, setMaster] = useState([]);
  const [dupes, setDupes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState("");
  const [into, setInto] = useState("");
  const [editing, setEditing] = useState(null);
  const [newName, setNewName] = useState("");
  const [aliasFor, setAliasFor] = useState(null);
  const [aliasList, setAliasList] = useState([]);
  const [newAlias, setNewAlias] = useState("");

  const load = useCallback(() => {
    Promise.all([airlinesAPI.master(), airlinesAPI.duplicates()])
      .then(([m, d]) => {
        setMaster(m.data.data || []);
        setDupes(d.data.data || []);
      })
      .catch(() => toast.error("Failed to load airline list"));
  }, []);

  const openAliases = (id) => {
    if (aliasFor === id) {
      setAliasFor(null);
      return;
    }
    setAliasFor(id);
    setNewAlias("");
    airlinesAPI
      .aliases(id)
      .then((r) => setAliasList(r.data.data || []))
      .catch(() => setAliasList([]));
  };

  const saveAlias = async () => {
    if (!newAlias.trim()) return;
    setBusy(true);
    try {
      const r = await airlinesAPI.addAlias(aliasFor, newAlias.trim());
      toast.success(r.data.message);
      setNewAlias("");
      openAliases(aliasFor);
      setAliasFor(aliasFor);
      airlinesAPI.aliases(aliasFor).then((x) => setAliasList(x.data.data || []));
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to add alias");
    } finally {
      setBusy(false);
    }
  };

  const removeAlias = async (aliasId) => {
    try {
      await airlinesAPI.deleteAlias(aliasId);
      setAliasList((l) => l.filter((a) => a.id !== aliasId));
      toast.success("Alias removed");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to remove alias");
    }
  };

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const doMerge = async (fromId, intoId) => {
    if (!fromId || !intoId) return toast.error("Pick both airlines");
    if (fromId === intoId) return toast.error("Pick two different airlines");
    setBusy(true);
    try {
      const res = await airlinesAPI.merge({ from_id: fromId, into_id: intoId });
      toast.success(res.data.message);
      setFrom("");
      setInto("");
      load();
      onChanged();
    } catch (err) {
      toast.error(err.response?.data?.message || "Merge failed");
    } finally {
      setBusy(false);
    }
  };

  const doRename = async (id) => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await airlinesAPI.rename(id, { name: newName.trim() });
      toast.success("Airline renamed");
      setEditing(null);
      setNewName("");
      load();
      onChanged();
    } catch (err) {
      toast.error(err.response?.data?.message || "Rename failed");
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (id) => master.find((m) => m.id === id)?.name || "";

  return (
    <Modal open={open} onClose={onClose} title="Manage airlines" size="lg">
      <div className="space-y-6">
        {/* Suggested duplicates */}
        {dupes.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                Possible duplicates ({dupes.length})
              </h3>
            </div>
            <div className="space-y-2">
              {dupes.map((p, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-3 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/10 dark:border-amber-800"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900 dark:text-white truncate">
                      <span className="font-semibold">{p.a.name}</span>
                      <span className="text-gray-400 mx-1.5">vs</span>
                      <span className="font-semibold">{p.b.name}</span>
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {p.reason} · {p.a.ticket_count} and {p.b.ticket_count} tickets
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    loading={busy}
                    onClick={() =>
                      doMerge(
                        // keep the one with more tickets
                        Number(p.a.ticket_count) < Number(p.b.ticket_count) ? p.a.id : p.b.id,
                        Number(p.a.ticket_count) < Number(p.b.ticket_count) ? p.b.id : p.a.id,
                      )
                    }
                  >
                    <Merge className="w-3.5 h-3.5" /> Merge
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Manual merge */}
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
            Merge two airlines
          </h3>
          <div className="flex flex-wrap gap-3 items-end">
            <Select
              label="Move tickets from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-52"
            >
              <option value="">Select…</option>
              {master.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.ticket_count})
                </option>
              ))}
            </Select>
            <Select
              label="Into"
              value={into}
              onChange={(e) => setInto(e.target.value)}
              className="w-52"
            >
              <option value="">Select…</option>
              {master.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.ticket_count})
                </option>
              ))}
            </Select>
            <Button loading={busy} onClick={() => doMerge(from, into)}>
              <Merge className="w-4 h-4" /> Merge
            </Button>
          </div>
          {from && into && from !== into && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              Every ticket on <strong>{nameOf(from)}</strong> will move to{" "}
              <strong>{nameOf(into)}</strong>, and <strong>{nameOf(from)}</strong>{" "}
              will be removed. Ticket history is kept.
            </p>
          )}
        </div>

        {/* Full list */}
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
            All airlines ({master.length})
          </h3>
          <div className="border border-gray-200 dark:border-gray-700 rounded-xl divide-y divide-gray-100 dark:divide-gray-700 max-h-80 overflow-y-auto">
            {master.map((a) => (
              <div key={a.id}>
                <div className="flex items-center gap-3 px-4 py-2.5">
                  {editing === a.id ? (
                    <>
                      <Input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        className="flex-1"
                        autoFocus
                      />
                      <Button size="sm" loading={busy} onClick={() => doRename(a.id)}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-gray-900 dark:text-white flex-1 truncate">
                        {a.name}
                      </p>
                      <Badge>{a.ticket_count} tickets</Badge>
                      <button
                        title="Aliases"
                        onClick={() => openAliases(a.id)}
                        className={`p-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-gray-700 ${
                          aliasFor === a.id
                            ? "text-blue-600"
                            : "text-gray-400 hover:text-blue-600"
                        }`}
                      >
                        <Tags className="w-4 h-4" />
                      </button>
                      <button
                        title="Rename"
                        onClick={() => {
                          setEditing(a.id);
                          setNewName(a.name);
                        }}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-gray-700"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>

                {aliasFor === a.id && (
                  <div className="px-4 pb-3 bg-gray-50 dark:bg-gray-700/30">
                    <p className="text-xs text-gray-500 dark:text-gray-400 py-2">
                      Other names for {a.name} — an IATA code or abbreviation on a
                      ticket resolves to this airline.
                    </p>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {aliasList.map((al) => (
                        <span
                          key={al.id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 text-xs text-gray-700 dark:text-gray-200"
                        >
                          {al.alias}
                          <button
                            onClick={() => removeAlias(al.id)}
                            className="text-gray-400 hover:text-red-500"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                      {aliasList.length === 0 && (
                        <span className="text-xs text-gray-400">
                          No aliases yet.
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        value={newAlias}
                        onChange={(e) => setNewAlias(e.target.value)}
                        onKeyDown={(e) =>
                          e.key === "Enter" && (e.preventDefault(), saveAlias())
                        }
                        placeholder="e.g. TK, THY, Turkish Air"
                        className="flex-1"
                      />
                      <Button size="sm" loading={busy} onClick={saveAlias}>
                        Add
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {master.length === 0 && (
              <p className="px-4 py-6 text-sm text-gray-400 text-center">
                No airlines yet — they appear as tickets are booked.
              </p>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function AirlinesPage() {
  const { hasRole } = useAuth();
  const canManage = hasRole("admin", "super_admin");
  const [manageOpen, setManageOpen] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  const setFilter = (key) => (e) =>
    setFilters((f) => ({ ...f, [key]: e.target.value }));

  const [loadError, setLoadError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    airlinesAPI
      .list(filters)
      .then((res) => setData(res.data.data))
      .catch((err) => {
        const msg =
          err.response?.data?.message ||
          err.message ||
          "Failed to load airlines";
        setLoadError(msg);
        toast.error(msg);
      })
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  if (selected)
    return (
      <AirlineDetail
        airline={selected}
        filters={filters}
        onBack={() => setSelected(null)}
      />
    );

  const airlines = data?.airlines || [];
  const totals = data?.totals || {};
  const names = data?.airline_names || [];
  const maxTickets = airlines.length ? airlines[0].tickets : 1;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Airlines
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {totals.airlines || 0} airline{totals.airlines === 1 ? "" : "s"} ·{" "}
            {totals.tickets || 0} tickets · {money(totals.total_revenue)} revenue
          </p>
        </div>
        {canManage && (
          <Button variant="outline" onClick={() => setManageOpen(true)}>
            <Merge className="w-4 h-4" /> Manage &amp; merge
          </Button>
        )}
      </div>

      <ManageModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        onChanged={load}
      />

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 uppercase">
              Airline
            </label>
            <Select
              value={filters.airline_name}
              onChange={setFilter("airline_name")}
              className="w-56"
            >
              <option value="">All airlines</option>
              {names.map((nm) => (
                <option key={nm} value={nm}>
                  {nm}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 uppercase">
              From date
            </label>
            <Input type="date" value={filters.from_date} onChange={setFilter("from_date")} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 uppercase">
              To date
            </label>
            <Input type="date" value={filters.to_date} onChange={setFilter("to_date")} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 uppercase">
              Date basis
            </label>
            <Select value={filters.date_basis} onChange={setFilter("date_basis")} className="w-36">
              <option value="booked">Booking date</option>
              <option value="flight">Flight date</option>
            </Select>
          </div>
          <Select value={filters.ticket_type} onChange={setFilter("ticket_type")} className="w-36">
            <option value="">All types</option>
            <option value="LOCAL">Local</option>
            <option value="INTERNATIONAL">International</option>
          </Select>
          <Button variant="outline" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear filters
          </Button>
        </div>
      </Card>

      {loadError ? (
        <Card className="p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-gray-900 dark:text-white">
                Couldn't load airlines
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {loadError}
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={load}>
                Try again
              </Button>
            </div>
          </div>
        </Card>
      ) : loading ? (
        <div className="flex justify-center py-20">
          <Spinner size="lg" />
        </div>
      ) : airlines.length === 0 ? (
        <Card>
          <EmptyState
            icon={Plane}
            title="No airlines yet"
            description="Once tickets are booked, airline performance shows up here."
          />
        </Card>
      ) : (
        <>
          {/* Top airline highlight */}
          <Card className="p-5">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="p-3 rounded-full bg-yellow-100 dark:bg-yellow-900/30 shrink-0">
                <Trophy className="w-6 h-6 text-yellow-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-yellow-700 dark:text-yellow-500 uppercase tracking-wide">
                  Top airline
                </p>
                <p className="text-xl font-bold text-gray-900 dark:text-white truncate">
                  {airlines[0].airline_name}
                </p>
              </div>
              <div className="flex gap-6">
                <div className="text-right">
                  <p className="text-xl font-bold text-gray-900 dark:text-white">
                    {airlines[0].tickets}
                  </p>
                  <p className="text-xs text-gray-500">tickets</p>
                </div>
                <div className="text-right">
                  <p className="text-xl font-bold text-green-600">
                    {money(airlines[0].total_revenue)}
                  </p>
                  <p className="text-xs text-gray-500">revenue</p>
                </div>
              </div>
            </div>
          </Card>

          {/* Comparison chart */}
          <Card className="p-6">
            <div className="flex items-center gap-2 mb-5">
              <Plane className="w-4 h-4 text-blue-600" />
              <h2 className="font-semibold text-gray-900 dark:text-white text-sm">
                Tickets by airline
              </h2>
            </div>
            <ResponsiveContainer width="100%" height={Math.max(200, airlines.length * 34)}>
              <BarChart
                data={airlines.map((a) => ({
                  name: a.airline_name,
                  tickets: a.tickets,
                  revenue: a.total_revenue,
                }))}
                layout="vertical"
                margin={{ left: 10, right: 20 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ borderRadius: "10px", border: "none", fontSize: "12px", boxShadow: "0 4px 20px rgba(0,0,0,0.12)" }}
                  formatter={(v, n) => (n === "revenue" ? [money(v), "Revenue"] : [v, "Tickets"])}
                />
                <Bar dataKey="tickets" name="tickets" radius={[0, 6, 6, 0]} barSize={18}>
                  {airlines.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Ranked table */}
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    {[
                      "#",
                      "Airline",
                      "Tickets",
                      "Local / Intl",
                      "Passengers",
                      "Routes",
                      "Sales",
                      "Cost",
                      "Revenue",
                      "Collected",
                      "Balance",
                      "",
                    ].map((h, i) => (
                      <th
                        key={i}
                        className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                  {airlines.map((a, i) => (
                    <tr
                      key={a.airline_name}
                      onClick={() => setSelected(a.airline_name)}
                      className="hover:bg-blue-50/50 dark:hover:bg-gray-700/30 cursor-pointer"
                    >
                      <td className="px-4 py-3">
                        <span
                          className={`w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold ${
                            i === 0
                              ? "bg-yellow-400 text-yellow-900"
                              : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                          }`}
                        >
                          {i + 1}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900 dark:text-white whitespace-nowrap">
                          {a.airline_name}
                        </p>
                        <div className="h-1.5 w-28 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden mt-1.5">
                          <div
                            className={`h-full rounded-full ${i === 0 ? "bg-yellow-400" : "bg-blue-500"}`}
                            style={{ width: `${(a.tickets / maxTickets) * 100}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3 font-semibold text-gray-900 dark:text-white">
                        {a.tickets}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                        {a.local_tickets} / {a.international_tickets}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                        {a.passengers}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                        {a.routes}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                        {money(a.total_sales)}
                      </td>
                      <td className="px-4 py-3 text-orange-600 dark:text-orange-400">
                        {money(a.total_cost)}
                      </td>
                      <td className="px-4 py-3 font-semibold text-green-600 dark:text-green-400">
                        {money(a.total_revenue)}
                      </td>
                      <td className="px-4 py-3 text-green-600 dark:text-green-400">
                        {money(a.total_collected)}
                      </td>
                      <td
                        className={`px-4 py-3 font-semibold ${a.total_balance > 0 ? "text-red-600" : "text-gray-400"}`}
                      >
                        {money(a.total_balance)}
                      </td>
                      <td className="px-4 py-3 text-gray-400">
                        <ChevronRight className="w-4 h-4" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
