"use client";
import { useState } from "react";
import { MIN_REASON } from "../../src/domain/staff-admin";
import { postStaff } from "./staff-api";
import "../styles/staff.css";

/**
 * A moderation button that asks for a reason before it acts. The reason is stored in the audit log with the change. On success it
 * calls onDone; on refusal it shows the server's message and any publish-check reasons.
 */
export function ReasonAction({ label, url, action, danger, onDone }: { label: string; url: string; action: string; danger?: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ error: string; reasons: string[] } | null>(null);

  if (!open) return <button type="button" className={danger ? "danger" : "secondary"} onClick={() => setOpen(true)}>{label}</button>;

  const submit = async () => {
    setBusy(true); setMsg(null);
    const r = await postStaff(url, { action, reason });
    setBusy(false);
    if (r.ok) { setOpen(false); setReason(""); onDone(); return; }
    setMsg({ error: String(r.data["error"] ?? "Could not save."), reasons: Array.isArray(r.data["reasons"]) ? r.data["reasons"].map(String) : [] });
  };

  return (
    <form className="stack-tight" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label>Reason for &ldquo;{label.toLowerCase()}&rdquo; (kept in the audit log)
        <textarea className="staff-reason" value={reason} onChange={e => setReason(e.target.value)} minLength={MIN_REASON} required />
      </label>
      <div className="row-actions">
        <button type="submit" className={danger ? "danger" : undefined} disabled={busy || reason.trim().length < MIN_REASON}>{busy ? "Saving…" : label}</button>
        <button type="button" className="secondary" onClick={() => { setOpen(false); setMsg(null); }}>Cancel</button>
      </div>
      {msg && <div role="alert"><p>{msg.error}</p>{msg.reasons.length > 0 && <ul>{msg.reasons.map(x => <li key={x}>{x}</li>)}</ul>}</div>}
    </form>
  );
}
