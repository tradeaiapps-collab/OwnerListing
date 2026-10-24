"use client";
import { useEffect, useState } from "react";
import "../styles/billing.css";
import { FEATURE_LABELS, money, type PlanView } from "./view";

export default function Plans() {
  const [data, setData] = useState<{ gstPercent: number; plans: PlanView[] } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/plans")
      .then(async r => { if (!r.ok) throw new Error(); setData(await r.json()); })
      .catch(() => setError("Could not load the plans."));
  }, []);

  return (
    <main>
      <h1>Plans</h1>
      <p className="muted">One flat fee per listing. Prices exclude GST; GST is shown below each price.</p>
      {error && <p role="alert">{error}</p>}
      {!error && !data && <p className="muted" role="status">Loading...</p>}
      {data && (
        <div className="plan-grid">
          {data.plans.map(p => (
            <section className="plan-card" key={p.id} aria-labelledby={`plan-${p.id}`}>
              <h2 id={`plan-${p.id}`}>{p.name}</h2>
              {p.price ? (
                <>
                  <p className="plan-price">{money(p.price.exGstCents)} <small>excl. GST</small></p>
                  <p className="plan-price-note">GST ({data.gstPercent}%) {money(p.price.gstCents)}. Total {money(p.price.totalCents)}.</p>
                </>
              ) : <p className="plan-unpriced">Price not set. This plan cannot be bought yet.</p>}
              <ul>
                <li>Up to {p.maxPhotos} photos</li>
                <li>{p.storageGb} GB storage</li>
                {p.features.map(f => <li key={f}>{FEATURE_LABELS[f] ?? f}</li>)}
              </ul>
            </section>
          ))}
        </div>
      )}
      <p>To buy a plan, go to <a href="/listings/mine">My listings</a> and choose Pay and publish. Payment is made on the bank's secure page.</p>
    </main>
  );
}
