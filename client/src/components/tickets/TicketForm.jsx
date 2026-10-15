import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  addMonths,
  format,
  getDaysInMonth,
  getDay,
  parseISO,
  startOfMonth,
} from "date-fns";
import { toDateInput } from "../../utils/date";
import {
  ticketsAPI,
  customersAPI,
  airlinesAPI,
  agentsAPI,
  ticketCitiesAPI,
} from "../../services/api";
import { Button, Input, Select } from "../ui";
import toast from "react-hot-toast";
import AccountSelect from "../AccountSelect";
import {
  FileText,
  Image as ImageIcon,
  Loader2,
  Sparkles,
  Phone,
  X,
  UserCheck,
  Plus,
  Minus,
  Trash2,
  Users,
  AlertTriangle,
  Plane,
  ArrowLeftRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

// ─── Helpers (v3: round trip + commission-aware revenue) ─────────────────────

const calcPaymentStatus = (amountPaid, sellingPrice) => {
  const paid = parseFloat(amountPaid) || 0;
  const total = parseFloat(sellingPrice) || 0;
  if (paid <= 0) return "unpaid";
  if (paid >= total) return "paid";
  return "partial";
};

// Same list the Collect Payment dialog uses, so payment history is consistent
export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "evc", label: "EVC Plus" },
  { value: "edahab", label: "eDahab" },
  { value: "bank", label: "Bank transfer" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];

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
  passenger_type: "adult",
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
  payment_method: "cash",
  // Which account the money landed in. The balance on the Accounts page is
  // built from these, so a payment without one shows as unassigned.
  account_id: "",
  agent_commission: "",
  agent_id: "",
  agent_name: "",
  agent_phone: "",
  source_file_url: "",
  // International travel documents. All optional — a booking is often taken
  // by phone with the papers following later.
  passport_number: "",
  nationality: "",
  date_of_birth: "",
  passport_expiry_date: "",
  visa_type: "",
  visa_expiry_date: "",
};

/**
 * One blank passenger row.
 *
 * A row is a name and that passenger's own ticket number, because a group
 * itinerary issues one number per traveller — the document Ahmed sent lists
 * KMUMGQ-16226-000011 against one name and …000010 against the other, and
 * storing the same number on both would make the two tickets impossible to
 * tell apart at the airline's counter.
 */
const blankPassenger = () => ({
  passenger_name: "",
  ticket_reference: "",
  passport_number: "",
  passenger_type: "adult",
});

const money = (v) => `$${(Number(v) || 0).toFixed(2)}`;

/**
 * Show the agent exactly what each passenger's ticket will be worth.
 *
 * The server does the real division in whole cents; this repeats it so the
 * form can show the answer before anything is saved. Same rule, so the two
 * always agree: the spare cents go to the earliest passengers.
 */
const previewShares = (total, n) => {
  const cents = Math.round((Number(total) || 0) * 100);
  if (!n) return [];
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(cents);
  const base = Math.floor(abs / n);
  const rem = abs - base * n;
  return Array.from({ length: n }, (_, i) => (sign * (base + (i < rem ? 1 : 0))) / 100);
};

const dateFromInput = (value) =>
  value ? parseISO(`${value.slice(0, 10)}T00:00:00`) : null;

