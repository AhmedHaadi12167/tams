import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { profileAPI } from "../services/api";
import { Button, Input, Card } from "../components/ui";
import toast from "react-hot-toast";
import { Plane, Mail, Shield, Lock } from "lucide-react";

// Step 1 → enter email
// Step 2 → enter OTP
// Step 3 → enter new password

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [passwords, setPasswords] = useState({
    new_password: "",
    confirm_password: "",
  });
  const [loading, setLoading] = useState(false);

  // Step 1 — send OTP
  const handleSendOTP = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await profileAPI.forgotPassword({ email });
      toast.success("OTP sent to your email!");
      setStep(2);
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to send OTP");
    } finally {
      setLoading(false);
    }
  };

  // Step 2 — verify OTP
  const handleVerifyOTP = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await profileAPI.verifyOTP({ email, otp });
      toast.success("OTP verified!");
      setStep(3);
    } catch (err) {
      toast.error(err.response?.data?.message || "Invalid OTP");
    } finally {
      setLoading(false);
    }
  };

  // Step 3 — reset password
  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (passwords.new_password !== passwords.confirm_password) {
      return toast.error("Passwords do not match");
    }
    setLoading(true);
    try {
      await profileAPI.resetPassword({
        email,
        otp,
        new_password: passwords.new_password,
      });
      toast.success("Password reset successfully! Please log in.");
      navigate("/login");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to reset password");
    } finally {
      setLoading(false);
    }
  };

  const steps = [
    { label: "Email", icon: Mail },
    { label: "OTP", icon: Shield },
    { label: "New Password", icon: Lock },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl shadow-lg mb-4">
            <Plane className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Reset Password
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Follow the steps to reset your password
          </p>
        </div>

        {/* Step indicators */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {steps.map((s, i) => {
            const Icon = s.icon;
            const active = step === i + 1;
            const done = step > i + 1;
            return (
              <React.Fragment key={i}>
                <div
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all
                  ${
                    done
                      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                      : active
                        ? "bg-blue-600 text-white"
                        : "bg-gray-100 text-gray-400 dark:bg-gray-700"
                  }`}
                >
                  <Icon className="w-3 h-3" />
                  {s.label}
                </div>
                {i < steps.length - 1 && (
                  <div
                    className={`w-6 h-0.5 rounded ${step > i + 1 ? "bg-green-400" : "bg-gray-200 dark:bg-gray-700"}`}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>

        <Card className="p-8">
          {/* Step 1 — Email */}
          {step === 1 && (
            <>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                Enter your email
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                We'll send a 6-digit OTP to your email address.
              </p>
              <form onSubmit={handleSendOTP} className="space-y-4">
                <Input
                  label="Email address"
                  type="email"
                  placeholder="you@agency.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
                <Button
                  type="submit"
                  loading={loading}
                  className="w-full"
                  size="lg"
                >
                  Send OTP
                </Button>
              </form>
            </>
          )}

          {/* Step 2 — OTP */}
          {step === 2 && (
            <>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                Enter OTP
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                A 6-digit code was sent to <strong>{email}</strong>. It expires
                in 10 minutes.
              </p>
              <form onSubmit={handleVerifyOTP} className="space-y-4">
                <Input
                  label="OTP Code"
                  type="text"
                  placeholder="000000"
                  value={otp}
                  onChange={(e) =>
                    setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  maxLength={6}
                  className="text-center text-2xl tracking-widest font-mono"
                  required
                />
                <Button
                  type="submit"
                  loading={loading}
                  className="w-full"
                  size="lg"
                >
                  Verify OTP
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    setStep(1);
                    setOtp("");
                  }}
                  className="w-full text-sm text-gray-500 hover:text-blue-600 text-center"
                >
                  ← Use a different email
                </button>
              </form>
            </>
          )}

          {/* Step 3 — New Password */}
          {step === 3 && (
            <>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                Set new password
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                Choose a strong password of at least 8 characters.
              </p>
              <form onSubmit={handleResetPassword} className="space-y-4">
                <Input
                  label="New password"
                  type="password"
                  placeholder="Min 8 characters"
                  value={passwords.new_password}
                  onChange={(e) =>
                    setPasswords((p) => ({
                      ...p,
                      new_password: e.target.value,
                    }))
                  }
                  required
                />
                <Input
                  label="Confirm new password"
                  type="password"
                  placeholder="Repeat password"
                  value={passwords.confirm_password}
                  onChange={(e) =>
                    setPasswords((p) => ({
                      ...p,
                      confirm_password: e.target.value,
                    }))
                  }
                  required
                />
                <Button
                  type="submit"
                  loading={loading}
                  className="w-full"
                  size="lg"
                >
                  Reset Password
                </Button>
              </form>
            </>
          )}

          <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-4">
            Remember your password?{" "}
            <Link
              to="/login"
              className="text-blue-600 hover:underline font-medium"
            >
              Sign in
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
