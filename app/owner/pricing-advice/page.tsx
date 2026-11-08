"use client";
import { useCallback, useEffect, useState } from "react";
import type { PricingAdvice, SellerGoal, Unavailable } from "../../../src/domain/seller-insights";
import { AdviceCard, Empty, GOAL_LABEL, InsightPanels, type Insights } from "../insight-panels";

interface Mine { id: string; title: string; address: string; transactionType: string; suburb?: string; postcode?: string; propertyType: string; bedrooms?: number }
interface Result extends Insights { goal: SellerGoal; goals: SellerGoal[]; advice: PricingAdvice | Unavailable; askingCents: number | null }
const HINT: Record<SellerGoal, string> = {
  fast_sale: "I want to sell fast. A price under the recent middle to attract buyers quickly.",
  balanced: "Balanced. A price around the middle of recent sales.",
  max_price: "I want to maximise price. The top of recent sales, with more time on the market."
};

export default function PricingAdvicePage() {
  const [listings, setListings] = useState<Mine[]>([]);
  const [id, setId] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);

  const load = useCallback(async (listingId: string, goal?: SellerGoal) => {
    if (!listingId) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/listings/${listingId}/pricing-advice`, goal
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal }) } : undefined);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error?.message ?? d.error ?? "Could not load pricing advice."); setRes(null); return; }
      setRes(d as Result);
    } catch { setError("Could not load pricing advice."); setRes(null); } finally { setBusy(false); }
  }, []);

  useEffect(() => {
    fetch("/api/listings/mine").then(async r => {
      if (r.status === 401) { setSignedOut(true); return; }
      const d = await r.json().catch(() => ({}));
      const sale = ((d.listings ?? []) as Mine[]).filter(l => l.transactionType === "sale");
      setListings(sale);
      const want = new URLSearchParams(window.location.search).get("listing");
      const first = sale.find(l => l.id === want) ?? sale[0];
      if (first) { setId(first.id); void load(first.id); }
    }).catch(() => setError("Could not load your listings."));
  }, [load]);

  const cur = listings.find(l => l.id === id);
  const area = cur ? new URLSearchParams({ ...(cur.suburb ? { suburb: cur.suburb } : {}), ...(cur.postcode ? { postcode: cur.postcode } : {}), propertyType: cur.propertyType, ...(cur.bedrooms !== undefined ? { bedrooms: String(cur.bedrooms) } : {}) }).toString() : "";
  return (
    <main className="mk">
      <h1>Pricing advice</h1>
      <p className="muted">Tell Elena what matters most and see a price to consider, with the sales behind it. You set the price.</p>
      {signedOut && <p role="alert">Sign in to see pricing advice. <a href="/login">Sign in</a></p>}
      {error && <p role="alert">{error}</p>}
      {!signedOut && listings.length === 0 && !error && <p className="empty">You have no listings for sale yet. <a href="/owner/market-insights">Look up any suburb</a> instead.</p>}
      {listings.length > 0 && (
        <div className="panel">
          <label>Listing<select value={id} onChange={e => { setId(e.target.value); void load(e.target.value); }}>{listings.map(l => <option key={l.id} value={l.id}>{l.title || l.address}</option>)}</select></label>
          <fieldset className="si-goals" disabled={busy}>
            <legend>What matters most?</legend>
            {(["fast_sale", "balanced", "max_price"] as SellerGoal[]).map(g => (
              <label key={g}><input type="radio" name="goal" value={g} checked={res?.goal === g} onChange={() => void load(id, g)} /><span><strong>{GOAL_LABEL[g]}</strong><span className="mk-sub">{HINT[g]}</span></span></label>
            ))}
          </fieldset>
          {busy && !res && <p className="muted" role="status">Working…</p>}
          {res && (res.advice.state === "ready" ? <AdviceCard a={res.advice} asking={res.askingCents} /> : <Empty message={res.advice.message} />)}
          {area && <p className="si-links"><a href={`/owner/market-insights?${area}`}>See all the sales and trends</a></p>}
        </div>
      )}
      {res && <InsightPanels i={res} />}
    </main>
  );
}
