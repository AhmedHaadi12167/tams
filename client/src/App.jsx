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
import AgentsPage from "./pages/AgentsPage";
import VisaPage from "./pages/VisaPage";
import PackagesPage from "./pages/PackagesPage";
import UsersPage from "./pages/UsersPage";
import BusinessesPage from "./pages/BusinessesPage";
import ProfilePage from "./pages/ProfilePage";

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
          <ProtectedRoute roles={["super_admin", "admin", "accountant"]}>
            <ReportsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/airlines"
        element={
          <ProtectedRoute roles={["super_admin", "admin", "agent", "accountant"]}>
            <AirlinesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/financials"
        element={
          <ProtectedRoute roles={["super_admin", "admin", "accountant"]}>
            <FinancialsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/agents"
        element={
          <ProtectedRoute roles={["super_admin", "admin", "accountant"]}>
            <AgentsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/visas"
        element={
          <ProtectedRoute roles={["super_admin", "admin", "agent", "accountant"]}>
            <VisaPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/packages"
        element={
          <ProtectedRoute roles={["super_admin", "admin", "agent", "accountant"]}>
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
