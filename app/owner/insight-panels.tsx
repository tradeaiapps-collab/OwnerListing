"use client";
import { useId, useState } from "react";
import type { ComparableSales, DomStats, PriceDaysModel, PricingAdvice, SellerGoal, SellerTrend, Unavailable } from "../../src/domain/seller-insights";
import "../styles/market.css";
import "../styles/seller-insights.css";

export type Curve = { priceCents: number; days: number }[];
export type GuideModel = (PriceDaysModel & { curve: Curve }) | Unavailable;
export interface Insights { comparables: ComparableSales | Unavailable; trend: SellerTrend | Unavailable; daysOnMarket: DomStats | Unavailable; pricingGuide: GuideModel; note: string }

const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
export const money = (cents: number) => aud.format(cents / 100);
const compact = (cents: number) => { const d = cents / 100; return d >= 1_000_000 ? `$${(d / 1_000_000).toFixed(2)}m` : d >= 1000 ? `$${Math.round(d / 1000)}k` : `$${Math.round(d)}`; };
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "short", year: "2-digit", timeZone: "UTC" });
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
export const GOAL_LABEL: Record<SellerGoal, string> = { fast_sale: "Sell fast", balanced: "Balanced", max_price: "Maximise price" };

export function Empty({ message }: { message: string }) { return <p className="muted" role="status">{message}</p>; }

export function ComparableTable({ c }: { c: ComparableSales }) {
  return (
    <>
      <p>{c.insight}</p>
      <dl className="mk-tiles">
        <div><dt>Middle price</dt><dd>{money(c.medianCents)}</dd></div>
        <div><dt>Middle half</dt><dd>{compact(c.p25Cents)} to {compact(c.p75Cents)}</dd></div>
        <div><dt>Vs last quarter</dt><dd>{c.changeVsLastQuarterPercent === undefined ? "n/a" : `${c.changeVsLastQuarterPercent > 0 ? "▲" : c.changeVsLastQuarterPercent < 0 ? "▼" : "■"} ${Math.abs(c.changeVsLastQuarterPercent)}%`}</dd></div>
        <div><dt>Price per m²</dt><dd>{c.medianPricePerSqmCents ? money(c.medianPricePerSqmCents) : "n/a"}</dd></div>
      </dl>
      <div className="table-wrap"><table>
        <thead><tr><th>Property</th><th>Sold</th><th className="num">Price</th><th className="num si-hide-narrow">$/m²</th><th className="num">Days</th></tr></thead>
        <tbody>{c.rows.map(r => (
          <tr key={r.id}><td>{r.label ?? `${cap(r.propertyType)}${r.bedrooms !== undefined ? `, ${r.bedrooms} bed` : ""}`}</td><td>{new Date(r.date).toLocaleDateString("en-AU")}</td>
            <td className="num">{money(r.priceCents)}</td><td className="num si-hide-narrow">{r.pricePerSqmCents ? money(r.pricePerSqmCents) : "n/a"}</td><td className="num">{r.daysOnMarket ?? "n/a"}</td></tr>
        ))}</tbody>
      </table></div>
    </>
  );
}

