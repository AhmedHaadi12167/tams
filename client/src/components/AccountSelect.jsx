import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { accountsAPI } from "../services/api";
import { Select } from "./ui";

/**
 * AccountSelect
 *
 * "Which account did this money go into, or come out of?"
 *
 * Every form that touches money asks the same question, so they all ask it
 * the same way and from the same list. Previously each form offered a fixed
 * set of labels — cash, bank, card — which recorded *how* money moved but
 * never *where it ended up*, so no balance could be worked out from them.
 *
 * The list is fetched once and shared. Ten forms mounting at once should not
 * mean ten identical requests, and the set of accounts changes about as
 * often as the agency opens a bank account.
 */

let cache = null;
let cachedError = null;
let inflight = null;

/** Drop the cached list — call after adding or renaming an account. */
export const refreshAccounts = () => {
  cache = null;
  cachedError = null;
  inflight = null;
};

/**
 * The accounts endpoint reads from v_account_balance, where the key is
 * `account_id` — there is no `id`. Normalising here means every consumer can
 * rely on one field name.
 *
 * Getting this wrong was subtle and expensive: `value={a.id}` with `a.id`
 * undefined renders an <option> with no value attribute at all, and the HTML
 * spec then falls back to the option's *text*. So picking "Dahabshiil Bank"
 * quietly set the value to the string "Dahabshiil Bank". The dropdown looked
 * correct, showed the right selection, and sent something that could never
 * match an account — which read on the server as "no account chosen".
 */
const normalise = (a) => ({ ...a, id: a.account_id ?? a.id });

const loadAccounts = () => {
  if (cache) return Promise.resolve({ accounts: cache, error: null });
  if (inflight) return inflight;
  inflight = accountsAPI
    .list()
    .then((res) => {
      cache = (res.data.data.accounts || [])
        .filter((a) => a.is_active)
        .map(normalise)
        // A row with no usable id would recreate the original bug silently.
        .filter((a) => Boolean(a.id));
      // An empty list is not an error. Since migration_v21 a new agency
      // starts with no accounts and adds its own, so this is the ordinary
      // first-run state and gets its own, friendlier treatment below.
      cachedError = null;
      return { accounts: cache, error: cachedError };
    })
    .catch((err) => {
      // This used to swallow the error and hand back an empty list. The
      // dropdown then looked merely empty, the user submitted anyway, and
      // the server filed the money by guesswork. A payment form that can't
      // list the accounts is broken and has to say so.
      cachedError =
        err.response?.data?.message ||
        "Couldn't load your payment accounts.";
      return { accounts: [], error: cachedError };
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
};

/** Shared hook, for screens that need the accounts themselves. */
export const useAccounts = () => {
  const [accounts, setAccounts] = useState(cache || []);
  const [error, setError] = useState(cachedError);
  const [loading, setLoading] = useState(!cache);
  useEffect(() => {
    let alive = true;
    loadAccounts().then((r) => {
      if (alive) {
        setAccounts(r.accounts);
        setError(r.error);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  return { accounts, loading, error };
};

const GROUPS = [
  ["cash", "Cash"],
  ["bank", "Banks"],
  ["mobile", "Mobile money"],
  ["merchant", "Merchant"],
  ["other", "Other"],
];

export default function AccountSelect({
  value,
  onChange,
  label,
  direction = "in",
  required = false,
  className = "",
  ...props
}) {
  const { accounts, loading, error } = useAccounts();

  const heading =
    label || (direction === "out" ? "Paid from *" : "Paid into *");

  // An empty picker is the failure that lets money get filed by guesswork, so
  // it is never rendered as a dropdown with nothing in it. But the two ways of
  // being empty are not the same thing and must not look the same:
  //
  //   - the request failed        → something is broken, offer to retry
  //   - the agency has none yet   → nothing is broken, offer to add one
  //
  // Showing a red "Couldn't load your accounts / Try again" to someone whose
  // only problem is that they haven't set up a bank account sends them looking
  // for a fault that doesn't exist.
  if (!loading && error) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {heading}
        </label>
        <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-3 py-2">
          <p className="text-xs text-red-700 dark:text-red-300">{error}</p>
          <button
            type="button"
            onClick={() => {
              refreshAccounts();
              window.location.reload();
            }}
            className="text-xs text-red-800 dark:text-red-200 underline mt-1"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!loading && accounts.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {heading}
        </label>
        <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
          <p className="text-xs text-amber-800 dark:text-amber-200">
            No payment accounts yet. Add the bank, mobile-money or cash account
            this money belongs to, and it will appear here.
          </p>
          <Link
            to="/accounts"
            className="text-xs font-semibold text-amber-900 dark:text-amber-100 underline mt-1 inline-block"
          >
            Add an account
          </Link>
        </div>
      </div>
    );
  }

  return (
    <Select
      label={heading}
      value={value || ""}
      onChange={onChange}
      required={required}
      className={className}
      {...props}
    >
      <option value="">
        {loading ? "Loading accounts…" : "— choose an account —"}
      </option>
      {GROUPS.map(([kind, groupLabel]) => {
        const inGroup = accounts.filter((a) => a.kind === kind);
        if (inGroup.length === 0) return null;
        // A single Cash account reads better without a group heading above it
        if (inGroup.length === 1 && kind === "cash") {
          return (
            <option key={inGroup[0].id} value={inGroup[0].id}>
              {inGroup[0].name}
            </option>
          );
        }
        return (
          <optgroup key={kind} label={groupLabel}>
            {inGroup.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </Select>
  );
}
