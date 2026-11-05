"use client";
import { useEffect, useId, useState } from "react";
import { calculateMortgage, DEFAULTS, parseAmount, TERMS } from "../src/domain/mortgage";
import "./styles/mortgage.css";

const aud = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
type Latest = { date: string; ratePct: number } | null;
const monthYear = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Repayment estimator. The visitor's own figures in, standard loan arithmetic out; nothing is sent anywhere except a read of the
 * published rate. `price` pre-fills a listing's price. The rate starts at the latest published RBA figure (or an example when none is stored).
 */
export default function MortgageCalc({ price, heading }: { price?: number; heading?: string }) {
  const id = useId();
  const [p, setP] = useState(price ? String(Math.round(price)) : "800000");
  const [down, setDown] = useState(String(DEFAULTS.downPct));
  const [rate, setRate] = useState(String(DEFAULTS.ratePct));
  const [term, setTerm] = useState<number>(DEFAULTS.termYears);
  const [tax, setTax] = useState(String(DEFAULTS.annualTax));
  const [ins, setIns] = useState(String(DEFAULTS.annualInsurance));
  const [latest, setLatest] = useState<Latest>(null);
  const [rateState, setRateState] = useState<"loading" | "ok" | "none">("loading");

  useEffect(() => {
    let live = true;
    fetch("/api/mortgage/rates").then(r => r.json()).then((b: { latest?: Latest }) => {
      if (!live) return;
      if (b.latest) { setLatest(b.latest); setRate(String(b.latest.ratePct)); setRateState("ok"); } else setRateState("none");
    }).catch(() => live && setRateState("none"));
    return () => { live = false; };
  }, []);

  const r = calculateMortgage({ price: parseAmount(p), downPct: Math.min(parseAmount(down), 100), ratePct: parseAmount(rate), termYears: term, annualTax: parseAmount(tax), annualInsurance: parseAmount(ins) });
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return (
    <form className="mc" onSubmit={e => e.preventDefault()} aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="mc-h">{heading ?? "Estimate your repayments"}</h3>
      <div className="mc-fields">
        <label className="mc-f">Purchase price (AUD)<input inputMode="numeric" value={p} maxLength={11} onChange={e => setP(e.target.value)} /></label>
        <label className="mc-f">Deposit (%)<input inputMode="decimal" value={down} maxLength={5} onChange={e => setDown(e.target.value)} /></label>
        <label className="mc-f">Interest rate (% a year)<input inputMode="decimal" value={rate} maxLength={6} onChange={e => setRate(e.target.value)} />
          <small>{rateState === "ok" && latest ? `RBA published average, ${monthYear(latest.date)}. Lenders vary.` : rateState === "loading" ? "Checking the latest rate…" : "An example rate. Enter your lender's rate."}</small>
        </label>
        <label className="mc-f">Loan term
          <select value={term} onChange={e => setTerm(Number(e.target.value))}>{TERMS.map(t => <option key={t} value={t}>{t} years</option>)}</select>
        </label>
        <label className="mc-f">Council and water rates (AUD a year)<input inputMode="numeric" value={tax} maxLength={9} onChange={e => setTax(e.target.value)} /></label>
        <label className="mc-f">Insurance (AUD a year)<input inputMode="numeric" value={ins} maxLength={9} onChange={e => setIns(e.target.value)} /></label>
      </div>
      <output className="mc-out" aria-live="polite">
        <span className="mc-hero">You&apos;d pay about <strong>{aud(r.monthlyTotal)}</strong> a month</span>
        <dl className="mc-rows">
          <div><dt>Loan repayment (principal and interest)</dt><dd>{aud(r.monthlyPI)}</dd></div>
          <div><dt>Council and water rates</dt><dd>{aud(r.monthlyTax)}</dd></div>
          <div><dt>Insurance</dt><dd>{aud(r.monthlyInsurance)}</dd></div>
          <div><dt>Amount borrowed</dt><dd>{aud(r.loan)}</dd></div>
          <div><dt>Total interest over {term} years</dt><dd>{aud(r.totalInterest)}</dd></div>
          <div><dt>Total paid over {term} years</dt><dd>{aud(r.totalPaid)}</dd></div>
        </dl>
      </output>
      <div className="mc-bar" role="img" aria-label={`Of everything paid: ${pct(r.shares.principal)} principal, ${pct(r.shares.interest)} interest, ${pct(r.shares.other)} rates and insurance`}>
        <span className="mc-seg mc-principal" style={{ flexGrow: r.shares.principal }} />
        <span className="mc-seg mc-interest" style={{ flexGrow: r.shares.interest }} />
        <span className="mc-seg mc-other" style={{ flexGrow: r.shares.other }} />
      </div>
      <ul className="mc-key" aria-hidden="true"><li className="mc-principal">Principal {pct(r.shares.principal)}</li><li className="mc-interest">Interest {pct(r.shares.interest)}</li><li className="mc-other">Rates and insurance {pct(r.shares.other)}</li></ul>
      <p className="mc-note">
        In the first month about {aud(r.firstMonthInterest)} of your repayment is interest and {aud(r.firstMonthPrincipal)} reduces the loan.
        {r.lmiLikely && " With a deposit under 20% most lenders charge lenders mortgage insurance, which this does not include."}
      </p>
      <p className="mc-note">An estimate only, not a loan offer, credit assessment or financial advice. It ignores fees, stamp duty, offset accounts and the buffer lenders add when they assess you. Ask a lender or broker for a quote.</p>
    </form>
  );
}
