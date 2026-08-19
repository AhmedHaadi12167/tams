import React, { useState, useRef, useCallback, useEffect } from "react";
import { ticketsAPI, customersAPI, airlinesAPI } from "../../services/api";
import { Button, Input, Select } from "../ui";
import toast from "react-hot-toast";
import {
  FileText,
  Image as ImageIcon,
  Loader2,
  Sparkles,
  Phone,
  X,
  UserCheck,
} from "lucide-react";

// ─── Helpers (v3: round trip + commission-aware revenue) ─────────────────────

const calcPaymentStatus = (amountPaid, sellingPrice) => {
  const paid = parseFloat(amountPaid) || 0;
  const total = parseFloat(sellingPrice) || 0;
  if (paid <= 0) return "unpaid";
  if (paid >= total) return "paid";
  return "partial";
};

const STATUS_STYLES = {
  unpaid:
    "bg-red-50 border-red-200 text-red-600 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400",
  partial:
    "bg-yellow-50 border-yellow-200 text-yellow-600 dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-400",
  paid: "bg-green-50 border-green-200 text-green-600 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400",
};

// ─── Initial State ────────────────────────────────────────────────────────────

const INITIAL = {
  ticket_type: "LOCAL",
  trip_type: "one_way",
  passenger_name: "",
  contact_number: "",
  from_city: "",
  to_city: "",
  flight_date: "",
  return_date: "",
  airline_name: "",
  ticket_reference: "",
  base_price: "",
  tax: "",
  surcharge: "",
  cost_price: "",
  selling_price: "",
  amount_paid: "",
  agent_commission: "",
  source_file_url: "",
};

// ─── Booked By Search ─────────────────────────────────────────────────────────

function BookedBySearch({ value, onChange }) {
  const [phone, setPhone] = useState("");
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState(null);
  const [notFound, setNotFound] = useState(false);

  const handleSearch = useCallback(async () => {
    const trimmed = phone.trim();
    if (!trimmed) return;
    setSearching(true);
    setResult(null);
    setNotFound(false);
    try {
      const res = await customersAPI.list({ search: trimmed, limit: 1 });
      const customers = res.data.data || [];
      // Match by phone exactly
      const match = customers.find((c) => c.phone === trimmed);
      if (match) {
        setResult(match);
        onChange(match.id);
      } else {
        setNotFound(true);
        onChange(null);
      }
    } catch {
      toast.error("Failed to search customer");
    } finally {
      setSearching(false);
    }
  }, [phone, onChange]);

  const handleClear = () => {
    setPhone("");
    setResult(null);
    setNotFound(false);
    onChange(null);
  };

  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
        Booked By (optional)
      </h3>
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
        Leave empty if the passenger booked for themselves.
      </p>

      {result ? (
        // ── Found ──────────────────────────────────────────────────────────
        <div className="flex items-center gap-3 p-3 rounded-xl border border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800">
          <UserCheck className="w-5 h-5 text-green-600 dark:text-green-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-green-800 dark:text-green-300 truncate">
              {result.name}
            </p>
            <p className="text-xs text-green-600 dark:text-green-400">
              {result.phone}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClear}
            className="p-1 rounded hover:bg-green-200 dark:hover:bg-green-800 transition"
          >
            <X className="w-4 h-4 text-green-600 dark:text-green-400" />
          </button>
        </div>
      ) : (
        // ── Search input ───────────────────────────────────────────────────
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="tel"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setNotFound(false);
              }}
              onKeyDown={(e) =>
                e.key === "Enter" && (e.preventDefault(), handleSearch())
              }
              placeholder="+252 XX XXX XXXX"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={handleSearch}
            disabled={searching || !phone.trim()}
          >
            {searching ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              "Search"
            )}
          </Button>
        </div>
      )}

      {notFound && (
        <p className="mt-2 text-xs text-red-500">
          No customer found with that phone number.
        </p>
      )}
    </div>
  );
}

// ─── Main Form ────────────────────────────────────────────────────────────────

const toDateInput = (v) => (v ? String(v).slice(0, 10) : "");

