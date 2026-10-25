"use client";
import { useCallback, useEffect, useState } from "react";
import { JSON_HEADERS } from "./ui";

type Comparable = { suburb: string; date: string; priceCents: number; adjustedCents: number; propertyType: string; bedrooms?: number; bathrooms?: number; parking?: number; distanceKm?: number; label?: string };
type Ready = {
  state: "ready"; lowCents: number; midCents: number; highCents: number; confidence: number; comparables: Comparable[]; basis: string[]; note: string;
  explanation: { state: "ready"; text: string } | { state: "unavailable" } | { state: "not_requested" };
};
type Guidance = Ready | { state: "unavailable"; message: string; note: string };

const money = (cents: number, rent: boolean) =>
  `${new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(cents / 100)}${rent ? " per week" : ""}`;
const confidenceWord = (c: number) => (c >= 0.7 ? "good" : c >= 0.5 ? "fair" : "low");

/**
 * Price guidance for the owner or appointed agent: a low to high range from comparable results, never shown to buyers.
 * The numbers come from rules; "Explain with AI" only adds words. Hidden behind "Estimate unavailable" when there is no data.
 */
export function PriceGuidanceCard({ listingId, rent }: { listingId: string; rent: boolean }) {
  const [g, setG] = useState<Guidance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showComps, setShowComps] = useState(false);

  const load = useCallback(async (explain: boolean) => {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/listings/${listingId}/price-guidance`, explain ? { method: "POST", headers: JSON_HEADERS, body: "{}" } : undefined);
      const d = await r.json();
      if (r.ok) setG(d); else setError(d.error ?? "Could not load price guidance.");
    } catch { setError("Could not load price guidance."); } finally { setBusy(false); }
  }, [listingId]);
  useEffect(() => { void load(false); }, [load]);

  return (
    <section className="panel" aria-label="Price guidance">
      <h3>Price guidance</h3>
      {!g && !error && <p className="muted" role="status">Loading…</p>}
      {g?.state === "unavailable" && <p className="muted" role="status">{g.message}</p>}
      {g?.state === "ready" && (
        <>
          <p><strong>{money(g.lowCents, rent)} to {money(g.highCents, rent)}</strong>, middle {money(g.midCents, rent)}.</p>
          <p className="muted">Confidence: {confidenceWord(g.confidence)} ({Math.round(g.confidence * 100)}%), from {g.comparables.length} comparable results.</p>
          <ul>{g.basis.map(b => <li key={b}>{b}</li>)}</ul>
          {g.explanation.state === "ready" && <p><em>AI explanation:</em> {g.explanation.text}</p>}
          {g.explanation.state === "unavailable" && <p className="muted">The AI explanation is unavailable right now. The numbers above do not use AI.</p>}
          <p>
            {g.explanation.state === "not_requested" && <button type="button" className="secondary" disabled={busy} onClick={() => void load(true)}>{busy ? "Working…" : "Explain with AI"}</button>}{" "}
            <button type="button" className="secondary" onClick={() => setShowComps(!showComps)}>{showComps ? "Hide comparables" : "Show comparables"}</button>
          </p>
          {showComps && (
            <table>
              <thead><tr><th>Suburb</th><th>Date</th><th>Beds</th><th>Result</th><th>Adjusted</th></tr></thead>
              <tbody>{g.comparables.map((c, i) => (
                <tr key={`${c.date}-${i}`}>
                  <td>{c.label ?? c.suburb}</td><td>{new Date(c.date).toLocaleDateString("en-AU")}</td><td>{c.bedrooms ?? "?"}</td>
                  <td>{money(c.priceCents, rent)}</td><td>{money(c.adjustedCents, rent)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </>
      )}
      {g && <p className="muted"><small>{g.note}</small></p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
