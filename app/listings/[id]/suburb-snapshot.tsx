"use client";
import { useEffect, useState } from "react";
import type { SuburbView } from "../../../src/domain/suburb-data";
import "../../styles/suburb-data.css";

/** Buyer-facing suburb figures for the listing's suburb, from the staff-loaded feed. Renders nothing when the suburb has no data. */
export function SuburbSnapshot({ state, suburb }: { state: string; suburb: string }) {
  const [view, setView] = useState<SuburbView | null>(null);
  useEffect(() => {
    fetch(`/api/suburbs/profile?state=${encodeURIComponent(state)}&suburb=${encodeURIComponent(suburb)}`)
      .then(async r => (r.ok ? setView((await r.json()).view ?? null) : setView(null))).catch(() => setView(null));
  }, [state, suburb]);
  if (!view) return null;
  return (
    <section className="sd-snapshot" aria-label={`About ${view.suburb}`}>
      <h2>About {view.suburb}</h2>
      <dl className="sd-facts">
        {view.facts.map(f => <div key={f.label} style={{ display: "contents" }}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
      </dl>
      <p className="muted"><small>Source: {view.source}, as at {view.asAt}. Suburb figures are general information, not a valuation of this property.</small></p>
    </section>
  );
}