export default function TicketForm({
  initial = {},
  onSave,
  onCancel,
  mode = "create",
}) {
  // Existing airlines, so agents pick instead of retyping a new variant.
  // Typing something new is always allowed — it gets created on save.
  const [airlineOptions, setAirlineOptions] = useState([]);
  useEffect(() => {
    airlinesAPI
      .master()
      .then((res) => setAirlineOptions((res.data.data || []).map((a) => a.name)))
      .catch(() => {});
  }, []);

  const [form, setForm] = useState({
    ...INITIAL,
    ...initial,
    flight_date: toDateInput(initial.flight_date),
    return_date: toDateInput(initial.return_date),
    trip_type: initial.trip_type || "one_way",
    amount_paid: initial.amount_paid ?? "",
    agent_commission: initial.agent_commission ?? "",
  });
  const [bookedByCustomerId, setBookedByCustomerId] = useState(
    initial.booked_by_customer_id || null,
  );
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
  const fileRef = useRef(null);

  // Live check against the airline registry: matched, or new-and-will-be-added.
  // Debounced so typing doesn't fire a request per keystroke.
  const [airlineMatch, setAirlineMatch] = useState(null);
  const typedAirline = (form.airline_name || "").trim();

  useEffect(() => {
    if (!typedAirline) {
      setAirlineMatch(null);
      return;
    }
    const t = setTimeout(() => {
      airlinesAPI
        .lookup(typedAirline)
        .then((res) => setAirlineMatch(res.data.data))
        .catch(() => setAirlineMatch(null));
    }, 400);
    return () => clearTimeout(t);
  }, [typedAirline]);

  const set = (key) => (e) => {
    const val = e.target.value;
    setForm((f) => {
      const updated = { ...f, [key]: val };

      // Auto-calculate cost_price and selling_price from pricing breakdown
      if (["base_price", "tax", "surcharge"].includes(key)) {
        const base =
          parseFloat(key === "base_price" ? val : updated.base_price) || 0;
        const tax = parseFloat(key === "tax" ? val : updated.tax) || 0;
        const surcharge =
          parseFloat(key === "surcharge" ? val : updated.surcharge) || 0;
        updated.cost_price = (base + tax).toFixed(2);
        updated.selling_price = (base + tax + surcharge).toFixed(2);
      }

      return updated;
    });
  };

  // Derived values — revenue is net of agent commission
  const revenue =
    form.selling_price && form.cost_price
      ? (
          parseFloat(form.selling_price) -
          parseFloat(form.cost_price) -
          (parseFloat(form.agent_commission) || 0)
        ).toFixed(2)
      : "—";

  const balance =
    form.selling_price && form.amount_paid !== ""
      ? (
          parseFloat(form.selling_price) - parseFloat(form.amount_paid || 0)
        ).toFixed(2)
      : "—";

  const paymentStatus = calcPaymentStatus(form.amount_paid, form.selling_price);

  // ── AI extraction ──────────────────────────────────────────────────────────
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadedFile(file);
    setExtracting(true);
    toast.loading("AI is reading your ticket...", { id: "extract" });
    try {
      const fd = new FormData();
      fd.append("ticket_file", file);
      const res = await ticketsAPI.extract(fd);
      const { extracted, source_file_url } = res.data.data;
      setForm((f) => {
        const updated = {
          ...f,
          ...Object.fromEntries(
            Object.entries(extracted).filter(([, v]) => v !== null && v !== ""),
          ),
          source_file_url: source_file_url || f.source_file_url,
        };
        const base = parseFloat(updated.base_price) || 0;
        const tax = parseFloat(updated.tax) || 0;
        const surcharge = parseFloat(updated.surcharge) || 0;
        if (base > 0 || tax > 0) {
          updated.cost_price = (base + tax).toFixed(2);
          updated.selling_price = (base + tax + surcharge).toFixed(2);
        }
        return updated;
      });
      toast.success("Ticket data extracted! Review and confirm.", {
        id: "extract",
      });
    } catch (err) {
      toast.error(
        err.response?.data?.message || "Extraction failed. Fill in manually.",
        { id: "extract" },
      );
    } finally {
      setExtracting(false);
    }
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload = {
        ...form,
        payment_status: paymentStatus,
        booked_by_customer_id: bookedByCustomerId || null,
      };

      if (mode === "create") {
        await ticketsAPI.create(payload);
        toast.success("Ticket created successfully!");
      } else {
        await ticketsAPI.update(initial.id, payload);
        toast.success("Ticket updated successfully!");
      }
      onSave?.();
    } catch (err) {
      const msg =
        err.response?.data?.message ||
        err.response?.data?.errors?.[0]?.msg ||
        "Failed to save ticket";
      toast.error(msg, { duration: 6000 });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* ── AI Upload ── */}
      {mode === "create" && (
        <div
          onClick={() => !extracting && fileRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all
            ${
              extracting
                ? "border-blue-400 bg-blue-50 dark:bg-blue-900/10"
                : "border-gray-300 dark:border-gray-600 hover:border-blue-400 hover:bg-blue-50/50"
            }`}
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={handleFileUpload}
            className="hidden"
          />
          {extracting ? (
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
              <p className="text-sm font-medium text-blue-600">
                AI is extracting ticket data...
              </p>
            </div>
          ) : uploadedFile ? (
            <div className="flex flex-col items-center gap-2 text-green-600">
              <Sparkles className="w-5 h-5" />
              <p className="text-sm font-medium">
                Extracted from {uploadedFile.name} — click to change
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <div className="flex gap-2">
                <FileText className="w-6 h-6 text-gray-400" />
                <ImageIcon className="w-6 h-6 text-gray-400" />
              </div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                <span className="text-blue-600">Upload ticket</span> for AI
                auto-fill
              </p>
              <p className="text-xs text-gray-400">
                PDF, JPEG, PNG — up to 10MB
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Ticket Type / Trip / Status ── */}
      <div className="grid grid-cols-2 gap-4">
        <Select
          label="Ticket type"
          value={form.ticket_type}
          onChange={set("ticket_type")}
        >
          <option value="LOCAL">Local (Domestic)</option>
          <option value="INTERNATIONAL">International</option>
        </Select>
        <Select
          label="Trip type"
          value={form.trip_type || "one_way"}
          onChange={set("trip_type")}
        >
          <option value="one_way">One way</option>
          <option value="round_trip">Round trip (Go &amp; Back)</option>
        </Select>
        {mode === "edit" && (
          <Select
            label="Status"
            value={form.status || "active"}
            onChange={set("status")}
          >
            <option value="active">Active</option>
            <option value="cancelled">Cancelled</option>
            <option value="refunded">Refunded</option>
          </Select>
        )}
      </div>

      {/* ── Passenger ── */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Passenger
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            label="Passenger name *"
            value={form.passenger_name}
            onChange={set("passenger_name")}
            placeholder="Full name"
            required
          />
          <Input
            label="Contact number"
            value={form.contact_number}
            onChange={set("contact_number")}
            placeholder="+252 XX XXX XXXX"
          />
        </div>
      </div>

      {/* ── Flight Details ── */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Flight Details
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            label="From *"
            value={form.from_city}
            onChange={set("from_city")}
            placeholder="Mogadishu"
            required
          />
          <Input
            label="To *"
            value={form.to_city}
            onChange={set("to_city")}
            placeholder="Dubai"
            required
          />
          <Input
            label={
              form.trip_type === "round_trip"
                ? "Departure flight date *"
                : "Flight date *"
            }
            type="date"
            value={form.flight_date}
            onChange={set("flight_date")}
            required
          />
          {form.trip_type === "round_trip" && (
            <Input
              label="Return flight date *"
              type="date"
              value={form.return_date || ""}
              onChange={set("return_date")}
              min={form.flight_date || undefined}
              required
            />
          )}
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Airline *
            </label>
            <input
              list="tams-airline-options"
              value={form.airline_name}
              onChange={set("airline_name")}
              placeholder="Pick one, or type a new airline"
              required
              autoComplete="off"
              className="px-3 py-2 rounded-lg border text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500
                placeholder-gray-400 dark:placeholder-gray-500"
            />
            <datalist id="tams-airline-options">
              {airlineOptions.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
            {!typedAirline && (
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Choose from the list, or type any new airline and it gets added.
              </p>
            )}

            {typedAirline && airlineMatch?.matched && (
              <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                <UserCheck className="w-3.5 h-3.5 shrink-0" />
                Matched to <strong>{airlineMatch.airline?.name}</strong>
                {airlineMatch.via && airlineMatch.via !== "name" && (
                  <span className="text-gray-400">via {airlineMatch.via}</span>
                )}
              </p>
            )}

            {typedAirline && airlineMatch && !airlineMatch.matched && (
              <div className="text-xs">
                <p className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <Sparkles className="w-3.5 h-3.5 shrink-0" />
                  New airline — <strong>{typedAirline}</strong> will be added.
                </p>
                {airlineMatch.suggestions?.length > 0 && (
                  <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                    <span className="text-gray-400">Did you mean</span>
                    {airlineMatch.suggestions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() =>
                          setForm((f) => ({ ...f, airline_name: s.name }))
                        }
                        className="px-2 py-0.5 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-medium hover:bg-blue-100 dark:hover:bg-blue-900/40"
                      >
                        {s.name}
                      </button>
                    ))}
                    <span className="text-gray-400">?</span>
                  </div>
                )}
              </div>
            )}
          </div>
          <Input
            label="Booking reference / PNR"
            value={form.ticket_reference}
            onChange={set("ticket_reference")}
            placeholder="AYJB07"
          />
        </div>
      </div>

      {/* ── Pricing ── */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Pricing
        </h3>

        {/* Breakdown */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <Input
            label="Base price"
            type="number"
            min="0"
            step="0.01"
            value={form.base_price}
            onChange={set("base_price")}
            placeholder="200"
          />
          <Input
            label="Tax"
            type="number"
            min="0"
            step="0.01"
            value={form.tax}
            onChange={set("tax")}
            placeholder="10"
          />
          <Input
            label="Surcharge"
            type="number"
            min="0"
            step="0.01"
            value={form.surcharge}
            onChange={set("surcharge")}
            placeholder="10"
          />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Total
            </label>
            <div className="px-3 py-2 rounded-lg border bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-sm text-gray-600 dark:text-gray-300">
              ${form.selling_price || "0.00"}
            </div>
          </div>
        </div>

        {/* Cost / Selling / Revenue */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <Input
            label="Cost price (Base + Tax) *"
            type="number"
            min="0"
            step="0.01"
            value={form.cost_price}
            onChange={set("cost_price")}
            placeholder="210.00"
            required
          />
          <Input
            label="Selling price (Total) *"
            type="number"
            min="0"
            step="0.01"
            value={form.selling_price}
            onChange={set("selling_price")}
            placeholder="220.00"
            required
          />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Revenue (profit)
            </label>
            <div
              className={`px-3 py-2 rounded-lg border text-sm font-semibold
              ${
                parseFloat(revenue) > 0
                  ? "bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400"
                  : parseFloat(revenue) < 0
                    ? "bg-red-50 border-red-200 text-red-700"
                    : "bg-gray-50 border-gray-200 text-gray-500 dark:bg-gray-700 dark:border-gray-600"
              }`}
            >
              ${revenue}
            </div>
          </div>
        </div>

        {/* Payment */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Input
            label="Amount paid *"
            type="number"
            min="0"
            step="0.01"
            value={form.amount_paid}
            onChange={set("amount_paid")}
            placeholder="0.00"
            required
          />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Balance
            </label>
            <div
              className={`px-3 py-2 rounded-lg border text-sm font-semibold
              ${
                balance !== "—" && parseFloat(balance) > 0
                  ? "bg-red-50 border-red-200 text-red-600 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400"
                  : balance !== "—" && parseFloat(balance) <= 0
                    ? "bg-green-50 border-green-200 text-green-600 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400"
                    : "bg-gray-50 border-gray-200 text-gray-500 dark:bg-gray-700 dark:border-gray-600"
              }`}
            >
              {balance === "—" ? "—" : `$${balance}`}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Payment status
            </label>
            <div
              className={`px-3 py-2 rounded-lg border text-sm font-semibold capitalize ${STATUS_STYLES[paymentStatus]}`}
            >
              {paymentStatus}
            </div>
          </div>
        </div>
      </div>

      {/* ── Agent Commission ── */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Agent Commission (optional)
        </h3>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
          Commission is subtracted from revenue (Revenue = Selling − Cost −
          Commission).
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            label="Commission amount"
            type="number"
            min="0"
            step="0.01"
            value={form.agent_commission}
            onChange={set("agent_commission")}
            placeholder="0.00"
          />
        </div>
      </div>

      {/* ── Booked By ── */}
      <BookedBySearch
        value={bookedByCustomerId}
        onChange={setBookedByCustomerId}
      />

      {/* ── Actions ── */}
      <div className="flex gap-3 pt-2">
        <Button type="submit" loading={loading} size="lg">
          {mode === "create" ? "Create Ticket" : "Save Changes"}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
