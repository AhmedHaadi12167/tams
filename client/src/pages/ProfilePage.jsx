import React, { useState, useEffect, useCallback } from "react";
import { profileAPI, businessAPI } from "../services/api";
import { Button, Input, Card, Badge } from "../components/ui";
import toast from "react-hot-toast";
import { User, Lock, Building2, Upload } from "lucide-react";
import { format } from "date-fns";

/** Uploads are served from /uploads, wherever UPLOAD_PATH points today. */
const fileUrl = (name) => (name ? `/uploads/${name}` : null);

const roleBadge = {
  super_admin: "danger",
  admin: "warning",
  agent: "info",
  accountant: "purple",
};

export default function ProfilePage() {
  const [profile, setProfile] = useState(null);
  // Name and job title save together — they are the two things about
  // yourself a customer sees, and they sit on the same line of an invoice.
  const [nameForm, setNameForm] = useState({ name: "", title: "" });
  const [passForm, setPassForm] = useState({
    current_password: "",
    new_password: "",
    confirm_password: "",
  });
  const [savingName, setSavingName] = useState(false);
  const [savingPass, setSavingPass] = useState(false);

  // The agency's own record — loaded separately from the profile because
  // only an admin may edit it, and only an account attached to an agency
  // has one at all (a super admin belongs to none).
  const [bizForm, setBizForm] = useState(null);
  const [savingBiz, setSavingBiz] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const loadBusiness = useCallback(() => {
    businessAPI
      .mine()
      .then((res) => {
        setBizForm({
          name: res.data.data.name || "",
          email: res.data.data.email || "",
          phone: res.data.data.phone || "",
          address: res.data.data.address || "",
          website: res.data.data.website || "",
          logo_url: res.data.data.logo_url || "",
        });
      })
      .catch(() => setBiz(null));
  }, []);

  useEffect(() => {
    profileAPI
      .get()
      .then((res) => {
        setProfile(res.data.data);
        setNameForm({
          name: res.data.data.name,
          title: res.data.data.title || "",
          email: res.data.data.email || "",
          current_password: "",
        });
        if (res.data.data.role === "admin") loadBusiness();
      })
      .catch(console.error);
  }, [loadBusiness]);

  const handleNameSave = async (e) => {
    e.preventDefault();
    setSavingName(true);
    try {
      const res = await profileAPI.update(nameForm);
      toast.success("Profile updated");
      setProfile((p) => ({ ...p, ...res.data.data }));
      // Clear the password box on success — it is proof for one change, not
      // something to leave sitting in a form.
      setNameForm((f) => ({ ...f, current_password: "" }));
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to update");
    } finally {
      setSavingName(false);
    }
  };

  const handleBusinessSave = async (e) => {
    e.preventDefault();
    setSavingBiz(true);
    try {
      const res = await businessAPI.updateMine(bizForm);
      // Re-seed the form from what was actually stored, so a value the
      // server trimmed or rejected is visible immediately rather than on
      // the next page load.
      const b = res.data.data;
      setBizForm({
        name: b.name || "",
        email: b.email || "",
        phone: b.phone || "",
        address: b.address || "",
        website: b.website || "",
        logo_url: b.logo_url || "",
      });
      toast.success("Agency details updated");
    } catch (err) {
      toast.error(err.response?.data?.message || "Could not update the agency");
    } finally {
      setSavingBiz(false);
    }
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLogo(true);
    try {
      const fd = new FormData();
      fd.append("logo", file);
      const res = await businessAPI.uploadLogo(fd);
      // Stored, not yet attached — it lands on the agency when you save, so
      // choosing a logo and changing your mind costs nothing.
      setBizForm((f) => ({ ...f, logo_url: res.data.data.logo_url }));
      toast.success("Logo ready — press Save to apply it");
    } catch (err) {
      toast.error(err.response?.data?.message || "Could not upload the logo");
    } finally {
      setUploadingLogo(false);
      e.target.value = "";
    }
  };

  const handlePasswordSave = async (e) => {
    e.preventDefault();
    if (passForm.new_password !== passForm.confirm_password) {
      return toast.error("New passwords do not match");
    }
    setSavingPass(true);
    try {
      await profileAPI.changePassword({
        current_password: passForm.current_password,
        new_password: passForm.new_password,
      });
      toast.success("Password changed successfully");
      setPassForm({
        current_password: "",
        new_password: "",
        confirm_password: "",
      });
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to change password");
    } finally {
      setSavingPass(false);
    }
  };

  if (!profile) return null;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          My Profile
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Manage your account settings
        </p>
      </div>

      {/* Account Info */}
      <Card className="p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="bg-blue-100 dark:bg-blue-900/30 p-2.5 rounded-xl">
            <User className="w-5 h-5 text-blue-600" />
          </div>
          <h2 className="font-semibold text-gray-900 dark:text-white">
            Account Info
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
          {[
            ["Email", profile.email],
            [
              "Role",
              <Badge variant={roleBadge[profile.role]}>
                {profile.role?.replace("_", " ")}
              </Badge>,
            ],
            [
              "Last Login",
              profile.last_login
                ? format(new Date(profile.last_login), "dd MMM yyyy HH:mm")
                : "Never",
            ],
            [
              "Member Since",
              format(new Date(profile.created_at), "dd MMM yyyy"),
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                {label}
              </p>
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                {value}
              </p>
            </div>
          ))}
        </div>

        <form onSubmit={handleNameSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Full name"
              value={nameForm.name}
              onChange={(e) =>
                setNameForm((f) => ({ ...f, name: e.target.value }))
              }
              required
            />
            {/* Your job title, not your access level. This is what a
                customer reads under your signature on an invoice — the role
                badge above is what the system lets you do, and the two are
                deliberately different things. */}
            <Input
              label="Job title"
              value={nameForm.title}
              onChange={(e) =>
                setNameForm((f) => ({ ...f, title: e.target.value }))
              }
              maxLength={120}
              placeholder="Operations Director"
              hint="Printed on invoices you prepare. Leave empty to show your role instead."
            />
            <Input
              label="Email address"
              type="email"
              value={nameForm.email}
              onChange={(e) =>
                setNameForm((f) => ({ ...f, email: e.target.value }))
              }
              required
              hint="This is what you sign in with."
            />
            {/* Only when the address is actually being changed. Asking for a
                password to save a name nobody touched is friction with no
                purpose — and teaches people to type it without reading. */}
            {nameForm.email.trim().toLowerCase() !==
              String(profile.email || "").toLowerCase() && (
              <Input
                label="Current password *"
                type="password"
                value={nameForm.current_password}
                onChange={(e) =>
                  setNameForm((f) => ({
                    ...f,
                    current_password: e.target.value,
                  }))
                }
                required
                hint="Needed to change the address you sign in with."
              />
            )}
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={savingName}>
              Save
            </Button>
          </div>
        </form>
      </Card>

      {/* ── The agency ──
          An admin edits it; everyone else reads it. This is the letterhead
          on every invoice, receipt and statement the agency issues, so an
          agency that changes its phone number should not have to ask the
          platform owner to type it in for them. */}
      {profile.role === "admin" && bizForm ? (
        <Card className="p-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="bg-purple-100 dark:bg-purple-900/30 p-2.5 rounded-xl">
              <Building2 className="w-5 h-5 text-purple-600" />
            </div>
            <h2 className="font-semibold text-gray-900 dark:text-white">
              Agency details
            </h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Printed at the top of every invoice, receipt and statement.
          </p>

          <form onSubmit={handleBusinessSave} className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="w-20 h-20 shrink-0 rounded-xl border border-gray-200 dark:border-gray-700 bg-white flex items-center justify-center overflow-hidden">
                {bizForm.logo_url ? (
                  <img
                    src={fileUrl(bizForm.logo_url)}
                    alt="Agency logo"
                    className="max-w-full max-h-full object-contain"
                  />
                ) : (
                  <Building2 className="w-7 h-7 text-gray-300" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-200 cursor-pointer hover:border-blue-400 hover:text-blue-600 transition-colors">
                  <Upload className="w-4 h-4" />
                  {uploadingLogo ? "Uploading…" : "Choose logo"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    className="hidden"
                    onChange={handleLogoUpload}
                    disabled={uploadingLogo}
                  />
                </label>
                {bizForm.logo_url && (
                  <button
                    type="button"
                    onClick={() =>
                      setBizForm((f) => ({ ...f, logo_url: "" }))
                    }
                    className="ml-2 text-xs text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                )}
                <p className="text-xs text-gray-400 mt-1.5">
                  Shown on printed documents. PNG or JPEG works best.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Agency name *"
                value={bizForm.name}
                onChange={(e) =>
                  setBizForm((f) => ({ ...f, name: e.target.value }))
                }
                required
              />
              <Input
                label="Agency email *"
                type="email"
                value={bizForm.email}
                onChange={(e) =>
                  setBizForm((f) => ({ ...f, email: e.target.value }))
                }
                required
              />
              <Input
                label="Phone"
                value={bizForm.phone}
                onChange={(e) =>
                  setBizForm((f) => ({ ...f, phone: e.target.value }))
                }
                placeholder="+252 XX XXX XXXX"
              />
              <Input
                label="Website"
                value={bizForm.website}
                onChange={(e) =>
                  setBizForm((f) => ({ ...f, website: e.target.value }))
                }
                placeholder="socdaalhub.com"
              />
              <div className="sm:col-span-2">
                <Input
                  label="Address"
                  value={bizForm.address}
                  onChange={(e) =>
                    setBizForm((f) => ({ ...f, address: e.target.value }))
                  }
                  placeholder="Bakaara, Mogadishu"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button type="submit" loading={savingBiz}>
                Save agency details
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        profile.business_name && (
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="bg-purple-100 dark:bg-purple-900/30 p-2.5 rounded-xl">
                <Building2 className="w-5 h-5 text-purple-600" />
              </div>
              <h2 className="font-semibold text-gray-900 dark:text-white">
                Agency
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                ["Agency Name", profile.business_name],
                ["Agency Email", profile.business_email || "—"],
                ["Phone", profile.business_phone || "—"],
              ].map(([label, value]) => (
                <div key={label}>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                    {label}
                  </p>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {value}
                  </p>
                </div>
              ))}
            </div>
          </Card>
        )
      )}

      {/* Change Password */}
      <Card className="p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="bg-green-100 dark:bg-green-900/30 p-2.5 rounded-xl">
            <Lock className="w-5 h-5 text-green-600" />
          </div>
          <h2 className="font-semibold text-gray-900 dark:text-white">
            Change Password
          </h2>
        </div>
        <form onSubmit={handlePasswordSave} className="space-y-4">
          <Input
            label="Current password"
            type="password"
            value={passForm.current_password}
            onChange={(e) =>
              setPassForm((f) => ({ ...f, current_password: e.target.value }))
            }
            placeholder="Enter current password"
            required
          />
          <Input
            label="New password"
            type="password"
            value={passForm.new_password}
            onChange={(e) =>
              setPassForm((f) => ({ ...f, new_password: e.target.value }))
            }
            placeholder="Min 8 characters"
            required
          />
          <Input
            label="Confirm new password"
            type="password"
            value={passForm.confirm_password}
            onChange={(e) =>
              setPassForm((f) => ({ ...f, confirm_password: e.target.value }))
            }
            placeholder="Repeat new password"
            required
          />
          <Button type="submit" loading={savingPass}>
            Change Password
          </Button>
        </form>
      </Card>
    </div>
  );
}
