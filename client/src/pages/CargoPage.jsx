import React, { useState, useEffect, useCallback, useRef } from "react";
import { cargoAPI, businessAPI, fileUrl } from "../services/api";
import { useAuth } from "../context/AuthContext";
import {
  Button,
  Card,
  Badge,
  Spinner,
  EmptyState,
  Pagination,
  Input,
  Select,
  Modal,
} from "../components/ui";
import toast from "react-hot-toast";
import {
  Package, Plus, Eye, Pencil, Trash2, Printer,
  Camera, Upload, X, Loader2, Image as ImageIcon, Banknote,
} from "lucide-react";
import { format } from "date-fns";
import AccountSelect from "../components/AccountSelect";
import { compressImage, humanSize } from "../utils/compressImage";
import { printCargoInvoice } from "../utils/cargoInvoice";
import { PaySupplierModal, supplierBalance } from "../components/PaySupplier";
import ActionsMenu from "../components/ActionsMenu";

/** What the sender still owes on a shipment. */
const balanceOf = (c) =>
  Math.round(((Number(c.total_price) || 0) - (Number(c.amount_paid) || 0)) * 100) / 100;

const cargoStatusVariant = {
  pending: "warning",
  in_progress: "info",
  delivered: "success",
  cancelled: "danger",
};
const paymentVariant = {
  unpaid: "danger",
  partial: "warning",
  paid: "success",
};
const cargoStatusLabel = {
  pending: "Pending",
  in_progress: "In Progress",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

const EMPTY_FORM = {
  item_description: "",
  weight_kg: "",
  price_per_kg: "",
  sender_name: "",
  sender_contact: "",
  from_city: "",
  receiver_name: "",
  receiver_contact: "",
  to_city: "",
  notes: "",
  cargo_status: "pending",
  // "weight" or "flat" — decides which price fields the form shows.
  pricing: "weight",
  flat_price: "",
  // What the agency keeps. A per-kilo price is sometimes the whole margin
  // and sometimes mostly the carrier's fee, and only the person at the
  // counter knows which — so they say, rather than the system assuming.
  // The margin, quoted the way the price is: per kilo when charging by
  // weight, a lump sum when charging a flat price.
  profit_per_kg: "",
  profit_flat: "",
  // Filled in when the shipment lands, so the customer can be told where to
  // collect it and who to ring.
  arrived_city: "",
  arrived_office: "",
  arrived_phone: "",
  amount_paid: "0",
  // Which account the money landed in — drives the Accounts balance.
  account_id: "",
  photo_url: "",
};

// ── Item photo — camera on mobile, file picker anywhere ──────
// Two inputs rather than one: `capture` opens the camera directly on
// phones and tablets, but is ignored on desktop, so the plain picker
// stays available as the fallback everywhere.
const PhotoField = ({ value, onChange }) => {
  const cameraRef = useRef(null);
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be picked twice
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      return toast.error("Please choose an image file");
    }
    // Generous, because whatever comes in gets compressed below. Only a
    // genuinely enormous file is refused outright.
    if (file.size > 40 * 1024 * 1024) {
      return toast.error("That photo is too large to process.");
    }

    setPreview(URL.createObjectURL(file));
    setUploading(true);
    try {
      // Shrink first. A phone photo is 4–12MB; this gets it under 400KB
      // without any visible loss, which on a mobile connection is the
      // difference between an upload that finishes and one that doesn't.
      const { file: small, before, after, saved } = await compressImage(file);
      if (saved > 0) {
        toast.success(
          `Photo reduced from ${humanSize(before)} to ${humanSize(after)}`,
          { duration: 2000 },
        );
      }
      const fd = new FormData();
      fd.append("photo", small);
      const res = await cargoAPI.uploadPhoto(fd);
      onChange(res.data.data.photo_url);
      toast.success("Photo attached");
    } catch (err) {
      setPreview(null);
      toast.error(err.response?.data?.message || "Photo upload failed");
    } finally {
      setUploading(false);
    }
  };

  const shown = preview || (value ? fileUrl(value) : null);

  return (
    <div className="flex flex-col gap-1 sm:col-span-2">
      <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
        Item photo
      </label>

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        className="hidden"
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={handleFile}
        className="hidden"
      />

      {shown ? (
        <div className="relative inline-block w-fit">
          <img
            src={shown}
            alt="Cargo item"
            className="h-36 w-auto rounded-xl border border-gray-200 dark:border-gray-600 object-cover"
          />
          {uploading && (
            <div className="absolute inset-0 rounded-xl bg-black/40 grid place-items-center">
              <Loader2 className="w-6 h-6 text-white animate-spin" />
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              setPreview(null);
              onChange("");
            }}
            className="absolute -top-2 -right-2 p-1 rounded-full bg-red-600 text-white shadow hover:bg-red-700"
            title="Remove photo"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          <Button
            type="button"
            variant="outline"
            onClick={() => cameraRef.current?.click()}
            disabled={uploading}
          >
            <Camera className="w-4 h-4" /> Take photo
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
            Upload image
          </Button>
        </div>
      )}
      <p className="text-xs text-gray-400 dark:text-gray-500">
        Optional — a photo of the item as received. Max 10MB.
      </p>
    </div>
  );
};

