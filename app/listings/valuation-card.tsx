"use client";
import { useEffect, useId, useState } from "react";
import type { Valuation } from "../../src/domain/valuation";
import type { Unavailable } from "../../src/domain/seller-insights";
import { formatPrice } from "../../src/domain/listing-details";
import "../styles/valuation.css";

const money = (c: number) => formatPrice(c, "sale");
const ICON = { green: "✓", yellow: "!", red: "▲", blue: "▼" } as const;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "2-digit" });

/** Where the asking price sits inside (or outside) the fair range, as a position along a bar. */
function Meter({ v }: { v: Valuation }) {
  const lo = Math.min(v.askingCents, v.lowCents) * 0.95, hi = Math.max(v.askingCents, v.highCents) * 1.05, span = hi - lo;
  const pos = (c: number) => `${(((c - lo) / span) * 100).toFixed(1)}%`;
  return (
    <div className={`vl-meter vl-${v.tone}`} role="img" aria-label={`Asking price ${money(v.askingCents)}; fair range ${money(v.lowCents)} to ${money(v.highCents)}`}>
      <span className="vl-meter-fair" style={{ left: pos(v.lowCents), width: `${(((v.highCents - v.lowCents) / span) * 100).toFixed(1)}%` }} />
      <span className="vl-meter-ask" style={{ left: pos(v.askingCents) }} />
    </div>
  );
}

/**
 * Buyer valuation card: a quick read on whether the asking price is fair, with the detail one click away. Renders nothing while valuations
 * are off for the site or this listing, or when the visitor is signed out (the API answers 404 or 401), so there is no empty box.
 */
export function ValuationCard({ listingId }: { listingId: string }) {
  const [state, setState] = useState<"loading" | "hidden" | "error" | { v: Valuation | Unavailable }>("loading");
  const [open, setOpen] = useState(false);
  const panel = useId();
  useEffect(() => {
    let live = true;
    fetch(`/api/listings/${listingId}/valuation`).then(async r => {
      if (!live) return;
      if (r.ok) setState({ v: ((await r.json()) as { valuation: Valuation | Unavailable }).valuation });
      else setState(r.status === 429 ? "error" : "hidden");
    }).catch(() => live && setState("error"));
    return () => { live = false; };
  }, [listingId]);

  if (state === "hidden") return null;
  if (state === "loading") return <section className="panel vl-card" aria-label="Valuation" aria-busy="true"><h2>Valuation</h2><p className="muted" role="status">Loading…</p></section>;
  if (state === "error") return <section className="panel vl-card" aria-label="Valuation"><h2>Valuation</h2><p role="alert">The valuation could not be loaded. Try again later.</p></section>;
  const v = state.v;
  if (v.state === "unavailable") return <section className="panel vl-card" aria-label="Valuation"><h2>Valuation</h2><p className="vl-off">Valuation unavailable. {v.message}</p></section>;

  return (
    <section className="panel vl-card" aria-label="Valuation">
      <h2>Valuation</h2>
      <p className="vl-head">
        <span className={`vl-badge vl-${v.tone}`}><span aria-hidden="true">{ICON[v.tone]}</span>{v.label}</span>
        <span className="vl-conf">Confidence: {v.confidence === "high" ? "High" : "Medium"}</span>
      </p>
      {v.showRange && <p className="vl-range">Market range: {money(v.lowCents)} to {money(v.highCents)} | Asking: {money(v.askingCents)}</p>}
      {v.showRange && <Meter v={v} />}
      <p>{v.summary}</p>
      <button type="button" className="secondary" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>{open ? "Hide details" : "View details"}</button>
      {open && (
        <div id={panel} className="vl-detail">
          {v.saleSpeed && <p>{v.saleSpeed}</p>}
          <div>
            <h3>Comparable sales</h3>
            <div className="vl-table-wrap">
              <table>
                <thead><tr><th scope="col">Sold</th><th scope="col" className="num">Price</th><th scope="col" className="num vl-hide-narrow">Beds</th><th scope="col" className="num">Days</th><th scope="col" className="vl-hide-narrow">Suburb</th></tr></thead>
                <tbody>{v.comparables.map(c => (
                  <tr key={c.id}>
                    <td>{day(c.date)}</td><td className="num">{money(c.priceCents)}</td><td className="num vl-hide-narrow">{c.bedrooms ?? "–"}</td><td className="num">{c.daysOnMarket ?? "–"}</td><td className="vl-hide-narrow">{c.label ?? c.suburb}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <p className="vl-note">Showing {v.comparables.length} of {v.basedOnSales} similar sales in the last 90 days.</p>
          </div>
          {v.renovation && (
            <div>
              <h3>Renovation potential</h3>
              <ul>{v.renovation.items.map(i => <li key={i.key}>{i.label}: about {money(i.costCents)} to do, adds about {money(i.valueAddCents)}</li>)}</ul>
              <p>All together: about {money(v.renovation.totalCostCents)} of work for roughly {money(v.renovation.totalValueAddCents)} of value.</p>
              <p className="vl-note">{v.renovation.note}</p>
            </div>
          )}
          {v.rental && (
            <div>
              <h3>Rental return</h3>
              <p>About {v.rental.grossYieldPercent}% gross yield, from a typical rent of {money(v.rental.medianWeeklyRentCents)} a week ({v.rental.sample} recent rentals).</p>
              <p className="vl-note">{v.rental.note}</p>
            </div>
          )}
          <p className="vl-links"><a href="/owner/market-insights">Powered by market insights</a></p>
          <p className="vl-note">{v.note}</p>
        </div>
      )}
    </section>
  );
}
