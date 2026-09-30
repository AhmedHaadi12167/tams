import React, { useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  FileSpreadsheet,
  Download,
  Upload,
  CheckCircle2,
  UserPlus,
  AlertTriangle,
  XCircle,
  Copy,
  ArrowLeft,
} from "lucide-react";
import { Button, Modal, Badge, Spinner } from "../../components/ui";
import { importAPI } from "../../services/booksApi";
import { money } from "./format";

/**
 * Import opening balances from the previous system.
 *
 *   1. Pick receivables (customers owe us) or payables (we owe airlines)
 *   2. Download the template, fill it, upload it
 *   3. Review: every row is matched to the exact customer / airline on file
 *      (phone first, then name). Ambiguous rows must be resolved; errors and
 *      duplicates are left out unless you tick them.
 *   4. Import — all rows in one go, or none.
 */
export default function OpeningImportModal({ open, onClose, onImported }) {
  const [type, setType] = useState("receivable");
  const [step, setStep] = useState("upload");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const fileRef = useRef(null);

  const reset = () => { setStep("upload"); setPreview(null); setRows([]); if (fileRef.current) fileRef.current.value = ""; };
  const close = () => { reset(); onClose(); };

  const download = async () => {
    try {
      const r = await importAPI.template(type);
      const url = URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `tams-opening-${type}s-template.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Couldn't download the template");
    }
  };

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("type", type);
      fd.append("file", file);
      const r = await importAPI.preview(fd);
      const data = r.data.data;
      setPreview(data);
      setRows(
        data.rows.map((x) => ({
          ...x,
          include: x.match === "matched" || x.match === "new" ? !x.duplicate : false,
          choice: x.party_id || (x.match === "new" ? "__new__" : ""),
        })),
      );
      setStep("review");
    } catch (err) {
      toast.error(err.response?.data?.message || "Couldn't read that file");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const setRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const selected = useMemo(() => rows.filter((r) => r.include && r.match !== "error" && r.choice), [rows]);
  const unresolved = rows.filter((r) => r.include && !r.choice && r.match !== "error").length;
  const total = selected.reduce((s, r) => s + Number(r.amount || 0), 0);

  const commit = async () => {
    if (!selected.length) return toast.error("Tick at least one row to import");
    setBusy(true);
    try {
      const r = await importAPI.commit({
        type,
        rows: selected.map((x) => ({
          row: x.row,
          name: x.name,
          phone: x.phone,
          service_type: x.service_type,
          amount: x.amount,
          entry_date: x.entry_date,
          reason: x.reason,
          party_id: x.choice && x.choice !== "__new__" ? x.choice : null,
        })),
      });
      toast.success(r.data.message);
      onImported?.();
      close();
    } catch (err) {
      toast.error(err.response?.data?.message || "Import failed — nothing was saved");
    } finally {
      setBusy(false);
    }
  };

  const who = type === "receivable" ? "Customer" : "Airline";

  return (
    <Modal open={open} onClose={close} title="Import opening balances" size={step === "review" ? "xl" : "lg"}>
      {step === "upload" && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              ["receivable", "Receivables", "What customers still owe you from the old system"],
              ["payable", "Payables", "What you still owe airlines from the old system"],
            ].map(([k, t, d]) => (
              <button
                key={k}
                onClick={() => setType(k)}
                className={`text-left rounded-xl border-2 p-4 transition ${
                  type === k
                    ? "border-blue-600 bg-blue-50/60 dark:bg-blue-900/20"
                    : "border-gray-200 dark:border-gray-700 hover:border-gray-300"
                }`}
              >
                <p className="font-semibold text-gray-900 dark:text-white">{t}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{d}</p>
              </button>
            ))}
          </div>

          <ol className="space-y-3 text-sm">
            <li className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center shrink-0">1</span>
              <div className="flex-1">
                <p className="text-gray-800 dark:text-gray-200">Download the template and fill one row per balance.</p>
                <Button size="sm" variant="outline" className="mt-2" onClick={download}>
                  <Download className="w-4 h-4" /> {type === "receivable" ? "Receivables" : "Payables"} template (.xlsx)
                </Button>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center shrink-0">2</span>
              <div className="flex-1">
                <p className="text-gray-800 dark:text-gray-200">Upload it. Nothing is saved until you review the matches.</p>
                <label className={`mt-2 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 cursor-pointer transition ${busy ? "opacity-60" : "border-gray-300 dark:border-gray-600 hover:border-blue-500 hover:bg-blue-50/40 dark:hover:bg-blue-900/10"}`}>
                  {busy ? <Spinner /> : <Upload className="w-7 h-7 text-gray-400" />}
                  <span className="text-sm text-gray-600 dark:text-gray-300">{busy ? "Reading and matching…" : "Choose an Excel (.xlsx) or CSV file"}</span>
                  <input ref={fileRef} type="file" accept=".xlsx,.csv" className="hidden" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
                </label>
              </div>
            </li>
          </ol>
          <p className="text-xs text-gray-500 dark:text-gray-400 flex items-start gap-2">
            <FileSpreadsheet className="w-4 h-4 shrink-0" />
            {type === "receivable"
              ? "Customers are matched by phone first, then by exact name. Anyone not on file is created as a new customer."
              : "Airlines are matched by name or by any alias you've saved. Airlines not on file are created."}
          </p>
        </div>
      )}

      {step === "review" && preview && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Chip icon={CheckCircle2} tone="green" n={preview.summary.matched} label="matched" />
            <Chip icon={UserPlus} tone="blue" n={preview.summary.new} label={`new ${who.toLowerCase()}${preview.summary.new === 1 ? "" : "s"}`} />
            <Chip icon={AlertTriangle} tone="amber" n={preview.summary.ambiguous} label="need a choice" />
            <Chip icon={Copy} tone="gray" n={preview.summary.duplicates} label="duplicates" />
            <Chip icon={XCircle} tone="red" n={preview.summary.errors} label="errors" />
          </div>

          <div className="max-h-[55vh] overflow-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800 z-10">
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2 w-10" />
                  <th className="px-2 py-2 w-12">Row</th>
                  <th className="px-2 py-2">In the file</th>
                  <th className="px-2 py-2">Matched {who.toLowerCase()}</th>
                  {type === "receivable" && <th className="px-2 py-2">Service</th>}
                  <th className="px-2 py-2">Date</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                {rows.map((r, i) => (
                  <tr key={r.row} className={r.match === "error" ? "bg-red-50/60 dark:bg-red-900/10" : r.include ? "" : "opacity-60"}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="rounded"
                        checked={!!r.include}
                        disabled={r.match === "error"}
                        onChange={(e) => setRow(i, { include: e.target.checked })}
                      />
                    </td>
                    <td className="px-2 py-2 text-gray-400 tabular-nums">{r.row}</td>
                    <td className="px-2 py-2">
                      <p className="text-gray-900 dark:text-white">{r.name || <span className="text-gray-400">—</span>}</p>
                      <p className="text-[11px] text-gray-400">{[r.phone, r.reason].filter(Boolean).join(" · ")}</p>
                    </td>
                    <td className="px-2 py-2 min-w-[220px]">
                      {r.match === "error" ? (
                        <span className="text-xs text-red-600">{r.message}</span>
                      ) : r.candidates?.length ? (
                        <select
                          value={r.choice}
                          onChange={(e) => setRow(i, { choice: e.target.value, include: !!e.target.value })}
                          className={`w-full text-sm rounded-md border px-2 py-1 bg-white dark:bg-gray-800 ${r.choice ? "border-gray-300 dark:border-gray-600" : "border-amber-400"}`}
                        >
                          {r.match === "ambiguous" && <option value="">— choose —</option>}
                          {r.match === "new" && <option value="__new__">Create “{r.party_name}”</option>}
                          {r.candidates.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>
                          ))}
                        </select>
                      ) : (
                        <div>
                          <span className="text-gray-800 dark:text-gray-200">{r.party_name}</span>{" "}
                          {r.match === "matched" ? <Badge variant="success">by {r.via}</Badge> : <Badge variant="info">new</Badge>}
                        </div>
                      )}
                      {r.match !== "error" && (r.duplicate || (r.match !== "matched" && r.message)) && (
                        <p className={`text-[11px] mt-0.5 ${r.duplicate ? "text-gray-500" : "text-amber-600"}`}>{r.duplicate || r.message}</p>
                      )}
                    </td>
                    {type === "receivable" && <td className="px-2 py-2 capitalize text-gray-600 dark:text-gray-300">{r.service_type}</td>}
                    <td className="px-2 py-2 whitespace-nowrap text-gray-600 dark:text-gray-300">{r.entry_date}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{Number.isFinite(r.amount) ? money(r.amount) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="text-sm text-gray-600 dark:text-gray-300">
              <b>{selected.length}</b> row{selected.length === 1 ? "" : "s"} · <b>{money(total)}</b> will be imported
              {unresolved > 0 && <span className="text-amber-600"> · {unresolved} ticked row{unresolved === 1 ? "" : "s"} still need a {who.toLowerCase()}</span>}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={reset}><ArrowLeft className="w-4 h-4" /> Another file</Button>
              <Button onClick={commit} loading={busy} disabled={!selected.length || unresolved > 0}>
                Import {selected.length} {type === "receivable" ? "receivable" : "payable"}{selected.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Chip({ icon: Icon, tone, n, label }) {
  const tones = {
    green: "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300",
    blue: "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300",
    gray: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
    red: "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300",
  };
  if (!n) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${tones[tone]}`}>
      <Icon className="w-3.5 h-3.5" /> {n} {label}
    </span>
  );
}
