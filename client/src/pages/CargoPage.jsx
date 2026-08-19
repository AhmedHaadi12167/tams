import React, { useState, useEffect, useCallback, useRef } from "react";
import { cargoAPI, fileUrl } from "../services/api";
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
  Package, Plus, Eye, Pencil, Trash2,
  Camera, Upload, X, Loader2, Image as ImageIcon,
} from "lucide-react";
import { format } from "date-fns";

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
  amount_paid: "0",
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
    if (file.size > 10 * 1024 * 1024) {
      return toast.error("Photo is too large. Maximum 10MB.");
    }

    setPreview(URL.createObjectURL(file));
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("photo", file);
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

  const totalPrice =
    form.weight_kg && form.price_per_kg
      ? (parseFloat(form.weight_kg) * parseFloat(form.price_per_kg)).toFixed(2)
      : "0.00";

  return (
    <form onSubmit={onSave} className="space-y-5">
      {/* Item */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Item Details
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-3">
            <Input
              label="Item description *"
              value={form.item_description}
              onChange={setField("item_description")}
              placeholder="e.g. Clothes, Electronics"
              required
            />
          </div>
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
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Total Price
            </label>
            <div className="px-3 py-2 rounded-lg border bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:text-green-400 font-semibold text-sm">
              ${totalPrice}
            </div>
          </div>
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
          <Select
            label="Cargo status"
            value={form.cargo_status}
            onChange={setField("cargo_status")}
          >
            <option value="pending">Pending</option>
            <option value="in_progress">In Progress</option>
            <option value="delivered">Delivered</option>
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
  const { canWrite } = useAuth();
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
      photo_url: item.photo_url || "",
    });
    setModal({ open: true, mode: "edit", item });
  };

  const openView = (item) => setModal({ open: true, mode: "view", item });
  const closeModal = () => setModal({ open: false, mode: null, item: null });

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (modal.mode === "create") {
        await cargoAPI.create(form);
        toast.success("Shipment created!");
      } else {
        await cargoAPI.update(modal.item.id, form);
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
      <div className="flex items-center justify-between">
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
                      {item.weight_kg} kg
                    </td>
                    <td className="px-4 py-3 font-semibold text-gray-900 dark:text-white">
                      ${Number(item.total_price).toFixed(2)}
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
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openView(item)}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        {canWrite() && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(item)}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(item)}
                              className="text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </>
                        )}
                      </div>
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
    </div>
  );
}
