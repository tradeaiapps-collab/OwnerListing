"use client";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import "../styles/market.css";

type Tx = "sale" | "rent";
interface Form { suburb: string; postcode: string; transactionType: Tx; propertyType: string; bedrooms: string; bathrooms: string; parking: string; areaSqm: string; condition: string }
interface Breakdown { startCents: number; endCents: number; steps: { key: string; label: string; deltaCents: number; runningCents: number; detail: string }[]; topComparables: { id: string; suburb: string; date: string; sharePercent: number; label?: string }[] }
interface Valuation { state: "ready"; lowCents: number; midCents: number; highCents: number; confidence: number; confidenceLabel: string; intervalPercent: number; comparablesUsed: number; methodology: string[]; breakdown?: Breakdown }
interface Forecast { state: "ready"; horizons: { months: number; lowCents: number; midCents: number; highCents: number; changePercent: number }[]; annualisedPercent: number; direction: string; confidence: string; intervalPercent: number; basedOnMonths: number; note: string }
interface Score { state: "ready"; score: number; label: string; confidence: string; grossYieldPercent?: number; components: { key: string; label: string; score: number; weight: number; reason: string }[]; note: string }
interface Demand { state: "ready"; outlook: string; score: number; confidence: string; recentChangePercent?: number; interestPerListing: number; note: string }
interface Market { state: "ready"; sampleSize: number; medianCents: number; p25Cents: number; p75Cents: number; change12mPercent?: number; change6mPercent?: number; salesPerMonth: number; salesLast3m: number; salesPrev3m: number; velocity?: string; medianDaysOnMarket?: number }
interface Trend { state: "ready"; points: { month: string; medianCents: number; count: number }[]; changePercent?: number }
interface Comp { id: string; suburb: string; propertyType: string; date: string; priceCents: number; adjustedCents: number; bedrooms?: number; daysOnMarket?: number; similarity: number; label?: string }
interface Unavailable { state: "unavailable"; message: string }
interface Result { tx: Tx; valuation: Valuation | Unavailable; market: Market | Unavailable; trend: Trend | Unavailable; comparables: Comp[]; note: string; forecast?: Forecast | Unavailable | undefined; score?: Score | Unavailable | undefined; demand?: Demand | Unavailable | undefined }
interface Turn { q: string; a: string; who: string; icon?: string }

const CONDITIONS = ["poor", "fair", "good", "excellent"] as const;
const FIRST_CHIPS = ["How was this value worked out?", "Where are prices heading?", "How is buyer demand?"];
const TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"];
const EMPTY: Form = { suburb: "", postcode: "", transactionType: "sale", propertyType: "house", bedrooms: "", bathrooms: "", parking: "", areaSqm: "", condition: "" };
const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const compact = (cents: number) => { const d = cents / 100; return d >= 1_000_000 ? `$${(d / 1_000_000).toFixed(2)}m` : d >= 1000 ? `$${Math.round(d / 1000)}k` : `$${Math.round(d)}`; };
const money = (cents: number, tx: Tx) => `${aud.format(cents / 100)}${tx === "rent" ? " /wk" : ""}`;
const move = (n?: number) => (n === undefined ? "n/a" : `${n > 0 ? "▲" : n < 0 ? "▼" : "■"} ${Math.abs(n)}%`);
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "short", year: "2-digit", timeZone: "UTC" });

function params(f: Form): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v.trim() !== "") p.set(k, v.trim());
  return p;
}

