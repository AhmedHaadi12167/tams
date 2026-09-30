import React from "react";
import { CheckCircle2, AlertTriangle, Wallet, Landmark, Users } from "lucide-react";
import { Card } from "../../components/ui";
import { fmtDate } from "../../utils/date";
import { money, pctText, OWNER_COLORS } from "./format";

/**
 * The balance sheet: what the agency owns, what it owes, and whose the rest is.
 * Every line comes from the same records as the journal; the two are tested
 * to agree to the cent.
 */
export default function BalanceSheetPanel({ balance: b, onShowOwners }) {
  if (!b) return null;
  const a = b.assets;
  const l = b.liabilities;
  const e = b.equity;
  const owners = e.by_owner;

  const assetLines = [
    ["Accounts receivable — customers", a.trade_receivables],
    ["Opening receivables (previous system)", a.opening_receivables],
    ["Airline credit", a.airline_receivable],
    ["Supplier credit (overpaid)", a.supplier_credit],
    ["Tax overpaid", a.tax_credit],
    ["Advances to agents", a.agent_advances],
    ["Fixed assets", a.fixed_assets],
  ];
  const liabilityLines = [
    ["Payable to airlines", l.payable_to_airlines],
    ["Opening payables (previous system)", l.opening_payables],
    ["Payable to suppliers", l.payable_to_suppliers],
    ["Tax payable (government)", l.tax_payable],
    ["Customer deposits held", l.customer_deposits],
    ["Customer credits (overpaid)", l.customer_credits],
    ["Agent commission payable", l.agent_commission_payable],
    ["Other liabilities", l.other_liabilities],
  ];

  return (
    <div className="space-y-6">
      {/* Status */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl px-5 py-4 ${
          b.balanced
            ? "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300"
            : "bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300"
        }`}
      >
        <div className="flex items-center gap-2 font-medium">
          {b.balanced ? <CheckCircle2 className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
          {b.balanced
            ? `Balanced — assets equal liabilities plus equity at ${fmtDate(b.as_of)}`
            : `Out of balance by ${money(b.difference)} at ${fmtDate(b.as_of)}`}
        </div>
        <div className="text-sm tabular-nums">
          {money(a.total)} = {money(l.total)} + {money(e.total)}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Assets */}
        <Card className="p-6">
          <Header icon={Wallet} title="Assets" total={a.total} tone="blue" />
          <Group title="Cash & bank" total={a.cash_and_bank}>
            <Line label="Cash in hand" value={a.cash_in_hand} strong />
            {(a.accounts || []).map((acc) => (
              <Line key={acc.account_id} label={acc.name} value={acc.balance} />
            ))}
            {Math.abs(a.unassigned_cash || 0) > 0.004 && (
              <Line label="Received, not yet filed to an account" value={a.unassigned_cash} muted />
            )}
          </Group>
          {assetLines.some(([, v]) => Math.abs(v || 0) > 0.004) && (
            <Group title="Owed to us & other assets">
              {assetLines.filter(([, v]) => Math.abs(v || 0) > 0.004).map(([k, v]) => <Line key={k} label={k} value={v} />)}
            </Group>
          )}
          <Total label="Total assets" value={a.total} />
        </Card>

        <div className="space-y-6">
          {/* Liabilities */}
          <Card className="p-6">
            <Header icon={Landmark} title="Liabilities" total={l.total} tone="orange" />
            {liabilityLines.filter(([, v]) => Math.abs(v || 0) > 0.004).length === 0 ? (
              <p className="text-sm text-gray-400 py-2">Nothing owed.</p>
            ) : (
              liabilityLines
                .filter(([, v]) => Math.abs(v || 0) > 0.004)
                .map(([k, v]) => <Line key={k} label={k} value={v} />)
            )}
            <Total label="Total liabilities" value={l.total} />
          </Card>

          {/* Equity */}
          <Card className="p-6">
            <Header icon={Users} title="Equity" total={e.total} tone="green" />
            {owners ? (
              <>
                {owners.owners.map((o, i) => (
                  <div key={o.owner_id} className="py-2.5 border-b border-gray-100 dark:border-gray-700/60 last:border-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: OWNER_COLORS[i % OWNER_COLORS.length] }} />
                        {o.name}'s equity
                        <span className="text-xs font-normal text-gray-400">{pctText(o.profit_share_pct)} of profit</span>
                      </span>
                      <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-white">{money(o.total)}</span>
                    </div>
                    <div className="mt-1 pl-4 grid grid-cols-2 sm:grid-cols-4 gap-x-3 text-[11px] text-gray-500 tabular-nums">
                      <span>Capital {money(o.capital)}</span>
                      <span>Drawings ({money(o.withdrawn)})</span>
                      <span className={o.profit_share < 0 ? "text-red-500" : ""}>Profit {money(o.profit_share)}</span>
                    </div>
                  </div>
                ))}
                {Math.abs(owners.retained_brought_forward) > 0.004 && (
                  <Line label="Retained earnings brought forward" value={owners.retained_brought_forward} />
                )}
                {Math.abs(owners.unallocated_profit) > 0.004 && (
                  <Line label="Profit not allocated to an owner" value={owners.unallocated_profit} />
                )}
              </>
            ) : (
              <>
                <Line label="Owner's capital" value={e.owner_capital} />
                <Line label="Retained earnings" value={e.retained_earnings} />
                {onShowOwners && (
                  <button onClick={onShowOwners} className="mt-2 text-xs text-blue-600 hover:underline">
                    Register the owners to see each owner's capital and profit share →
                  </button>
                )}
              </>
            )}
            <p className="text-xs text-gray-500 mt-3">
              Profit to date: <span className={`tabular-nums font-medium ${e.profit_to_date < 0 ? "text-red-600" : "text-green-600"}`}>{money(e.profit_to_date)}</span>
            </p>
            <Total label="Total equity" value={e.total} />
          </Card>

          <Card className="px-6 py-4">
            <div className="flex items-center justify-between">
              <span className="font-bold text-gray-900 dark:text-white">Liabilities + equity</span>
              <span className="text-lg font-bold tabular-nums text-blue-600 dark:text-blue-400">{money(b.total_liabilities_and_equity)}</span>
            </div>
          </Card>
        </div>
      </div>

      {b.notes?.length > 0 && (
        <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-1 list-disc pl-5">
          {b.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}

const TONE = {
  blue: "text-blue-600 dark:text-blue-400",
  orange: "text-orange-600 dark:text-orange-400",
  green: "text-green-600 dark:text-green-400",
};

function Header({ icon: Icon, title, total, tone }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="flex items-center gap-2 font-semibold text-gray-900 dark:text-white">
        <Icon className="w-4 h-4 text-gray-400" /> {title}
      </h2>
      <span className={`text-lg font-bold tabular-nums ${TONE[tone]}`}>{money(total)}</span>
    </div>
  );
}

function Group({ title, total, children }) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between pt-2 pb-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{title}</p>
        {total !== undefined && <span className="text-xs font-semibold tabular-nums text-gray-500">{money(total)}</span>}
      </div>
      {children}
    </div>
  );
}

function Line({ label, value, strong, muted }) {
  const neg = Number(value) < 0;
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className={`text-sm ${strong ? "font-medium text-gray-900 dark:text-white" : muted ? "text-gray-400" : "text-gray-600 dark:text-gray-400"} pl-3`}>{label}</span>
      <span className={`text-sm tabular-nums ${strong ? "font-semibold" : ""} ${neg ? "text-red-600" : "text-gray-900 dark:text-white"}`}>
        {neg ? `(${money(-value)})` : money(value)}
      </span>
    </div>
  );
}

function Total({ label, value }) {
  return (
    <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-700 mt-2 pt-3">
      <span className="font-semibold text-gray-900 dark:text-white">{label}</span>
      <span className="font-bold tabular-nums text-gray-900 dark:text-white">{money(value)}</span>
    </div>
  );
}
