import React, { useState, useEffect, useCallback, useRef } from "react";
import { businessAPI, authAPI, fileUrl } from "../services/api";
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
  StatCard,
} from "../components/ui";
import toast from "react-hot-toast";
import {
  Building2,
  Plus,
  Eye,
  Pencil,
  TrendingUp,
  Users,
  Ticket,
  Package,
  ImagePlus,
  X,
} from "lucide-react";
import { format } from "date-fns";

const statusVariant = {
  active: "success",
  suspended: "danger",
  inactive: "warning",
};

const EMPTY_CREATE = {
  business_name: "",
  business_email: "",
  business_phone: "",
  business_address: "",
  business_website: "",
  business_logo_url: "",
  admin_name: "",
  admin_email: "",
  admin_password: "",
};

const EMPTY_EDIT = {
  name: "",
  email: "",
  phone: "",
  address: "",
  website: "",
  logo_url: "",
  status: "active",
};

const LOGO_TYPES = ["image/png", "image/jpeg"];
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Pick, preview and clear an agency logo.
 *
 * The file is uploaded the moment it is chosen rather than on submit, and
 * the form then carries only the returned file name. That is what lets the
 * same control work on the registration form, where there is no business
 * row yet to attach an upload to.
 *
 * PNG and JPEG only, and the check is repeated here rather than left to the
 * server: telling someone their file is the wrong type before a 2MB upload
 * is a better experience than telling them after, and the real check still
 * runs server-side where it counts.
 */