/** Line chart of the rolling median. Inline SVG; the table view gives every value without hovering. */
function TrendChart({ points, tx }: { points: Trend["points"]; tx: Tx }) {
  const [table, setTable] = useState(false);
  const id = useId();
  const W = 640, H = 220, L = 60, R = 12, T = 12, B = 28;
  const lo = Math.min(...points.map(p => p.medianCents)), hi = Math.max(...points.map(p => p.medianCents));
  const pad = (hi - lo) * 0.15 || hi * 0.05;
  const min = lo - pad, max = hi + pad;
  const x = (i: number) => L + (points.length <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const every = Math.max(1, Math.ceil(points.length / 5));
  return (
    <figure className="mk-chart">
      <figcaption><span>Median {tx === "rent" ? "weekly rent" : "price"}, rolling three months</span>
        <button type="button" className="link-button" aria-pressed={table} onClick={() => setTable(!table)}>{table ? "Show chart" : "Show table"}</button></figcaption>
      {!table ? (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}t`} preserveAspectRatio="xMidYMid meet">
          <title id={`${id}t`}>Median {tx === "rent" ? "rent" : "price"} from {monthLabel(points[0]!.month)} to {monthLabel(points[points.length - 1]!.month)}</title>
          {[min, (min + max) / 2, max].map(t => (
            <g key={t}><line className="mk-grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} /><text className="mk-axis" x={L - 6} y={y(t) + 4} textAnchor="end">{compact(t)}</text></g>
          ))}
          {points.map((p, i) => (i % every === 0 || i === points.length - 1) && (
            <text key={p.month} className="mk-axis" x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>{monthLabel(p.month)}</text>
          ))}
          <polyline className="mk-line" points={points.map((p, i) => `${x(i)},${y(p.medianCents)}`).join(" ")} />
          {points.map((p, i) => <circle key={p.month} className="mk-dot" cx={x(i)} cy={y(p.medianCents)} r={3}><title>{`${monthLabel(p.month)}: ${money(p.medianCents, tx)} (${p.count} results)`}</title></circle>)}
        </svg>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Month</th><th className="num">Median</th><th className="num">Results</th></tr></thead>
          <tbody>{points.map(p => <tr key={p.month}><td>{monthLabel(p.month)}</td><td className="num">{money(p.medianCents, tx)}</td><td className="num">{p.count}</td></tr>)}</tbody>
        </table></div>
      )}
    </figure>
  );
}

function RangeBar({ v, tx }: { v: Valuation; tx: Tx }) {
  const pos = ((v.midCents - v.lowCents) / (v.highCents - v.lowCents || 1)) * 100;
  return (
    <div className="mk-range" role="img" aria-label={`Estimated ${money(v.lowCents, tx)} to ${money(v.highCents, tx)}, middle ${money(v.midCents, tx)}`}>
      <div className="mk-range-bar"><span className="mk-range-mid" style={{ left: `${Math.min(95, Math.max(5, pos))}%` }} /></div>
      <div className="mk-range-ends"><span>{money(v.lowCents, tx)}</span><span>{money(v.highCents, tx)}</span></div>
    </div>
  );
}

export default function MarketPage() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [chips, setChips] = useState<string[]>(FIRST_CHIPS);
  const [asked, setAsked] = useState<Form | null>(null);

  const run = useCallback(async (f: Form) => {
    setBusy(true); setError(""); setSignedOut(false); setTurns([]);
    const q = params(f).toString();
    try {
      const [v, m, t, c] = await Promise.all(["valuation", "market", "trends", "comparables"].map(n => fetch(`/api/intelligence/${n}?${q}`)));
      if (v!.status === 401) { setSignedOut(true); setRes(null); return; }
      if (!v!.ok) { setError((await v!.json().catch(() => ({}))).error ?? "Could not load property intelligence."); setRes(null); return; }
      const bad = [m!, t!, c!].find(r => !r.ok);
      if (bad) { setError(bad.status === 429 ? "You've looked up a lot of properties this hour. Try again later." : "Could not load property intelligence."); setRes(null); return; }
      const [vj, mj, tj, cj] = await Promise.all([v!.json(), m!.json(), t!.json(), c!.json()]);
      // The outlook panels are extras: if one fails the rest of the page still shows.
      const extra = async (n: string, key: string) => { const r = await fetch(`/api/intelligence/${n}?${q}`).catch(() => null); return r && r.ok ? ((await r.json().catch(() => ({})))[key] as never) : undefined; };
      const [forecast, score, demand] = await Promise.all([extra("forecast", "forecast"), extra("investment", "score"), extra("demand", "demand")]);
      setRes({ tx: f.transactionType, valuation: vj.valuation, market: mj.market, trend: tj.trend, comparables: cj.comparables, note: vj.note, forecast, score, demand });
      setAsked(f);
    } catch { setError("Could not load property intelligence."); setRes(null); } finally { setBusy(false); }
  }, []);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (!p.get("suburb") && !p.get("postcode")) return;
    const f: Form = { ...EMPTY };
    for (const k of Object.keys(EMPTY) as (keyof Form)[]) { const v = p.get(k); if (v) (f as unknown as Record<string, string>)[k] = v; }
    setForm(f); void run(f);
  }, [run]);

  const submit = (e: FormEvent) => { e.preventDefault(); void run(form); };
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function ask(text: string) {
    const t = text.trim();
    if (!t || !asked || asking) return;
    setAsking(true); setQuestion("");
    try {
      const r = await fetch("/api/intelligence/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...Object.fromEntries(params(asked)), question: t }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setTurns(x => [...x, { q: t, a: d.text, who: d.persona?.name ?? "Elena", icon: d.persona?.icon }]); setChips(d.suggestions ?? []); }
      else setTurns(x => [...x, { q: t, a: d.error ?? "I couldn't answer that just now.", who: "Elena" }]);
    } catch { setTurns(x => [...x, { q: t, a: "I couldn't answer that just now.", who: "Elena" }]); } finally { setAsking(false); }
  }

  const rent = form.transactionType === "rent";
  const tx = res?.tx ?? "sale";
  return (
    <main className="mk">
      <h1>Market insights</h1>
      <p className="muted">Estimated value, local market figures, comparable sales and trends, with Elena to explain them. Advisory only.</p>

      <form className="panel mk-form" onSubmit={submit} aria-label="Property details">
        <label>Suburb<input value={form.suburb} onChange={set("suburb")} maxLength={80} autoComplete="off" placeholder="e.g. Paddington" /></label>
        <label>Postcode<input value={form.postcode} onChange={set("postcode")} inputMode="numeric" pattern="\d{4}" maxLength={4} placeholder="4064" /></label>
        <label>Looking at<select value={form.transactionType} onChange={set("transactionType")}><option value="sale">Sale price</option><option value="rent">Weekly rent</option></select></label>
        <label>Property type<select value={form.propertyType} onChange={set("propertyType")}>{TYPES.map(t => <option key={t} value={t}>{t[0]!.toUpperCase() + t.slice(1)}</option>)}</select></label>
        <label>Bedrooms<input type="number" min={0} max={20} value={form.bedrooms} onChange={set("bedrooms")} /></label>
        <label>Bathrooms<input type="number" min={0} max={20} value={form.bathrooms} onChange={set("bathrooms")} /></label>
        <label>Parking<input type="number" min={0} max={20} value={form.parking} onChange={set("parking")} /></label>
        <label>Size (m²)<input type="number" min={1} value={form.areaSqm} onChange={set("areaSqm")} /></label>
        <label>Condition<select value={form.condition} onChange={set("condition")}><option value="">Typical</option>{CONDITIONS.filter(c => c !== "good").map(c => <option key={c} value={c}>{c[0]!.toUpperCase() + c.slice(1)}</option>)}</select></label>
        <div className="mk-actions"><button type="submit" disabled={busy || (!form.suburb.trim() && !form.postcode.trim())}>{busy ? "Working…" : rent ? "Get rent insights" : "Get insights"}</button></div>
      </form>

      {error && <p role="alert">{error}</p>}
      {signedOut && <p role="alert">Sign in to see property intelligence. <a href="/login">Sign in</a></p>}
      {busy && !res && <p className="muted" role="status">Loading…</p>}

      {res && (
        <div className="mk-grid-wrap" aria-busy={busy}>
          <section className="panel" aria-label="Estimated value">
            <h2>Estimated value</h2>
            {res.valuation.state === "ready" ? (
              <>
                <p className="mk-big">{money(res.valuation.midCents, tx)}</p>
                <RangeBar v={res.valuation} tx={tx} />
                <p className="muted">Confidence: <strong>{res.valuation.confidenceLabel}</strong> ({Math.round(res.valuation.confidence * 100)}%), from {res.valuation.comparablesUsed} comparable results. The range covers about {res.valuation.intervalPercent}% of similar results.</p>
                {res.valuation.breakdown && (
                  <details><summary>What drove this value</summary>
                    <div className="table-wrap"><table>
                      <thead><tr><th>Step</th><th className="num">Change</th><th className="num">Running</th></tr></thead>
                      <tbody>{res.valuation.breakdown.steps.map(st => (
                        <tr key={st.key}><td>{st.label}<span className="mk-sub">{st.detail}</span></td><td className="num">{st.deltaCents === 0 ? "n/a" : `${st.deltaCents > 0 ? "+" : "-"}${money(Math.abs(st.deltaCents), tx)}`}</td><td className="num">{money(st.runningCents, tx)}</td></tr>
                      ))}</tbody>
                    </table></div>
                    <p className="muted">Heaviest results: {res.valuation.breakdown.topComparables.slice(0, 3).map(c => `${c.label ?? c.suburb} ${c.date.slice(0, 7)} (${c.sharePercent}%)`).join(", ")}.</p>
                  </details>
                )}
                <details><summary>How this was worked out</summary><ol className="mk-steps">{res.valuation.methodology.map(m => <li key={m}>{m.replace(/^\d+\.\s*/, "")}</li>)}</ol></details>
              </>
            ) : <p className="muted" role="status">{res.valuation.message}</p>}
          </section>

          <section className="panel" aria-label="Market">
            <h2>Market</h2>
            {res.market.state === "ready" ? (
              <dl className="mk-tiles">
                <div><dt>Median</dt><dd>{money(res.market.medianCents, tx)}</dd></div>
                <div><dt>Change on last year</dt><dd>{move(res.market.change12mPercent ?? res.market.change6mPercent)}</dd></div>
                <div><dt>Results a month</dt><dd>{res.market.salesPerMonth}</dd></div>
                <div><dt>Median days on market</dt><dd>{res.market.medianDaysOnMarket ?? "n/a"}</dd></div>
                <div><dt>Activity</dt><dd className="mk-cap">{res.market.velocity ?? "n/a"}</dd></div>
                <div><dt>Middle half</dt><dd>{money(res.market.p25Cents, tx)} to {money(res.market.p75Cents, tx)}</dd></div>
              </dl>
            ) : <p className="muted" role="status">{res.market.message}</p>}
          </section>

          <section className="panel mk-wide" aria-label="Value trend">
            <h2>Value trend</h2>
            {res.trend.state === "ready" ? <TrendChart points={res.trend.points} tx={tx} /> : <p className="muted" role="status">{res.trend.message}</p>}
          </section>

          <section className="panel" aria-label="Price outlook">
            <h2>Price outlook</h2>
            {!res.forecast ? <p className="muted" role="status">The outlook is not available right now.</p> : res.forecast.state === "ready" ? (
              <>
                <p className="muted">Trend is <strong>{res.forecast.direction}</strong>, about {res.forecast.annualisedPercent}% a year (confidence {res.forecast.confidence}, {res.forecast.basedOnMonths} months of history). Ranges cover {res.forecast.intervalPercent}%.</p>
                <div className="table-wrap"><table>
                  <thead><tr><th>In</th><th className="num">Middle</th><th className="num">Range</th><th className="num">Change</th></tr></thead>
                  <tbody>{res.forecast.horizons.map(h => <tr key={h.months}><td>{h.months} months</td><td className="num">{money(h.midCents, tx)}</td><td className="num">{compact(h.lowCents)} to {compact(h.highCents)}</td><td className="num">{move(h.changePercent)}</td></tr>)}</tbody>
                </table></div>
                <p className="muted mk-note">{res.forecast.note}</p>
              </>
            ) : <p className="muted" role="status">{res.forecast.message}</p>}
          </section>

          <section className="panel" aria-label="Area fundamentals">
            <h2>Area fundamentals</h2>
            {!res.score ? <p className="muted" role="status">The score is not available right now.</p> : res.score.state === "ready" ? (
              <>
                <p className="mk-big">{res.score.score}<span className="mk-unit">/100</span> <span className="mk-cap mk-label">{res.score.label}</span></p>
                <ul className="mk-bars">{res.score.components.map(c => (
                  <li key={c.key}><div className="mk-bar-head"><span>{c.label}</span><span>{c.score}</span></div>
                    <div className="mk-bar" role="img" aria-label={`${c.label} ${c.score} out of 100`}><span style={{ width: `${c.score}%` }} /></div>
                    <span className="mk-sub">{c.reason}</span></li>
                ))}</ul>
                <p className="muted mk-note">Confidence {res.score.confidence}. {res.score.note}</p>
              </>
            ) : <p className="muted" role="status">{res.score.message}</p>}
          </section>

          <section className="panel mk-wide" aria-label="Buyer demand">
            <h2>Buyer demand</h2>
            {!res.demand ? <p className="muted" role="status">Buyer demand is not available right now.</p> : res.demand.state === "ready" ? (
              <>
                <p className="muted">Interest on this platform looks <strong>{res.demand.outlook}</strong> (score {res.demand.score}/100, confidence {res.demand.confidence}).{res.demand.recentChangePercent !== undefined && ` Recent weeks are ${move(res.demand.recentChangePercent)} on the weeks before.`} About {res.demand.interestPerListing} saves, enquiries and offers per listing over four weeks.</p>
                <p className="muted mk-note">{res.demand.note}</p>
              </>
            ) : <p className="muted" role="status">{res.demand.message}</p>}
          </section>

          <section className="mk-wide" aria-label="Comparable properties">
            <h2>Comparable properties</h2>
            {res.comparables.length === 0 ? <p className="empty">No similar recent results in this area.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Property</th><th>Date</th><th className="num">Beds</th><th className="num">Result</th><th className="num">Adjusted</th><th className="num">Days</th><th className="num">Match</th></tr></thead>
                <tbody>{res.comparables.map(c => (
                  <tr key={c.id}><td>{c.label ?? `${c.propertyType[0]!.toUpperCase()}${c.propertyType.slice(1)}, ${c.suburb}`}</td><td>{new Date(c.date).toLocaleDateString("en-AU")}</td>
                    <td className="num">{c.bedrooms ?? "?"}</td><td className="num">{money(c.priceCents, tx)}</td><td className="num">{money(c.adjustedCents, tx)}</td>
                    <td className="num">{c.daysOnMarket ?? "n/a"}</td><td className="num">{c.similarity}%</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </section>

          <section className="panel mk-wide mk-ask" aria-label="Ask Elena">
            <h2>Ask Elena</h2>
            <p className="muted">She explains these figures. She can't change them or tell you what to do.</p>
            <ul className="mk-turns" aria-live="polite">
              {turns.map((t, i) => (
                <li key={i}><p className="mk-q">{t.q}</p><p className="mk-a">{t.icon && <img src={t.icon} alt="" width={28} height={28} />}<span><strong>{t.who}</strong>{t.a.split("\n\n").map((para, j) => <span key={j} className="mk-para">{para}</span>)}</span></p></li>
              ))}
              {asking && <li className="muted" role="status">Elena is looking at the numbers…</li>}
            </ul>
            <div className="mk-chips">{chips.map(c => <button key={c} type="button" className="secondary" disabled={asking} onClick={() => void ask(c)}>{c}</button>)}</div>
            <form className="mk-askform" onSubmit={e => { e.preventDefault(); void ask(question); }}>
              <label className="sr-only" htmlFor="mk-q">Your question</label>
              <input id="mk-q" value={question} maxLength={500} onChange={e => setQuestion(e.target.value)} placeholder="e.g. How confident is this estimate?" />
              <button type="submit" disabled={asking || !question.trim()}>Ask</button>
            </form>
          </section>
          <p className="muted mk-wide mk-note">{res.note}</p>
        </div>
      )}
    </main>
  );
}
