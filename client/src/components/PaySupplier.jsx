import React, { useState, useEffect } from "react";
import { suppliersAPI } from "../services/api";
import { Button, Modal, Input } from "./ui";
import AccountSelect, { refreshAccounts } from "./AccountSelect";
import toast from "react-hot-toast";
import { Banknote } from "lucide-react";

/**
 * PaySupplier — send money to an embassy, a tour operator or a carrier.
 *
 * Airlines have worked this way since the beginning: a cost recorded when
 * the sale is made, a balance showing what is still owed, and a button that
 * asks which account the money leaves from. Visas, packages and cargo did
 * not. Their cost was typed on the record and then treated as already paid,
 * which is how a $1,900 embassy fee vanished from the agency's cash without
 * a shilling moving — the balance sheet read $130 while the bank held
 * $2,030.
 *
 * Nothing here is clever. It is the airline flow, applied to the suppliers
 * that were missing it, so all four kinds of debt behave identically.
 */

const money = (v) => `$${(Number(v) || 0).toFixed(2)}`;

/** What is still owed on one record, given whatever the API returned. */
export const supplierBalance = (kind, record) => {
  if (!record) return 0;
  const cost =
    kind === "cargo"
      ? record.profit_total === null || record.profit_total === undefined
        ? 0 // no margin entered means no cost was recorded
        : Math.max(
            (Number(record.total_price) || 0) -
              (Number(record.profit_total) || 0),
            0,
          )
      : Number(kind === "package" ? record.total_cost : record.cost_price) || 0;
  const paid = Number(record.supplier_paid) || 0;
  return Math.round((cost - paid) * 100) / 100;
};

/**
 * The modal on its own, controlled by the page.
 *
 * It used to be bundled with its own trigger button, and that button was
 * placed inside the ⋮ actions menu. Clicking it closed the menu, the menu
 * unmounted its portal, and the modal went with it before it could paint —
 * so "Pay fee" looked like a dead button. A modal must outlive whatever
 * opened it, which means living at page level.
 */
export function PaySupplierModal({ kind, record, open, onClose, onPaid }) {
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);

  const owed = supplierBalance(kind, record);

  // Pre-filled with the whole balance each time it opens, because settling in
  // full is what usually happens and retyping a number the system already
  // knows is a chance to get it wrong.
  useEffect(() => {
    if (!open) return;
    setAmount(owed.toFixed(2));
    setAccountId("");
    setReference("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, record?.id]);

  if (!record) return null;

  const submit = async (e) => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (!val || val <= 0) return toast.error("Enter an amount");
    if (val > owed + 0.001)
      return toast.error(`That is more than the ${money(owed)} still owed`);

    setSaving(true);
    try {
      const res = await suppliersAPI.pay(kind, record.id, {
        amount: val,
        account_id: accountId || undefined,
        reference: reference || undefined,
      });
      toast.success(res.data.message);
      refreshAccounts();
      onClose?.();
      onPaid?.();
    } catch (err) {
      toast.error(err.response?.data?.message || "Could not record the payment");
    } finally {
      setSaving(false);
    }
  };

  return (
      <Modal open={open} onClose={onClose} title={`Pay ${kind} cost`}>
        <form onSubmit={submit} className="space-y-4">
          <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-4">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Still owed on this {kind}:{" "}
              <strong className="text-gray-900 dark:text-white">
                {money(owed)}
              </strong>
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              This money leaves the account you choose and appears in its
              ledger straight away.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Amount"
              type="number"
              min="0"
              step="0.01"
              max={owed}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              error={
                parseFloat(amount) > owed + 0.001
                  ? `More than the ${money(owed)} owed`
                  : undefined
              }
              hint="Leave as-is to settle in full"
            />
            <AccountSelect
              direction="out"
              label="Paid from *"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            />
          </div>

          <Input
            label="Reference (optional)"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Receipt or transfer number"
          />

          <div className="flex gap-3 justify-end pt-1">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              <Banknote className="w-4 h-4" /> Pay {money(parseFloat(amount) || 0)}
            </Button>
          </div>
        </form>
      </Modal>
  );
}
