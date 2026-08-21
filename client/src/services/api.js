import axios from "axios";

const api = axios.create({ baseURL: "/api", timeout: 30000 });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("tams_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * Endpoints where a 401 is an *answer*, not an expired session.
 *
 * A wrong password legitimately returns 401. Treating that as "your session
 * ended" used to wipe the token and hard-navigate to /login, which threw
 * away the error message before the user could read it — so a locked-out
 * account looked like a page that simply refreshed itself.
 */
const AUTH_ENDPOINTS = [
  "/auth/login",
  "/auth/forgot-password",
  "/auth/verify-otp",
  "/auth/reset-password",
];

/**
 * Why the session ended, handed to the login page so it can say something
 * more useful than "please sign in". sessionStorage rather than a query
 * string: it survives the navigation but never ends up in a shared link.
 */
export const SESSION_MESSAGE_KEY = "tams_session_message";

const SESSION_MESSAGES = {
  SESSION_REPLACED:
    "You were signed out because this account signed in on another device.",
  SESSION_ENDED: "You have been signed out. Please sign in again.",
  TOKEN_EXPIRED: "Your session expired. Please sign in again.",
};

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const url = err.config?.url || "";
    const isAuthCall = AUTH_ENDPOINTS.some((p) => url.startsWith(p));

    if (err.response?.status === 401 && !isAuthCall) {
      const code = err.response?.data?.code;
      const message =
        SESSION_MESSAGES[code] || err.response?.data?.message || null;

      if (message) {
        try {
          sessionStorage.setItem(SESSION_MESSAGE_KEY, message);
        } catch {
          /* private browsing can refuse storage; the redirect still works */
        }
      }

      localStorage.removeItem("tams_token");
      // Don't stack redirects if several requests fail at once.
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  },
);

export const authAPI = {
  createBusiness: (data) => api.post("/auth/create-business", data),
  login: (data) => api.post("/auth/login", data),
  logout: () => api.post("/auth/logout"),
  me: () => api.get("/auth/me"),
};

export const ticketsAPI = {
  extract: (formData) =>
    api.post("/tickets/extract", formData, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 60000,
    }),
  list: (params) => api.get("/tickets", { params }),
  manifest: (params) => api.get("/tickets/manifest", { params }),
  get: (id) => api.get(`/tickets/${id}`),
  create: (data) => api.post("/tickets", data),
  update: (id, data) => api.put(`/tickets/${id}`, data),
  delete: (id) => api.delete(`/tickets/${id}`),
  addPayment: (id, data) => api.post(`/tickets/${id}/payments`, data),
  payments: (id) => api.get(`/tickets/${id}/payments`),
};

export const cargoAPI = {
  list: (params) => api.get("/cargo", { params }),
  get: (id) => api.get(`/cargo/${id}`),
  create: (data) => api.post("/cargo", data),
  update: (id, data) => api.put(`/cargo/${id}`, data),
  delete: (id) => api.delete(`/cargo/${id}`),
  uploadPhoto: (formData) =>
    api.post("/cargo/photo", formData, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 60000,
    }),
  deletePhoto: (id) => api.delete(`/cargo/${id}/photo`),
};

// Uploaded files are served from the API host, not the SPA route
export const fileUrl = (p) => (p ? `/uploads/${p}` : null);

// An empty array means "none of this kind", so it must still be sent —
// only an absent key means "everything".
const selectionParams = (sel) => {
  if (!sel) return undefined;
  return {
    ticket_ids: (sel.ticket_ids || []).join(","),
    visa_ids: (sel.visa_ids || []).join(","),
    package_ids: (sel.package_ids || []).join(","),
  };
};

export const customersAPI = {
  list: (params) => api.get("/customers", { params }),
  get: (id) => api.get(`/customers/${id}`),
  create: (data) => api.post("/customers", data), // ← add this
  update: (id, data) => api.put(`/customers/${id}`, data),
  delete: (id) => api.delete(`/customers/${id}`),
  // sel: optional { ticket_ids, visa_ids, package_ids } to invoice a subset.
  // Omit it entirely for the full statement.
  statement: (id, sel) =>
    api.get(`/customers/${id}/statement`, { params: selectionParams(sel) }),
  statementPDF: (id, sel) =>
    api.get(`/customers/${id}/statement/pdf`, {
      params: selectionParams(sel),
      responseType: "blob",
    }),
};

export const groupBookingsAPI = {
  list: (params) => api.get("/group-bookings", { params }),
  get: (id) => api.get(`/group-bookings/${id}`),
  create: (data) => api.post("/group-bookings", data),
  update: (id, data) => api.put(`/group-bookings/${id}`, data),
  delete: (id) => api.delete(`/group-bookings/${id}`),
  exportPDF: (id) =>
    api.get(`/group-bookings/${id}/pdf`, { responseType: "blob" }),
};

// Helper: download a blob response as a file
export const downloadBlob = (blob, filename) => {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
};

