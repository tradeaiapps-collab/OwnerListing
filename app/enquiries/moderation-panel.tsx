"use client";
import { useEffect, useState } from "react";
import { JSON_HEADERS } from "../listings/ui";

type Flag = { category: string; severity: "low" | "medium" | "high"; match: string; explanation: string; suggestion: string };
type Check = { risk: "none" | "low" | "medium" | "high"; tone: string; flags: Flag[]; rewrites: { tone: string; text: string; removed: number }[] };
type Template = { id: string; scenario: string; label: string; body: string };
type Insight = {
  stalled?: { days: number; waitingOn: "buyer" | "seller"; followUps: { tone: string; text: string }[] };
  toneShift?: { by: "buyer" | "seller"; tone: string };
};
type Feedback = { messageId: string; status: "revision_requested" | "educated"; note: string; reasons: { category: string; explanation: string; suggestion: string }[] };
type Extras = { templates: Template[]; scenarios: Record<string, string>; insight: Insight; feedback: Feedback[] };

const label = (s: string) => s.replace(/_/g, " ");

/**
 * Seller side of a thread: Elena checks the draft as you type (rules only, nothing is stored or sent), explains any concern,
 * offers softer versions in four tones, and has message templates plus follow-up and tone notes for the conversation.
 * She advises only. The Send button is never disabled by this panel.
 */
export function ModerationPanel({ enquiryId, draft, onUse, name = "Elena" }: { enquiryId: string; draft: string; onUse: (text: string) => void; name?: string | undefined }) {
  const [extras, setExtras] = useState<Extras | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [scenario, setScenario] = useState("");

  useEffect(() => {
    let live = true;
    fetch(`/api/enquiries/${enquiryId}/moderation`).then(r => (r.ok ? r.json() : null)).then(d => { if (live && d) setExtras(d); }).catch(() => { /* panel just stays empty */ });
    return () => { live = false; };
  }, [enquiryId]);

  useEffect(() => {
    if (!draft.trim()) { setCheck(null); return; }
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/enquiries/${enquiryId}/moderation`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ body: draft }) })
        .then(r => (r.ok ? r.json() : null)).then(d => { if (live) setCheck(d); }).catch(() => { if (live) setCheck(null); });
    }, 700);
    return () => { live = false; clearTimeout(t); };
  }, [enquiryId, draft]);

  if (!extras) return null;
  const templates = extras.templates.filter(t => !scenario || t.scenario === scenario);
  const flagged = check && check.risk !== "none";

  return (
    <section className="enq-mod" aria-label={`${name} message check`}>
      {extras.feedback.map(f => (
        <div key={f.messageId} className="enq-mod-note risk-medium" role="note">
          <strong>{f.status === "revision_requested" ? "Our team asked you to revise an earlier message" : "A note from our team about an earlier message"}</strong>
          <p>{f.note}</p>
          <ul>{f.reasons.map(r => <li key={r.category}>{r.explanation} {r.suggestion}</li>)}</ul>
        </div>
      ))}
      {extras.insight.stalled && (
        <details className="enq-mod-note">
          <summary>{extras.insight.stalled.waitingOn === "buyer" ? `No reply from the buyer for ${extras.insight.stalled.days} days` : `The buyer has waited ${extras.insight.stalled.days} days for your reply`}. Suggested follow-up</summary>
          <div className="enq-mod-actions">
            {extras.insight.stalled.followUps.map(f => <button key={f.tone} type="button" className="secondary" onClick={() => onUse(f.text)}>{f.tone}</button>)}
          </div>
        </details>
      )}
      {extras.insight.toneShift && (
        <p className="enq-mod-note" role="note">The {extras.insight.toneShift.by}&apos;s latest message sounds {extras.insight.toneShift.tone}. A calm, factual reply usually works best.</p>
      )}
      {flagged && (
        <div className={`enq-mod-note risk-${check.risk}`} role="status" aria-live="polite">
          <strong>{name} suggests a second look before you send</strong>
          <ul>{check.flags.map(f => <li key={f.category}><b>{label(f.category)}.</b> {f.explanation} {f.suggestion}{f.match ? ` (matched "${f.match}")` : ""}</li>)}</ul>
          {check.rewrites.length > 0 && (
            <>
              <p className="muted">Softer versions (check every word before you send):</p>
              <div className="enq-mod-actions">
                {check.rewrites.map(r => <button key={r.tone} type="button" className="secondary" onClick={() => onUse(r.text)}>Use {r.tone}</button>)}
              </div>
            </>
          )}
        </div>
      )}
      <details className="enq-mod-templates">
        <summary>Message templates</summary>
        <label>Scenario
          <select value={scenario} onChange={e => setScenario(e.target.value)}>
            <option value="">All</option>
            {Object.entries(extras.scenarios).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <ul className="enq-mod-list">
          {templates.map(t => (
            <li key={t.id}>
              <span>{t.label}</span>
              <button type="button" className="secondary" onClick={() => onUse(t.body)}>Use</button>
            </li>
          ))}
        </ul>
        <p className="muted">Fill in the [brackets] before you send. Templates make no promises and give no legal or financial advice.</p>
      </details>
    </section>
  );
}
