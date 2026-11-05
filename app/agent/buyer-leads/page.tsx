"use client";
import { useEffect, useState } from "react";
import "../../styles/buyer-leads.css";

type Signal = { label: string; points: number; kind: string };
type Lead = {
  enquiryId: string; buyerName: string; listingTitle: string; probability: number; tier: "red" | "yellow" | "green"; closed: boolean; confidence: string;
  signals: Signal[]; overdue: boolean; daysSinceContact?: number;
  profile: { experience: string; intent: string; speed: string; focus: string; notes: string[] };
  followUp: { window: string; text: string; confidence: string };
};
type View = {
  leads: Lead[]; summary: { red: number; yellow: number; green: number; closed: number };
  accuracy: { resolved: number; enough: boolean; brier?: number; hitRate?: number; byTier: { tier: string; n: number; conversionRate?: number }[] };
};

const TIER_LABEL = { red: "Hot", yellow: "Warm", green: "Cold" } as const;
const WINDOW_LABEL: Record<string, string> = { "24h": "Next 24 hours", this_week: "This week", two_weeks: "Within 2 weeks", none: "No contact needed" };
const SPEED: Record<string, string> = { fast: "Moves fast", steady: "Steady pace", slow: "Slow mover", not_yet: "No firm step yet" };
const FOCUS: Record<string, string> = { focused: "Focused on this property", comparing: "Comparing a few properties", shopping: "Shopping around" };

/** Buyer leads ranked by chance of an offer: hot first, with a reason, a suggested contact time and topic, and how well the scores have held up. */
export default function BuyerLeads() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch("/api/agent/buyer-leads").then(async r => {
      const b = (await r.json().catch(() => ({}))) as View & { error?: string };
      if (r.status === 401) return setError("Sign in to see your buyer leads.");
      if (!r.ok) return setError(b.error ?? "Could not load your buyer leads.");
      setView(b);
    }).catch(() => setError("Could not load your buyer leads."));
  }, []);

  return (
    <main className="bl">
      <h1>Buyer leads</h1>
      <p className="bl-meta">Estimated chance each buyer makes an offer, from what they have done on the platform. A guide, not a decision: you know your buyers best. <a href="/agent/workspace">Back to workspace</a> · <a href="/agent/leads">Lead inbox</a></p>
      {error && <p role="alert">{error}</p>}
      {!view && !error && <p className="bl-meta" role="status">Loading…</p>}
      {view && (
        <>
          <ul className="bl-summary" aria-label="Summary">
            <li><span>Hot, follow up now</span><strong>{view.summary.red}</strong></li>
            <li><span>Warm, this week</span><strong>{view.summary.yellow}</strong></li>
            <li><span>Cold, lower priority</span><strong>{view.summary.green}</strong></li>
            <li><span>Closed</span><strong>{view.summary.closed}</strong></li>
          </ul>
          {view.leads.length === 0 && <p className="bl-meta">No enquiries on your listings yet.</p>}
          <ul className="bl-list">
            {view.leads.map(l => (
              <li key={l.enquiryId} className={`bl-lead ${l.closed ? "closed" : l.tier}`}>
                <div className="bl-head">
                  <strong>{l.buyerName}</strong>
                  <span className={`bl-pill ${l.closed ? "closed" : l.tier}`}>{l.closed ? "Closed" : TIER_LABEL[l.tier]} · {l.probability}%</span>
                </div>
                <p className="bl-meta">{l.listingTitle} · {l.daysSinceContact === undefined ? "Not contacted yet" : `Last contact ${l.daysSinceContact} day${l.daysSinceContact === 1 ? "" : "s"} ago`}{l.overdue ? " · follow-up overdue" : ""}</p>
                <p className="bl-next">{l.followUp.text}</p>
                <p className="bl-meta">{WINDOW_LABEL[l.followUp.window]} · {l.followUp.confidence} confidence in this advice</p>
                <ul className="bl-chips" aria-label="Buyer profile">
                  <li>{l.profile.intent === "motivated" ? "Motivated" : "Exploring"}</li>
                  <li>{l.profile.experience === "returning" ? "Returning buyer" : "New to the platform"}</li>
                  <li>{SPEED[l.profile.speed]}</li>
                  <li>{FOCUS[l.profile.focus]}</li>
                </ul>
                <details>
                  <summary>Why this score ({l.confidence} confidence)</summary>
                  <ul className="bl-signals">
                    {l.signals.map((s, i) => <li key={i} className={s.points < 0 ? "neg" : ""}>{s.points > 0 ? "+" : ""}{s.points} {s.label}</li>)}
                    {l.profile.notes.map((t, i) => <li key={`n${i}`}>{t}</li>)}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
          <section className="bl-acc" aria-labelledby="acc-h">
            <h2 id="acc-h">How accurate are the scores?</h2>
            {view.accuracy.resolved === 0
              ? <p className="bl-meta">Not enough history yet. Scores are saved daily and compared with whether the buyer made an offer within 30 days.</p>
              : <p className="bl-meta">{view.accuracy.resolved} scores checked against results{view.accuracy.hitRate !== undefined ? `; ${view.accuracy.hitRate}% called correctly` : ""}.{view.accuracy.enough ? "" : " Too few results to adjust the scoring yet."}</p>}
            {view.accuracy.resolved > 0 && (
              <table>
                <thead><tr><th scope="col">Band</th><th scope="col">Scores</th><th scope="col">Made an offer</th></tr></thead>
                <tbody>{view.accuracy.byTier.map(t => <tr key={t.tier}><th scope="row">{TIER_LABEL[t.tier as keyof typeof TIER_LABEL]}</th><td>{t.n}</td><td>{t.conversionRate === undefined ? "–" : `${t.conversionRate}%`}</td></tr>)}</tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
  );
}
