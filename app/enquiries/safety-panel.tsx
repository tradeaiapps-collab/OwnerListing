"use client";
import { useCallback, useEffect, useState } from "react";
import { JSON_HEADERS } from "../listings/ui";

export type SafetyFlagView = {
  messageId: string; risk: "low" | "medium" | "high"; handoff: boolean; warning?: string;
  reasons: { category: string; explanation: string }[]; reviewOutcome?: "confirmed" | "dismissed";
};
export type SafetyView = { flags: SafetyFlagView[]; aiPaused: boolean; note: string };

/** Loads the seller-side safety warnings for a thread. Buyers always get an empty list. A failure just shows no warnings. */
export function useSafety(enquiryId: string): { safety: SafetyView | null; reload: () => Promise<void> } {
  const [safety, setSafety] = useState<SafetyView | null>(null);
  const reload = useCallback(async () => {
    try {
      const r = await fetch(`/api/enquiries/${enquiryId}/safety`);
      if (r.ok) setSafety(await r.json());
    } catch { /* the thread still works without warnings */ }
  }, [enquiryId]);
  useEffect(() => { void reload(); }, [reload]);
  return { safety, reload };
}

/** Warning shown under one flagged buyer message. Wording says what to watch for; it never calls the buyer a scammer. */
export function MessageWarning({ flag }: { flag: SafetyFlagView }) {
  return (
    <div className={`enq-safety risk-${flag.risk}`} role="note">
      <strong>{flag.warning}</strong>
      <ul>{flag.reasons.map(r => <li key={r.category}>{r.explanation}</li>)}</ul>
      {flag.reviewOutcome === "dismissed" && <small>Checked by our team: no problem found.</small>}
      {flag.reviewOutcome === "confirmed" && <small>Checked by our team: please do not continue with this request.</small>}
    </div>
  );
}

/** Top of the thread, seller side: the money rule, and the AI pause with a button to resume it. */
export function SafetySummary({ enquiryId, safety, onChange }: { enquiryId: string; safety: SafetyView; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function resume() {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/enquiries/${enquiryId}/safety`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "resume_ai" }) });
      if (!r.ok) setError("Only the listing owner can turn the AI back on.");
      await onChange();
    } catch { setError("That did not work."); } finally { setBusy(false); }
  }
  return (
    <section aria-label="Safety" className="enq-safety-summary">
      <p className="muted">{safety.note}</p>
      {safety.aiPaused && (
        <p>
          The AI assistant is paused on this conversation because a message needs your personal attention.{" "}
          <button type="button" className="secondary" disabled={busy} onClick={() => void resume()}>Turn AI back on</button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
