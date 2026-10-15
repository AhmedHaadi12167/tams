import React, { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { SESSION_MESSAGE_KEY } from "../services/api";
import toast from "react-hot-toast";
import { Info, Eye, EyeOff } from "lucide-react";
import logo from "../assests/logo.png";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    email: "",
    password: "",
  });

  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [showPassword, setShowPassword] = useState(false);

  // Display a message if the previous session has ended.
  useEffect(() => {
    try {
      const msg = sessionStorage.getItem(SESSION_MESSAGE_KEY);

      if (msg) {
        setNotice(msg);
        sessionStorage.removeItem(SESSION_MESSAGE_KEY);
      }
    } catch {
      // Storage may be unavailable.
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
    <div
      className="relative flex min-h-screen items-center justify-center
        overflow-hidden bg-[#f3f5f7] px-4 py-10
        dark:bg-gray-950"
      style={{
        backgroundImage: `
          linear-gradient(to right, rgba(120,130,145,0.07) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(120,130,145,0.07) 1px, transparent 1px)
        `,
        backgroundSize: "68px 68px",
      }}
    >
      {/* Login card */}
      <div className="relative z-10 w-full max-w-md">
        <div
          className="rounded-[22px] border border-gray-200
            bg-white px-6 py-9 shadow-sm
            sm:px-9 sm:py-10
            dark:border-gray-800 dark:bg-gray-900"
        >
          {/* Logo */}
          <div className="mb-5 flex justify-center">
            <div className="flex items-center justify-center">
              <img
                src={logo}
                alt="TAMS Logo"
                className="h-20 w-auto object-contain"
                onError={(e) =>
                  console.error("Logo failed to load:", e.currentTarget.src)
                }
              />
            </div>
          </div>

          {/* Heading */}
          <div className="mb-7 text-center">
            <h1
              className="text-2xl font-semibold tracking-tight
                text-gray-950 dark:text-white"
            >
              Login
            </h1>

            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              Enter your details to login.
            </p>
          </div>

          {/* Session notice */}
          {notice && (
            <div
              className="mb-5 flex items-start gap-2 rounded-xl
                border border-amber-200 bg-amber-50 px-3 py-3
                dark:border-amber-800 dark:bg-amber-900/20"
            >
              <Info size={17} className="mt-0.5 shrink-0 text-amber-600" />

              <p className="text-sm text-amber-800 dark:text-amber-200">
                {notice}
              </p>
            </div>
          )}

          {/* Login form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email */}
            <div>
              <label
                htmlFor="email"
                className="mb-2 block text-sm font-medium
                  text-gray-700 dark:text-gray-300"
              >
                Email
              </label>

              <input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="Enter your Email"
                value={form.email}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    email: e.target.value,
                  }))
                }
                required
                className="h-11 w-full rounded-xl border
                  border-gray-200 bg-white px-3 text-sm
                  text-gray-900 outline-none transition
                  placeholder:text-gray-400
                  focus:border-gray-900 focus:ring-2
                  focus:ring-gray-900/10
                  dark:border-gray-700 dark:bg-gray-950
                  dark:text-white dark:focus:border-gray-400"
              />
            </div>

            {/* Password */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <label
                  htmlFor="password"
                  className="text-sm font-medium
                    text-gray-700 dark:text-gray-300"
                >
                  Password
                </label>

                <Link
                  to="/forgot-password"
                  className="text-xs font-medium text-gray-800
                    transition hover:text-blue-600 hover:underline
                    dark:text-gray-300 dark:hover:text-blue-400"
                >
                  Forgot password?
                </Link>
              </div>

              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={form.password}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      password: e.target.value,
                    }))
                  }
                  required
                  className="h-11 w-full rounded-xl border
                    border-gray-200 bg-white px-3 pr-11
                    text-sm text-gray-900 outline-none
                    transition placeholder:text-gray-400
                    focus:border-gray-900 focus:ring-2
                    focus:ring-gray-900/10
                    dark:border-gray-700 dark:bg-gray-950
                    dark:text-white dark:focus:border-gray-400"
                />

                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex
                    items-center px-3 text-gray-500
                    hover:text-gray-900
                    dark:hover:text-white"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="flex h-12 w-full items-center
                justify-center rounded-xl bg-blue-600 px-4
                text-sm font-medium text-white shadow-sm
                transition hover:bg-blue-700
                focus:outline-none focus:ring-2
                focus:ring-blue-500 focus:ring-offset-2
                active:scale-[0.99]
                disabled:cursor-not-allowed
                disabled:opacity-60"
            >
              {loading ? "Logging in..." : "Log In"}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p
          className="mt-5 text-center text-xs
            text-gray-500 dark:text-gray-400"
        >
          TAMS · Travel Agency Management System
        </p>
      </div>
    </div>
  );
}
