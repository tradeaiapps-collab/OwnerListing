"use client";
import { useCallback, useEffect, useState } from "react";

interface Item { type: string; severity: "info" | "caution" | "risk"; title: string; rationale: string; template: string; decision: "used" | "dismissed" | null }
interface Coaching { active: boolean; comparison: { text: string } | null; suggestions: Item[] }
const SEVERITY = { risk: "Worth fixing", caution: "Worth a look", info: "Idea" } as const;

/** Elena's advice for this sale's terms. Cards with a reason; the person copies a template into the sale's messages or dismisses it. Nothing is sent for them. */
export default function CoachingPanel({ settlementId }: { settlementId: string }) {
  const [c, setC] = useState<Coaching | null>(null);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/settlements/${settlementId}/coaching`).catch(() => null);
    if (r?.ok) setC((await r.json()) as Coaching); else setError("Elena's advice could not be loaded.");
  }, [settlementId]);
  useEffect(() => { void load(); }, [load]);

  async function decide(type: string, decision: "use" | "dismiss") {
    setBusy(type); setError("");
    const r = await fetch(`/api/settlements/${settlementId}/coaching`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ suggestion: type, decision }) }).catch(() => null);
    const d = r ? ((await r.json().catch(() => ({}))) as { template?: string | null; error?: string }) : {};
    if (!r?.ok) setError(d.error ?? "That did not work.");
    else if (d.template) setShown(s => ({ ...s, [type]: d.template! }));
    setBusy("");
    await load();
  }

  if (!c || !c.active || (c.suggestions.length === 0 && !c.comparison && !error)) return null;
  return (
    <aside className="coach-panel" aria-labelledby="coach-h">
      <h2 id="coach-h">Elena&apos;s advice</h2>
      <p className="muted">Suggestions to help this sale reach settlement. They are advice, not legal advice, and nothing is sent for you.</p>
      {c.comparison ? <p className="coach-compare">{c.comparison.text}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <ul className="coach-list">
        {c.suggestions.map(s => (
          <li key={s.type} className={`coach-card is-${s.severity}${s.decision === "dismissed" ? " is-dismissed" : ""}`}>
            <span className="badge">{SEVERITY[s.severity]}</span>
            <h3>{s.title}</h3>
            <p>{s.rationale}</p>
            {s.decision === "dismissed" ? <p className="muted">You dismissed this.</p> : null}
            {s.decision === "used" || shown[s.type] ? <blockquote className="coach-template">{shown[s.type] ?? s.template}<span className="muted"> Copy this into the <a href={`/messages/${settlementId}`}>messages for this sale</a>.</span></blockquote> : null}
            {s.decision === null ? (
              <div className="settle-actions">
                <button type="button" disabled={busy === s.type} onClick={() => void decide(s.type, "use")}>Use this suggestion</button>
                <button type="button" className="secondary" disabled={busy === s.type} onClick={() => void decide(s.type, "dismiss")}>Ignore</button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </aside>
  );
}
