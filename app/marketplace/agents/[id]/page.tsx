"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import "../../../styles/agent-marketplace.css";
import { Avatar, JSON_HEADERS, Stars, aud, monthLabel } from "../ui";
import { BookingModal } from "./booking-modal";

type Agent = {
  id: string; name: string; headline: string; photoUrl: string | null; specialties: string[]; languages: string[]; yearsExperience: number | null; consultModes: string[]; consultMinutes: number;
  areas: string[]; postcodes: string[]; rating: number | null; reviewCount: number; sales: number; bio: string; timezone: string;
  ratings: { count: number; average: number | null; distribution: Record<string, number> };
  reviews: { rating: number; title: string; body: string; createdAt: string; reviewer: string }[];
  portfolio: { source: "platform" | "agent"; suburb: string; propertyType: string; month: string; priceCents?: number; note?: string }[];
};
type Viewer = { signedIn: boolean; userType: string | null; canReview: boolean };

/** Public agent profile: bio, portfolio, reviews, and the booking dialog. */
export default function AgentProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [viewer, setViewer] = useState<Viewer>({ signedIn: false, userType: null, canReview: false });
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [booking, setBooking] = useState(false);
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/marketplace/agents/${id}`);
      if (r.status === 404) return setState("missing");
      if (!r.ok) return setState("error");
      const d = await r.json();
      setAgent(d.agent); setViewer(d.viewer); setState("ready");
    } catch { setState("error"); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (state === "ready" && new URLSearchParams(window.location.search).get("book") === "1") setBooking(true); }, [state]);

  async function review(e: FormEvent) {
    e.preventDefault();
    if (!rating) return setMsg("Choose a star rating.");
    setBusy(true); setMsg("");
    try {
      const r = await fetch(`/api/marketplace/agents/${id}/reviews`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ rating, title, body: text }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setRating(0); setTitle(""); setText(""); setMsg("Thank you. Your review is live."); await load(); } else setMsg(d.error ?? "Could not save your review.");
    } catch { setMsg("Could not save your review."); } finally { setBusy(false); }
  }

  if (state === "loading") return <main className="ma"><p className="muted">Loading agent…</p></main>;
  if (state === "missing") return <main className="ma"><div className="ma-state"><h1>Agent not found</h1><p>This agent is not listed.</p><p><a className="button" href="/marketplace/agents">Browse agents</a></p></div></main>;
  if (state === "error" || !agent) return <main className="ma"><p role="alert" className="ma-error">Could not load this agent.</p><p><button type="button" onClick={() => { setState("loading"); void load(); }}>Try again</button></p></main>;

  const canBook = viewer.userType === "buyer" || viewer.userType === "owner";
  const bookable = agent.consultModes.length > 0;
  return (
    <main className="ma">
      <p style={{ margin: 0 }}><a href="/marketplace/agents">← All agents</a></p>
      <section className="ma-profile-head" aria-labelledby="ma-name">
        <div className="ma-head">
          <Avatar name={agent.name} photoUrl={agent.photoUrl} large />
          <div><h1 id="ma-name">{agent.name}</h1>{agent.headline && <p className="ma-headline">{agent.headline}</p>}<Stars value={agent.rating} count={agent.reviewCount} /></div>
        </div>
        <div className="actions" style={{ margin: 0 }}>
          {bookable ? <button type="button" onClick={() => setBooking(true)}>Book a consultation</button> : <span className="muted">Not taking consultation bookings right now.</span>}
        </div>
      </section>

      <section className="ma-section" aria-labelledby="ma-about">
        <h2 id="ma-about">About</h2>
        {agent.bio ? <p style={{ margin: 0, whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{agent.bio}</p> : <p className="muted" style={{ margin: 0 }}>No bio yet.</p>}
        <ul className="ma-meta">
          {agent.yearsExperience !== null && <li>{agent.yearsExperience} years experience</li>}
          {agent.sales > 0 && <li>{agent.sales} {agent.sales === 1 ? "sale" : "sales"}</li>}
          {bookable && <li>{agent.consultMinutes} min free {agent.consultModes.join(" or ")} consultation</li>}
        </ul>
        {agent.specialties.length > 0 && <ul className="ma-tags" aria-label="Specialties">{agent.specialties.map(s => <li key={s} className="ma-tag">{s}</li>)}</ul>}
        {agent.languages.length > 0 && <p className="muted" style={{ margin: 0 }}>Speaks {agent.languages.join(", ")}</p>}
        {(agent.areas.length > 0 || agent.postcodes.length > 0) && <p className="muted" style={{ margin: 0 }}>Works in {[...agent.areas, ...agent.postcodes].join(", ")}</p>}
      </section>

      <section className="ma-section" aria-labelledby="ma-port">
        <h2 id="ma-port">Recent sales</h2>
        {agent.portfolio.length === 0 ? <p className="muted" style={{ margin: 0 }}>No sales to show yet.</p> : (
          <ul className="ma-portfolio">
            {agent.portfolio.map((p, i) => (
              <li key={i}>
                <div><strong>{p.suburb}</strong> <span className="muted" style={{ textTransform: "capitalize" }}>· {p.propertyType}</span>{p.priceCents ? <> · {aud(p.priceCents)}</> : null}{p.note ? <> · {p.note}</> : null}</div>
                <span className="when">{monthLabel(p.month)}</span>
                <p className="src">{p.source === "platform" ? "Sold through this platform" : "Added by the agent"}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ma-section" aria-labelledby="ma-rev">
        <h2 id="ma-rev">Reviews</h2>
        {agent.ratings.count === 0 ? <p className="muted" style={{ margin: 0 }}>No reviews yet.</p> : (
          <>
            <div className="ma-dist" aria-label="Rating breakdown">
              {[5, 4, 3, 2, 1].map(n => (
                <div key={n}><span>{n} ★</span><span className="bar"><span style={{ width: `${(agent.ratings.distribution[n]! / agent.ratings.count) * 100}%` }} /></span><span>{agent.ratings.distribution[n]}</span></div>
              ))}
            </div>
            <ul className="ma-reviews">
              {agent.reviews.map((r, i) => (
                <li key={i}>
                  <Stars value={r.rating} />
                  {r.title && <strong>{r.title}</strong>}
                  {r.body && <p>{r.body}</p>}
                  <span className="muted">{r.reviewer} · {new Intl.DateTimeFormat("en-AU", { dateStyle: "medium" }).format(new Date(r.createdAt))}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {viewer.canReview ? (
          <form className="ma-form" onSubmit={review}>
            <h3>Review {agent.name}</h3>
            <fieldset className="ma-star-input"><legend className="muted">Your rating</legend>
              {[1, 2, 3, 4, 5].map(n => <label key={n} className={n <= rating ? "on" : ""}><input type="radio" name="rating" value={n} checked={rating === n} onChange={() => setRating(n)} /><span aria-hidden="true">★</span><span className="sr-only">{n} {n === 1 ? "star" : "stars"}</span></label>)}
            </fieldset>
            <label className="field">Headline <span className="hint">Optional</span><input value={title} onChange={e => setTitle(e.target.value)} maxLength={80} /></label>
            <label className="field">Your experience <span className="hint">Optional. Your name shows as first name and initial.</span><textarea rows={4} value={text} onChange={e => setText(e.target.value)} maxLength={1500} /></label>
            {msg && <p role="status" className={msg.startsWith("Thank") ? "ma-ok" : "ma-error"}>{msg}</p>}
            <div className="actions" style={{ margin: 0 }}><button type="submit" disabled={busy}>{busy ? "Saving…" : "Post review"}</button></div>
          </form>
        ) : <p className="muted" style={{ margin: 0 }}>{viewer.signedIn ? "You can review this agent after a consultation with them, or after dealing with them on a listing." : <><a href="/login?as=buyer">Sign in</a> to review an agent you have worked with.</>}</p>}
        {!viewer.canReview && msg && <p role="status" className="ma-ok">{msg}</p>}
      </section>

      {booking && <BookingModal agentId={agent.id} agentName={agent.name} signedIn={viewer.signedIn} canBook={canBook} onClose={() => setBooking(false)} />}
    </main>
  );
}
