"use client";
import { useEffect, useState } from "react";
import type { RatesView } from "../../../src/domain/listing-rates";
import "../../styles/listing-rates.css";

/** Buyer-facing council and water rates for a sale listing, as the seller stated them. Renders nothing when none were stated. */
export function RatesCard({ listingId }: { listingId: string }) {
  const [view, setView] = useState<RatesView | null>(null);
  useEffect(() => {
    fetch(`/api/listings/${listingId}/rates`).then(async r => (r.ok ? setView((await r.json()).view ?? null) : setView(null))).catch(() => setView(null));
  }, [listingId]);
  if (!view) return null;
  return (
    <section aria-label="Council and water rates">
      <h2>Rates and charges</h2>
      <dl className="lr-list">
        {view.lines.map(l => <div key={l.label} style={{ display: "contents" }}><dt>{l.label}</dt><dd>{l.amount}<small>About {l.yearly}</small></dd></div>)}
        {view.totalYearly && <><dt>Combined</dt><dd className="lr-total">{view.totalYearly}</dd></>}
      </dl>
      {view.waterUsageNote && <p>{view.waterUsageNote}</p>}
      <p className="muted"><small>Stated by the seller{view.asAt ? ` from the notice dated ${view.asAt}` : ""}. Check the current notices before you buy.</small></p>
    </section>
  );
}
