import React, { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import {
  LayoutDashboard,
  Ticket,
  Users,
  BarChart3,
  Settings,
  LogOut,
  Sun,
  Moon,
  Menu,
  Plane,
  ChevronRight,
  Package,
  Building2,
  Users2,
  Wallet,
  Stamp,
  Luggage,
  UserRound,
} from "lucide-react";

// The super admin runs the platform; they do not run an agency. Tickets,
// visas, packages, airlines, agents, reports and financials all belong to
// one particular business, and a super admin has no business_id — so those
// screens had nothing meaningful to show them anyway. Restricting the menu
// to Dashboard and Businesses matches what the role actually does.
const NAV_ITEMS = [
  {
    path: "/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    roles: ["super_admin", "admin", "agent", "accountant"],
  },
  {
    path: "/businesses",
    label: "Businesses",
    icon: Building2,
    roles: ["super_admin"],
  },
  {
    path: "/tickets",
    label: "Tickets",
    icon: Ticket,
    roles: ["admin", "agent", "accountant"],
  },
  {
    path: "/group-bookings",
    label: "Group Bookings",
    icon: Users2,
    roles: ["admin", "agent"],
  },
  { path: "/cargo", label: "Cargo", icon: Package, roles: ["admin", "agent"] },
  {
    path: "/customers",
    label: "Customers",
    icon: Users,
    roles: ["admin", "agent"],
  },
  {
    path: "/visas",
    label: "Visas",
    icon: Stamp,
    roles: ["admin", "agent", "accountant"],
  },
  {
    path: "/packages",
    label: "Packages",
    icon: Luggage,
    roles: ["admin", "agent", "accountant"],
  },
  {
    path: "/airlines",
    label: "Airlines",
    icon: Plane,
    roles: ["admin", "agent", "accountant"],
  },
  {
    path: "/agents",
    label: "Agents",
    icon: UserRound,
    roles: ["admin", "accountant"],
  },
  {
    path: "/reports",
    label: "Reports",
    icon: BarChart3,
    roles: ["admin", "accountant"],
  },
  {
    path: "/financials",
    label: "Financials",
    icon: Wallet,
    roles: ["admin", "accountant"],
  },
  { path: "/users", label: "Team", icon: Settings, roles: ["admin"] },
];

const NavItem = ({ item, collapsed, onClick }) => {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.path}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all group relative
        ${
          isActive
            ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
            : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 hover:text-gray-900 dark:hover:text-white"
        }`
      }
    >
      <Icon className="w-5 h-5 flex-shrink-0" />
      {!collapsed && <span>{item.label}</span>}
      {collapsed && (
        <div className="absolute left-full ml-3 px-2 py-1 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 shadow-lg">
          {item.label}
        </div>
      )}
    </NavLink>
  );
};

export const Layout = ({ children }) => {
  const { user, logout, hasRole } = useAuth();
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const visibleItems = NAV_ITEMS.filter((item) => hasRole(...item.roles));

  // Await the server call so the session is actually retired before we
  // navigate away — otherwise the request can be cancelled mid-flight and
  // the old token would survive.
  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  const SidebarContent = ({ onNavClick }) => (
    <div className="flex flex-col h-full">
      <div
        className={`flex items-center gap-3 px-4 py-5 border-b border-gray-200 dark:border-gray-700 ${collapsed ? "justify-center" : ""}`}
      >
        <div className="bg-blue-600 p-2 rounded-xl flex-shrink-0">
          <Plane className="w-5 h-5 text-white" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="font-bold text-gray-900 dark:text-white text-sm leading-none">
              TAMS
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
              {user?.business_name || "Platform"}
            </p>
          </div>
        )}
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {visibleItems.map((item) => (
          <NavItem
            key={item.path}
            item={item}
            collapsed={collapsed}
            onClick={onNavClick}
          />
        ))}
      </nav>

      <div className="p-3 border-t border-gray-200 dark:border-gray-700 space-y-2">
        <button
          onClick={toggle}
          className="flex items-center gap-3 w-full px-3 py-2 rounded-xl text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50"
        >
          {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          {!collapsed && <span>{dark ? "Light mode" : "Dark mode"}</span>}
        </button>
        {!collapsed && (
          <div
            className="px-3 py-2 rounded-xl bg-gray-50 dark:bg-gray-700/50 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={() => navigate("/profile")}
          >
            <p className="text-xs font-medium text-gray-900 dark:text-white truncate">
              {user?.name}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 capitalize">
              {user?.role?.replace("_", " ")} ·{" "}
              <span className="text-blue-500">Edit profile</span>
            </p>
          </div>
        )}
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2 rounded-xl text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
        >
          <LogOut className="w-4 h-4" />
          {!collapsed && <span>Sign out</span>}
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-[#f6f8fc] dark:bg-gray-900 overflow-hidden">
      <aside
        className={`hidden lg:flex flex-col flex-shrink-0 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 transition-all duration-200 relative ${collapsed ? "w-16" : "w-60"}`}
      >
        <SidebarContent />
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="absolute -right-3 top-1/2 -translate-y-1/2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full p-1 text-gray-400 hover:text-gray-600 shadow-sm z-10"
        >
          <ChevronRight
            className={`w-3 h-3 transition-transform ${collapsed ? "" : "rotate-180"}`}
          />
        </button>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute left-0 top-0 bottom-0 w-64 bg-white dark:bg-gray-800 shadow-2xl z-50">
            <SidebarContent onNavClick={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => setMobileOpen(true)}
            className="text-gray-600 dark:text-gray-400"
          >
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-2">
            <div className="bg-blue-600 p-1.5 rounded-lg">
              <Plane className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-gray-900 dark:text-white text-sm">
              TAMS
            </span>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
};
