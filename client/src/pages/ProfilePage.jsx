import React, { useState, useEffect } from "react";
import { profileAPI } from "../services/api";
import { Button, Input, Card, Badge } from "../components/ui";
import toast from "react-hot-toast";
import { User, Lock, Building2, Shield } from "lucide-react";
import { format } from "date-fns";

const roleBadge = {
  super_admin: "danger",
  admin: "warning",
  agent: "info",
  accountant: "purple",
};

export default function ProfilePage() {
  const [profile, setProfile] = useState(null);
  const [nameForm, setNameForm] = useState({ name: "" });
  const [passForm, setPassForm] = useState({
    current_password: "",
    new_password: "",
    confirm_password: "",
  });
  const [savingName, setSavingName] = useState(false);
  const [savingPass, setSavingPass] = useState(false);

  useEffect(() => {
    profileAPI
      .get()
      .then((res) => {
        setProfile(res.data.data);
        setNameForm({ name: res.data.data.name });
      })
      .catch(console.error);
  }, []);

  const handleNameSave = async (e) => {
    e.preventDefault();
    setSavingName(true);
    try {
      await profileAPI.update(nameForm);
      toast.success("Name updated successfully");
      setProfile((p) => ({ ...p, name: nameForm.name }));
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to update");
    } finally {
      setSavingName(false);
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

        <div className="grid grid-cols-2 gap-4 mb-5">
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

        <form onSubmit={handleNameSave} className="flex gap-3 items-end">
          <div className="flex-1">
            <Input
              label="Full name"
              value={nameForm.name}
              onChange={(e) => setNameForm({ name: e.target.value })}
              required
            />
          </div>
          <Button type="submit" loading={savingName}>
            Save
          </Button>
        </form>
      </Card>

      {/* Business Info */}
      {profile.business_name && (
        <Card className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="bg-purple-100 dark:bg-purple-900/30 p-2.5 rounded-xl">
              <Building2 className="w-5 h-5 text-purple-600" />
            </div>
            <h2 className="font-semibold text-gray-900 dark:text-white">
              Agency
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-4">
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