// ── Cargo Form — defined OUTSIDE the page to prevent focus loss ──
const CargoForm = ({ form, setForm, onSave, onCancel, saving }) => {
  const setField = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  // Two ways to price a shipment, and which one applies is decided by what
  // the user fills in rather than by a mode switch they have to remember.
  const byWeight = form.pricing === "weight";
  const totalPrice = byWeight
    ? ((parseFloat(form.weight_kg) || 0) * (parseFloat(form.price_per_kg) || 0)).toFixed(2)
    : (parseFloat(form.flat_price) || 0).toFixed(2);

  return (
    <form onSubmit={onSave} className="space-y-5">
      {/* Item */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Item Details
        </h3>

        {/* How this shipment is priced */}
        <div className="flex gap-2 mb-3">
          {[
            ["weight", "By weight (kg)"],
            ["flat", "Fixed price"],
          ].map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setForm((f) => ({ ...f, pricing: mode }))}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                form.pricing === mode
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
          {byWeight
            ? "Weight × rate. Use this when the goods go on a scale."
            : "Type what you're charging. Use this for electronics and anything priced by eye."}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-3">
            <Input
              label="Item description"
              value={form.item_description}
              onChange={setField("item_description")}
              placeholder="e.g. Clothes, Electronics — optional"
            />
          </div>

          {byWeight ? (
            <>
              <Input
                label="Weight (kg) *"
                type="number"
                min="0.1"
                step="0.1"
                value={form.weight_kg}
                onChange={setField("weight_kg")}
                placeholder="15"
                required
              />
              <Input
                label="Price per kg ($) *"
                type="number"
                min="0"
                step="0.01"
                value={form.price_per_kg}
                onChange={setField("price_per_kg")}
                placeholder="3.00"
                required
              />
            </>
          ) : (
            <div className="md:col-span-2">
              <Input
                label="Total price ($) *"
                type="number"
                min="0"
                step="0.01"
                value={form.flat_price}
                onChange={setField("flat_price")}
                placeholder="40.00"
                required
              />
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Total Price
            </label>
            <div className="px-3 py-2 rounded-lg border bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:text-green-400 font-semibold text-sm">
              ${totalPrice}
            </div>
          </div>

          {form.pricing === "weight" ? (
            <Input
              label="Your profit per kg ($)"
              type="number"
              min="0"
              step="0.01"
              value={form.profit_per_kg}
              onChange={setField("profit_per_kg")}
              placeholder="Leave blank if it's all profit"
              hint={
                form.profit_per_kg === ""
                  ? "Blank means the whole price is profit"
                  : `Margin ${(
                      (parseFloat(form.weight_kg) || 0) *
                      (parseFloat(form.profit_per_kg) || 0)
                    ).toFixed(2)} · carrier cost ${Math.max(
                      (parseFloat(totalPrice) || 0) -
                        (parseFloat(form.weight_kg) || 0) *
                          (parseFloat(form.profit_per_kg) || 0),
                      0,
                    ).toFixed(2)}`
              }
              error={
                parseFloat(form.profit_per_kg) >
                parseFloat(form.price_per_kg) + 0.001
                  ? "More than the price per kg"
                  : undefined
              }
            />
          ) : (
            <Input
              label="Your profit ($)"
              type="number"
              min="0"
              step="0.01"
              value={form.profit_flat}
              onChange={setField("profit_flat")}
              placeholder="Leave blank if it's all profit"
              hint={
                form.profit_flat === ""
                  ? "Blank means the whole price is profit"
                  : `Carrier cost ${Math.max(
                      (parseFloat(totalPrice) || 0) -
                        (parseFloat(form.profit_flat) || 0),
                      0,
                    ).toFixed(2)}`
              }
              error={
                parseFloat(form.profit_flat) > parseFloat(totalPrice) + 0.001
                  ? "More than the total price"
                  : undefined
              }
            />
          )}

        </div>
      </div>

      {/* Sender */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Sender
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            label="Sender name *"
            value={form.sender_name}
            onChange={setField("sender_name")}
            placeholder="Ahmed Awil"
            required
          />
          <Input
            label="Sender contact"
            value={form.sender_contact}
            onChange={setField("sender_contact")}
            placeholder="610481578"
          />
          <Input
            label="From city *"
            value={form.from_city}
            onChange={setField("from_city")}
            placeholder="Mogadishu"
            required
          />
        </div>
      </div>

      {/* Receiver */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Receiver
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            label="Receiver name *"
            value={form.receiver_name}
            onChange={setField("receiver_name")}
            placeholder="Asiya Awil"
            required
          />
          <Input
            label="Receiver contact"
            value={form.receiver_contact}
            onChange={setField("receiver_contact")}
            placeholder="638730010"
          />
          <Input
            label="To city *"
            value={form.to_city}
            onChange={setField("to_city")}
            placeholder="Laascaanood"
            required
          />
        </div>
      </div>

      {/* Payment & Status */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Payment & Status
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            label="Amount paid ($)"
            type="number"
            min="0"
            step="0.01"
            value={form.amount_paid}
            onChange={setField("amount_paid")}
            placeholder="0.00"
          />
          <AccountSelect
            direction="in"
            value={form.account_id}
            onChange={setField("account_id")}
          />
          <Select
            label="Cargo status"
            value={form.cargo_status}
            onChange={setField("cargo_status")}
          >
            <option value="pending">Pending</option>
            <option value="in_progress">In Progress</option>
            <option value="delivered">Delivered — arrived</option>
            <option value="cancelled">Cancelled</option>
          </Select>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Notes
            </label>
            <textarea
              value={form.notes}
              onChange={setField("notes")}
              placeholder="Optional notes..."
              className="px-3 py-2 rounded-lg border text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              rows={2}
            />
          </div>

          <PhotoField
            value={form.photo_url}
            onChange={(url) => setForm((f) => ({ ...f, photo_url: url }))}
          />
        </div>
      </div>

      {/* Where it landed — shown once the shipment has arrived */}
      {form.cargo_status === "delivered" && (
        <div className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-900/10 p-4">
          <h3 className="text-xs font-semibold text-green-700 dark:text-green-300 uppercase tracking-wide mb-1">
            Where to collect
          </h3>
          <p className="text-xs text-green-700 dark:text-green-400 mb-3">
            This is what the customer sees on the tracking page, so give the
            office name they'll recognise and a number someone answers.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input
              label="City"
              value={form.arrived_city}
              onChange={setField("arrived_city")}
              placeholder={form.to_city || "Laascaanood"}
            />
            <Input
              label="Office"
              value={form.arrived_office}
              onChange={setField("arrived_office")}
              placeholder="Sahal Travel"
            />
            <Input
              label="Office phone"
              value={form.arrived_phone}
              onChange={setField("arrived_phone")}
              placeholder="634499223"
            />
          </div>
          {(form.arrived_city || form.to_city) && (
            <p className="text-sm text-green-800 dark:text-green-200 mt-3 italic">
              "Alaabtaada waxay taalaa {form.arrived_city || form.to_city}
              {form.arrived_office
                ? `, gaar ahaan xafiiska ${form.arrived_office}`
                : ""}
              ."
            </p>
          )}
        </div>
      )}

      <div className="flex gap-3 pt-1">
        <Button type="submit" loading={saving}>
          Save Shipment
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
};

// ── Main Page ────────────────────────────────────────────────
export default function CargoPage() {
  // The modal lives here, not in the menu: the menu unmounts the moment it
  // closes, and a modal that dies with its trigger never appears at all.
  const [paySupplier, setPaySupplier] = useState(null);
  const { canWrite, user } = useAuth();

  /**
   * Print, or save as PDF — the browser's own dialog does both, so there is
   * one document and one code path rather than a printed version and a
   * separately generated file that drift apart.
   */
  const printReceipt = async (item) => {
    try {
      const [payRes, bizRes] = await Promise.all([
        cargoAPI.payments(item.id).catch(() => ({ data: { data: [] } })),
        businessAPI.mine().catch(() => ({ data: { data: {} } })),
      ]);
      const business = bizRes.data?.data || {};
      const ok = printCargoInvoice(
        item,
        business,
        payRes.data?.data || [],
        {
          logoUrl: business.logo_url ? fileUrl(business.logo_url) : null,
          preparedBy: user ? { name: user.name, title: user.title } : null,
        },
      );
      if (!ok) toast.error("Allow pop-ups to print the receipt");
    } catch {
      toast.error("Couldn't build the receipt");
    }
  };
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    search: "",
    cargo_status: "",
    payment_status: "",
    page: 1,
    limit: 20,
  });
  const [modal, setModal] = useState({ open: false, mode: null, item: null });
  // Shipment currently having money collected against it.
  const [payItem, setPayItem] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    cargoAPI
      .list(filters)
      .then((res) => {
        setItems(res.data.data);
        setMeta(res.data.meta);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const setFilter = (key) => (e) =>
    setFilters((f) => ({ ...f, [key]: e.target.value, page: 1 }));

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setModal({ open: true, mode: "create", item: null });
  };

  const openEdit = (item) => {
    setForm({
      item_description: item.item_description,
      weight_kg: item.weight_kg,
      profit_per_kg:
        item.profit_per_kg === null || item.profit_per_kg === undefined
          ? ""
          : String(item.profit_per_kg),
      profit_flat:
        item.profit_flat === null || item.profit_flat === undefined
          ? ""
          : String(item.profit_flat),
      price_per_kg: item.price_per_kg,
      sender_name: item.sender_name,
      sender_contact: item.sender_contact || "",
      from_city: item.from_city,
      receiver_name: item.receiver_name,
      receiver_contact: item.receiver_contact || "",
      to_city: item.to_city,
      notes: item.notes || "",
      cargo_status: item.cargo_status,
      amount_paid: item.amount_paid,
      account_id: item.account_id || "",
      // A shipment that was given a flat price reopens in flat mode, so
      // saving it again doesn't silently switch it to weight-based.
      pricing: item.flat_price != null && Number(item.flat_price) > 0 ? "flat" : "weight",
      flat_price: item.flat_price ?? "",
      arrived_city: item.arrived_city || "",
      arrived_office: item.arrived_office || "",
      arrived_phone: item.arrived_phone || "",
      photo_url: item.photo_url || "",
    });
    setModal({ open: true, mode: "edit", item });
  };

  const openView = (item) => setModal({ open: true, mode: "view", item });
  const closeModal = () => setModal({ open: false, mode: null, item: null });

  // Only the fields for the chosen pricing mode go to the server. Leaving a
  // stale weight behind on a fixed-price shipment would make the stored total
  // disagree with what the form showed.
  const payload = () => {
    const { pricing, ...rest } = form;
    return pricing === "flat"
      ? { ...rest, weight_kg: null, price_per_kg: null }
      : { ...rest, flat_price: null };
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (modal.mode === "create") {
        await cargoAPI.create(payload());
        toast.success("Shipment created!");
      } else {
        await cargoAPI.update(modal.item.id, payload());
        toast.success("Shipment updated!");
      }
      closeModal();
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to save shipment");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item) => {
    if (!window.confirm(`Delete shipment ${item.tracking_number}?`)) return;
    try {
      await cargoAPI.delete(item.id);
      toast.success("Shipment deleted");
      load();
    } catch {
      toast.error("Failed to delete");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Cargo
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {meta.total} shipments
          </p>
        </div>
        {canWrite() && (
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" /> New Shipment
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-48">
            <Input
              placeholder="Search sender, receiver, tracking..."
              value={filters.search}
              onChange={setFilter("search")}
            />
          </div>
          <Select
            value={filters.cargo_status}
            onChange={setFilter("cargo_status")}
            className="w-36"
          >
            <option value="">All status</option>
            <option value="pending">Pending</option>
            <option value="in_progress">In Progress</option>
            <option value="delivered">Delivered</option>
            <option value="cancelled">Cancelled</option>
          </Select>
          <Select
            value={filters.payment_status}
            onChange={setFilter("payment_status")}
            className="w-36"
          >
            <option value="">All payments</option>
            <option value="unpaid">Unpaid</option>
            <option value="partial">Partial</option>
            <option value="paid">Paid</option>
          </Select>
          <Button
            variant="outline"
            onClick={() =>
              setFilters({
                search: "",
                cargo_status: "",
                payment_status: "",
                page: 1,
                limit: 20,
              })
            }
          >
            Clear
          </Button>
        </div>
      </Card>

      {/* Table */}
      <Card>
        {loading ? (
          <div className="flex justify-center py-16">
            <Spinner size="lg" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No shipments yet"
            description="Create your first cargo shipment."
            action={
              canWrite() && (
                <Button onClick={openCreate}>
                  <Plus className="w-4 h-4" /> New Shipment
                </Button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  {[
                    "Tracking",
                    "Item",
                    "Route",
                    "Weight",
                    "Total",
                    "Balance",
                    "Status",
                    "Payment",
                    "",
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {items.map((item) => (
                  <tr
                    key={item.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-blue-600 dark:text-blue-400 font-semibold">
                        {item.tracking_number}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        {item.photo_url ? (
                          <img
                            src={fileUrl(item.photo_url)}
                            alt=""
                            className="w-9 h-9 rounded-lg object-cover border border-gray-200 dark:border-gray-600 shrink-0"
                          />
                        ) : (
                          <div className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-700 grid place-items-center shrink-0">
                            <ImageIcon className="w-4 h-4 text-gray-300 dark:text-gray-500" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900 dark:text-white truncate">
                            {item.item_description}
                          </p>
                          <p className="text-xs text-gray-400 truncate">
                            {item.sender_name} → {item.receiver_name}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {item.from_city} → {item.to_city}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {item.weight_kg ? `${item.weight_kg} kg` : "—"}
                    </td>
                    <td className="px-4 py-3 font-semibold text-gray-900 dark:text-white">
                      ${Number(item.total_price).toFixed(2)}
                    </td>
                    <td
                      className={`px-4 py-3 font-semibold ${
                        balanceOf(item) > 0
                          ? "text-red-600 dark:text-red-400"
                          : "text-gray-400"
                      }`}
                    >
                      ${balanceOf(item).toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={cargoStatusVariant[item.cargo_status]}>
                        {cargoStatusLabel[item.cargo_status]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={paymentVariant[item.payment_status]}>
                        {item.payment_status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <ActionsMenu
                        items={[
                          { label: "View", icon: Eye, onClick: () => openView(item) },
                          { label: "Print receipt", icon: Printer, onClick: () => printReceipt(item) },
                          balanceOf(item) > 0 && item.cargo_status !== "cancelled"
                            ? { label: "Collect payment", icon: Banknote, onClick: () => setPayItem(item) }
                            : null,
                          supplierBalance("cargo", item) > 0
                            ? { label: "Pay carrier", icon: Banknote, onClick: () => setPaySupplier(item) }
                            : null,
                          canWrite() ? { label: "Edit", icon: Pencil, onClick: () => openEdit(item) } : null,
                          canWrite() ? { label: "Delete", icon: Trash2, danger: true, onClick: () => handleDelete(item) } : null,
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-4 pb-4">
          <Pagination
            page={filters.page}
            totalPages={meta.totalPages}
            onChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          />
        </div>
      </Card>

      {/* Create/Edit Modal */}
      <Modal
        open={modal.open && modal.mode !== "view"}
        onClose={closeModal}
        title={modal.mode === "create" ? "New Shipment" : "Edit Shipment"}
        size="lg"
      >
        <CargoForm
          form={form}
          setForm={setForm}
          onSave={handleSave}
          onCancel={closeModal}
          saving={saving}
        />
      </Modal>

      {/* View Modal */}
      <Modal
        open={modal.open && modal.mode === "view"}
        onClose={closeModal}
        title="Shipment Details"
        size="md"
      >
        {modal.item && (
          <div className="space-y-3">
            <div className="text-center py-2">
              <p className="text-xs text-gray-500">Tracking Number</p>
              <p className="text-xl font-mono font-bold text-blue-600">
                {modal.item.tracking_number}
              </p>
            </div>

            {modal.item.photo_url && (
              <a
                href={fileUrl(modal.item.photo_url)}
                target="_blank"
                rel="noreferrer"
                className="block"
              >
                <img
                  src={fileUrl(modal.item.photo_url)}
                  alt={modal.item.item_description}
                  className="w-full max-h-64 object-contain rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900"
                />
                <p className="text-xs text-center text-gray-400 mt-1">
                  Click to open full size
                </p>
              </a>
            )}
            {[
              ["Item", modal.item.item_description],
              ["Weight", `${modal.item.weight_kg} kg`],
              ["Price/kg", `$${Number(modal.item.price_per_kg).toFixed(2)}`],
              ["Total Price", `$${Number(modal.item.total_price).toFixed(2)}`],
              ["Amount Paid", `$${Number(modal.item.amount_paid).toFixed(2)}`],
              ["Route", `${modal.item.from_city} → ${modal.item.to_city}`],
              [
                "Sender",
                `${modal.item.sender_name} (${modal.item.sender_contact || "—"})`,
              ],
              [
                "Receiver",
                `${modal.item.receiver_name} (${modal.item.receiver_contact || "—"})`,
              ],
              ["Cargo Status", cargoStatusLabel[modal.item.cargo_status]],
              ["Payment", modal.item.payment_status],
              ["Notes", modal.item.notes || "—"],
              ["Agent", modal.item.agent_name || "—"],
              [
                "Created",
                format(new Date(modal.item.created_at), "dd MMM yyyy HH:mm"),
              ],
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700/50 last:border-0"
              >
                <span className="text-sm text-gray-500">{label}</span>
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  {value}
                </span>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* Collect against a shipment */}
      <Modal
        open={!!payItem}
        onClose={() => setPayItem(null)}
        title={payItem ? `Collect — ${payItem.sender_name}` : ""}
      >
        {payItem && (
          <CargoCollectForm
            item={payItem}
            onDone={() => {
              setPayItem(null);
              load();
            }}
            onCancel={() => setPayItem(null)}
          />
        )}
      </Modal>
      <PaySupplierModal
        kind="cargo"
        record={paySupplier}
        open={Boolean(paySupplier)}
        onClose={() => setPaySupplier(null)}
        onPaid={load}
      />
    </div>
  );
}

// ── Collect against a shipment ───────────────────────────────────────────────
//
// Same shape as the ticket and visa dialogs, so staff meet one pattern for
// taking money rather than three. Editing the shipment to change what was
// paid still works, but that is an amendment; this is a receipt.
function CargoCollectForm({ item, onDone, onCancel }) {
  const balance = balanceOf(item);
  const [amount, setAmount] = useState(balance.toFixed(2));
  const [accountId, setAccountId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (!val || val <= 0) return toast.error("Enter a valid amount");
    if (val > balance + 0.001)
      return toast.error(`Amount exceeds the balance ($${balance.toFixed(2)})`);
    if (!accountId) return toast.error("Choose which account the money goes into");

    setSaving(true);
    try {
      const res = await cargoAPI.addPayment(item.id, {
        amount: val,
        account_id: accountId,
        note: note || undefined,
      });
      toast.success(res.data.message);
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to collect payment");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {item.item_description || "Shipment"} · {item.from_city} → {item.to_city}
        </p>
        <div className="flex gap-6 mt-2 text-sm">
          <span className="text-gray-500">
            Total{" "}
            <strong className="text-gray-900 dark:text-white">
              ${Number(item.total_price).toFixed(2)}
            </strong>
          </span>
          <span className="text-gray-500">
            Paid{" "}
            <strong className="text-green-600">
              ${Number(item.amount_paid).toFixed(2)}
            </strong>
          </span>
          <span className="text-gray-500">
            Balance <strong className="text-red-600">${balance.toFixed(2)}</strong>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label="Amount to collect *"
          type="number"
          min="0.01"
          step="0.01"
          max={balance}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <AccountSelect
          direction="in"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        />
      </div>

      <Input
        label="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. paid by receiver on collection"
      />

      <div className="flex gap-3 justify-end pt-1">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          <Banknote className="w-4 h-4" /> Collect
        </Button>
      </div>
    </form>
  );
}
