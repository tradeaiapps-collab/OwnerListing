"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import "../../styles/enquiries.css";
import "../../styles/agent-workspace.css";

type Lead = {
  enquiryId: string; buyerId: string; buyerName: string; listingTitle: string; score: number; band: "hot" | "warm" | "cold";
  reasons: string[]; nextAction: string; stage: string; followUpAt?: string; overdue: boolean; offerStatus?: string; notes: number;
  autoScore?: number; fitPercent?: number; overridden?: boolean;
};
type Perf = {
  listings: number; enquiries: number; hot: number; unanswered: number; overdue: number; openOffers: number; pipelineCents: number;
  closedDeals: number; closedCents: number; acceptanceRate?: number; medianResponseMinutes?: number; peers?: { acceptanceRate?: number; medianResponseMinutes?: number };
};
type Forecast = { expectedClosings: number; expectedCents: number; ratePercent: number; basis: string };
type Note = { kind: string; body: string; createdAt: string };
type Answer = { name: string; text: string; suggestions: string[] };

const STAGES = ["new", "contacted", "viewing", "offer", "won", "lost"];
const KINDS = ["note", "call", "email", "meeting", "preference"];
const aud = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
const mins = (m: number) => (m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`);

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as T & { error?: string } };
}
const json = (method: string, data: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

type Stay = { id: string; listingId: string; listingTitle: string; portal: string; checkIn: string; checkOut: string; status: "confirmed" | "conflict"; source: string };
const PORTAL_NAMES: Record<string, string> = { airbnb: "Airbnb", vrbo: "VRBO", booking_com: "Booking.com" };
const stayDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" });

/** Agent workspace: performance, ranked leads with pipeline stages, a private client log, and the assistant. */
export default function AgentWorkspace() {
  const [data, setData] = useState<{ performance: Perf; forecast: Forecast; leads: Lead[] } | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Lead | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [stays, setStays] = useState<Stay[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await call<{ performance: Perf; forecast: Forecast; leads: Lead[] }>("/api/agent/workspace");
      if (r.status === 401) return setError("Sign in to use your workspace.");
      if (!r.ok) return setError(r.body.error ?? "Could not load your workspace.");
      setError(""); setData(r.body);
    } catch { setError("Could not load your workspace."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void call<{ stays: Stay[] }>("/api/agent/blocked-dates").then(r => { if (r.ok) setStays(r.body.stays); }).catch(() => undefined);
  }, []);

  async function ask(q: string, buyerId?: string) {
    if (!q.trim()) return;
    setBusy(true);
    const r = await call<Answer>("/api/agent/workspace/assistant", json("POST", { question: q, ...(buyerId ? { buyerId } : {}) })).catch(() => null);
    setBusy(false);
    setAnswer(r?.ok ? r.body : { name: "Assistant", text: r?.body.error ?? "I could not answer that just now.", suggestions: [] });
  }
  async function openClient(l: Lead) {
    setOpen(l); setNotes([]);
    const r = await call<{ notes: Note[] }>(`/api/agent/workspace/clients/${l.buyerId}`).catch(() => null);
    if (r?.ok) setNotes(r.body.notes);
  }
  async function setStage(l: Lead, stage: string, followUpAt: string) {
    const r = await call(`/api/agent/workspace/leads/${l.enquiryId}`, json("PUT", { stage, followUpAt: followUpAt || null }));
    if (!r.ok) setError(r.body.error ?? "Could not update the lead."); else await load();
  }
  async function saveOverride(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!open) return;
    const f = new FormData(e.currentTarget);
    const r = await call(`/api/agent/workspace/leads/${open.enquiryId}/override`, json("PUT", { score: Number(f.get("score")), reason: String(f.get("reason") ?? "") }));
    if (!r.ok) return setError(r.body.error ?? "Could not save your score.");
    setError(""); await load();
  }
  async function clearOverride() {
    if (!open) return;
    const r = await call(`/api/agent/workspace/leads/${open.enquiryId}/override`, { method: "DELETE" });
    if (!r.ok) return setError(r.body.error ?? "Could not remove your score.");
    setError(""); await load();
  }
  async function addNote(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!open) return;
    const f = new FormData(e.currentTarget), body = String(f.get("body") ?? "");
    const r = await call(`/api/agent/workspace/clients/${open.buyerId}`, json("POST", { kind: f.get("kind"), body }));
    if (!r.ok) return setError(r.body.error ?? "Could not save the note.");
    e.currentTarget.reset(); setError(""); await openClient(open); await load();
  }

  const p = data?.performance, f = data?.forecast;
  return (
    <main className="aw">
      <h1>Agent workspace</h1>
      <p><a href="/agent/listings">Appointed listings</a> · <a href="/agent/appointments">Invitations</a> · <a href="/agent/team">Team</a> · <a href="/agent/reports">Reports</a> · <a href="/agent/my-performance">My performance</a> · <a href="/agent/market-forecast">Market forecast</a> · <a href="/agent/automations">Automations</a> · <a href="/agent/marketplace">Marketplace profile</a> · <a href="/agent/rates">Loan rates</a> · <a href="/agent/videos">Videos</a></p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p className="muted" role="status">Loading…</p>}
      {p && f && (
        <>
          <ul className="aw-kpis" aria-label="Performance">
            <li className="aw-kpi"><span>Accepted offers</span><strong>{p.closedDeals}</strong><small>{aud(p.closedCents)}</small></li>
            <li className="aw-kpi"><span>Open pipeline</span><strong>{aud(p.pipelineCents)}</strong><small>{p.openOffers} open offer{p.openOffers === 1 ? "" : "s"}</small></li>
            <li className="aw-kpi"><span>Acceptance rate</span><strong>{p.acceptanceRate === undefined ? "–" : `${p.acceptanceRate}%`}</strong><small>{p.peers?.acceptanceRate === undefined ? "Peer figure needs more agents" : `Other agents ${p.peers.acceptanceRate}%`}</small></li>
            <li className="aw-kpi"><span>Median first reply</span><strong>{p.medianResponseMinutes === undefined ? "–" : mins(p.medianResponseMinutes)}</strong><small>{p.peers?.medianResponseMinutes === undefined ? "Peer figure needs more agents" : `Other agents ${mins(p.peers.medianResponseMinutes)}`}</small></li>
            <li className="aw-kpi"><span>Hot leads</span><strong>{p.hot}</strong><small>{p.enquiries} in total</small></li>
            <li className="aw-kpi"><span>Need a first reply</span><strong>{p.unanswered}</strong><small>{p.overdue} follow-up{p.overdue === 1 ? "" : "s"} overdue</small></li>
            <li className="aw-kpi"><span>Forecast, next month</span><strong>{f.expectedClosings} closing{f.expectedClosings === 1 ? "" : "s"}</strong><small>{aud(f.expectedCents)} at {f.ratePercent}% ({f.basis})</small></li>
            <li className="aw-kpi"><span>Appointed listings</span><strong>{p.listings}</strong></li>
          </ul>
          <div className="aw-main">
            <section className="aw-card" aria-labelledby="blocked-h">
              <h2 id="blocked-h">Portal bookings and blocked dates</h2>
              {stays.length === 0 && <p className="empty">Nothing booked on the portals for your listings.</p>}
              <ul className="aw-leads">
                {stays.map(b => (
                  <li key={b.id} className="aw-lead">
                    <div className="aw-lead-head">
                      <a href={`/listings/${b.listingId}/syndication`}>{b.listingTitle}</a>
                      {b.status === "conflict" && <span className="aw-score warm">Clash</span>}
                    </div>
                    <p className="aw-meta">{stayDate(b.checkIn)} to {stayDate(b.checkOut)} · {PORTAL_NAMES[b.portal] ?? b.portal}{b.source === "ical" ? " · imported" : ""}</p>
                  </li>
                ))}
              </ul>
            </section>
            <section className="aw-card" aria-labelledby="leads-h">
              <h2 id="leads-h">Leads, best first</h2>
              {data.leads.length === 0 && <p className="empty">No enquiries on your listings yet.</p>}
              <ul className="aw-leads">
                {data.leads.map(l => (
                  <li key={l.enquiryId} className={`aw-lead${open?.enquiryId === l.enquiryId ? " is-open" : ""}`}>
                    <div className="aw-lead-head">
                      <button type="button" onClick={() => void openClient(l)} aria-expanded={open?.enquiryId === l.enquiryId}>{l.buyerName}</button>
                      <span className={`aw-score ${l.band}`} title={l.reasons.join(", ")}>{l.score} {l.band}{l.overridden ? " (yours)" : ""}</span>
                    </div>
                    <p className="aw-meta">{l.listingTitle}{l.offerStatus ? ` · offer ${l.offerStatus.replace("_", " ")}` : ""}</p>
                    <p className="aw-meta">{l.nextAction}</p>
                    <div className="aw-controls">
                      <label>Stage
                        <select value={l.stage} onChange={e => void setStage(l, e.target.value, l.followUpAt ?? "")}>{STAGES.map(s => <option key={s}>{s}</option>)}</select>
                      </label>
                      <label>Follow up
                        <input type="date" value={l.followUpAt ?? ""} onChange={e => void setStage(l, l.stage, e.target.value)} />
                      </label>
                    </div>
                    {l.overdue && <p className="aw-overdue" role="status">Follow-up overdue</p>}
                  </li>
                ))}
              </ul>
              {open && (
                <section aria-labelledby="client-h">
                  <h2 id="client-h">{open.buyerName}: private log</h2>
                  <p className="aw-meta">Only you can see this. {open.reasons.join(", ")}.</p>
                  {(() => {
                    const cur = data.leads.find(x => x.enquiryId === open.enquiryId) ?? open;
                    return (
                      <form className="aw-form" onSubmit={e => void saveOverride(e)} key={`${cur.enquiryId}:${cur.score}:${cur.overridden}`}>
                        <p className="aw-meta">Automatic score {cur.autoScore ?? cur.score}{cur.fitPercent !== undefined ? ` · ${cur.fitPercent}% match to the buyer's saved searches` : ""}. Set your own if you know better; it replaces the automatic score until you remove it.</p>
                        <label>Your score (0-100) <input name="score" type="number" min={0} max={100} step={1} defaultValue={cur.score} required /></label>
                        <label>Why <input name="reason" maxLength={300} minLength={3} required placeholder="e.g. pre-approved, ready to offer" /></label>
                        <div className="aw-controls">
                          <button type="submit">Save my score</button>
                          {cur.overridden && <button type="button" className="aw-chips-btn" onClick={() => void clearOverride()}>Use automatic score</button>}
                        </div>
                      </form>
                    );
                  })()}
                  <button type="button" className="aw-chips-btn" onClick={() => void ask("Summarise this client", open.buyerId)}>Ask {answer?.name ?? "the assistant"} to summarise</button>
                  <form className="aw-form" onSubmit={e => void addNote(e)}>
                    <label>Type <select name="kind">{KINDS.map(k => <option key={k}>{k}</option>)}</select></label>
                    <label>Details <textarea name="body" maxLength={2000} required /></label>
                    <button type="submit">Add to log</button>
                  </form>
                  {notes.length === 0 ? <p className="empty">Nothing logged yet.</p> : (
                    <ul className="aw-notes">{notes.map((n, i) => <li key={i}><small>{n.kind} · {n.createdAt.slice(0, 10)}</small>{n.body}</li>)}</ul>
                  )}
                </section>
              )}
            </section>
            <aside className="aw-card aw-elena" aria-labelledby="elena-h">
              <div className="aw-elena-head">
                <img src="/assistant/elena-pose-tablet.jpg" alt="" width={56} height={56} />
                <div><h2 id="elena-h" style={{ margin: 0 }}>{answer?.name ?? "Elena"}</h2><small>AI assistant, not a licensed agent</small></div>
              </div>
              <p className="aw-answer" role="status" aria-live="polite">{busy ? "Looking at your numbers…" : answer?.text ?? "Ask me about your performance, your leads, or what may close next month."}</p>
              <div className="aw-chips">
                {(answer?.suggestions?.length ? answer.suggestions : ["How am I performing?", "Which leads should I call first?", "What will close next month?"]).map(s => (
                  <button key={s} type="button" onClick={() => void ask(s)}>{s}</button>
                ))}
              </div>
              <form className="aw-ask" onSubmit={e => { e.preventDefault(); void ask(question, open?.buyerId); setQuestion(""); }}>
                <input value={question} onChange={e => setQuestion(e.target.value)} maxLength={500} aria-label="Ask the assistant" placeholder="Ask a question" />
                <button type="submit" disabled={busy}>Ask</button>
              </form>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
