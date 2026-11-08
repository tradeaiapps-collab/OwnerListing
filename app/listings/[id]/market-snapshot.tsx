"use client";
import { useEffect, useState } from "react";
import type { PricingAdvice, SellerGoal, Unavailable, ComparableSales, SellerTrend } from "../../../src/domain/seller-insights";
import { GOAL_LABEL, money } from "../../owner/insight-panels";
import "../../styles/market.css";
import "../../styles/seller-insights.css";

interface Snap { goal: SellerGoal; advice: PricingAdvice | Unavailable; comparables: ComparableSales | Unavailable; trend: SellerTrend | Unavailable }

/** For the listing's owner only: the API answers 404 to everyone else, so this renders nothing for buyers and visitors. */
export function MarketSnapshot({ listingId }: { listingId: string }) {
  const [s, setS] = useState<Snap | null>(null);
  useEffect(() => {
    fetch(`/api/listings/${listingId}/pricing-advice`).then(async r => (r.ok ? setS(await r.json()) : setS(null))).catch(() => setS(null));
  }, [listingId]);
  if (!s) return null;
  const rising = s.comparables.state === "ready" && s.comparables.direction === "up";
  return (
    <section className="panel si-snapshot" aria-label="Your market snapshot">
      <h2>Market snapshot (only you see this)</h2>
      {s.comparables.state === "ready" ? <p>{s.comparables.insight}</p> : <p className="muted">{s.comparables.message}</p>}
      {s.trend.state === "ready" && s.trend.season && <p>{s.trend.season.season} ({s.trend.season.months}) sales here averaged {Math.abs(s.trend.season.differencePercent)}% {s.trend.season.differencePercent >= 0 ? "higher" : "lower"} than the rest of the year.</p>}
      {rising && <p className="muted">The market is trending up, so pricing within the range above can help attract offers.</p>}
      {s.advice.state === "ready" && <p>{GOAL_LABEL[s.advice.goal]}: consider about <strong>{money(s.advice.recommendedCents)}</strong>.</p>}
      <p className="si-links"><a href={`/owner/pricing-advice?listing=${listingId}`}>Pricing advice</a><a href="/owner/market-insights">All market insights</a></p>
    </section>
  );
}
