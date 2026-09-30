// Shared formatting for the Financials screens.

export const money = (v) =>
  `$${Number(v || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Accounting style: negatives in brackets. */
export const acct = (v) => {
  const n = Number(v || 0);
  if (Math.abs(n) < 0.005) return "—";
  return n < 0 ? `(${money(-n)})` : money(n);
};

export const pctText = (v) => {
  const n = Number(v || 0);
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
};

export const OWNER_COLORS = [
  "#2563eb",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ef4444",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

export const SOURCE_LABELS = {
  ticket_sale: "Ticket sold",
  ticket_cancel: "Ticket cancelled",
  ticket_payment: "Ticket payment",
  visa_sale: "Visa sold",
  visa_cancel: "Visa cancelled",
  visa_payment: "Visa payment",
  visa_supplier: "Visa supplier",
  package_sale: "Package sold",
  package_cancel: "Package cancelled",
  package_payment: "Package payment",
  package_supplier: "Package supplier",
  cargo_sale: "Cargo shipped",
  cargo_cancel: "Cargo cancelled",
  cargo_payment: "Cargo payment",
  cargo_supplier: "Cargo carrier",
  airline_payment: "Airline payment",
  agent_payment: "Agent commission",
  deposit: "Customer deposit",
  opening_receivable: "Opening receivable",
  opening_payable: "Opening payable",
  opening_collection: "Opening collection",
  tax_payment: "Tax paid",
  expense: "Expense",
  transfer: "Transfer",
  account_opening: "Account opening",
  business_opening: "Opening position",
  owner_opening: "Owner opening capital",
  owner_contribution: "Owner capital",
  owner_withdrawal: "Owner drawings",
};

export const sourceLabel = (s) =>
  SOURCE_LABELS[s] ||
  String(s || "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
