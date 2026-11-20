"use client";
import { useCallback, useEffect, useState } from "react";
import "../styles/agent-marketplace.css";
import { JSON_HEADERS } from "../listings/ui";
import { Avatar, Stars } from "../marketplace/agents/ui";
import { DAYS, STATUS_TEXT, TRADE_OPTIONS, dollars, tradeLabel, type Window } from "./shared";

type Card = { contractorNo: number; headline: string; verified: boolean; ratingAvg: number | null; ratingCount: number; completed: number; photoUrl: string | null; testimonial: string | null };
type Result = { card: Card | null; id: string; name: string; trade: string; availableNow: boolean; callOutCents: number | null; hours: string | Window[]; timeZone: string; phone: string; email: string | null; note: string | null; suburbs: string[]; postcodes: string[] };
type Reply = { contractorName: string; businessName: string | null; status: string; etaMinutes: number | null; note: string | null; phone: string | null; email: string | null };
type Req = { id: string; number: number; jobNumber: number | null; assignmentId: string | null; round: number; role: string; status: string; trade: string; description: string; suburb: string | null; postcode: string | null; createdAt: string; addressText: string | null; replies: Reply[] };
type Listing = { id: string; title?: string; addressText?: string };

const hoursText = (h: string | Window[]) => (typeof h === "string" ? h : h.map(w => `${w.days.map(d => DAYS[d]).join(" ")} ${w.start}–${w.end}`).join(" · "));

