const express = require("express");
const router = express.Router();
const {
  authenticate,
  authorize,
  scopeBusiness,
} = require("../middlewares/auth");
const upload = require("../middlewares/upload");

const authController = require("../controllers/authController");
const ticketController = require("../controllers/ticketController");
const customerController = require("../controllers/customerController");
const reportController = require("../controllers/reportController");
const userController = require("../controllers/userController");
const cargoController = require("../controllers/cargoController");
const businessController = require("../controllers/businessController");
const profileController = require("../controllers/profileController");
const expenseController = require("../controllers/expenseController");
const financialsController = require("../controllers/financialsController");
const airlineController = require("../controllers/airlineController");

const {
  groupBookingValidation,
  createGroupBooking,
  getGroupBookings,
  getGroupBooking,
  exportGroupBookingPDF,
  updateGroupBooking,
  deleteGroupBooking,
} = require("../controllers/groupTicketsController");

// ── Public Auth ───────────────────────────────────────────
router.post(
  "/auth/login",
  authController.loginValidation,
  authController.login,
);
router.post("/auth/forgot-password", profileController.forgotPassword);
router.post("/auth/verify-otp", profileController.verifyOTP);
router.post("/auth/reset-password", profileController.resetPassword);

// ── All routes below require authentication ───────────────
router.use(authenticate, scopeBusiness);

// ── Group Bookings ────────────────────────────────────────
router.get(
  "/group-bookings",
  authorize("admin", "agent", "accountant"),
  getGroupBookings,
);
router.post(
  "/group-bookings",
  authorize("admin", "agent"),
  groupBookingValidation,
  createGroupBooking,
);
router.get(
  "/group-bookings/:id",
  authorize("admin", "agent", "accountant"),
  getGroupBooking,
);
router.get(
  "/group-bookings/:id/pdf",
  authorize("admin", "agent", "accountant"),
  exportGroupBookingPDF,
);
router.put("/group-bookings/:id", authorize("admin"), updateGroupBooking);
router.delete("/group-bookings/:id", authorize("admin"), deleteGroupBooking);

// ── Profile (any logged in user) ──────────────────────────
router.get("/profile", profileController.getProfile);
router.put("/profile", profileController.updateProfile);
router.put("/profile/change-password", profileController.changePassword);
router.get("/auth/me", authController.getMe);

// ── Business Management (super_admin only) ────────────────
router.post(
  "/auth/create-business",
  authorize("super_admin"),
  authController.businessValidation,
  authController.createBusiness,
);
router.get(
  "/businesses/overview",
  authorize("super_admin"),
  businessController.getPlatformOverview,
);
router.get(
  "/businesses",
  authorize("super_admin"),
  businessController.getBusinesses,
);
router.get(
  "/businesses/:id",
  authorize("super_admin"),
  businessController.getBusiness,
);
router.put(
  "/businesses/:id",
  authorize("super_admin"),
  businessController.updateBusiness,
);

// ── Users ─────────────────────────────────────────────────
router.get(
  "/users",
  authorize("admin", "super_admin"),
  userController.getUsers,
);
router.post(
  "/users",
  authorize("admin", "super_admin"),
  userController.userValidation,
  userController.createUser,
);
router.put(
  "/users/:id",
  authorize("admin", "super_admin"),
  userController.userValidation,
  userController.updateUser,
);
router.delete(
  "/users/:id",
  authorize("admin", "super_admin"),
  userController.deleteUser,
);

// ── Tickets ───────────────────────────────────────────────
router.post(
  "/tickets/extract",
  authorize("admin", "agent"),
  upload.single("ticket_file"),
  ticketController.extractFromFile,
);
router.get(
  "/tickets",
  authorize("admin", "agent", "accountant"),
  ticketController.getTickets,
);
router.post(
  "/tickets",
  authorize("admin", "agent"),
  ticketController.ticketValidation,
  ticketController.createTicket,
);
router.get(
  "/tickets/:id",
  authorize("admin", "agent", "accountant"),
  ticketController.getTicket,
);
router.put(
  "/tickets/:id",
  authorize("admin", "agent"),
  ticketController.ticketValidation,
  ticketController.updateTicket,
);
router.delete(
  "/tickets/:id",
  authorize("admin", "agent"),
  ticketController.deleteTicket,
);

// ── Ticket Payments (ALL users can collect money) ─────────
router.post(
  "/tickets/:id/payments",
  authorize("admin", "agent", "accountant", "super_admin"),
  ticketController.addPayment,
);
router.get(
  "/tickets/:id/payments",
  authorize("admin", "agent", "accountant", "super_admin"),
  ticketController.getPayments,
);

// ── Cargo ─────────────────────────────────────────────────
// Photo upload registered before /cargo/:id so the literal path wins
router.post(
  "/cargo/photo",
  authorize("admin", "agent"),
  upload.single("photo"),
  cargoController.uploadCargoPhoto,
);
router.delete(
  "/cargo/:id/photo",
  authorize("admin", "agent"),
  cargoController.deleteCargoPhoto,
);
router.get(
  "/cargo",
  authorize("admin", "agent", "accountant"),
  cargoController.getCargo,
);
router.post(
  "/cargo",
  authorize("admin", "agent"),
  cargoController.cargoValidation,
  cargoController.createCargo,
);
router.get(
  "/cargo/:id",
  authorize("admin", "agent", "accountant"),
  cargoController.getCargoById,
);
router.put(
  "/cargo/:id",
  authorize("admin", "agent"),
  cargoController.updateCargo,
);
router.delete(
  "/cargo/:id",
  authorize("admin", "agent"),
  cargoController.deleteCargo,
);

