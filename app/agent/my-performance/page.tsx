"use client";
import { useEffect, useState } from "react";
import type { DateRange, MonthComparison, PerfMetrics } from "../../../src/domain/agent-performance";
import { days, percent, Rating } from "../../agent-performance-ui";
import "../../styles/agent-performance.css";

interface Data { range: DateRange; metrics: PerfMetrics; platform: PerfMetrics; months: MonthComparison; suggestions: string[]; comments: { rating: number; comment: string; month: string }[]; activeListings: number }

/** Higher is better for everything except days to sale and fall-through rate. */
function Delta({ now, before, lowerBetter, unit }: { now?: number | undefined; before?: number | undefined; lowerBetter?: boolean; unit: string }) {
  if (now === undefined || before === undefined) return <span className="muted">No earlier figure</span>;
  const d = Math.round((now - before) * 10) / 10;
  if (d === 0) return <span>No change</span>;
  const better = lowerBetter ? d < 0 : d > 0;
  return <span className={better ? "ap-better" : "ap-worse"}>{d > 0 ? "▲" : "▼"} {Math.abs(d)}{unit} ({better ? "better" : "worse"})</span>;
}

/** An agent's own figures, this month against last month, with plain suggestions. */
export default function MyPerformance() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/agent/my-performance");
        if (r.status === 401) return setError("Sign in as an agent to see your performance.");
        if (!r.ok) throw new Error();
        setData(await r.json());
      } catch { setError("Could not load your performance."); }
    })();
  }, []);

  const m = data?.metrics, t = data?.months.thisMonth, l = data?.months.lastMonth;
  return (
    <main className="ap">
      <div>
        <h1>My performance</h1>
        <p className="ap-lead">Your figures for the last 180 days, and this month so far against last month. Owners see the same measures when they compare agents.</p>
      </div>
      {error && <p role="alert" className="ap-error">{error} {error.startsWith("Sign in") && <a href="/login?as=agent">Sign in</a>}</p>}
      {!data && !error && <p className="ap-state" role="status">Loading…</p>}
      {data && m && t && l && (
        <>
          <div className="ap-kpis">
            <div className="ap-kpi"><span>Avg days to sale</span><strong>{days(m.timeToSaleDays)}</strong></div>
            <div className="ap-kpi"><span>Sales per month</span><strong>{m.dealVelocity}</strong></div>
            <div className="ap-kpi"><span>Buyer rating</span><strong>{m.satisfaction ?? "–"}</strong><Rating m={m} /></div>
            <div className="ap-kpi"><span>Price vs asking</span><strong>{percent(m.priceVariancePercent, true)}</strong></div>
            <div className="ap-kpi"><span>Fell through</span><strong>{percent(m.fallThroughRate)}</strong></div>
            <div className="ap-kpi"><span>Active listings</span><strong>{data.activeListings}</strong></div>
          </div>
          <section className="ap-section" aria-labelledby="mo-h">
            <h2 id="mo-h">This month and last month</h2>
            <div className="ap-table-wrap">
              <table className="ap-table">
                <thead><tr><th scope="col">Measure</th><th scope="col" className="num">Last month</th><th scope="col" className="num">This month</th><th scope="col">Change</th></tr></thead>
                <tbody>
                  <tr><th scope="row">Sales</th><td className="num">{l.sold}</td><td className="num">{t.sold}</td><td><Delta now={t.sold} before={l.sold} unit="" /></td></tr>
                  <tr><th scope="row">Avg days to sale</th><td className="num">{days(l.timeToSaleDays)}</td><td className="num">{days(t.timeToSaleDays)}</td><td><Delta now={t.timeToSaleDays} before={l.timeToSaleDays} lowerBetter unit=" d" /></td></tr>
                  <tr><th scope="row">Buyer rating</th><td className="num">{l.satisfaction ?? "–"}</td><td className="num">{t.satisfaction ?? "–"}</td><td><Delta now={t.satisfaction} before={l.satisfaction} unit="" /></td></tr>
                  <tr><th scope="row">Price vs asking</th><td className="num">{percent(l.priceVariancePercent, true)}</td><td className="num">{percent(t.priceVariancePercent, true)}</td><td><Delta now={t.priceVariancePercent} before={l.priceVariancePercent} unit=" pts" /></td></tr>
                  <tr><th scope="row">Fell through</th><td className="num">{l.fellThrough} of {l.acceptedOffers}</td><td className="num">{t.fellThrough} of {t.acceptedOffers}</td><td><Delta now={t.fellThrough} before={l.fellThrough} lowerBetter unit="" /></td></tr>
                </tbody>
              </table>
            </div>
          </section>
          <section className="ap-section" aria-labelledby="su-h">
            <h2 id="su-h">Suggestions</h2>
            <ul className="ap-suggest">{data.suggestions.map(s => <li key={s}>{s}</li>)}</ul>
            <p className="muted">Compared with all agents over the same period: {days(data.platform.timeToSaleDays)} to sale, {percent(data.platform.fallThroughRate)} fell through.</p>
          </section>
          {data.comments.length > 0 && (
            <section className="ap-section" aria-labelledby="co-h">
              <h2 id="co-h">What buyers said</h2>
              <ul className="ap-quotes">{data.comments.map((c, i) => <li key={i}><span>{"★".repeat(c.rating)} <span className="muted">{c.month}</span></span><p>{c.comment}</p></li>)}</ul>
            </section>
          )}
          <p className="muted">Figures cover {data.range.from} to {data.range.to}. Buyers are never named.</p>
        </>
      )}
    </main>
  );
}
