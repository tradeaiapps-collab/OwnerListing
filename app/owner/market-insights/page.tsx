"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { InsightPanels, type Insights } from "../insight-panels";

interface Form { suburb: string; postcode: string; propertyType: string; bedrooms: string; areaSqm: string }
const TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"];
const EMPTY: Form = { suburb: "", postcode: "", propertyType: "house", bedrooms: "", areaSqm: "" };

export default function SellerMarketInsights() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [res, setRes] = useState<Insights | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);

  const run = useCallback(async (f: Form) => {
    setBusy(true); setError(""); setSignedOut(false);
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v.trim() !== "") p.set(k, v.trim());
    try {
      const r = await fetch(`/api/owner/market-insights?${p}`);
      if (r.status === 401) { setSignedOut(true); setRes(null); return; }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? "Could not load market insights."); setRes(null); return; }
      setRes(d as Insights);
    } catch { setError("Could not load market insights."); setRes(null); } finally { setBusy(false); }
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.get("suburb") && !q.get("postcode")) return;
    const f: Form = { ...EMPTY };
    for (const k of Object.keys(EMPTY) as (keyof Form)[]) { const v = q.get(k); if (v) f[k] = v; }
    setForm(f); void run(f);
  }, [run]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = (e: FormEvent) => { e.preventDefault(); void run(form); };
  return (
    <main className="mk">
      <h1>Market insights for sellers</h1>
      <p className="muted">See what similar homes sold for, where prices are heading and how long homes take to sell. Guide only.</p>
      <form className="panel mk-form" onSubmit={submit} aria-label="Your property">
        <label>Suburb<input value={form.suburb} onChange={set("suburb")} maxLength={80} autoComplete="off" placeholder="e.g. Paddington" /></label>
        <label>Postcode<input value={form.postcode} onChange={set("postcode")} inputMode="numeric" pattern="\d{4}" maxLength={4} placeholder="4064" /></label>
        <label>Property type<select value={form.propertyType} onChange={set("propertyType")}>{TYPES.map(t => <option key={t} value={t}>{t[0]!.toUpperCase() + t.slice(1)}</option>)}</select></label>
        <label>Bedrooms<input type="number" min={0} max={20} value={form.bedrooms} onChange={set("bedrooms")} /></label>
        <label>Size (m²)<input type="number" min={1} value={form.areaSqm} onChange={set("areaSqm")} /></label>
        <div className="mk-actions"><button type="submit" disabled={busy || (!form.suburb.trim() && !form.postcode.trim())}>{busy ? "Working…" : "Show insights"}</button></div>
      </form>
      {error && <p role="alert">{error}</p>}
      {signedOut && <p role="alert">Sign in to see market insights. <a href="/login">Sign in</a></p>}
      {busy && !res && <p className="muted" role="status">Loading…</p>}
      {res && <InsightPanels i={res} />}
      <p className="si-links"><a href="/owner/listing-performance">See how your listing is performing</a> <a href="/owner/pricing-advice">Get pricing advice for one of your listings</a> <a href="/market">Full market tool, with Elena</a></p>
    </main>
  );
}
