"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { AiSummary, ComparisonRow } from "../../../../src/domain/offer-analysis";
import { JSON_HEADERS } from "../../ui";
import "../../../styles/offers.css";

const dollars = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

/** Owner-only offer comparison. The table is calculated without AI. The AI summary is optional and shows "AI unavailable" while the engine is off. */
export default function OfferAnalysis() {
  const { id } = useParams<{ id: string }>();
  const [rows, setRows] = useState<ComparisonRow[] | null>(null);
  const [note, setNote] = useState("");
  const [ai, setAi] = useState<AiSummary>({ state: "not_requested" });
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);

  const apply = async (r: Response) => {
    const d = await r.json().catch(() => ({}));
    if (r.ok) { setRows(d.rows); setNote(d.note); setAi(d.ai); setError(""); }
    else setError(r.status === 401 ? "Sign in to see this report." : r.status === 404 ? "Listing not found." : d.error ?? "Could not load the report.");
  };

  useEffect(() => {
    setRows(null);
    setAi({ state: "not_requested" });
    fetch(`/api/listings/${id}/offer-analysis`).then(apply).catch(() => setError("Could not load the report."));
  }, [id]);

  const askAi = async () => {
    setAsking(true);
    await fetch(`/api/listings/${id}/offer-analysis`, { method: "POST", headers: JSON_HEADERS, body: "{}" }).then(apply).catch(() => setError("Could not ask for the AI summary."));
    setAsking(false);
  };

  return (
    <main>
      <h1>Compare offers</h1>
      <p>Your offers side by side. Only you decide: nothing here accepts, rejects or counters an offer.</p>
      {error ? <p role="alert">{error}</p> : null}
      {!error && rows === null ? <p className="muted" role="status">Loading…</p> : null}
      {rows && rows.length === 0 ? <p className="empty">No offers to compare yet.</p> : null}
      {rows && rows.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="compare-table">
              <caption className="muted">Sorted by price, then deposit, then settlement days, then fewest conditions</caption>
              <thead><tr><th>#</th><th>Offer</th><th>Price</th><th>Deposit</th><th>Settlement</th><th>Conditions</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td>{r.rank}</td>
                    <td>{r.label}</td>
                    <td>{dollars(r.priceCents)}</td>
                    <td>{dollars(r.depositCents)} ({r.depositPercent}%)</td>
                    <td>{r.settlementDays} days</td>
                    <td>{r.conditions.length > 0 ? r.conditions.join("; ") : "None"}</td>
                    <td>{label(r.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">{note}</p>
          <section className="panel">
            <h2>AI summary (optional)</h2>
            {ai.state === "ready" ? <div className="ai-note"><strong>AI summary</strong><br />{ai.text}<br /><small>{ai.note}</small></div> : null}
            {ai.state === "unavailable" ? <p role="status"><strong>AI unavailable.</strong> {ai.message}</p> : null}
            <div className="actions">
              <button type="button" className="secondary" onClick={askAi} disabled={asking}>{asking ? "Asking…" : "Ask AI for a summary"}</button>
              <a href={`/listings/${id}/contract-draft`}>Preview a contract draft</a>
              <a href={`/listings/${id}/offers`}>Back to offers</a>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
