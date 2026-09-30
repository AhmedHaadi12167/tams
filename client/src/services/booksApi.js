// Owners, the automatic books, and importing opening balances.
import api from "./api";

export const ownersAPI = {
  list: () => api.get("/owners"),
  create: (data) => api.post("/owners", data),
  update: (id, data) => api.put(`/owners/${id}`, data),
  delete: (id) => api.delete(`/owners/${id}`),
  transactions: (id) => api.get(`/owners/${id}/transactions`),
  addTransaction: (id, data) => api.post(`/owners/${id}/transactions`, data),
  deleteTransaction: (txId) => api.delete(`/owners/transactions/${txId}`),
};

export const booksAPI = {
  chart: () => api.get("/financials/chart-of-accounts"),
  trialBalance: (params) => api.get("/financials/trial-balance", { params }),
  generalLedger: (params) => api.get("/financials/general-ledger", { params }),
  journal: (params) => api.get("/financials/journal", { params }),
};

export const importAPI = {
  template: (type) =>
    api.get("/financials/opening-items/template", {
      params: { type },
      responseType: "blob",
    }),
  preview: (formData) =>
    api.post("/financials/opening-items/import/preview", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    }),
  commit: (data) => api.post("/financials/opening-items/import/commit", data),
};
