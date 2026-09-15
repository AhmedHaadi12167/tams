import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { Layout } from "./components/layout/Layout";
import { Spinner } from "./components/ui";

import LoginPage from "./pages/LoginPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import DashboardPage from "./pages/DashboardPage";
import TicketsPage from "./pages/TicketsPage";
import GroupBookingsPage from "./pages/GroupBookingsPage";
import CargoPage from "./pages/CargoPage";
import CustomersPage from "./pages/CustomersPage";
import ReportsPage from "./pages/ReportsPage";
import AirlinesPage from "./pages/AirlinesPage";
import FinancialsPage from "./pages/FinancialsPage";
import AccountsPage from "./pages/AccountsPage";
import AgentsPage from "./pages/AgentsPage";
import VisaPage from "./pages/VisaPage";
import PackagesPage from "./pages/PackagesPage";
import UsersPage from "./pages/UsersPage";
import BusinessesPage from "./pages/BusinessesPage";
import ProfilePage from "./pages/ProfilePage";
import TrackPage from "./pages/TrackPage";
import LandingPage from "./pages/LandingPage";

const ProtectedRoute = ({ children, roles }) => {
  const { user, loading, hasRole } = useAuth();
  if (loading)
    return (
      <div className="flex items-center justify-center h-screen">
        <Spinner size="lg" />
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !hasRole(...roles)) return <Navigate to="/dashboard" replace />;
  return <Layout>{children}</Layout>;
};

const PublicRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="flex items-center justify-center h-screen">
        <Spinner size="lg" />
      </div>
    );
  if (user) return <Navigate to="/dashboard" replace />;
  return children;
};

function AppRoutes() {
  return (
    <Routes>
      {/* Public — no login, and deliberately not wrapped in PublicRoute,
          which would bounce a signed-in member of staff to the dashboard
          when they only wanted to check a parcel. */}
      {/* The public face of the domain. Not wrapped in PublicRoute either:
          bouncing a signed-in member of staff away from the company's own
          home page would be absurd, and it is the page Google reads. */}
      <Route path="/" element={<LandingPage />} />

      <Route path="/track" element={<TrackPage />} />
      <Route path="/track/:code" element={<TrackPage />} />

      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <PublicRoute>
            <ForgotPasswordPage />
          </PublicRoute>
        }
      />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/tickets"
        element={
          <ProtectedRoute roles={["admin", "agent", "accountant"]}>
            <TicketsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/group-bookings"
        element={
          <ProtectedRoute roles={["admin", "agent"]}>
            <GroupBookingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/cargo"
        element={
          <ProtectedRoute roles={["admin", "agent", "accountant"]}>
            <CargoPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/customers"
        element={
          <ProtectedRoute roles={["admin", "agent", "accountant"]}>
            <CustomersPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/reports"
        element={
          <ProtectedRoute roles={["admin", "accountant"]}>
            <ReportsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/airlines"
        element={
          <ProtectedRoute roles={["admin", "agent", "accountant"]}>
            <AirlinesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/financials"
        element={
          <ProtectedRoute roles={["admin", "accountant"]}>
            <FinancialsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/accounts"
        element={
          <ProtectedRoute roles={["admin", "accountant"]}>
            <AccountsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/agents"
        element={
          <ProtectedRoute roles={["admin", "accountant"]}>
            <AgentsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/visas"
        element={
          <ProtectedRoute roles={["admin", "agent", "accountant"]}>
            <VisaPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/packages"
        element={
          <ProtectedRoute roles={["admin", "agent", "accountant"]}>
            <PackagesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/users"
        element={
          <ProtectedRoute roles={["admin"]}>
            <UsersPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/businesses"
        element={
          <ProtectedRoute roles={["super_admin"]}>
            <BusinessesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/profile"
        element={
          <ProtectedRoute>
            <ProfilePage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
          <Toaster
            position="top-right"
            toastOptions={{
              duration: 4000,
              style: {
                borderRadius: "10px",
                background: "var(--toast-bg, #fff)",
                color: "var(--toast-color, #111)",
                boxShadow: "0 4px 20px rgba(0,0,0,0.1)",
              },
            }}
          />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
