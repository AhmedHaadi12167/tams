import React, { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import {
  Package,
  Search,
  MapPin,
  Phone,
  CheckCircle2,
  Truck,
  Clock,
  XCircle,
  Loader2,
} from "lucide-react";
import { fmtDate } from "../utils/date";

/**
 * TrackPage
 *
 * The only page in TAMS that anybody can open without an account.
 *
 * Written for the phone of someone standing in a shop asking "has my parcel
 * arrived?". That shapes every decision here: one input, large text, no
 * navigation, no login prompt, and the answer in a single sentence at the
 * top before any detail.
 *
 * It deliberately does not import the app's `api` client. That one attaches
 * the stored auth token and redirects to /login on a 401 — both wrong for a
 * page whose whole point is that the visitor has no account.
 */

const publicApi = axios.create({ baseURL: "/api/public", timeout: 15000 });

const STEPS = [
  { key: "pending", label: "Received", icon: Clock },
  { key: "in_progress", label: "On the way", icon: Truck },
  { key: "delivered", label: "Arrived", icon: CheckCircle2 },
];

const stepIndex = (status) => STEPS.findIndex((s) => s.key === status);

export default function TrackPage() {
  const { code: codeFromUrl } = useParams();
  const navigate = useNavigate();

  const [code, setCode] = useState(codeFromUrl || "");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // The served HTML already carries the right title for a crawler; this is
  // for the browser tab, the bookmark, and the share sheet on a phone — all
  // of which read the live document, not the response body.
  useEffect(() => {
    const previous = document.title;
    document.title = codeFromUrl
      ? `${codeFromUrl} — Raadi Alaabtaada`
      : "Raadi Alaabtaada — Track your cargo";
    return () => {
      document.title = previous;
    };
  }, [codeFromUrl]);

  const lookup = useCallback(async (raw) => {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await publicApi.get(`/track/${encodeURIComponent(trimmed)}`);
      setResult(res.data.data);
    } catch (err) {
      setError(
        err.response?.data?.message ||
          "We couldn't reach the tracking service. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // A link like /track/CGO-123456 looks it up straight away, so the agency
  // can send the whole URL by SMS and the customer taps once.
  useEffect(() => {
    if (codeFromUrl) lookup(codeFromUrl);
  }, [codeFromUrl, lookup]);

  const submit = (e) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    navigate(`/track/${encodeURIComponent(trimmed)}`);
    lookup(trimmed);
  };

  const current = result ? stepIndex(result.status) : -1;
  const cancelled = result?.status === "cancelled";

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 px-4 py-10">
      <div className="w-full max-w-lg mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl shadow-lg mb-4">
            <Package className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Track your shipment
          </h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            Raadi alaabtaada — enter your tracking number
          </p>
        </div>

        {/* Search */}
        <form onSubmit={submit} className="flex gap-2 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="CGO-123456"
              autoComplete="off"
              autoCapitalize="characters"
              className="w-full pl-11 pr-3 py-3.5 rounded-xl border border-gray-300 dark:border-gray-600
                bg-white dark:bg-gray-800 text-base text-gray-900 dark:text-white
                placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !code.trim()}
            className="px-5 py-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium
              disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              "Track"
            )}
          </button>
        </form>

        {error && (
          <div className="rounded-2xl bg-white dark:bg-gray-800 shadow-sm border border-red-200 dark:border-red-800 p-6 text-center">
            <XCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <p className="text-gray-700 dark:text-gray-200">{error}</p>
          </div>
        )}

        {result && (
          <div className="space-y-4">
            {/* The answer, before any detail */}
            <div
              className={`rounded-2xl p-5 shadow-sm border ${
                result.status === "delivered"
                  ? "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"
                  : cancelled
                    ? "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800"
                    : "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700"
              }`}
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {result.tracking_number}
              </p>
              <p className="text-xl font-bold text-gray-900 dark:text-white mt-1">
                {result.status_label}
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
                {result.message}
              </p>
            </div>

            {/* Progress */}
            {!cancelled && (
              <div className="rounded-2xl bg-white dark:bg-gray-800 shadow-sm border border-gray-200 dark:border-gray-700 p-5">
                <div className="flex items-start justify-between">
                  {STEPS.map((step, i) => {
                    const Icon = step.icon;
                    const done = i <= current;
                    return (
                      <React.Fragment key={step.key}>
                        <div className="flex flex-col items-center gap-2 flex-1">
                          <div
                            className={`w-10 h-10 rounded-full grid place-items-center ${
                              done
                                ? "bg-blue-600 text-white"
                                : "bg-gray-100 dark:bg-gray-700 text-gray-400"
                            }`}
                          >
                            <Icon className="w-5 h-5" />
                          </div>
                          <span
                            className={`text-xs text-center ${
                              done
                                ? "text-gray-900 dark:text-white font-medium"
                                : "text-gray-400"
                            }`}
                          >
                            {step.label}
                          </span>
                        </div>
                        {i < STEPS.length - 1 && (
                          <div
                            className={`h-0.5 flex-1 mt-5 ${
                              i < current
                                ? "bg-blue-600"
                                : "bg-gray-200 dark:bg-gray-700"
                            }`}
                          />
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Where to collect */}
            {result.collect_at && (
              <div className="rounded-2xl bg-white dark:bg-gray-800 shadow-sm border border-gray-200 dark:border-gray-700 p-5">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
                  Collect from
                </h2>
                <div className="flex items-start gap-3 mb-3">
                  <MapPin className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-gray-900 dark:text-white">
                      {result.collect_at.office}
                    </p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {result.collect_at.city}
                    </p>
                  </div>
                </div>
                {result.collect_at.phone && (
                  <a
                    href={`tel:${result.collect_at.phone}`}
                    className="flex items-center gap-3 rounded-xl bg-blue-50 dark:bg-blue-900/20 px-4 py-3 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
                  >
                    <Phone className="w-5 h-5 text-blue-600 shrink-0" />
                    <span className="font-semibold text-blue-700 dark:text-blue-300">
                      {result.collect_at.phone}
                    </span>
                    <span className="text-xs text-blue-600 dark:text-blue-400 ml-auto">
                      Tap to call
                    </span>
                  </a>
                )}
              </div>
            )}

            {/* Detail */}
            <div className="rounded-2xl bg-white dark:bg-gray-800 shadow-sm border border-gray-200 dark:border-gray-700 p-5">
              <dl className="space-y-2.5 text-sm">
                {[
                  ["Item", result.item],
                  ["From", result.route.from],
                  ["To", result.route.to],
                  ["Sent", fmtDate(result.sent_at)],
                  ["Sender", result.sender],
                  ["Receiver", result.receiver],
                ]
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-4">
                      <dt className="text-gray-500 dark:text-gray-400">{k}</dt>
                      <dd className="text-gray-900 dark:text-white font-medium text-right">
                        {v}
                      </dd>
                    </div>
                  ))}
              </dl>
            </div>

            <p className="text-center text-xs text-gray-400 dark:text-gray-500">
              {result.agency.name}
            </p>
          </div>
        )}

        {!result && !error && !loading && (
          <p className="text-center text-sm text-gray-500 dark:text-gray-400">
            Your tracking number is on the receipt you were given.
          </p>
        )}
      </div>
    </div>
  );
}
