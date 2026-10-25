"use client";
import { useState } from "react";
import { JSON_HEADERS } from "../listings/ui";

type Violation = { code: string; message: string };
type DraftResponse =
  | { state: "drafted"; intent: string; quietHours: boolean; earliestSend: string; draft: { id: string; text: string; status: "pending" | "held"; violations: Violation[] } }
  | { state: "owner_only"; intent: string; message: string; reasons: string[] }
  | { state: "unavailable"; message: string; templateBody?: string }
  | { state: "paused"; message: string };

export const AI_DRAFT_LABEL = "AI draft. Check every fact before you send. Nothing is sent until you press Send.";

/**
 * Seller side of a thread: ask the AI for a reply draft, edit it, then send or discard it. The AI never sends.
 * A held draft (failed checks) can still be edited and sent; the checks run again on the edited text.
 */
export function AiReplyPanel({ enquiryId, onSent }: { enquiryId: string; onSent: () => Promise<void> }) {
  const [res, setRes] = useState<DraftResponse | null>(null);
  const [text, setText] = useState("");
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [violations, setViolations] = useState<Violation[]>([]);

  async function ask() {
    setBusy(true); setError(""); setViolations([]);
    try {
      const r = await fetch(`/api/enquiries/${enquiryId}/ai/draft`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? "Could not draft a reply."); return; }
      setRes(d);
      if (d.state === "drafted") { setText(d.draft.text); setEdited(false); setViolations(d.draft.violations); }
    } catch { setError("Could not draft a reply."); } finally { setBusy(false); }
  }

  async function send() {
    if (res?.state !== "drafted") return;
    setBusy(true); setError("");
    try {
      const body = edited ? { mode: "edited", text } : { mode: "as_is" };
      const r = await fetch(`/api/ai/drafts/${res.draft.id}/send`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json();
      if (r.ok) { setRes(null); setText(""); await onSent(); return; }
      setError(d.error ?? "Could not send."); setViolations(d.violations ?? []);
    } catch { setError("Could not send."); } finally { setBusy(false); }
  }

  async function discard() {
    if (res?.state !== "drafted") return;
    setBusy(true);
    try { await fetch(`/api/ai/drafts/${res.draft.id}/discard`, { method: "POST", headers: JSON_HEADERS, body: "{}" }); } catch { /* the draft simply stays pending */ }
    setRes(null); setText(""); setBusy(false);
  }

  return (
    <section aria-label="AI reply assistant" className="enq-draft">
      <h2>AI reply assistant</h2>
      {!res && <button type="button" disabled={busy} onClick={() => void ask()}>{busy ? "Drafting…" : "Draft a reply with AI"}</button>}
      {res && res.state !== "drafted" && (
        <>
          <p role="status">{res.message}</p>
          {res.state === "owner_only" && res.reasons.length > 0 && <ul>{res.reasons.map(r => <li key={r}>{r}</li>)}</ul>}
          {res.state === "unavailable" && res.templateBody && (
            <>
              <p className="muted">Your saved template, to copy into your reply and edit:</p>
              <blockquote style={{ whiteSpace: "pre-wrap" }}>{res.templateBody}</blockquote>
            </>
          )}
          <button type="button" className="secondary" onClick={() => setRes(null)}>Close</button>
        </>
      )}
      {res?.state === "drafted" && (
        <form className="stack" onSubmit={e => { e.preventDefault(); void send(); }}>
          <p className="muted">{AI_DRAFT_LABEL} Topic: {res.intent}.</p>
          {res.draft.status === "held" && <p role="alert">This draft did not pass the checks. Edit it before sending.</p>}
          {violations.length > 0 && <ul>{violations.map(v => <li key={v.code}>{v.message}</li>)}</ul>}
          {res.quietHours && <p className="muted">It is quiet hours in the property&apos;s state. Consider sending after {new Date(res.earliestSend).toLocaleString("en-AU")}.</p>}
          <textarea value={text} rows={6} maxLength={3800} aria-label="AI draft" onChange={e => { setText(e.target.value); setEdited(true); }} />
          <p className="muted">A note that AI helped write this reply is added when you send it.</p>
          <p>
            <button type="submit" disabled={busy || !text.trim()}>{busy ? "Sending…" : edited ? "Send edited reply" : "Send"}</button>{" "}
            <button type="button" className="secondary" disabled={busy} onClick={() => void discard()}>Discard</button>
          </p>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