function CitySelect({ label, value, onChange }) {
  const containerRef = useRef(null);
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let current = true;
    const timer = setTimeout(() => {
      ticketCitiesAPI
        .list(search.trim())
        .then((res) => {
          if (current) {
            setOptions(res.data.data || []);
            setError("");
          }
        })
        .catch((err) => {
          if (current) {
            setOptions([]);
            setError(
              err.response?.data?.message || "Could not load airport choices.",
            );
          }
        });
    }, 180);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, search]);

  const selectAirport = async (airport) => {
    try {
      const result = await ticketCitiesAPI.save({
        iata_code: airport.iata_code,
      });
      const savedAirport = result.data.data;
      const location = `${savedAirport.city_name} | ${savedAirport.iata_code}`;
      onChange(location);
      setSearch("");
      setOpen(false);
    } catch (err) {
      toast.error(
        err.response?.data?.message || "Could not save this airport.",
      );
    }
  };

  const visibleValue = open ? search : value;

  return (
    <div ref={containerRef} className="relative min-w-0">
      <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
        {label}
      </label>
      <input
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={visibleValue}
        onFocus={() => {
          setSearch("");
          setOpen(true);
        }}
        onChange={(event) => {
          setSearch(event.target.value);
          onChange(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (event.key === "Enter" && open && options[0]) {
            event.preventDefault();
            selectAirport(options[0]);
          }
        }}
        placeholder="Search city or airport"
        autoComplete="off"
        required
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
      />
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-64 w-full min-w-64 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-gray-700 dark:bg-gray-800">
          {error ? (
            <p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : options.length ? (
            options.map((airport) => (
              <button
                key={`${airport.iata_code}-${airport.airport_name}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectAirport(airport)}
                className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-blue-50 dark:hover:bg-blue-900/20"
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-gray-900 dark:text-white">
                    {airport.city_name}
                    {airport.primary && (
                      <span className="ml-1.5 text-[9px] font-normal uppercase tracking-wide text-green-700 dark:text-green-400">
                        Primary
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[10px] text-gray-500 dark:text-gray-400">
                    {airport.airport_name}
                  </span>
                </span>
                <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                  {airport.iata_code}
                </span>
              </button>
            ))
          ) : (
            <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
              {search.trim()
                ? "No matching airport. Search by city or airport name."
                : "Type a city or airport name to search."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function BookingDates({
  tripType,
  departureDate,
  returnDate,
  onDepartureChange,
  onReturnChange,
}) {
  const [open, setOpen] = useState(false);
  const [activeDate, setActiveDate] = useState("departure");
  const [month, setMonth] = useState(() =>
    startOfMonth(dateFromInput(departureDate) || new Date()),
  );
  const pickerRef = useRef(null);
  const isRoundTrip = tripType === "round_trip";
  const departure = dateFromInput(departureDate);
  const returnFlight = dateFromInput(returnDate);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!pickerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  const chooseDate = (date) => {
    const value = format(date, "yyyy-MM-dd");
    if (activeDate === "return" && departure && date >= departure) {
      onReturnChange(value);
      setOpen(false);
      return;
    }
    onDepartureChange(value);
    onReturnChange("");
    if (isRoundTrip) {
      setActiveDate("return");
    } else {
      setOpen(false);
    }
  };

  const renderMonth = (monthDate) => {
    const firstDay = startOfMonth(monthDate);
    const offset = getDay(firstDay);
    const days = getDaysInMonth(firstDay);
    return (
      <div key={format(firstDay, "yyyy-MM")} className="min-w-[228px] flex-1">
        <h4 className="mb-3 text-center text-xs font-semibold uppercase tracking-wide text-gray-800 dark:text-gray-100">
          {format(firstDay, "MMMM yyyy")}
        </h4>
        <div className="mb-1 grid grid-cols-7 text-center text-[10px] font-medium text-gray-400">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: offset }, (_, index) => (
            <span key={`empty-${index}`} />
          ))}
          {Array.from({ length: days }, (_, index) => {
            const date = new Date(
              firstDay.getFullYear(),
              firstDay.getMonth(),
              index + 1,
            );
            const dateValue = format(date, "yyyy-MM-dd");
            const selected =
              dateValue === departureDate || dateValue === returnDate;
            const inRange =
              departure &&
              returnFlight &&
              date > departure &&
              date < returnFlight;
            return (
              <button
                key={dateValue}
                type="button"
                onClick={() => chooseDate(date)}
                aria-label={format(date, "EEEE, MMMM d, yyyy")}
                className={`h-7 rounded-md text-xs transition-colors ${
                  selected
                    ? "bg-blue-600 font-semibold text-white"
                    : inRange
                      ? "bg-blue-50 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
                      : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                }`}
              >
                {index + 1}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const dateButton = (label, value, field) => (
    <button
      type="button"
      onClick={() => {
        setActiveDate(field);
        setOpen(true);
      }}
      className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
    >
      <CalendarDays className="h-4 w-4 shrink-0 text-gray-500" />
      <span className="min-w-0">
        <span className="block text-[10px] font-medium uppercase tracking-wide text-gray-400">
          {label}
        </span>
        <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">
          {dateFromInput(value)
            ? format(dateFromInput(value), "dd/MM/yyyy")
            : "Select date"}
        </span>
      </span>
    </button>
  );

  return (
    <div ref={pickerRef} className="relative min-w-0">
      <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
        {isRoundTrip ? "Travel dates" : "Travel date"}
      </label>
      <div className="flex min-h-[42px] divide-x divide-gray-200 rounded-lg border border-gray-300 bg-white dark:divide-gray-700 dark:border-gray-600 dark:bg-gray-800">
        {dateButton(
          isRoundTrip ? "Depart" : "Travel",
          departureDate,
          "departure",
        )}
        {isRoundTrip && (
          dateButton("Return", returnDate, "return")
        )}
      </div>
      {open && (
        <div
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:p-4"
          style={{ width: "min(560px, calc(100vw - 2rem))" }}
        >
          <div className="mb-3 flex items-center justify-between">
            <div className="flex gap-4 text-[10px] font-semibold uppercase tracking-wide">
              <button
                type="button"
                onClick={() => setActiveDate("departure")}
                className={activeDate === "departure" ? "text-blue-700 dark:text-blue-300" : "text-gray-400"}
              >
                Depart{" "}
                <span className="ml-1 normal-case">
                  {departure ? format(departure, "MMM d, yyyy") : "Select"}
                </span>
              </button>
              {isRoundTrip && (
                <button
                  type="button"
                  onClick={() => setActiveDate("return")}
                  className={activeDate === "return" ? "text-blue-700 dark:text-blue-300" : "text-gray-400"}
                >
                  Return{" "}
                  <span className="ml-1 normal-case">
                    {returnFlight ? format(returnFlight, "MMM d, yyyy") : "Select"}
                  </span>
                </button>
              )}
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setMonth((current) => addMonths(current, -1))}
                aria-label="Previous month"
                className="rounded-md p-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setMonth((current) => addMonths(current, 1))}
                aria-label="Next month"
                className="rounded-md p-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className={`grid gap-4 ${isRoundTrip ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
            {renderMonth(month)}
            {isRoundTrip && renderMonth(addMonths(month, 1))}
          </div>
        </div>
      )}
    </div>
  );
}

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


export default function TicketForm({
  initial = {},
  onSave,
  onCancel,
  mode = "create",
}) {
  // Existing airlines, so agents pick instead of retyping a new variant.
  // Typing something new is always allowed — it gets created on save.
  const [airlineOptions, setAirlineOptions] = useState([]);
  const [agents, setAgents] = useState([]);
  useEffect(() => {
    airlinesAPI
      .master()
      .then((res) => setAirlineOptions((res.data.data || []).map((a) => a.name)))
      .catch(() => {});
    // Empty list is fine — the agents table only exists after migration v8
    agentsAPI
      .simple()
      .then((res) => setAgents(res.data.data || []))
      .catch(() => setAgents([]));
  }, []);

  const [form, setForm] = useState({
    ...INITIAL,
    ...initial,
    flight_date: toDateInput(initial.flight_date),
    return_date: toDateInput(initial.return_date),
    trip_type: initial.trip_type || "one_way",
    passenger_type: initial.passenger_type || "adult",
    amount_paid: initial.amount_paid ?? "",
    payment_method: initial.payment_method || "cash",
    account_id: initial.account_id || "",
    agent_commission: initial.agent_commission ?? "",
    agent_id: initial.agent_id || "",
    agent_name: initial.agent_name_commission || "",
    agent_phone: initial.agent_phone || "",
    // Travel documents. The date fields go through toDateInput for the same
    // reason flight_date does — a raw value from the API won't populate a
    // <input type="date"> and would silently blank the field on save.
    passport_number: initial.passport_number || "",
    nationality: initial.nationality || "",
    visa_type: initial.visa_type || "",
    date_of_birth: toDateInput(initial.date_of_birth),
    passport_expiry_date: toDateInput(initial.passport_expiry_date),
    visa_expiry_date: toDateInput(initial.visa_expiry_date),
  });

  /**
   * The passengers travelling on this booking.
   *
   * One row is the ordinary case and behaves exactly as the form always
   * has. Adding rows turns the booking into a group: one price, one person
   * paying, several seats.
   *
   * Editing an existing ticket never shows this — a ticket is one seat, and
   * adding passengers to it would have to mean re-splitting money that has
   * already been collected against it.
   */
  const [passengers, setPassengers] = useState([
    {
      ...blankPassenger(),
      passenger_name: initial.passenger_name || "",
      ticket_reference: initial.ticket_reference || "",
      passport_number: initial.passport_number || "",
    },
  ]);
  // Who pays. Separate from the passengers because it is a different role:
  // the money, the balance and the statement all follow this person, who may
  // not be travelling at all.
  const [contact, setContact] = useState({
    contact_name: initial.contact_name || "",
    contact_number: initial.contact_number || "",
  });
  // Set when the document claimed a different number of passengers than the
  // AI could actually read. Never reconciled silently — a missing passenger
  // is a seat somebody paid for.
  const [countWarning, setCountWarning] = useState(null);

  const isGroup = mode === "create" && passengers.length > 1;
  const namedPassengers = passengers.filter((p) => p.passenger_name.trim());

  const setPassenger = (i, key) => (e) => {
    const val = e.target.value;
    setPassengers((list) =>
      list.map((p, idx) => (idx === i ? { ...p, [key]: val } : p)),
    );
  };
  const removePassenger = (i) =>
    setPassengers((list) => {
      const passenger = list[i];
      if (!passenger || (passenger.passenger_type === "adult" &&
        list.filter((item) => item.passenger_type === "adult").length <= 1)) {
        return list;
      }
      return list.filter((_, index) => index !== i);
    });
  const changePassengerCount = (type, amount) => {
    setPassengers((list) => {
      if (amount > 0) return [...list, { ...blankPassenger(), passenger_type: type }];
      const matching = list.reduce(
        (indices, passenger, index) =>
          passenger.passenger_type === type ? [...indices, index] : indices,
        [],
      );
      if (matching.length <= (type === "adult" ? 1 : 0)) return list;
      const lastIndex = matching[matching.length - 1];
      return list.filter((_, index) => index !== lastIndex);
    });
  };
  const swapCities = () =>
    setForm((current) => ({
      ...current,
      from_city: current.to_city,
      to_city: current.from_city,
    }));

  // Commission is the exception, not the rule — keep it out of the way until
  // it's actually needed. Editing a ticket that already has one opens it.
  const [hasCommission, setHasCommission] = useState(
    Number(initial.agent_commission) > 0,
  );
  const [bookedByCustomerId, setBookedByCustomerId] = useState(
    initial.booked_by_customer_id || null,
  );
  const matchedAgent = agents.find(
    (a) => a.name.toLowerCase() === (form.agent_name || "").trim().toLowerCase(),
  );

  // Picking a known agent fills in their number so it can't be mistyped
  const onAgentNameChange = (e) => {
    const val = e.target.value;
    const hit = agents.find(
      (a) => a.name.toLowerCase() === val.trim().toLowerCase(),
    );
    setForm((f) => ({
      ...f,
      agent_name: val,
      agent_id: hit ? hit.id : "",
      agent_phone: hit && hit.phone ? hit.phone : f.agent_phone,
    }));
  };

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

      // The passenger list is handled on its own — spreading it into `form`
      // would put an array where the flight fields live.
      const {
        passengers: readPassengers,
        contact_name,
        passenger_count,
        passenger_count_stated,
        passenger_count_mismatch,
        ...flat
      } = extracted;

      setForm((f) => {
        const updated = {
          ...f,
          ...Object.fromEntries(
            Object.entries(flat).filter(([, v]) => v !== null && v !== ""),
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

      if (Array.isArray(readPassengers) && readPassengers.length > 0) {
        setPassengers(
          readPassengers.map((p) => ({
            passenger_name: p.passenger_name || "",
            ticket_reference: p.ticket_reference || "",
            passport_number: p.passport_number || "",
            passenger_type: "adult",
          })),
        );
      }
      setContact((c) => ({
        contact_name: contact_name || c.contact_name,
        contact_number: extracted.contact_number || c.contact_number,
      }));

      // Reported, never quietly fixed. If the itinerary says three people
      // and only two names could be read, the third is a seat somebody paid
      // for and a human has to go and look.
      setCountWarning(
        passenger_count_mismatch
          ? `The document mentions ${passenger_count_stated} passengers but only ${passenger_count} could be read. Check the ticket and add anyone missing.`
          : null,
      );

      const n = readPassengers?.length || 0;
      toast.success(
        n > 1
          ? `${n} passengers read from the ticket. Review and confirm.`
          : "Ticket data extracted! Review and confirm.",
        { id: "extract" },
      );
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

    if (mode === "create" && !form.from_city?.trim()) {
      return toast.error("Enter a departure city");
    }
    if (mode === "create" && !form.to_city?.trim()) {
      return toast.error("Enter a destination city");
    }
    if (mode === "create" && !form.flight_date) {
      return toast.error("Select a departure date");
    }
    if (mode === "create" && form.trip_type === "round_trip") {
      if (!form.return_date) return toast.error("Select a return date");
      if (form.return_date < form.flight_date) {
        return toast.error("Return date must be after the departure date");
      }
    }
    if (mode === "create" && namedPassengers.length === 0) {
      return toast.error("Add at least one passenger");
    }
    if (mode === "create" && namedPassengers.length !== passengers.length) {
      return toast.error("Enter a name for each selected passenger");
    }

    setLoading(true);
    try {
      const payload = {
        ...form,
        payment_status: paymentStatus,
        booked_by_customer_id: bookedByCustomerId || null,
        // Empty date inputs must go as null, not "". Postgres rejects an
        // empty string for a DATE column.
        date_of_birth: form.date_of_birth || null,
        passport_expiry_date: form.passport_expiry_date || null,
        visa_expiry_date: form.visa_expiry_date || null,
      };

      if (mode === "create") {
        // The passenger list goes up whenever there is a list to send —
        // which is always, on create. The server treats one passenger
        // exactly as it treats one ticket, so nothing changes for an
        // ordinary booking except that the contact is named explicitly.
        payload.passengers = namedPassengers.map((p) => ({
          passenger_name: p.passenger_name.trim(),
          passenger_type: p.passenger_type,
          ticket_reference: p.ticket_reference.trim() || null,
          passport_number: p.passport_number.trim() || null,
        }));
        payload.passenger_name = payload.passengers[0].passenger_name;
        payload.contact_name = contact.contact_name.trim() || null;
        payload.contact_number = contact.contact_number.trim() || null;

        const res = await ticketsAPI.create(payload);
        toast.success(res.data?.message || "Ticket created successfully!");
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
    <form
      onSubmit={handleSubmit}
      className="space-y-4 text-sm [&_input]:text-xs [&_select]:text-xs [&_label]:text-xs"
    >
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
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {mode === "edit" ? (
          <Select
            label="Ticket type"
            value={form.ticket_type}
            onChange={set("ticket_type")}
            className="text-xs"
          >
            <option value="LOCAL">Local (Domestic)</option>
            <option value="INTERNATIONAL">International</option>
          </Select>
        ) : (
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
              Ticket type
            </legend>
            <div className="flex items-center gap-4">
              {[
                ["LOCAL", "Local"],
                ["INTERNATIONAL", "International"],
              ].map(([value, label]) => (
                <label
                  key={value}
                  className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-gray-800 dark:text-gray-200"
                >
                  <input
                    type="radio"
                    name="ticket_type"
                    value={value}
                    checked={form.ticket_type === value}
                    onChange={set("ticket_type")}
                    className="h-3.5 w-3.5 accent-green-700"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {mode === "edit" ? (
          <Select
            label="Trip type"
            value={form.trip_type || "one_way"}
            onChange={set("trip_type")}
            className="text-xs"
          >
            <option value="one_way">One way</option>
            <option value="round_trip">Round trip (Go &amp; Back)</option>
          </Select>
        ) : (
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
              Trip type
            </legend>
            <div className="flex items-center gap-4">
              {[
                ["round_trip", "Round trip"],
                ["one_way", "One way"],
              ].map(([value, label]) => (
                <label
                  key={value}
                  className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-gray-800 dark:text-gray-200"
                >
                  <input
                    type="radio"
                    name="trip_type"
                    value={value}
                    checked={form.trip_type === value}
                    onChange={set("trip_type")}
                    className="h-3.5 w-3.5 accent-green-700"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {/* No status here: cancelling moves money (refund, fee, tax,
            airline return), so it is done with Cancel & refund on the
            ticket, which records every movement. */}
      </div>

      {mode === "create" && (
        <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800 sm:p-5">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              Where are you going?
            </h3>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Choose your route and travel dates.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.1fr_auto_1.1fr_1.5fr] lg:items-end">
            <CitySelect
              label="From"
              value={form.from_city}
              onChange={(value) =>
                setForm((current) => ({ ...current, from_city: value }))
              }
            />
            <button
              type="button"
              onClick={swapCities}
              aria-label="Swap departure and destination"
              title="Swap cities"
              className="flex h-8 w-8 items-center justify-center justify-self-center rounded-full border border-gray-200 bg-white text-blue-700 transition hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-blue-300"
            >
              <ArrowLeftRight className="h-3.5 w-3.5" />
            </button>
            <CitySelect
              label="To"
              value={form.to_city}
              onChange={(value) =>
                setForm((current) => ({ ...current, to_city: value }))
              }
            />
            <BookingDates
              tripType={form.trip_type}
              departureDate={form.flight_date}
              returnDate={form.return_date}
              onDepartureChange={(flight_date) =>
                setForm((current) => ({ ...current, flight_date }))
              }
              onReturnChange={(return_date) =>
                setForm((current) => ({ ...current, return_date }))
              }
            />
          </div>
        </section>
      )}

      {/* ── Passenger (editing one existing ticket) ── */}
      {mode === "edit" && (
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
            <Select
              label="Passenger type"
              value={form.passenger_type}
              onChange={set("passenger_type")}
            >
              <option value="adult">Adult</option>
              <option value="child">Child</option>
              <option value="infant">Infant</option>
            </Select>
            <Input
              label="Contact number"
              value={form.contact_number}
              onChange={set("contact_number")}
              placeholder="+252 XX XXX XXXX"
            />
          </div>
        </div>
      )}

      {/* ── Contact and passengers (new booking) ──
          Two sections, because they are two different things. The contact
          is who the money comes from — one person, who owes the balance and
          receives the statement. The passengers are who flies. On a family
          booking the contact is usually the first passenger as well; that
          needs no special handling, they simply appear in both places. */}
      {mode === "create" && (
        <>
          <div>
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
              Contact — who pays
            </h3>
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
              The balance, the statement and the invoice all go to this
              person. One only, even when several people are travelling.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Contact name"
                value={contact.contact_name}
                onChange={(e) =>
                  setContact((c) => ({ ...c, contact_name: e.target.value }))
                }
                placeholder="Leave empty if the first passenger is paying"
              />
              <Input
                label="Contact number"
                value={contact.contact_number}
                onChange={(e) =>
                  setContact((c) => ({ ...c, contact_number: e.target.value }))
                }
                placeholder="+252 XX XXX XXXX"
              />
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800 sm:p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Passengers — who flies
              </h3>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
                <Users className="w-3.5 h-3.5" />
                {passengers.length}{" "}
                {passengers.length === 1
                  ? "passenger"
                  : "passengers"}
              </span>
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
              Set the traveller count, then enter each passenger's details.
            </p>

            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {[
                ["adult", "Adult", "12+ years"],
                ["child", "Child", "2–11 years"],
                ["infant", "Infant", "0–23 months"],
              ].map(([type, label, age]) => {
                const count = passengers.filter(
                  (passenger) => passenger.passenger_type === type,
                ).length;
                return (
                  <div
                    key={type}
                    className="flex items-center justify-between rounded-lg border border-gray-200 px-2.5 py-2 dark:border-gray-700"
                  >
                    <div>
                      <p className="text-xs font-semibold text-gray-900 dark:text-white">
                        {label}
                      </p>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400">
                        {age}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => changePassengerCount(type, -1)}
                        disabled={count <= (type === "adult" ? 1 : 0)}
                        aria-label={`Remove one ${label.toLowerCase()}`}
                        className="flex h-6 w-6 items-center justify-center rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                      >
                        <Minus className="h-3 w-3" />
                      </button>
                      <span className="w-4 text-center text-xs font-semibold tabular-nums text-gray-900 dark:text-white">
                        {count}
                      </span>
                      <button
                        type="button"
                        onClick={() => changePassengerCount(type, 1)}
                        aria-label={`Add one ${label.toLowerCase()}`}
                        className="flex h-6 w-6 items-center justify-center rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {countWarning && (
              <div className="flex items-start gap-2 mb-3 p-3 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  {countWarning}
                </p>
              </div>
            )}

            <div className="space-y-3">
              {passengers.map((p, i) => (
                <div
                  key={i}
                  className="flex gap-2 items-start rounded-lg border border-gray-200 dark:border-gray-700 p-2"
                >
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    <Plane className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_220px] gap-2">
                    <Input
                      label={`${p.passenger_type[0].toUpperCase()}${p.passenger_type.slice(1)} ${i + 1} name *`}
                      value={p.passenger_name}
                      onChange={setPassenger(i, "passenger_name")}
                      placeholder="Full name"
                      required
                      className="py-1.5"
                    />
                    <Input
                      label="Ticket number"
                      value={p.ticket_reference}
                      onChange={setPassenger(i, "ticket_reference")}
                      placeholder="KMUMGQ-16226-000011"
                      className="max-w-[200px] py-1.5"
                      hint={
                        i === 0
                          ? "Each passenger has their own on a group ticket"
                          : undefined
                      }
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removePassenger(i)}
                    disabled={
                      p.passenger_type === "adult"
                        ? passengers.filter((item) => item.passenger_type === "adult").length <= 1
                        : passengers.filter((item) => item.passenger_type === p.passenger_type).length === 0
                    }
                    title={
                      p.passenger_type === "adult" &&
                      passengers.filter((item) => item.passenger_type === "adult").length <= 1
                        ? "A booking needs at least one adult"
                        : `Remove passenger ${i + 1}`
                    }
                    className="mt-1 p-1 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

          </div>
        </>
      )}

      {/* ── Flight Details ── */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Flight Details
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {mode === "edit" && (
            <>
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
            </>
          )}
          {mode === "edit" && form.trip_type === "round_trip" && (
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
            className="max-w-[220px]"
          />
        </div>
      </div>

      {/* ── Pricing ── */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
          Pricing
        </h3>
        {isGroup && (
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
            The combined price for all {namedPassengers.length || passengers.length}{" "}
            passengers, exactly as the ticket quotes it. It is divided between
            them below.
          </p>
        )}

        {/* Breakdown */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mb-4">
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

        {/* What each passenger's ticket will actually be worth.
            Shown before saving, not after, because the split is the one
            thing about a group booking an agent cannot check by eye — and
            the cent that cannot divide evenly has to land somewhere
            visible rather than disappear. */}
        {isGroup && Number(form.selling_price) > 0 && (
          <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800 text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide">
              How the {money(form.selling_price)} splits
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {previewShares(form.selling_price, namedPassengers.length).map(
                (share, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between px-4 py-2 text-sm"
                  >
                    <span className="text-gray-700 dark:text-gray-200 truncate">
                      {namedPassengers[i].passenger_name || `Passenger ${i + 1}`}
                    </span>
                    <span className="font-semibold text-gray-900 dark:text-white tabular-nums">
                      {money(share)}
                    </span>
                  </div>
                ),
              )}
            </div>
            <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-800 text-sm font-bold">
              <span className="text-gray-600 dark:text-gray-300">Total</span>
              <span className="text-gray-900 dark:text-white tabular-nums">
                {money(
                  previewShares(
                    form.selling_price,
                    namedPassengers.length,
                  ).reduce((a, b) => a + b, 0),
                )}
              </span>
            </div>
          </div>
        )}

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
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
          <AccountSelect
            direction="in"
            value={form.account_id}
            onChange={set("account_id")}
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
        {!hasCommission ? (
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={false}
              onChange={() => setHasCommission(true)}
              className="rounded cursor-pointer"
            />
            <span className="text-sm text-gray-600 dark:text-gray-300">
              An agent earns commission on this booking
            </span>
          </label>
        ) : (
          <>
            <label className="flex items-center gap-2.5 cursor-pointer select-none mb-3">
              <input
                type="checkbox"
                checked
                onChange={() => {
                  setHasCommission(false);
                  // Clearing the amount keeps revenue honest
                  setForm((f) => ({
                    ...f,
                    agent_commission: "",
                    agent_id: "",
                    agent_name: "",
                    agent_phone: "",
                  }));
                }}
                className="rounded cursor-pointer"
              />
              <span className="text-sm text-gray-600 dark:text-gray-300">
                An agent earns commission on this booking
              </span>
            </label>

            <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
              Commission is subtracted from revenue (Revenue = Selling − Cost −
              Commission). A new agent is created automatically from the name
              and phone below.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Input
                label="Commission amount *"
                type="number"
                min="0"
                step="0.01"
                value={form.agent_commission}
                onChange={set("agent_commission")}
                placeholder="0.00"
              />
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Agent name *
                </label>
                <input
                  list="tams-agent-options"
                  value={form.agent_name}
                  onChange={onAgentNameChange}
                  placeholder="Pick one, or type a new agent"
                  autoComplete="off"
                  className="px-3 py-2 rounded-lg border text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                    border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500
                    placeholder-gray-400 dark:placeholder-gray-500"
                />
                <datalist id="tams-agent-options">
                  {agents.map((a) => (
                    <option key={a.id} value={a.name}>
                      {a.phone || ""}
                    </option>
                  ))}
                </datalist>
              </div>
              <Input
                label="Agent phone"
                value={form.agent_phone}
                onChange={set("agent_phone")}
                placeholder="+252 61 234 5678"
              />
            </div>

            {form.agent_name.trim() && (
              <p
                className={`text-xs mt-2 ${
                  matchedAgent
                    ? "text-green-600 dark:text-green-400"
                    : "text-amber-600 dark:text-amber-400"
                }`}
              >
                {matchedAgent
                  ? `Existing agent — commission added to ${matchedAgent.name}'s balance.`
                  : `New agent — "${form.agent_name.trim()}" will be added to your agents list.`}
              </p>
            )}
          </>
        )}
      </div>

      {/* ── Booked By ── */}
      <BookedBySearch
        value={bookedByCustomerId}
        onChange={setBookedByCustomerId}
      />

      {/* ── Actions ── */}
      <div className="flex gap-3 pt-2">
        <Button type="submit" loading={loading} size="sm">
          {mode === "create" ? "Create Ticket" : "Save Changes"}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
