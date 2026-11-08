"use client";
import { useCallback, useEffect, useState } from "react";
import { JSON_HEADERS, formatWhen } from "../../inspections/ui";
import TemplateEditor from "./template-editor";

type Msg = { id: string; kindLabel: string; status: string; listingTitle: string; scheduledAt: string; draftBody: string; finalBody?: string; edited: boolean; dueAt: string; decidedAt?: string };
const STATUS: Record<string, string> = { sent: "Sent", skipped: "Skipped", expired: "Expired", scheduled: "Scheduled" };

/** Elena's drafted confirmations and reminders for inspections you accepted. Nothing is sent until you press Send. */
export default function InspectorMessages() {
  const [suggestions, setSuggestions] = useState<Msg[] | null>(null);
  const [history, setHistory] = useState<Msg[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/inspector/messages").catch(() => null);
    if (!r || !r.ok) { setError(r?.status === 401 ? "Sign in to see Elena's drafts." : "Could not load drafts."); return; }
    const d = await r.json();
    setSuggestions(d.suggestions); setHistory(d.history);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function decide(m: Msg, action: "send" | "skip") {
    setBusy(m.id); setError(""); setNote("");
    const body = action === "send" ? { action, body: edits[m.id] ?? m.draftBody } : { action };
    const r = await fetch(`/api/inspector/messages/${m.id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
    setBusy("");
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) { setError(r ? d.error ?? "Could not save." : "Network error."); await load(); return; }
    setNote(action === "send" ? "Sent to the buyer." : "Skipped."); await load();
  }

  return (
    <main className="insp-page">
      <h1>Elena&apos;s message drafts</h1>
      <p><a href="/inspector">Back to the inspector portal</a></p>
      <p className="muted">Elena drafts a confirmation when you accept a booking and a reminder 24 hours before. You decide: send it, edit it first, or skip it. The buyer sees it in the app only after you send.</p>
      <div aria-live="polite">{error && <p role="alert">{error}</p>}{note && <p role="status">{note}</p>}</div>

      <h2>Waiting for you</h2>
      {suggestions === null && !error && <p className="muted" role="status">Loading…</p>}
      {suggestions?.length === 0 && <p className="empty">No drafts waiting. New ones appear when you accept a booking.</p>}
      <ul className="card-list insp-list">
        {suggestions?.map(m => (
          <li key={m.id}>
            <div className="top"><strong>{m.kindLabel}</strong><span className="badge">Elena suggested</span></div>
            <span>{m.listingTitle} · {formatWhen(m.scheduledAt)}</span>
            <form className="insp-form" onSubmit={e => { e.preventDefault(); void decide(m, "send"); }}>
              <label>Message to the buyer
                <textarea rows={8} maxLength={1500} value={edits[m.id] ?? m.draftBody} onChange={e => setEdits({ ...edits, [m.id]: e.target.value })} />
              </label>
              <div className="actions">
                <button type="submit" disabled={busy === m.id || !(edits[m.id] ?? m.draftBody).trim()}>{busy === m.id ? "Sending…" : (edits[m.id] ?? m.draftBody) === m.draftBody ? "Send" : "Send edited"}</button>
                <button type="button" className="secondary" disabled={busy === m.id} onClick={() => decide(m, "skip")}>Skip</button>
              </div>
            </form>
          </li>
        ))}
      </ul>

      <h2>Recent</h2>
      {history.length === 0 && <p className="empty">Sent, skipped and expired drafts are listed here.</p>}
      <ul className="card-list insp-list">
        {history.map(m => (
          <li key={m.id}>
            <div className="top"><strong>{m.kindLabel}</strong><span className="badge">{STATUS[m.status] ?? m.status}{m.status === "sent" && m.edited ? " (edited)" : ""}</span></div>
            <span>{m.listingTitle} · {formatWhen(m.scheduledAt)}</span>
            {m.status === "scheduled" && <span className="muted">Elena will offer this at {formatWhen(m.dueAt)}.</span>}
            {m.finalBody && <details><summary>Elena suggested this message{m.edited ? ", you edited it" : ""}</summary><p className="insp-summary-text">{m.finalBody}</p></details>}
          </li>
        ))}
      </ul>

      <h2>Your wording</h2>
      <TemplateEditor endpoint="/api/inspector/message-templates" scope="agent" />
    </main>
  );
}
