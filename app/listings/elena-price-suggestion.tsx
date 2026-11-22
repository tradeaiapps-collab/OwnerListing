"use client";
import { useCallback, useEffect, useState } from "react";

type Evidence = { kind: "sold" | "asking"; label: string; suburb: string; date: string; priceCents: number; bedrooms?: number; bathrooms?: number; areaSqm?: number; distanceKm?: number };
type Ready = {
  state: "ready"; basisLabel: string; lowCents: number; midCents: number; highCents: number; confidence: "low" | "medium" | "high"; summary: string;
  evidence: Evidence[]; steps: string[]; notPricedIn: string[]; position?: { relation: "inside" | "above" | "below"; text: string }; disclaimer: string;
};
type Insufficient = { state: "insufficient"; message: string; missing: string[]; disclaimer: string };
type Suggestion = Ready | Insufficient;

const aud = (cents: number, rent: boolean) =>
  `${new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(cents / 100)}${rent ? " per week" : ""}`;
const CONF_TEXT = { low: "Low confidence", medium: "Medium confidence", high: "High confidence" } as const;

/**
 * Elena's asking-price suggestion for the owner: a range, how sure she is, and the evidence it rests on. A guide only. It has no button
 * that sets the price: the owner changes the price on the edit page. Shows loading, error (with retry), and "not enough data" states.
 */
export function ElenaPriceSuggestion({ listingId, rent, editHref }: { listingId: string; rent: boolean; editHref?: string }) {
  const [s, setS] = useState<Suggestion | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setError(""); setS(null);
    try {
      const r = await fetch(`/api/listings/${listingId}/price-suggestion`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) setS(d); else setError(d.error ?? "Elena could not work out a price suggestion.");
    } catch { setError("Elena could not work out a price suggestion."); }
  }, [listingId]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="panel eps" aria-labelledby={`eps-h-${listingId}`}>
      <h2 id={`eps-h-${listingId}`}>Elena's price suggestion</h2>
      {!s && !error && <p className="muted" role="status">Elena is looking at nearby listings and sales…</p>}
      {error && <p role="alert">{error} <button type="button" className="secondary" onClick={() => void load()}>Try again</button></p>}
      {s?.state === "insufficient" && (
        <>
          <p role="status"><strong>{s.message}</strong> She will not guess a number.</p>
          <p className="muted">What is missing:</p>
          <ul>{s.missing.map(m => <li key={m}>{m}</li>)}</ul>
        </>
      )}
      {s?.state === "ready" && (
        <>
          <p className="eps-range"><strong>{aud(s.lowCents, rent)} to {aud(s.highCents, rent)}</strong></p>
          <p className="eps-meta">
            <span className={`badge eps-conf eps-conf-${s.confidence}`}>{CONF_TEXT[s.confidence]}</span>
            <span className="muted">Middle {aud(s.midCents, rent)} · {s.basisLabel}</span>
          </p>
          <p>{s.summary}</p>
          {s.position && <p role="status"><em>{s.position.text}</em> You choose the price.</p>}
          <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide the evidence" : "Show the evidence"}</button>
          {open && (
            <div className="eps-more">
              {s.evidence.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th scope="col">Property</th><th scope="col">Date</th><th scope="col" className="eps-num eps-opt">Beds</th><th scope="col" className="eps-num eps-opt">Size</th><th scope="col" className="eps-num">Price</th></tr></thead>
                    <tbody>{s.evidence.map((e, i) => (
                      <tr key={`${e.date}-${i}`}>
                        <td>{e.label}<br /><small className="muted">{e.kind === "sold" ? (rent ? "Leased" : "Sold") : "Asking price"}</small></td>
                        <td>{new Date(e.date).toLocaleDateString("en-AU")}</td><td className="eps-num eps-opt">{e.bedrooms ?? "–"}</td>
                        <td className="eps-num eps-opt">{e.areaSqm ? `${Math.round(e.areaSqm)} m²` : "–"}</td><td className="eps-num">{aud(e.priceCents, rent)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              <h3>How it was worked out</h3>
              <ul>{s.steps.map(x => <li key={x}>{x}</li>)}</ul>
              <h3>Not priced in</h3>
              <ul>{s.notPricedIn.map(x => <li key={x}>{x}</li>)}</ul>
            </div>
          )}
          {editHref && <p><a className="button secondary" href={editHref}>Change my price</a></p>}
        </>
      )}
      {(s || error) && <p className="muted"><small>{s?.disclaimer ?? "A guide only, not a valuation or advice."}</small></p>}
    </section>
  );
}