// ── Customers ─────────────────────────────────────────────
router.get(
  "/customers",
  authorize("admin", "agent", "accountant"),
  customerController.getCustomers,
);
router.get(
  "/customers/:id",
  authorize("admin", "agent", "accountant"),
  customerController.getCustomer,
);
router.get(
  "/customers/:id/statement",
  authorize("admin", "agent", "accountant"),
  customerController.getCustomerStatement,
);
router.get(
  "/customers/:id/statement/pdf",
  authorize("admin", "agent", "accountant"),
  customerController.exportCustomerStatementPDF,
);
router.put(
  "/customers/:id",
  authorize("admin", "agent"),
  customerController.customerValidation,
  customerController.updateCustomer,
);
router.delete(
  "/customers/:id",
  authorize("admin"),
  customerController.deleteCustomer,
);

// ── Airline master list (autocomplete + merge) ────────────
// Registered before /airlines/:name so the literal path wins.
router.get(
  "/airlines-list",
  authorize("super_admin", "admin", "agent", "accountant"),
  airlineController.listAirlines,
);
router.get(
  "/airlines-list/duplicates",
  authorize("super_admin", "admin"),
  airlineController.findDuplicates,
);
router.get(
  "/airlines-list/lookup",
  authorize("super_admin", "admin", "agent", "accountant"),
  airlineController.lookupAirline,
);
router.get(
  "/airlines-list/:id/aliases",
  authorize("super_admin", "admin", "agent", "accountant"),
  airlineController.getAliases,
);
router.post(
  "/airlines-list/:id/aliases",
  authorize("super_admin", "admin"),
  airlineController.addAlias,
);
router.delete(
  "/airlines-list/aliases/:aliasId",
  authorize("super_admin", "admin"),
  airlineController.deleteAlias,
);
router.put(
  "/airlines-list/:id",
  authorize("super_admin", "admin"),
  airlineController.updateAirline,
);
router.post(
  "/airlines-list/merge",
  authorize("super_admin", "admin"),
  airlineController.mergeAirlines,
);
router.delete(
  "/airlines-list/:id",
  authorize("super_admin", "admin"),
  airlineController.deleteAirline,
);

// ── Airlines (airline performance + passenger manifests) ──
router.get(
  "/airlines",
  authorize("super_admin", "admin", "agent", "accountant"),
  airlineController.getAirlines,
);
router.get(
  "/airlines/:name/passengers",
  authorize("super_admin", "admin", "agent", "accountant"),
  airlineController.getAirlinePassengers,
);
router.get(
  "/airlines/:name/pdf",
  authorize("super_admin", "admin", "agent", "accountant"),
  airlineController.exportAirlinePDF,
);

// ── Expenses ──────────────────────────────────────────────
router.get(
  "/expenses/categories",
  authorize("super_admin", "admin", "accountant"),
  expenseController.getCategories,
);
router.get(
  "/expenses",
  authorize("super_admin", "admin", "accountant"),
  expenseController.getExpenses,
);
router.post(
  "/expenses",
  authorize("admin", "accountant"),
  expenseController.expenseValidation,
  expenseController.createExpense,
);
router.get(
  "/expenses/:id",
  authorize("super_admin", "admin", "accountant"),
  expenseController.getExpense,
);
router.put(
  "/expenses/:id",
  authorize("admin", "accountant"),
  expenseController.expenseValidation,
  expenseController.updateExpense,
);
router.delete(
  "/expenses/:id",
  authorize("admin"),
  expenseController.deleteExpense,
);

// ── Financials (P&L, balance sheet, cash flow, receivables) ─
router.get(
  "/financials/profit-loss",
  authorize("super_admin", "admin", "accountant"),
  financialsController.getProfitLoss,
);
router.get(
  "/financials/balance-sheet",
  authorize("super_admin", "admin", "accountant"),
  financialsController.getBalanceSheet,
);
router.get(
  "/financials/cash-flow",
  authorize("super_admin", "admin", "accountant"),
  financialsController.getCashFlow,
);
router.get(
  "/financials/receivables",
  authorize("super_admin", "admin", "accountant"),
  financialsController.getReceivables,
);
router.put(
  "/financials/opening-balances",
  authorize("super_admin", "admin"),
  financialsController.updateOpeningBalances,
);

// ── Reports ───────────────────────────────────────────────
router.get(
  "/reports/dashboard",
  authorize("super_admin", "admin", "accountant", "agent"),
  reportController.getDashboard,
);
router.get(
  "/reports/tickets",
  authorize("super_admin", "admin", "accountant"),
  reportController.getReportTickets,
);
router.get(
  "/reports/summary",
  authorize("super_admin", "admin", "accountant"),
  reportController.getReportSummary,
);
router.get(
  "/reports/export/pdf",
  authorize("super_admin", "admin", "accountant"),
  reportController.exportPDF,
);
router.get(
  "/reports/export/excel",
  authorize("super_admin", "admin", "accountant"),
  reportController.exportExcel,
);

module.exports = router;
