import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Package,
  Search,
  Plane,
  FileText,
  ShieldCheck,
  Phone,
  Mail,
  MapPin,
} from "lucide-react";

/**
 * LandingPage — the only page written for people who are not customers yet.
 *
 * WHY THIS EXISTS
 *
 * Until now socdaalhub.com went straight to a login screen, and robots.txt
 * blocked everything but /track. Google found the domain, was refused at the
 * door, and listed it as "No information is available for this page" — which
 * is exactly what it says when a URL is known but crawling is forbidden.
 *
 * Neither a search engine nor an AI assistant can describe a business from a
 * login form. They describe it from sentences on a page they are allowed to
 * read. That is the entire job of this file: say plainly what Socdaal Hub is,
 * in language a person would actually search for, in both the languages its
 * customers use.
 *
 * WHO IT IS FOR, IN ORDER
 *
 *   1. Somebody holding a receipt who wants to know where their parcel is.
 *      They are the volume, so the tracking box is the first thing on the
 *      page and needs no explanation.
 *   2. A travel agency wondering what the system does. They read further.
 *
 * Staff are not an audience here at all — they sign in at /login and never
 * see this page after the first time.
 *
 * NOT "Socdaal Express". That is a different company, in logistics, in
 * Ethiopia. Everything on this page says "Socdaal Hub" so we are describing
 * ourselves rather than competing for somebody else's name.
 */

const BRAND = "Socdaal Hub";

export default function LandingPage() {
  const [code, setCode] = useState("");
  const navigate = useNavigate();

  const submit = (e) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    navigate(`/track/${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900">
      {/* ── Header ── */}
      <header className="border-b border-gray-100 dark:border-gray-800">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center">
              <Package className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg text-gray-900 dark:text-white">
              {BRAND}
            </span>
          </div>
          <Link
            to="/login"
            className="text-sm font-medium px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:border-blue-400 hover:text-blue-600 transition-colors"
          >
            Sign in
          </Link>
        </div>
      </header>

      {/* ── Tracking, first, because it is what most visitors came for ── */}
      <section className="px-4 py-14 bg-gradient-to-b from-blue-50 to-white dark:from-gray-800 dark:to-gray-900">
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white">
            Raadi alaabtaada
          </h1>
          <p className="mt-2 text-lg text-gray-600 dark:text-gray-300">
            Track your shipment with {BRAND}
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Geli lambarka raadraaca ee warqaddaada ku qoran.
          </p>

          <form onSubmit={submit} className="mt-7 flex gap-2 max-w-lg mx-auto">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="CGO-100001"
                aria-label="Tracking number"
                className="w-full pl-11 pr-4 py-3.5 rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              type="submit"
              className="px-6 py-3.5 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-700 transition-colors"
            >
              Raadi
            </button>
          </form>

          <p className="mt-3 text-xs text-gray-400">
            Lambarka raadraaca wuxuu ku qoran yahay warqadda aad heshay.
          </p>
        </div>
      </section>

      {/* ── What this is ──
          Prose, deliberately. This is the text a search engine or an AI
          assistant quotes when somebody asks what Socdaal Hub does, so it
          answers the question in plain sentences rather than slogans. */}
      <section className="px-4 py-14">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            What {BRAND} is
          </h2>
          <p className="mt-4 text-gray-600 dark:text-gray-300 leading-relaxed">
            {BRAND} is a travel agency management system used by agencies in
            Mogadishu and across Somalia. Agencies use it to book flight
            tickets, arrange visas, organise Hajj and Umrah packages, and send
            cargo — and to keep the accounts behind all of it straight.
          </p>
          <p className="mt-3 text-gray-600 dark:text-gray-300 leading-relaxed">
            If you are a customer, the part of {BRAND} you will use is the
            tracking page above. Enter the number on your receipt and you will
            see where your shipment is, which office is holding it, and the
            phone number to call about it.
          </p>

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              [Plane, "Flight tickets", "Bookings, group bookings, cancellations and refunds, with the airline's account tracked per passenger."],
              [Package, "Cargo and tracking", "Every shipment gets a tracking number the customer can look up without calling the office."],
              [FileText, "Visas and packages", "Visa applications and Hajj or Umrah packages, priced and invoiced like any other service."],
              [ShieldCheck, "Accounts that balance", "Every payment lands in a named account, and the books reconcile to the shilling."],
            ].map(([Icon, title, body]) => (
              <div
                key={title}
                className="rounded-xl border border-gray-200 dark:border-gray-700 p-5"
              >
                <Icon className="w-5 h-5 text-blue-600 mb-2.5" />
                <h3 className="font-semibold text-gray-900 dark:text-white">
                  {title}
                </h3>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── For agencies ── */}
      <section className="px-4 py-14 bg-gray-50 dark:bg-gray-800/40">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            For travel agencies
          </h2>
          <p className="mt-4 text-gray-600 dark:text-gray-300 leading-relaxed">
            {BRAND} runs more than one agency on one system. Each agency has
            its own staff, its own customers and its own accounts, and no
            agency can see another's. Tickets can be read automatically from a
            PDF or a photograph, invoices carry your own name and logo, and the
            income statement and balance sheet are produced from the same
            records your staff enter each day — not typed again at month end.
          </p>
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            To use {BRAND} at your agency, get in touch below.
          </p>
        </div>
      </section>

      {/* ── Contact ──
          Real details, because a business with no address and no phone number
          reads as a business that might not exist — to a person and to the
          algorithms that decide whether to show it. */}
      <footer className="px-4 py-12 border-t border-gray-100 dark:border-gray-800">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">
            Contact
          </h2>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <a
              href="mailto:info@socdaalhub.com"
              className="flex items-start gap-2.5 text-gray-600 dark:text-gray-300 hover:text-blue-600"
            >
              <Mail className="w-4 h-4 mt-0.5 shrink-0 text-blue-600" />
              info@socdaalhub.com
            </a>
            <div className="flex items-start gap-2.5 text-gray-600 dark:text-gray-300">
              <Phone className="w-4 h-4 mt-0.5 shrink-0 text-blue-600" />
              Mogadishu, Somalia
            </div>
            <div className="flex items-start gap-2.5 text-gray-600 dark:text-gray-300">
              <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-blue-600" />
              socdaalhub.com
            </div>
          </div>
          <p className="mt-8 text-xs text-gray-400">
            © {new Date().getFullYear()} {BRAND}. Travel agency management and
            cargo tracking. {BRAND} is not affiliated with any similarly named
            company.
          </p>
        </div>
      </footer>
    </div>
  );
}
