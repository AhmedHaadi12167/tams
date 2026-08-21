import React, { useState, useEffect, useCallback } from 'react';
import { reportsAPI } from '../services/api';
import { Button, Card, Badge, Spinner, Pagination, Select, Input, StatCard } from '../components/ui';
import toast from 'react-hot-toast';
import {
  FileText, FileSpreadsheet, DollarSign, Banknote, Wallet,
  AlertCircle, ListFilter, X, TrendingUp, Receipt,
} from 'lucide-react';
import { format } from 'date-fns';
import { fmtDate } from '../utils/date';

const money = (v) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const EMPTY = { from_date: '', to_date: '', ticket_type: '' };

export default function ReportsPage() {
  const [filters, setFilters] = useState(EMPTY);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState('');

  // The ticket list is deliberately opt-in. An agency with thousands of
  // tickets shouldn't pull them all just to read this month's revenue.
  const [showList, setShowList] = useState(false);
  const [tickets, setTickets] = useState([]);
  const [listMeta, setListMeta] = useState({ total: 0, totalPages: 1 });
  const [listPage, setListPage] = useState(1);
  const [listLimit, setListLimit] = useState(50);
  const [listLoading, setListLoading] = useState(false);

  const setFilter = (key) => (e) => {
    setFilters((f) => ({ ...f, [key]: e.target.value }));
    setListPage(1);
  };

  // ── Money summary: cheap, always loaded ───────────────
  const loadSummary = useCallback(() => {
    setLoading(true);
    reportsAPI
      .summary(filters)
      .then((res) => setSummary(res.data.data.summary))
      .catch(() => toast.error('Failed to load report'))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  // ── Ticket detail: only when asked for ────────────────
  const loadList = useCallback(() => {
    setListLoading(true);
    reportsAPI
      .tickets({ ...filters, page: listPage, limit: listLimit })
      .then((res) => {
        setTickets(res.data.data);
        setListMeta(res.data.meta);
      })
      .catch(() => toast.error('Failed to load ticket list'))
      .finally(() => setListLoading(false));
  }, [filters, listPage, listLimit]);

  useEffect(() => {
    if (showList) loadList();
  }, [showList, loadList]);

  // Changing filters invalidates a loaded list — collapse it again
  useEffect(() => { setShowList(false); }, [filters]);

  const exportFile = async (kind) => {
    setExporting(kind);
    try {
      const res = kind === 'pdf'
        ? await reportsAPI.exportPDF(filters)
        : await reportsAPI.exportExcel(filters);
      downloadBlob(
        res.data,
        `revenue-report-${format(new Date(), 'yyyy-MM-dd')}.${kind === 'pdf' ? 'pdf' : 'xlsx'}`,
      );
      toast.success(`${kind === 'pdf' ? 'PDF' : 'Excel'} downloaded`);
    } catch {
      toast.error('Export failed');
    } finally {
      setExporting('');
    }
  };

  const periodLabel =
    filters.from_date || filters.to_date
      ? `${filters.from_date || 'start'} → ${filters.to_date || 'today'}`
      : 'All time';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Reports</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Financial summary · {periodLabel}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" loading={exporting === 'pdf'} onClick={() => exportFile('pdf')}>
            <FileText className="w-4 h-4" /> Export PDF
          </Button>
          <Button variant="outline" loading={exporting === 'excel'} onClick={() => exportFile('excel')}>
            <FileSpreadsheet className="w-4 h-4" /> Export Excel
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 uppercase">From date</label>
            <Input type="date" value={filters.from_date} onChange={setFilter('from_date')} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 uppercase">To date</label>
            <Input type="date" value={filters.to_date} onChange={setFilter('to_date')} />
          </div>
          <Select value={filters.ticket_type} onChange={setFilter('ticket_type')} className="w-36">
            <option value="">All types</option>
            <option value="LOCAL">Local</option>
            <option value="INTERNATIONAL">International</option>
          </Select>
          <Button variant="outline" onClick={() => setFilters(EMPTY)}>Clear filters</Button>
        </div>
      </Card>

      {/* Money summary */}
      {loading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : summary ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              title="Total Revenue"
              value={money(summary.total_revenue)}
              subtitle={`${summary.total_tickets} tickets sold`}
              icon={DollarSign}
              color="blue"
            />
            <StatCard
              title="Collected"
              value={money(summary.total_collected)}
              subtitle="Payments received"
              icon={Banknote}
              color="green"
            />
            <StatCard
              title="Balance Due"
              value={money(summary.total_balance)}
              subtitle="Still to collect"
              icon={Wallet}
              color="orange"
            />
            <StatCard
              title="Unpaid Tickets"
              value={summary.unpaid_tickets}
              subtitle="Not fully paid"
              icon={AlertCircle}
              color="orange"
            />
          </div>

          {/* Money breakdown */}
          <Card className="p-6">
            <div className="flex items-center gap-2 mb-5">
              <TrendingUp className="w-4 h-4 text-blue-600" />
              <h2 className="font-semibold text-gray-900 dark:text-white text-sm">
                Money summary
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-1 max-w-3xl">
              {[
                ['Tickets sold', summary.total_tickets, false],
                ['Revenue earned', money(summary.total_revenue), false],
                ['Money collected', money(summary.total_collected), 'green'],
                ['Outstanding balance', money(summary.total_balance), 'red'],
                ['Tickets not fully paid', summary.unpaid_tickets, false],
                [
                  'Collection rate',
                  Number(summary.total_collected) + Number(summary.total_balance) > 0
                    ? `${((Number(summary.total_collected) /
                        (Number(summary.total_collected) + Number(summary.total_balance))) * 100).toFixed(1)}%`
                    : '—',
                  false,
                ],
              ].map(([label, value, tone]) => (
                <div
                  key={label}
                  className="flex items-center justify-between py-2.5 border-b border-gray-100 dark:border-gray-700/60"
                >
                  <span className="text-sm text-gray-600 dark:text-gray-400">{label}</span>
                  <span
                    className={`text-sm font-semibold tabular-nums ${
                      tone === 'green'
                        ? 'text-green-600 dark:text-green-400'
                        : tone === 'red'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-gray-900 dark:text-white'
                    }`}
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}

      {/* Ticket detail — opt-in */}
      <Card className="p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Receipt className="w-4 h-4 text-gray-400" />
            <div>
              <h2 className="font-semibold text-gray-900 dark:text-white text-sm">
                Ticket detail
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {showList
                  ? `${listMeta.total} ticket(s) in this period`
                  : 'Not loaded — the summary above covers the money.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {showList && (
              <Select
                value={listLimit}
                onChange={(e) => { setListLimit(parseInt(e.target.value)); setListPage(1); }}
                className="w-28"
              >
                {[25, 50, 100, 200].map((n) => (
                  <option key={n} value={n}>{n} rows</option>
                ))}
              </Select>
            )}
            <Button
              variant={showList ? 'outline' : 'primary'}
              onClick={() => setShowList((v) => !v)}
            >
              {showList ? (<><X className="w-4 h-4" /> Hide list</>)
                        : (<><ListFilter className="w-4 h-4" /> Load ticket list</>)}
            </Button>
          </div>
        </div>

        {showList && (
          <div className="mt-5 -mx-6 -mb-6">
            {listLoading ? (
              <div className="flex justify-center py-16"><Spinner size="lg" /></div>
            ) : tickets.length === 0 ? (
              <p className="px-6 py-12 text-center text-gray-400 text-sm">
                No tickets in this period
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-y border-gray-200 dark:border-gray-700">
                      {['Passenger', 'Route', 'Airline', 'Flight Date', 'Booked', 'Type',
                        'Cost', 'Selling', 'Revenue', 'Paid', 'Balance', 'Agent', 'Status'].map((h) => (
                        <th key={h} className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                    {tickets.map((t) => (
                      <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">{t.passenger_name}</td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{t.from_city} → {t.to_city}</td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{t.airline_name}</td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                          {fmtDate(t.flight_date)}
                          {t.trip_type === 'round_trip' && t.return_date && (
                            <p className="text-xs text-gray-400">⇄ {fmtDate(t.return_date)}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                          {t.created_at ? format(new Date(t.created_at), 'dd MMM yyyy') : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={t.ticket_type === 'LOCAL' ? 'info' : 'purple'}>{t.ticket_type}</Badge>
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400">${Number(t.cost_price).toFixed(2)}</td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400">${Number(t.selling_price).toFixed(2)}</td>
                        <td className="px-4 py-3 font-semibold text-green-600 dark:text-green-400">${Number(t.revenue).toFixed(2)}</td>
                        <td className="px-4 py-3 text-green-600 dark:text-green-400">${Number(t.amount_paid || 0).toFixed(2)}</td>
                        <td className="px-4 py-3 font-semibold text-red-600">
                          ${(Number(t.selling_price) - Number(t.amount_paid || 0)).toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{t.agent_name || '—'}</td>
                        <td className="px-4 py-3">
                          <Badge variant={t.status === 'active' ? 'success' : t.status === 'cancelled' ? 'danger' : 'warning'}>
                            {t.status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="px-4 py-4">
              <Pagination page={listPage} totalPages={listMeta.totalPages} onChange={setListPage} />
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