/** Monthly average price as bars. The table view gives every value without hovering. */
export function TrendBars({ t }: { t: SellerTrend }) {
  const [table, setTable] = useState(false);
  const id = useId();
  const W = 640, H = 220, L = 60, R = 12, T = 12, B = 28;
  const lo = Math.min(...t.points.map(p => p.averageCents)), hi = Math.max(...t.points.map(p => p.averageCents));
  const pad = (hi - lo) * 0.15 || hi * 0.05, min = lo - pad, max = hi + pad;
  const x = (i: number) => L + (t.points.length <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (t.points.length - 1));
  const y = (v: number) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const every = Math.max(1, Math.ceil(t.points.length / 5));
  return (
    <figure className="mk-chart">
      <figcaption><span>Average sale price by month</span>
        <button type="button" className="link-button" aria-pressed={table} onClick={() => setTable(!table)}>{table ? "Show chart" : "Show table"}</button></figcaption>
      {!table ? (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}t`} preserveAspectRatio="xMidYMid meet">
          <title id={`${id}t`}>Average sale price from {monthLabel(t.points[0]!.month)} to {monthLabel(t.points[t.points.length - 1]!.month)}</title>
          {[min, (min + max) / 2, max].map(v => <g key={v}><line className="mk-grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text className="mk-axis" x={L - 6} y={y(v) + 4} textAnchor="end">{compact(v)}</text></g>)}
          {t.points.map((p, i) => (i % every === 0 || i === t.points.length - 1) && <text key={p.month} className="mk-axis" x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === t.points.length - 1 ? "end" : "middle"}>{monthLabel(p.month)}</text>)}
          <polyline className="mk-line" points={t.points.map((p, i) => `${x(i)},${y(p.averageCents)}`).join(" ")} />
          {t.points.map((p, i) => <circle key={p.month} className="mk-dot" cx={x(i)} cy={y(p.averageCents)} r={3}><title>{`${monthLabel(p.month)}: ${money(p.averageCents)} (${p.sales} sales)`}</title></circle>)}
        </svg>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Month</th><th className="num">Average</th><th className="num">Sales</th></tr></thead>
          <tbody>{t.points.map(p => <tr key={p.month}><td>{monthLabel(p.month)}</td><td className="num">{money(p.averageCents)}</td><td className="num">{p.sales}</td></tr>)}</tbody>
        </table></div>
      )}
      <p>{t.insight}</p>
    </figure>
  );
}

export function DomPanel({ d }: { d: DomStats }) {
  const parts = [["Fast (0-14 days)", d.bandPercent.fast, d.bands.fast], ["Standard (15-30)", d.bandPercent.standard, d.bands.standard], ["Slow (31+)", d.bandPercent.slow, d.bands.slow]] as const;
  return (
    <>
      <p>{d.insight}</p>
      <ul className="mk-bars">{parts.map(([label, p, n]) => (
        <li key={label}><div className="mk-bar-head"><span>{label}</span><span>{p}% ({n})</span></div>
          <div className="mk-bar" role="img" aria-label={`${label}: ${p} percent of sales`}><span style={{ width: `${p}%` }} /></div></li>
      ))}</ul>
    </>
  );
}

/** Slider over the price range seen in recent sales; days come from a straight-line fit, so they are a guide, not a promise. */
export function PriceSlider({ g }: { g: PriceDaysModel & { curve: Curve } }) {
  const id = useId();
  const lo = g.curve[0]!.priceCents, hi = g.curve[g.curve.length - 1]!.priceCents;
  const [price, setPrice] = useState(g.medianCents);
  const p = Math.min(hi, Math.max(lo, price));
  const days = Math.min(180, Math.max(1, Math.round(g.interceptDays + (g.slopeDaysPerTenPercent / 0.1) * (p / g.medianCents))));
  return (
    <div className="si-slider">
      <label htmlFor={id}>Asking price <strong>{money(p)}</strong></label>
      <input id={id} type="range" min={lo} max={hi} step={Math.max(1000, Math.round((hi - lo) / 100 / 100) * 100)} value={p} onChange={e => setPrice(Number(e.target.value))} />
      <div className="mk-range-ends"><span>{money(lo)}</span><span>{money(hi)}</span></div>
      <p className="mk-big" aria-live="polite">About {days} {days === 1 ? "day" : "days"}<span className="mk-unit"> to sell</span></p>
      <p className="muted mk-note">From {g.sample} sales in the last 12 months. Each 10% on the price added about {g.slopeDaysPerTenPercent} days. Link strength: {g.confidence}.</p>
    </div>
  );
}

export function InsightPanels({ i }: { i: Insights }) {
  return (
    <div className="mk-grid-wrap">
      <section className="panel mk-wide" aria-label="Comparable sales"><h2>Comparable sales, last 90 days</h2>
        {i.comparables.state === "ready" ? <ComparableTable c={i.comparables} /> : <Empty message={i.comparables.message} />}</section>
      <section className="panel mk-wide" aria-label="Price trend"><h2>Price trend, last 12 months</h2>
        {i.trend.state === "ready" ? <TrendBars t={i.trend} /> : <Empty message={i.trend.message} />}</section>
      <section className="panel" aria-label="Days on market"><h2>Days on the market</h2>
        {i.daysOnMarket.state === "ready" ? <DomPanel d={i.daysOnMarket} /> : <Empty message={i.daysOnMarket.message} />}</section>
      <section className="panel" aria-label="Pricing guide"><h2>Pricing guide</h2>
        {"curve" in i.pricingGuide ? <PriceSlider g={i.pricingGuide} /> : <Empty message={(i.pricingGuide as Unavailable).message} />}</section>
      <p className="muted mk-wide mk-note">{i.note}</p>
    </div>
  );
}

export function AdviceCard({ a, asking }: { a: PricingAdvice; asking?: number | null }) {
  return (
    <>
      <p className="mk-big">{money(a.recommendedCents)}<span className="mk-unit"> {GOAL_LABEL[a.goal].toLowerCase()}</span></p>
      <p>{a.rationale}</p>
      {asking ? <p className="muted">Your current asking price is {money(asking)}.</p> : null}
      <div className="table-wrap"><table>
        <thead><tr><th>Goal</th><th className="num">Price</th><th className="num">Days to sell</th></tr></thead>
        <tbody>{a.scenarios.map(s => (
          <tr key={s.goal} className={s.goal === a.goal ? "si-picked" : undefined}><td>{GOAL_LABEL[s.goal]}</td><td className="num">{money(s.priceCents)}</td><td className="num">{s.estimatedDays ?? "n/a"}</td></tr>
        ))}</tbody>
      </table></div>
      <p className="muted mk-note">Based on {a.basedOnSales} recent sales. Confidence: {a.confidence}.</p>
    </>
  );
}