export const reportsAPI = {
  dashboard: (params) => api.get("/reports/dashboard", { params }),
  tickets: (params) => api.get("/reports/tickets", { params }),
  summary: (params) => api.get("/reports/summary", { params }),
  exportPDF: (params) =>
    api.get("/reports/export/pdf", { params, responseType: "blob" }),
  exportExcel: (params) =>
    api.get("/reports/export/excel", { params, responseType: "blob" }),
};

export const airlinesAPI = {
  list: (params) => api.get("/airlines", { params }),
  passengers: (name, params) =>
    api.get(`/airlines/${encodeURIComponent(name)}/passengers`, { params }),
  exportPDF: (name, params) =>
    api.get(`/airlines/${encodeURIComponent(name)}/pdf`, {
      params,
      responseType: "blob",
    }),
  // master list
  master: () => api.get("/airlines-list"),
  duplicates: () => api.get("/airlines-list/duplicates"),
  lookup: (name) => api.get("/airlines-list/lookup", { params: { name } }),
  rename: (id, data) => api.put(`/airlines-list/${id}`, data),
  merge: (data) => api.post("/airlines-list/merge", data),
  remove: (id) => api.delete(`/airlines-list/${id}`),
  aliases: (id) => api.get(`/airlines-list/${id}/aliases`),
  addAlias: (id, alias) => api.post(`/airlines-list/${id}/aliases`, { alias }),
  deleteAlias: (aliasId) => api.delete(`/airlines-list/aliases/${aliasId}`),
  // payables — money owed to carriers
  payables: (params) => api.get("/airlines/payables", { params }),
  pay: (id, data) => api.post(`/airlines/${id}/payments`, data),
  payTickets: (data) => api.post("/airlines/tickets/pay", data),
  payments: (id) => api.get(`/airlines/${id}/payments`),
  deletePayment: (paymentId) =>
    api.delete(`/airlines/payments/${paymentId}`),
};

export const agentsAPI = {
  list: (params) => api.get("/agents", { params }),
  simple: () => api.get("/agents/simple"),
  get: (id) => api.get(`/agents/${id}`),
  create: (data) => api.post("/agents", data),
  update: (id, data) => api.put(`/agents/${id}`, data),
  delete: (id) => api.delete(`/agents/${id}`),
  pay: (id, data) => api.post(`/agents/${id}/payments`, data),
  deletePayment: (paymentId) => api.delete(`/agents/payments/${paymentId}`),
};

export const visasAPI = {
  list: (params) => api.get("/visas", { params }),
  get: (id) => api.get(`/visas/${id}`),
  create: (data) => api.post("/visas", data),
  update: (id, data) => api.put(`/visas/${id}`, data),
  delete: (id) => api.delete(`/visas/${id}`),
  addPayment: (id, data) => api.post(`/visas/${id}/payments`, data),
};

export const packagesAPI = {
  list: (params) => api.get("/packages", { params }),
  get: (id) => api.get(`/packages/${id}`),
  create: (data) => api.post("/packages", data),
  update: (id, data) => api.put(`/packages/${id}`, data),
  delete: (id) => api.delete(`/packages/${id}`),
  addPayment: (id, data) => api.post(`/packages/${id}/payments`, data),
};

export const expensesAPI = {
  categories: () => api.get("/expenses/categories"),
  list: (params) => api.get("/expenses", { params }),
  get: (id) => api.get(`/expenses/${id}`),
  create: (data) => api.post("/expenses", data),
  update: (id, data) => api.put(`/expenses/${id}`, data),
  delete: (id) => api.delete(`/expenses/${id}`),
};

export const financialsAPI = {
  profitLoss: (params) => api.get("/financials/profit-loss", { params }),
  balanceSheet: (params) => api.get("/financials/balance-sheet", { params }),
  cashFlow: (params) => api.get("/financials/cash-flow", { params }),
  receivables: (params) => api.get("/financials/receivables", { params }),
  updateOpeningBalances: (data) =>
    api.put("/financials/opening-balances", data),
};

export const usersAPI = {
  list: (params) => api.get("/users", { params }),
  create: (data) => api.post("/users", data),
  update: (id, data) => api.put(`/users/${id}`, data),
  delete: (id) => api.delete(`/users/${id}`),
};

export const businessAPI = {
  overview: () => api.get("/businesses/overview"),
  list: (params) => api.get("/businesses", { params }),
  get: (id) => api.get(`/businesses/${id}`),
  update: (id, data) => api.put(`/businesses/${id}`, data),
};

export const profileAPI = {
  get: () => api.get("/profile"),
  update: (data) => api.put("/profile", data),
  changePassword: (data) => api.put("/profile/change-password", data),
  forgotPassword: (data) => api.post("/auth/forgot-password", data),
  verifyOTP: (data) => api.post("/auth/verify-otp", data),
  resetPassword: (data) => api.post("/auth/reset-password", data),
};

export default api;
