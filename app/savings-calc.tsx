"use client";
import { useState } from "react";

const aud = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const num = (s: string) => { const v = Number(s.replace(/[^0-9.]/g, "")); return Number.isFinite(v) && v >= 0 ? v : 0; };

/**
 * Illustrative comparison only: the visitor's own figures in, simple arithmetic out. The starting values are examples, not market
 * statistics; commission rates vary and are negotiable. Nothing is sent anywhere.
 */
export default function SavingsCalc() {
  const [price, setPrice] = useState("800000");
  const [rate, setRate] = useState("2.0");
  const [marketing, setMarketing] = useState("0");
  const [plan, setPlan] = useState("0");
  const commission = (num(price) * Math.min(num(rate), 10)) / 100 + num(marketing);
  const diff = commission - num(plan);
  return (
    <form className="sc" onSubmit={e => e.preventDefault()} aria-describedby="sc-note">
      <div className="sc-fields">
        <label className="sc-f">Sale price (AUD)<input inputMode="numeric" value={price} maxLength={11} onChange={e => setPrice(e.target.value)} /></label>
        <label className="sc-f">Agent commission (%)<input inputMode="decimal" value={rate} maxLength={5} onChange={e => setRate(e.target.value)} /></label>
        <label className="sc-f">Agent marketing (AUD)<input inputMode="numeric" value={marketing} maxLength={9} onChange={e => setMarketing(e.target.value)} /></label>
        <label className="sc-f">Our plan fee (AUD)<input inputMode="numeric" value={plan} maxLength={9} onChange={e => setPlan(e.target.value)} /></label>
      </div>
      <p className="sc-hint"><a href="/plans">Look up plan prices</a></p>
      <output className="sc-out" aria-live="polite">
        <span>Agent cost in this example <strong>{aud(commission)}</strong></span>
        <span>Difference with your figures <strong>{aud(diff)}</strong></span>
      </output>
      <p id="sc-note" className="sc-note">Illustrative only, using the figures you enter. The starting values are examples, not typical rates. Commission is negotiable and other costs (conveyancing, marketing, your time) apply either way. Not financial advice.</p>
    </form>
  );
}