/** Emergency contractors: search by trade and suburb (available now first), or send one urgent request that Elena passes to the contractors available now. */
export default function EmergencyPage() {
  const [trade, setTrade] = useState("");
  const [suburb, setSuburb] = useState("");
  const [postcode, setPostcode] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [searchErr, setSearchErr] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [form, setForm] = useState({ trade: "plumber", listingId: "", description: "", addressText: "", suburb: "", postcode: "", callbackPhone: "", propertyKind: "other" });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState("");
  const [error, setError] = useState("");

  const search = useCallback(async (t: string, s: string, p: string) => {
    setSearchErr("");
    const qs = new URLSearchParams(); if (t) qs.set("trade", t); if (s.trim()) qs.set("suburb", s.trim()); if (p.trim()) qs.set("postcode", p.trim());
    try {
      const r = await fetch(`/api/emergency/search?${qs}`);
      if (r.status === 401) { setSignedOut(true); setResults([]); return; }
      if (!r.ok) { setSearchErr("Could not search right now."); return; }
      setResults((await r.json()).results);
    } catch { setSearchErr("Could not search right now."); }
  }, []);
  const loadReqs = useCallback(async () => {
    try { const r = await fetch("/api/emergency/requests"); if (r.ok) setReqs(((await r.json()).requests as Req[]).filter(x => x.role === "requester")); } catch { /* the list is optional */ }
  }, []);
  useEffect(() => {
    void search("", "", "");
    void loadReqs();
    fetch("/api/listings/mine").then(async r => { if (r.ok) setListings((await r.json()).listings ?? []); }).catch(() => undefined);
  }, [search, loadReqs]);

  async function send(e: React.FormEvent) {
    e.preventDefault(); setError(""); setSent(""); setSending(true);
    const body = { ...form, listingId: form.listingId || undefined, callbackPhone: form.callbackPhone || undefined };
    const r = await fetch("/api/emergency/requests", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setSending(false);
    if (r.status === 401) { setError("Sign in to send an urgent request."); return; }
    if (!r.ok) { setError(d.error ?? "Could not send the request."); return; }
    setSent(`EMG-${d.number}: ${d.message}`); setForm(f => ({ ...f, description: "" })); await loadReqs();
  }
  async function cancel(id: string) {
    await fetch(`/api/emergency/requests/${id}/cancel`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    await loadReqs();
  }

  return (
    <main className="emg-page">
      <header className="emg-head">
        <h1>Emergency contractors</h1>
        <p className="emg-danger" role="note"><strong>In danger?</strong> Call 000 first. For gas leaks, fire or electric shock leave the property.</p>
        <p className="muted">Tell Elena what is wrong and she asks the contractors available right now. Or search below and call one yourself. You pay the contractor directly.</p>
      </header>

      <form className="emg-panel emg-form" onSubmit={e => void send(e)} aria-labelledby="emg-urgent">
        <h2 id="emg-urgent">Send an urgent request</h2>
        <label className="field"><span>What kind of help?</span>
          <select value={form.trade} onChange={e => setForm({ ...form, trade: e.target.value })}>{TRADE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
        </label>
        <label className="field"><span>What is the problem?</span>
          <textarea rows={4} maxLength={1000} required minLength={10} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Water is coming through the ceiling in the kitchen" />
        </label>
        {listings.length > 0 && (
          <label className="field"><span>Which property?</span>
            <select value={form.listingId} onChange={e => setForm({ ...form, listingId: e.target.value })}>
              <option value="">Another address</option>
              {listings.map(l => <option key={l.id} value={l.id}>{l.title ?? l.addressText ?? l.id}</option>)}
            </select>
          </label>
        )}
        {!form.listingId && (
          <>
            <label className="field"><span>Street address</span><input value={form.addressText} maxLength={200} onChange={e => setForm({ ...form, addressText: e.target.value })} required /></label>
            <div className="emg-two">
              <label className="field"><span>Suburb</span><input value={form.suburb} maxLength={80} onChange={e => setForm({ ...form, suburb: e.target.value })} required /></label>
              <label className="field"><span>Postcode</span><input inputMode="numeric" maxLength={4} value={form.postcode} onChange={e => setForm({ ...form, postcode: e.target.value.replace(/\D/g, "") })} /></label>
            </div>
            <label className="field"><span>This is</span>
              <select value={form.propertyKind} onChange={e => setForm({ ...form, propertyKind: e.target.value })}><option value="other">A property</option><option value="rental">A rental</option><option value="sale">A property for sale</option></select>
            </label>
          </>
        )}
        <label className="field"><span>Your phone, optional</span><input type="tel" inputMode="tel" value={form.callbackPhone} onChange={e => setForm({ ...form, callbackPhone: e.target.value })} /></label>
        <p className="muted emg-hint">Contractors see the suburb first. Your street address and phone go only to the one who accepts. Elena sends a fixed message and writes nothing on your behalf beyond what you type here.</p>
        <button type="submit" disabled={sending}>{sending ? "Sending…" : "Ask contractors now"}</button>
        {error && <p role="alert" className="emg-alert">{error}</p>}
        {sent && <p role="status" className="emg-ok">{sent}</p>}
      </form>

      {reqs.length > 0 && (
        <section className="emg-panel" aria-labelledby="emg-mine">
          <h2 id="emg-mine">Your urgent requests</h2>
          <ul className="emg-list">
            {reqs.map(r => (
              <li key={r.id} className="emg-item">
                <div className="emg-top"><strong>{r.jobNumber ? `JOB-${r.jobNumber}` : `EMG-${r.number}`} · {tradeLabel(r.trade)}</strong><span className={`emg-badge st-${r.status}`}>{STATUS_TEXT[r.status] ?? r.status}</span></div>
                <p className="muted">{[r.suburb, r.postcode].filter(Boolean).join(" ")} · {new Date(r.createdAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}</p>
                <p className="emg-quote">“{r.description}”</p>
                {r.replies.length === 0 ? <p className="muted">{r.status === "open" ? "No contractor was available to ask. Use the search below." : ""}</p> : (
                  <ul className="emg-replies">
                    {r.replies.map((c, i) => (
                      <li key={i}>
                        <strong>{c.businessName ?? c.contractorName}</strong> <span className={`emg-badge st-${c.status}`}>{STATUS_TEXT[c.status] ?? c.status}</span>
                        {c.etaMinutes && <span className="muted"> · about {c.etaMinutes} min away</span>}
                        {c.status === "accepted" && <p className="emg-contact">{c.phone && <a href={`tel:${c.phone}`}>{c.phone}</a>}{c.email && <> · <a href={`mailto:${c.email}`}>{c.email}</a></>} · Pay them directly.</p>}
                      </li>
                    ))}
                  </ul>
                )}
                {r.status === "accepted" && r.assignmentId && <p><a href={`/jobs/${r.assignmentId}`}>Open the job</a> to chat, add photos and leave feedback.</p>}
                {r.status === "open" && r.round > 1 && <p className="muted">Elena has asked more contractors (round {r.round} of 3).</p>}
                {r.status === "open" && <button type="button" className="secondary" onClick={() => void cancel(r.id)}>Cancel request</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="emg-panel" aria-labelledby="emg-search">
        <h2 id="emg-search">Find an emergency contractor</h2>
        <form className="emg-search" onSubmit={e => { e.preventDefault(); void search(trade, suburb, postcode); }}>
          <label className="field"><span>Trade</span><select value={trade} onChange={e => setTrade(e.target.value)}><option value="">Any trade</option>{TRADE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
          <label className="field"><span>Suburb</span><input value={suburb} onChange={e => setSuburb(e.target.value)} /></label>
          <label className="field"><span>Postcode</span><input inputMode="numeric" maxLength={4} value={postcode} onChange={e => setPostcode(e.target.value.replace(/\D/g, ""))} /></label>
          <button type="submit">Search</button>
        </form>
        {searchErr && <p role="alert" className="emg-alert">{searchErr}</p>}
        {signedOut && <p className="empty"><a href="/login">Sign in</a> to see contractors and their contact details.</p>}
        {!signedOut && results === null && !searchErr && <p className="muted" role="status">Loading…</p>}
        {!signedOut && results && results.length === 0 && <p className="empty">No emergency contractors match. Try another suburb or trade.</p>}
        {results && results.length > 0 && (
          <ul className="emg-list">
            {results.map(c => (
              <li key={`${c.id}-${c.trade}`} className="emg-item">
                <div className="emg-top">
                  <div className="emg-who">
                    <Avatar name={c.name} photoUrl={c.card?.photoUrl ?? null} />
                    <div>
                      <strong>{c.card ? <a href={`/contractors/${c.card.contractorNo}`}>{c.name}</a> : c.name}</strong>
                      {c.card && <p className="muted">CON-{c.card.contractorNo}{c.card.verified ? " · Licence checked" : ""}</p>}
                    </div>
                  </div>
                  <span className={`emg-badge ${c.availableNow ? "st-accepted" : "st-closed"}`}>{c.availableNow ? "Available now" : "Not available now"}</span>
                </div>
                {c.card && <p className="emg-rating"><Stars value={c.card.ratingAvg} count={c.card.ratingCount} />{c.card.completed > 0 && <span className="muted"> · {c.card.completed} {c.card.completed === 1 ? "job" : "jobs"} completed</span>}</p>}
                {c.card?.headline && <p>{c.card.headline}</p>}
                {c.card?.testimonial && <p className="emg-quote">“{c.card.testimonial}”</p>}
                <p className="muted">{tradeLabel(c.trade)} · Call-out {dollars(c.callOutCents)}</p>
                <p className="muted">Hours ({c.timeZone}): {hoursText(c.hours)}</p>
                <p className="muted">Covers: {[...c.suburbs, ...c.postcodes].join(", ") || "—"}</p>
                {c.note && <p>{c.note}</p>}
                <p className="emg-contact"><a href={`tel:${c.phone}`}>{c.phone}</a>{c.email && <> · <a href={`mailto:${c.email}`}>{c.email}</a></>}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
