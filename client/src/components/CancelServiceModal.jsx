import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Ban } from "lucide-react";
import { Button, Input, Modal } from "./ui";
import AccountSelect from "./AccountSelect";
import { visasAPI, packagesAPI } from "../services/api";

const money = (v) =>
  `$${Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const KINDS = {
  visa: { api: visasAPI, what: "visa application", supplier: "embassy / visa supplier", name: (r) => r.applicant_name },
  package: { api: packagesAPI, what: "package", supplier: "tour operator / supplier", name: (r) => r.label || r.lead_name },
};

/**
 * Cancel a visa or package properly: record any refund to the customer and
 * anything the supplier gives back. Whatever the customer's payments net to
 * afterwards is kept by the agency and shows in the income statement.
 */
export default function CancelServiceModal({ kind, record, onClose, onDone }) {
  const k = KINDS[kind];
  const [form, setForm] = useState({
    refund_amount: "",
    account_id: "",
    supplier_refund: "",
    supplier_account_id: "",
    reason: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm({ refund_amount: "", account_id: "", supplier_refund: "", supplier_account_id: "", reason: "" });
  }, [record]);

  if (!record) return null;
  const paid = Number(record.amount_paid || 0);
  const supplierPaid = Number(record.supplier_paid || 0);
  const refund = Number(form.refund_amount || 0);
  const supplierRefund = Number(form.supplier_refund || 0);
  const kept = paid - refund;
  const supplierLoss = supplierPaid - supplierRefund;
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e?.target ? e.target.value : e }));

  const submit = async (e) => {
    e.preventDefault();
    if (refund < 0 || refund > paid + 0.001)
      return toast.error(`The refund can be at most ${money(paid)}`);
    if (supplierRefund < 0 || supplierRefund > supplierPaid + 0.001)
      return toast.error(`The supplier can return at most ${money(supplierPaid)}`);
    if (refund > 0 && !form.account_id) return toast.error("Choose the account the refund is paid from");
    if (supplierRefund > 0 && !form.supplier_account_id)
      return toast.error("Choose the account the supplier's money went into");
    setSaving(true);
    try {
      const r = await k.api.cancel(record.id, form);
      toast.success(r.data.message || "Cancelled");
      onDone?.();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || "Couldn't cancel");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Cancel ${k.what} — ${k.name(record) || ""}`}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg bg-gray-50 dark:bg-gray-700/40 px-3 py-2">
            <p className="text-xs text-gray-500">Customer has paid</p>
            <p className="font-semibold tabular-nums text-gray-900 dark:text-white">{money(paid)}</p>
          </div>
          <div className="rounded-lg bg-gray-50 dark:bg-gray-700/40 px-3 py-2">
            <p className="text-xs text-gray-500">Paid to the {k.supplier}</p>
            <p className="font-semibold tabular-nums text-gray-900 dark:text-white">{money(supplierPaid)}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Refund to customer ($)" type="number" step="0.01" min="0" max={paid} value={form.refund_amount} onChange={set("refund_amount")} placeholder="0.00" disabled={paid <= 0} />
          {refund > 0 && (
            <AccountSelect direction="out" label="Refund paid from *" value={form.account_id} onChange={set("account_id")} />
          )}
        </div>
        {supplierPaid > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Returned by supplier ($)" type="number" step="0.01" min="0" max={supplierPaid} value={form.supplier_refund} onChange={set("supplier_refund")} placeholder="0.00" />
            {supplierRefund > 0 && (
              <AccountSelect direction="in" label="Received into *" value={form.supplier_account_id} onChange={set("supplier_account_id")} />
            )}
          </div>
        )}
        <Input label="Reason" value={form.reason} onChange={set("reason")} placeholder="e.g. customer changed plans" />

        <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm space-y-1">
          <div className="flex justify-between"><span className="text-gray-500">Agency keeps from the customer</span><span className="tabular-nums font-medium">{money(kept)}</span></div>
          {supplierPaid > 0 && (
            <div className="flex justify-between"><span className="text-gray-500">Lost to the supplier</span><span className="tabular-nums font-medium text-red-600">({money(supplierLoss)})</span></div>
          )}
          <div className="flex justify-between border-t border-gray-100 dark:border-gray-700 pt-1">
            <span className="font-semibold">Result of this cancellation</span>
            <span className={`tabular-nums font-bold ${kept - supplierLoss >= 0 ? "text-green-600" : "text-red-600"}`}>{money(kept - supplierLoss)}</span>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>Keep it</Button>
          <Button type="submit" variant="danger" loading={saving}><Ban className="w-4 h-4" /> Cancel {k.what}</Button>
        </div>
      </form>
    </Modal>
  );
}
