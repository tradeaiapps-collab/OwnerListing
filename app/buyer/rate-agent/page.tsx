"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/agent-marketplace.css";
import "../../styles/agent-performance.css";

type Sale = { listingId: string; address: string; agentName: string };

/** After a purchase: the buyer rates the agent who handled the sale, once per sale. */
export default function RateAgent() {
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/ratings/pending");
      if (r.status === 401) return setError("Sign in to rate your agent.");
      if (!r.ok) throw new Error();
      setSales((await r.json()).sales);
    } catch { setError("Could not load your sales."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <main className="ap">
      <div>
        <h1>Rate your agent</h1>
        <p className="ap-lead">Tell us how the agent handled your purchase. Owners see your rating and comment, never your name.</p>
      </div>
      {error && <p role="alert" className="ap-error">{error} {error.startsWith("Sign in") && <a href="/login?as=buyer">Sign in</a>}</p>}
      {msg && <p role="status" className="ap-ok">{msg}</p>}
      {!sales && !error && <p className="ap-state" role="status">Loading…</p>}
      {sales && sales.length === 0 && <div className="ap-state"><p>Nothing to rate right now. You can rate an agent once an offer of yours has been accepted.</p></div>}
      {sales?.map(s => <RateForm key={s.listingId} sale={s} onDone={m => { setMsg(m); void load(); }} />)}
    </main>
  );
}

function RateForm({ sale, onDone }: { sale: Sale; onDone: (m: string) => void }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating === 0) { setErr("Choose 1 to 5 stars."); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/ratings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listingId: sale.listingId, rating, comment }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Could not save your rating.");
      onDone(`Thanks. Your rating of ${sale.agentName} was saved.`);
    } catch (x) { setErr(x instanceof Error ? x.message : "Could not save your rating."); } finally { setBusy(false); }
  }
  return (
    <form className="ap-section ap-rate-form" onSubmit={submit}>
      <h2>{sale.address}</h2>
      <p className="muted" style={{ margin: 0 }}>Agent: {sale.agentName}</p>
      <fieldset className="ma-star-input" style={{ border: 0, padding: 0 }}>
        <legend>Your rating</legend>
        {[1, 2, 3, 4, 5].map(n => (
          <label key={n} className={n <= rating ? "on" : ""}><input type="radio" name={`r-${sale.listingId}`} value={n} checked={rating === n} onChange={() => setRating(n)} /><span aria-hidden="true">★</span><span className="sr-only">{n} star{n === 1 ? "" : "s"}</span></label>
        ))}
      </fieldset>
      <label>Comment (optional)<textarea value={comment} maxLength={1000} onChange={e => setComment(e.target.value)} /></label>
      {err && <p role="alert" className="ap-error">{err}</p>}
      <div className="actions"><button type="submit" disabled={busy}>{busy ? "Saving…" : "Submit rating"}</button></div>
    </form>
  );
}