function LogoPicker({ value, onChange, label = "Agency logo" }) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    // Cleared straight away so choosing the same file twice still fires.
    e.target.value = "";
    if (!file) return;

    if (!LOGO_TYPES.includes(file.type))
      return toast.error("The logo must be a PNG or JPEG file.");
    if (file.size > LOGO_MAX_BYTES)
      return toast.error("That logo is over 2 MB. Please use a smaller file.");

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("logo", file);
      const res = await businessAPI.uploadLogo(fd);
      onChange(res.data.data.logo_url);
      toast.success("Logo uploaded");
    } catch (err) {
      toast.error(err.response?.data?.message || "Could not upload that logo");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </label>
      <div className="flex items-center gap-3">
        <div className="w-24 h-16 rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 flex items-center justify-center overflow-hidden shrink-0">
          {value ? (
            <img
              src={fileUrl(value)}
              alt="Agency logo"
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <ImagePlus className="w-5 h-5 text-gray-400" />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={busy}
              onClick={() => inputRef.current?.click()}
            >
              {value ? "Replace" : "Choose logo"}
            </Button>
            {value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange("")}
              >
                <X className="w-3.5 h-3.5" /> Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            PNG or JPEG, up to 2 MB. Printed on this agency's invoices and
            shown in their sidebar.
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          onChange={pick}
        />
      </div>
    </div>
  );
}

export default function BusinessesPage() {
  const [businesses, setBusinesses] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);

  // Modals
  const [createModal, setCreateModal] = useState(false);
  const [editModal, setEditModal] = useState(null); // holds the business being edited
  const [viewModal, setViewModal] = useState(null);
  const [viewData, setViewData] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);

  // Forms
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [editForm, setEditForm] = useState(EMPTY_EDIT);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      businessAPI.list({ page, limit: 15, search, status: statusFilter }),
      businessAPI.overview(),
    ])
      .then(([bizRes, overviewRes]) => {
        setBusinesses(bizRes.data.data);
        setMeta(bizRes.data.meta);
        setOverview(overviewRes.data.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page, search, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // Open edit modal — prefill form with current values
  const openEdit = (biz) => {
    setEditForm({
      name: biz.name || "",
      email: biz.email || "",
      phone: biz.phone || "",
      address: biz.address || "",
      website: biz.website || "",
      logo_url: biz.logo_url || "",
      status: biz.status || "active",
    });
    setEditModal(biz);
  };

  const openView = async (biz) => {
    setViewModal(biz);
    setViewLoading(true);
    try {
      const res = await businessAPI.get(biz.id);
      setViewData(res.data.data);
    } catch {
      toast.error("Failed to load business details");
    } finally {
      setViewLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await authAPI.createBusiness(createForm);
      toast.success("Business registered successfully!");
      setCreateModal(false);
      setCreateForm(EMPTY_CREATE);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to create business");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await businessAPI.update(editModal.id, editForm);
      toast.success("Business updated successfully!");
      setEditModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to update business");
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (biz, status) => {
    try {
      await businessAPI.update(biz.id, { status });
      toast.success(`Business ${status}`);
      load();
    } catch {
      toast.error("Failed to update status");
    }
  };

  const setC = (key) => (e) =>
    setCreateForm((f) => ({ ...f, [key]: e.target.value }));
  const setE = (key) => (e) =>
    setEditForm((f) => ({ ...f, [key]: e.target.value }));

  const ov = overview?.summary || {};

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Businesses
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            All agencies on the platform
          </p>
        </div>
        <Button onClick={() => setCreateModal(true)}>
          <Plus className="w-4 h-4" /> Register Business
        </Button>
      </div>

      {/* Platform overview */}
      {overview && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title="Total Businesses"
            value={ov.total_businesses || 0}
            icon={Building2}
            color="blue"
          />
          <StatCard
            title="Total Users"
            value={ov.total_users || 0}
            icon={Users}
            color="purple"
          />
          <StatCard
            title="Total Tickets"
            value={ov.total_tickets || 0}
            icon={Ticket}
            color="green"
          />
          <StatCard
            title="Total Cargo"
            value={ov.total_cargo || 0}
            icon={Package}
            color="orange"
          />
        </div>
      )}

      {/* Filters */}
      <Card className="p-4">
        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-48">
            <Input
              placeholder="Search name or email..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="w-36"
          >
            <option value="">All status</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="inactive">Inactive</option>
          </Select>
        </div>
      </Card>

      {/* Business cards */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : businesses.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No businesses yet"
          action={
            <Button onClick={() => setCreateModal(true)}>
              <Plus className="w-4 h-4" /> Register
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {businesses.map((biz) => (
            <Card
              key={biz.id}
              className="p-5 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between mb-2">
                {biz.logo_url && (
                  <div className="w-11 h-11 mr-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white flex items-center justify-center overflow-hidden shrink-0">
                    <img
                      src={fileUrl(biz.logo_url)}
                      alt=""
                      className="max-w-full max-h-full object-contain"
                    />
                  </div>
                )}
                <div className="min-w-0 flex-1 mr-2">
                  <h3 className="font-semibold text-gray-900 dark:text-white truncate">
                    {biz.name}
                  </h3>
                  <p className="text-xs text-gray-500 truncate">{biz.email}</p>
                  {biz.phone && (
                    <p className="text-xs text-gray-400">{biz.phone}</p>
                  )}
                  {biz.address && (
                    <p className="text-xs text-gray-400 truncate">
                      {biz.address}
                    </p>
                  )}
                </div>
                <Badge variant={statusVariant[biz.status]}>{biz.status}</Badge>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 my-3 py-3 border-y border-gray-100 dark:border-gray-700/50">
                <div className="text-center">
                  <p className="text-lg font-bold text-gray-900 dark:text-white">
                    {biz.tickets_this_month}
                  </p>
                  <p className="text-xs text-gray-500">Tickets/mo</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-gray-900 dark:text-white">
                    {biz.cargo_this_month}
                  </p>
                  <p className="text-xs text-gray-500">Cargo/mo</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-gray-900 dark:text-white">
                    {biz.total_users}
                  </p>
                  <p className="text-xs text-gray-500">Users</p>
                </div>
              </div>

              <p className="text-xs text-gray-400 mb-3">
                Joined {format(new Date(biz.created_at), "dd MMM yyyy")}
              </p>

              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openView(biz)}
                >
                  <Eye className="w-3.5 h-3.5" /> Details
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openEdit(biz)}
                >
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </Button>
                {biz.status === "active" ? (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleStatusChange(biz, "suspended")}
                  >
                    Suspend
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleStatusChange(biz, "active")}
                  >
                    Activate
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Pagination page={page} totalPages={meta.totalPages} onChange={setPage} />

      {/* ── Create Business Modal ── */}
      <Modal
        open={createModal}
        onClose={() => setCreateModal(false)}
        title="Register New Business"
        size="lg"
      >
        <form onSubmit={handleCreate} className="space-y-5">
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Agency Info
            </h3>
            <div className="space-y-3">
              <Input
                label="Agency name *"
                value={createForm.business_name}
                onChange={setC("business_name")}
                required
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label="Agency email *"
                  type="email"
                  value={createForm.business_email}
                  onChange={setC("business_email")}
                  required
                />
                <Input
                  label="Phone"
                  value={createForm.business_phone}
                  onChange={setC("business_phone")}
                />
              </div>
              <Input
                label="Address"
                value={createForm.business_address}
                onChange={setC("business_address")}
                placeholder="KM5, Hodan District, Mogadishu"
              />
              <Input
                label="Website"
                value={createForm.business_website}
                onChange={setC("business_website")}
                placeholder="www.example.so"
              />
              <LogoPicker
                value={createForm.business_logo_url}
                onChange={(v) =>
                  setCreateForm((f) => ({ ...f, business_logo_url: v }))
                }
              />
            </div>
          </div>
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Admin Account
            </h3>
            <div className="space-y-3">
              <Input
                label="Admin full name *"
                value={createForm.admin_name}
                onChange={setC("admin_name")}
                required
              />
              <Input
                label="Admin email *"
                type="email"
                value={createForm.admin_email}
                onChange={setC("admin_email")}
                required
              />
              <Input
                label="Password *"
                type="password"
                value={createForm.admin_password}
                onChange={setC("admin_password")}
                placeholder="Min 8 characters"
                required
              />
            </div>
          </div>
          <div className="flex gap-3">
            <Button type="submit" loading={saving}>
              Register Business
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreateModal(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      {/* ── Edit Business Modal ── */}
      <Modal
        open={!!editModal}
        onClose={() => setEditModal(null)}
        title={`Edit — ${editModal?.name}`}
        size="md"
      >
        <form onSubmit={handleEdit} className="space-y-4">
          <Input
            label="Business name *"
            value={editForm.name}
            onChange={setE("name")}
            required
          />
          <Input
            label="Email *"
            type="email"
            value={editForm.email}
            onChange={setE("email")}
            required
          />
          <Input
            label="Phone"
            value={editForm.phone}
            onChange={setE("phone")}
            placeholder="+252 XX XXX XXXX"
          />
          <Input
            label="Address"
            value={editForm.address}
            onChange={setE("address")}
            placeholder="Mogadishu, Somalia"
          />
          <Input
            label="Website"
            value={editForm.website}
            onChange={setE("website")}
            placeholder="www.example.so"
          />
          <LogoPicker
            value={editForm.logo_url}
            onChange={(v) => setEditForm((f) => ({ ...f, logo_url: v }))}
          />
          <Select
            label="Status"
            value={editForm.status}
            onChange={setE("status")}
          >
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="inactive">Inactive</option>
          </Select>
          <div className="flex gap-3 pt-2">
            <Button type="submit" loading={saving}>
              Save Changes
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setEditModal(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      {/* ── View Business Modal ── */}
      <Modal
        open={!!viewModal}
        onClose={() => {
          setViewModal(null);
          setViewData(null);
        }}
        title="Business Details"
        size="lg"
      >
        {viewLoading ? (
          <div className="flex justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : (
          viewData && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <StatCard
                  title="Total Tickets"
                  value={viewData.stats.total_tickets}
                  icon={Ticket}
                  color="blue"
                />
                <StatCard
                  title="This Month"
                  value={viewData.stats.tickets_this_month}
                  icon={TrendingUp}
                  color="green"
                />
                <StatCard
                  title="Total Cargo"
                  value={viewData.stats.total_cargo}
                  icon={Package}
                  color="purple"
                />
                <StatCard
                  title="Customers"
                  value={viewData.stats.total_customers}
                  icon={Users}
                  color="orange"
                />
              </div>
              <div>
                <h4 className="font-semibold text-gray-900 dark:text-white mb-3">
                  Team ({viewData.users.length})
                </h4>
                <div className="space-y-2">
                  {viewData.users.map((u) => (
                    <div
                      key={u.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-2 px-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-white">
                          {u.name}
                        </p>
                        <p className="text-xs text-gray-500">{u.email}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={u.role === "admin" ? "warning" : "info"}
                        >
                          {u.role}
                        </Badge>
                        <Badge variant={u.is_active ? "success" : "danger"}>
                          {u.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )
        )}
      </Modal>
    </div>
  );
}
