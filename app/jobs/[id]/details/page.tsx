"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS } from "../../../listings/ui";

interface Job { id: string; kind: string; status: string; role: "owner" | "contractor"; counterpartName: string; address: string; addressHidden: boolean; usageRightsConfirmed: boolean }
interface Quote { id: string; amountCents: number; description: string; status: string; createdAt: string }
interface Review { rating: number; comment: string | null; reply: string | null }
const dollars = (c: number) => (c / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const QUOTE_STATUS: Record<string, string> = { sent: "Waiting for the owner", accepted: "Accepted", declined: "Declined", withdrawn: "Withdrawn" };
const REPORT_KINDS = [["no_show", "Did not turn up"], ["poor_work", "Poor work"], ["late", "Turned up late"], ["conduct", "Conduct"], ["other", "Something else"]] as const;

/** One job for its owner and contractor: where it is, usage rights, written quotes, then (owner) the rating and a report. */
export default function JobDetails() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [rightsText, setRightsText] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [rightsTick, setRightsTick] = useState(false);
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [kind, setKind] = useState<string>("no_show");
  const [detail, setDetail] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/assignments/${id}/trust`);
      const d = await r.json();
      if (!r.ok) { setError(r.status === 401 ? "Sign in to see this job." : r.status === 404 ? "Job not found." : d.error ?? "Could not load the job."); return; }
      setJob(d.job); setQuotes(d.quotes); setReview(d.review); setRightsText(d.usageRightsText);
    } catch { setError("Could not load the job."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function call(url: string, body: unknown, done: string) {
    setBusy(true); setError(""); setMsg("");
    const r = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) { setMsg(done); await load(); return true; }
    setError(d.error ?? "That did not work. Try again."); return false;
  }
  const finish = () => setBusy(false);
  const cents = Math.round(Number(amount.replace(/[$,\s]/g, "")) * 100);

  if (!job) return <main><h1>Job details</h1>{error ? <p role="alert">{error}</p> : <p className="muted" role="status">Loading…</p>}</main>;
  const owner = job.role === "owner";
  const live = job.status === "approved";
  const sent = quotes.find(q => q.status === "sent");

  return (
    <main>
      <h1>{job.kind} job with {job.counterpartName}</h1>
      <p><a href={owner ? "/dashboard" : `/jobs/${job.id}/chat`}>{owner ? "Back" : "Open the job chat"}</a></p>
      {error && <p role="alert">{error}</p>}
      {msg && <p role="status">{msg}</p>}

      <section><h2>Where</h2>
        <p style={{ overflowWrap: "anywhere" }}>{job.address}</p>
        {job.addressHidden && <p className="muted">The street address is shown once you accept the job.</p>}
      </section>

      {!owner && job.kind === "photographer" && (
        <section><h2>Photo usage rights</h2>
          {job.usageRightsConfirmed ? <p><span className="badge">Confirmed</span> You can upload photos.</p> : live ? (
            <div className="stack">
              <label><input type="checkbox" checked={rightsTick} onChange={e => setRightsTick(e.target.checked)} /> {rightsText}</label>
              <button type="button" disabled={busy || !rightsTick} onClick={() => void call(`/api/assignments/${job.id}/usage-rights`, { confirm: true }, "Usage rights confirmed.").finally(finish)}>Confirm and allow uploads</button>
            </div>
          ) : <p className="muted">Accept the job to confirm usage rights.</p>}
        </section>
      )}

      <section><h2>Quotes</h2>
        <p className="muted">For work beyond the listed price, the contractor sends a written quote. Work should not start until the owner accepts it.</p>
        {quotes.length === 0 && <p className="empty">No quotes on this job.</p>}
        <ul className="card-list">
          {quotes.map(q => (
            <li key={q.id} className="card">
              <p><strong>{dollars(q.amountCents)}</strong> · <span className="badge">{QUOTE_STATUS[q.status] ?? q.status}</span></p>
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{q.description}</p>
              {q.status === "sent" && live && (
                <div className="actions">
                  {owner ? (<>
                    <button type="button" disabled={busy} onClick={() => void call(`/api/quotes/${q.id}`, { action: "accept" }, "Quote accepted.").finally(finish)}>Accept quote</button>
                    <button type="button" className="secondary" disabled={busy} onClick={() => void call(`/api/quotes/${q.id}`, { action: "decline" }, "Quote declined.").finally(finish)}>Decline</button>
                  </>) : <button type="button" className="secondary" disabled={busy} onClick={() => void call(`/api/quotes/${q.id}`, { action: "withdraw" }, "Quote withdrawn.").finally(finish)}>Withdraw</button>}
                </div>
              )}
            </li>
          ))}
        </ul>
        {!owner && live && !sent && (
          <form className="stack" onSubmit={e => { e.preventDefault(); void call(`/api/assignments/${job.id}/quotes`, { amountCents: cents, description: desc }, "Quote sent to the owner.").then(ok => { if (ok) { setAmount(""); setDesc(""); } }).finally(finish); }}>
            <label>Amount (AUD)<input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" required placeholder="450.00" /></label>
            <label>What the work is and what the price includes<textarea value={desc} onChange={e => setDesc(e.target.value)} required minLength={10} maxLength={2000} /></label>
            <button type="submit" disabled={busy || !Number.isFinite(cents) || cents <= 0}>Send quote</button>
          </form>
        )}
      </section>

      {owner && job.status === "completed" && (
        <section><h2>Rate this contractor</h2>
          {review ? (
            <p>{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}{review.comment ? ` · ${review.comment}` : ""}{review.reply ? ` · Their reply: ${review.reply}` : ""}</p>
          ) : (
            <form className="stack" onSubmit={e => { e.preventDefault(); void call(`/api/assignments/${job.id}/review`, { rating, ...(comment.trim() ? { comment } : {}) }, "Thanks for your review.").finally(finish); }}>
              <fieldset><legend>Stars</legend>
                {[1, 2, 3, 4, 5].map(n => <label key={n}><input type="radio" name="rating" checked={rating === n} onChange={() => setRating(n)} /> {n}</label>)}
              </fieldset>
              <label>Comment (public, optional)<textarea value={comment} onChange={e => setComment(e.target.value)} maxLength={1500} /></label>
              <button type="submit" disabled={busy || rating === 0}>Post review</button>
            </form>
          )}
        </section>
      )}

      {owner && (job.status === "approved" || job.status === "completed") && (
        <section><h2>Report a problem</h2>
          <p className="muted">If the contractor did not turn up or the work was poor, tell staff. They review every report and can suspend a contractor.</p>
          <form className="stack" onSubmit={e => { e.preventDefault(); void call(`/api/assignments/${job.id}/complaint`, { kind, details: detail }, "Reported. Staff will review it.").then(ok => { if (ok) setDetail(""); }).finally(finish); }}>
            <label>What went wrong
              <select value={kind} onChange={e => setKind(e.target.value)}>{REPORT_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </label>
            <label>Details<textarea value={detail} onChange={e => setDetail(e.target.value)} required minLength={10} maxLength={1500} /></label>
            <button type="submit" disabled={busy}>Send report</button>
          </form>
        </section>
      )}
    </main>
  );
}
