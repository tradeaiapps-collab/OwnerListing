"use client";
import { useEffect, useRef, useState } from "react";
import { BULK_ASYNC_ABOVE, BULK_LABELS, type BulkAction } from "../../../src/domain/listing-bulk";
import { MIN_REASON } from "../../../src/domain/staff-admin";
import { postStaff } from "../staff-api";

export type Selection = { ids: string[] } | { filter: Record<string, string> };
interface Preview { total: number; willChange: number; willSkip: number; summary: string; skipReasons: { reason: string; count: number }[]; examples: { id: string; title: string; change: string }[] }
interface Job { id: string; status: "queued" | "running" | "done" | "failed"; total: number; processed: number; succeeded: number; skipped: number; failed: number; problems: { id: string; outcome: string; message: string }[] }

const PROPERTY_TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"];
const text = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);

/**
 * One bulk action on the selected listings: choose the details and a reason, review what would change (count, skipped listings and why,
 * a few examples), confirm, then watch progress. Nothing changes until the confirm button.
 */
export function BulkDialog({ action, selection, onClose, onDone }: { action: BulkAction; selection: Selection; onClose: () => void; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [f, setF] = useState({ status: "sold", tag: "", propertyType: "house", mode: "percent", value: "", agent: "", reason: "" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { ref.current?.showModal(); }, []);

  const params = () => {
    switch (action) {
      case "set_status": return { status: f.status };
      case "add_tag": return { tag: f.tag };
      case "set_property_type": return { propertyType: f.propertyType };
      case "adjust_price": return { mode: f.mode, value: Number(f.value) };
      case "assign_agent": return { agent: f.agent };
      default: return {};
    }
  };
  const edit = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setPreview(null); setError(""); };

  async function review() {
    setBusy(true); setError("");
    const r = await postStaff("/api/staff/listings/bulk", { action, params: params(), ...selection, dryRun: true });
    setBusy(false);
    if (!r.ok) { setError(text(r.data["error"], "Could not preview.")); return; }
    setPreview(r.data["preview"] as Preview);
  }

  async function apply() {
    if (!preview) return;
    setBusy(true); setError("");
    const r = await postStaff("/api/staff/listings/bulk", { action, params: params(), ...selection, reason: f.reason, expectedCount: preview.total });
    setBusy(false);
    if (!r.ok) { setError(text(r.data["error"], "Could not apply.")); return; }
    setJob(r.data["job"] as Job);
  }

  // Follow a queued or running job until it finishes.
  useEffect(() => {
    if (!job || job.status === "done" || job.status === "failed") return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/staff/listings/bulk/${job.id}`).catch(() => null);
      if (r?.ok) setJob((await r.json()).job as Job);
    }, 1500);
    return () => clearInterval(t);
  }, [job]);

  const finished = job?.status === "done" || job?.status === "failed";
  const close = () => { ref.current?.close(); if (finished) onDone(); else onClose(); };
  const reasonOk = f.reason.trim().length >= MIN_REASON;
  const ready = action === "set_status" || action === "publish" || action === "archive" || action === "delete" ? true
    : action === "add_tag" ? f.tag.trim().length > 1 : action === "set_property_type" ? true
    : action === "adjust_price" ? Number(f.value) !== 0 && f.value !== "" : f.agent.trim().length > 2;

  return (
    <dialog ref={ref} className="bulk-dialog" aria-labelledby="bulk-title" onCancel={e => { e.preventDefault(); close(); }}>
      <h2 id="bulk-title">{BULK_LABELS[action]}</h2>
      {!job && (
        <form className="stack-tight" onSubmit={e => { e.preventDefault(); void (preview ? apply() : review()); }}>
          {action === "set_status" && (
            <label>New status
              <select value={f.status} onChange={e => edit({ status: e.target.value })}>
                <option value="sold">Sold (sale listings)</option><option value="rented">Rented (rental listings)</option><option value="available">Available again (back to draft)</option>
              </select>
            </label>
          )}
          {action === "add_tag" && <label>Tag or campaign <input value={f.tag} maxLength={40} placeholder="e.g. spring-campaign" onChange={e => edit({ tag: e.target.value })} /></label>}
          {action === "set_property_type" && (
            <label>Property type
              <select value={f.propertyType} onChange={e => edit({ propertyType: e.target.value })}>{PROPERTY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select>
            </label>
          )}
          {action === "adjust_price" && (
            <div className="bulk-price">
              <label>Change by
                <select value={f.mode} onChange={e => edit({ mode: e.target.value })}><option value="percent">Percent (%)</option><option value="amount">Dollars ($)</option></select>
              </label>
              <label>Amount (use - to reduce)
                <input type="number" inputMode="decimal" step="any" value={f.value} placeholder={f.mode === "percent" ? "10" : "-50000"} onChange={e => edit({ value: e.target.value })} />
              </label>
            </div>
          )}
          {action === "assign_agent" && <label>New agent (email or id)<input value={f.agent} autoComplete="off" onChange={e => edit({ agent: e.target.value })} /></label>}
          {action === "publish" && <p className="muted">Each listing still has to pass the publish checks. Listings that fail are skipped and listed afterwards.</p>}
          {action === "delete" && <p className="muted">Deleted listings leave the staff list and the market; their records are kept. Listings with open offers or inspection bookings are skipped.</p>}
          <label>Reason (kept in the audit log for every listing)
            <textarea className="staff-reason" value={f.reason} minLength={MIN_REASON} onChange={e => edit({ reason: e.target.value })} required />
          </label>
          {preview && (
            <div className="admin-notice" role="status" aria-live="polite">
              <p><strong>{preview.summary}</strong></p>
              <p>{preview.willChange} of {preview.total} listing{preview.total === 1 ? "" : "s"} will change{preview.willSkip > 0 ? `, ${preview.willSkip} skipped` : ""}.{preview.total > BULK_ASYNC_ABOVE ? " This is a large run and finishes in the background." : ""}</p>
              {preview.examples.length > 0 && <ul>{preview.examples.map(x => <li key={x.id}>{x.title}: {x.change}</li>)}</ul>}
              {preview.skipReasons.length > 0 && <><p>Skipped:</p><ul>{preview.skipReasons.map(s => <li key={s.reason}>{s.count} &times; {s.reason}</li>)}</ul></>}
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="row-actions">
            {!preview
              ? <button type="submit" disabled={busy || !ready || !reasonOk}>{busy ? "Checking…" : "Review changes"}</button>
              : <button type="submit" className={action === "delete" ? "danger" : undefined} disabled={busy || preview.willChange === 0}>{busy ? "Applying…" : `Apply to ${preview.willChange} listing${preview.willChange === 1 ? "" : "s"}`}</button>}
            <button type="button" className="secondary" onClick={close}>Cancel</button>
          </div>
        </form>
      )}
      {job && (
        <div className="stack-tight">
          <progress className="bulk-progress" max={job.total} value={job.processed} aria-label="Bulk run progress" />
          <p role="status" aria-live="polite">
            {finished ? "Finished. " : "Working… "}{job.processed} of {job.total} checked: {job.succeeded} changed, {job.skipped} skipped, {job.failed} failed.
          </p>
          {finished && job.problems.length > 0 && (
            <details open={job.problems.length <= 5}><summary>{job.problems.length} not changed</summary>
              <ul>{job.problems.slice(0, 50).map(p => <li key={p.id}><code>{p.id.slice(0, 8)}</code> {p.message}</li>)}</ul>
              {job.problems.length > 50 && <p className="muted">And {job.problems.length - 50} more; the audit trail lists every listing.</p>}
            </details>
          )}
          <div className="row-actions"><button type="button" onClick={close}>{finished ? "Done" : "Close (keeps running)"}</button></div>
        </div>
      )}
    </dialog>
  );
}
