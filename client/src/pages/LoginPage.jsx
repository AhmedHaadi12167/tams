import React, { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Button, Input, Card } from "../components/ui";
import { SESSION_MESSAGE_KEY } from "../services/api";
import toast from "react-hot-toast";
import { Plane, Info } from "lucide-react";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);

  // If we were sent here by an ended session, say why. Being told "you
  // signed in on another device" is the difference between a system that
  // seems broken and one that seems careful.
  useEffect(() => {
    try {
      const msg = sessionStorage.getItem(SESSION_MESSAGE_KEY);
      if (msg) {
        setNotice(msg);
        sessionStorage.removeItem(SESSION_MESSAGE_KEY);
      }
    } catch {
      /* storage unavailable — no notice to show */
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setNotice(null);
    try {
      await login(form.email, form.password);
      toast.success("Welcome back!");
      navigate("/dashboard");
    } catch (err) {
      toast.error(err.response?.data?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl shadow-lg mb-4">
            <Plane className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            TAMS
          </h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            Travel Agency Management System
          </p>
        </div>

        <Card className="p-8">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-6">
            Sign in to your account
          </h2>
          {notice && (
            <div className="flex gap-2 items-start mb-5 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2.5">
              <Info className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-800 dark:text-amber-200">
                {notice}
              </p>
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email address"
              type="email"
              placeholder="you@agency.com"
              value={form.email}
              onChange={(e) =>
                setForm((f) => ({ ...f, email: e.target.value }))
              }
              required
            />
            <Input
              label="Password"
              type="password"
              placeholder="••••••••"
              value={form.password}
              onChange={(e) =>
                setForm((f) => ({ ...f, password: e.target.value }))
              }
              required
            />
            <Button
              type="submit"
              loading={loading}
              className="w-full"
              size="lg"
            >
              Sign in
            </Button>
          </form>
          <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-4">
            <Link
              to="/forgot-password"
              className="text-blue-600 hover:underline"
            >
              Forgot password?
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
