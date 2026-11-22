"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { AiSummary } from "../../../../src/domain/offer-analysis";
import type { CompareColumn } from "../../../../src/domain/offer-compare";
import { offerStatusLabel } from "../../../../src/domain/offer-display";
import { JSON_HEADERS } from "../../ui";
import { CounterDraft } from "./counter-draft";
import "../../../styles/offers.css";
import "../../../styles/elena-offers.css";

const dollars = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
type Data = { columns: CompareColumn[]; summary: string[]; omitted: number; note: string; listing: { address: string; askingPriceCents?: number } };

const FINANCE_CLASS: Record<string, string> = { verified: "ok", pending: "warn", condition: "warn", none: "" };

function Win() { return <span className="cmp-win">Best</span>; }

/** Owner/agent offers comparison. Elena's reading is by rules, so it is complete with the AI off. Only the owner decides: nothing here accepts, rejects or sends. */
export default function OfferAnalysis() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Data | null>(null);
  const [ai, setAi] = useState<AiSummary>({ state: "not_requested" });
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setData(null); setError("");
    fetch(`/api/listings/${id}/offers/compare`).then(async r => {
      const d = await r.json().catch(() => ({}));
      if (r.ok) setData(d); else setError(r.status === 401 ? "Sign in to see this comparison." : r.status === 404 ? "Listing not found." : r.status === 429 ? "Too many requests. Try again in a while." : d.error ?? "Could not load the comparison.");
    }).catch(() => setError("Could not load the comparison."));
  }, [id]);

  const askAi = async () => {
    setAsking(true);
    const r = await fetch(`/api/listings/${id}/offer-analysis`, { method: "POST", headers: JSON_HEADERS, body: "{}" }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) setAi(d.ai); else setError(d.error ?? "Could not ask for the AI summary.");
    setAsking(false);
  };

  const cols = data?.columns ?? [];
  const status = (c: CompareColumn) => offerStatusLabel(c.status, "owner");
  return (
    <main className="cmp">
      <h1>Compare offers</h1>
      <p>Your open offers side by side, with Elena&apos;s plain-language reading. Buyers are only &ldquo;Offer A&rdquo;, &ldquo;Offer B&rdquo;: Elena never shows one buyer&apos;s terms to another.</p>
      {error ? <p role="alert" className="cmp-err">{error}</p> : null}
      {!error && data === null ? <p className="muted" role="status">Loading the comparison…</p> : null}
      {data && cols.length === 0 ? <p className="empty">No open offers to compare yet. <a href={`/listings/${id}/offers`}>Back to offers</a></p> : null}
      {data && cols.length > 0 ? (
        <>
          <section className="panel cmp-summary" aria-labelledby="cmp-sum-h">
            <h2 id="cmp-sum-h">Elena&apos;s reading</h2>
            <ul>{data.summary.map(s => <li key={s}>{s}</li>)}</ul>
            {data.omitted > 0 ? <p className="muted">Showing the newest {cols.length} open offers; {data.omitted} older {data.omitted === 1 ? "one is" : "ones are"} on the offers page.</p> : null}
          </section>

          <div className="table-wrap cmp-wide">
            <table className="cmp-table">
              <caption className="sr-only">Open offers side by side</caption>
              <thead><tr><th scope="col">Term</th>{cols.map(c => <th scope="col" key={c.id}>{c.label}<small>{status(c)}</small></th>)}</tr></thead>
              <tbody>
                <tr><th scope="row">Price</th>{cols.map(c => <td key={c.id}><strong>{dollars(c.priceCents)}</strong>{c.best.price ? <Win /> : null}{c.versusAsking ? <small>{c.versusAsking.text}</small> : null}</td>)}</tr>
                <tr><th scope="row">Deposit</th>{cols.map(c => <td key={c.id}>{dollars(c.depositCents)}<small>{c.depositPercent}% of price</small>{c.best.deposit ? <Win /> : null}</td>)}</tr>
                <tr><th scope="row">Conditions</th>{cols.map(c => <td key={c.id}>{c.conditions.length ? <ul className="cmp-list">{c.conditions.map(x => <li key={x}>{x}</li>)}</ul> : "None"}{c.best.conditions ? <Win /> : null}</td>)}</tr>
                <tr><th scope="row">Finance</th>{cols.map(c => <td key={c.id} className={`cmp-fin ${FINANCE_CLASS[c.finance]}`}>{c.financeText}</td>)}</tr>
                <tr><th scope="row">Settlement</th>{cols.map(c => <td key={c.id}>{c.settlementDays} days{c.best.settlement ? <Win /> : null}</td>)}</tr>
                <tr><th scope="row">Reply by</th>{cols.map(c => <td key={c.id}>{c.replyBy ? <>Your counter lapses {day(c.replyBy)}</> : <span className="muted">No counter waiting</span>}</td>)}</tr>
                <tr><th scope="row">Submitted</th>{cols.map(c => <td key={c.id}>{day(c.submittedAt)}</td>)}</tr>
              </tbody>
            </table>
          </div>

          <ul className="cmp-cards card-list">
            {cols.map(c => (
              <li key={c.id}>
                <h3>{c.label} <span className={`badge badge-${c.status}`}>{status(c)}</span></h3>
                <dl>
                  <div><dt>Price</dt><dd><strong>{dollars(c.priceCents)}</strong>{c.best.price ? <Win /> : null}{c.versusAsking ? <small>{c.versusAsking.text}</small> : null}</dd></div>
                  <div><dt>Deposit</dt><dd>{dollars(c.depositCents)} <small>({c.depositPercent}%)</small>{c.best.deposit ? <Win /> : null}</dd></div>
                  <div><dt>Conditions</dt><dd>{c.conditions.length ? c.conditions.join("; ") : "None"}{c.best.conditions ? <Win /> : null}</dd></div>
                  <div><dt>Finance</dt><dd className={`cmp-fin ${FINANCE_CLASS[c.finance]}`}>{c.financeText}</dd></div>
                  <div><dt>Settlement</dt><dd>{c.settlementDays} days{c.best.settlement ? <Win /> : null}</dd></div>
                  <div><dt>Reply by</dt><dd>{c.replyBy ? `Your counter lapses ${day(c.replyBy)}` : "No counter waiting"}</dd></div>
                </dl>
              </li>
            ))}
          </ul>

          <section className="cmp-q" aria-labelledby="cmp-q-h">
            <h2 id="cmp-q-h">Questions worth asking</h2>
            <p className="muted">Ask in each buyer&apos;s own enquiry thread. Each list is about that one offer only.</p>
            <div className="cmp-qgrid">
              {cols.map(c => (
                <div className="panel" key={c.id}>
                  <h3>{c.label}</h3>
                  {c.questions.length ? <ul>{c.questions.map(q => <li key={q}>{q}</li>)}</ul> : <p className="muted">Nothing stands out. The terms look complete.</p>}
                  <CounterDraft listingId={id} offerId={c.id} label={c.label} />
                  <p><a href={`/listings/${id}/offers/${c.id}`}>Open {c.label}</a></p>
                </div>
              ))}
            </div>
          </section>
          <p className="muted">{data.note}</p>

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
