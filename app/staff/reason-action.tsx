"use client";
import { useState } from "react";
import { MIN_REASON } from "../../src/domain/staff-admin";
import { postStaff } from "./staff-api";
import "../styles/staff.css";

/**
 * A moderation button that asks for a reason before it acts. The reason is stored in the audit log with the change. An optional choice
 * (radio buttons, first option selected) is sent as one more body field. On success it calls onDone with the response; on refusal it
 * shows the server's message and any publish-check reasons.
 */
export interface ActionChoice { field: string; legend: string; options: readonly { value: string; label: string }[] }

export function ReasonAction({ label, url, action, danger, choice, onDone }: {
  label: string; url: string; action: string; danger?: boolean; choice?: ActionChoice; onDone: (data: Record<string, unknown>) => void
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState(choice?.options[0]?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ error: string; reasons: string[] } | null>(null);

  if (!open) return <button type="button" className={danger ? "danger" : "secondary"} onClick={() => setOpen(true)}>{label}</button>;

  const submit = async () => {
    setBusy(true); setMsg(null);
    const r = await postStaff(url, { action, reason, ...(choice ? { [choice.field]: picked } : {}) });
    setBusy(false);
    if (r.ok) { setOpen(false); setReason(""); setPicked(choice?.options[0]?.value ?? ""); onDone(r.data); return; }
    setMsg({ error: String(r.data["error"] ?? "Could not save."), reasons: Array.isArray(r.data["reasons"]) ? r.data["reasons"].map(String) : [] });
  };

  return (
    <form className="stack-tight" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label>Reason for &ldquo;{label.toLowerCase()}&rdquo; (kept in the audit log)
        <textarea className="staff-reason" value={reason} onChange={e => setReason(e.target.value)} minLength={MIN_REASON} required />
      </label>
      {choice && (
        <fieldset className="stack-tight">
          <legend>{choice.legend}</legend>
          {choice.options.map(o => (
            <label key={o.value} className="radio"><input type="radio" name={`${action}-${choice.field}`} value={o.value} checked={picked === o.value} onChange={() => setPicked(o.value)} /> {o.label}</label>
          ))}
        </fieldset>
      )}
      <div className="row-actions">
        <button type="submit" className={danger ? "danger" : undefined} disabled={busy || reason.trim().length < MIN_REASON}>{busy ? "Saving…" : label}</button>
        <button type="button" className="secondary" onClick={() => { setOpen(false); setMsg(null); }}>Cancel</button>
      </div>
      {msg && <div role="alert"><p>{msg.error}</p>{msg.reasons.length > 0 && <ul>{msg.reasons.map(x => <li key={x}>{x}</li>)}</ul>}</div>}
    </form>
  );
}
