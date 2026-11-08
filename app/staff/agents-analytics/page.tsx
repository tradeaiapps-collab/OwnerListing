"use client";
import { useCallback, useEffect, useState } from "react";
import { PERFORMANCE_PERIODS, type AdminAnalytics } from "../../../src/domain/agent-performance";
import { days, percent } from "../../agent-performance-ui";
import { loadError } from "../staff-api";
import "../../styles/agent-performance.css";

/** Every agent ranked by average time to sale, with the fall-through outlier flag and a CSV export. */
export default function StaffAgentsAnalytics() {
  const [period, setPeriod] = useState("180");
  const [data, setData] = useState<AdminAnalytics | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (d: string) => {
    setError("");
    const r = await fetch(`/api/staff/agents-analytics?days=${d}`).catch(() => null);
    if (!r || !r.ok) { setData(null); setError(r?.status === 400 ? "Check the period." : loadError(r?.status ?? 0)); return; }
    setData((await r.json()).analytics);
  }, []);
  useEffect(() => { void load(period); }, [period, load]);

  const flagged = data?.rows.filter(r => r.flagged) ?? [];
  return (
    <main className="admin-page ap">
      <div>
        <h1>Agent performance</h1>
        <p className="ap-lead">All agents ranked by average days from listing to accepted offer. Flagged agents have a high share of accepted offers that fell through.</p>
      </div>
      <div className="ap-filters">
        <label>Period
          <select value={period} onChange={e => setPeriod(e.target.value)}>
            {PERFORMANCE_PERIODS.map(d => <option key={d} value={d}>Last {d} days</option>)}
          </select>
        </label>
        <div className="actions"><a className="button secondary" href={`/api/staff/agents-analytics?days=${period}&format=csv`}>Export CSV</a></div>
      </div>
      {error && <p role="alert" className="ap-error">{error}</p>}
      {!data && !error && <p className="ap-state" role="status">Loading…</p>}
      {data && (
        <>
          <div className="ap-kpis">
            <div className="ap-kpi"><span>Sales</span><strong>{data.platform.sold}</strong></div>
            <div className="ap-kpi"><span>Avg days to sale</span><strong>{days(data.platform.timeToSaleDays)}</strong></div>
            <div className="ap-kpi"><span>Avg buyer rating</span><strong>{data.platform.satisfaction ?? "–"}</strong></div>
            <div className="ap-kpi"><span>Fall-through rate</span><strong>{percent(data.platform.fallThroughRate)}</strong></div>
            <div className="ap-kpi"><span>Agents flagged</span><strong>{flagged.length}</strong></div>
          </div>
          {data.rows.length === 0 ? <div className="ap-state">No agents have been appointed to a listing yet.</div> : (
            <div className="ap-table-wrap">
              <table className="ap-table">
                <caption className="sr-only">Agents ranked by average days to sale</caption>
                <thead><tr>
                  <th scope="col" className="num">#</th><th scope="col">Agent</th>
                  <th scope="col" className="num">Avg days to sale</th><th scope="col" className="num">Sales per month</th>
                  <th scope="col" className="num">Buyer rating</th><th scope="col" className="num">Price vs asking</th>
                  <th scope="col" className="num">Fell through</th><th scope="col">Flag</th>
                </tr></thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={r.key} className={r.flagged ? "flagged" : undefined}>
                      <td className="num">{i + 1}</td>
                      <td className="agent">{r.label}<small>{r.metrics.sold} sold · {r.metrics.acceptedOffers} accepted</small></td>
                      <td className="num">{days(r.metrics.timeToSaleDays)}</td>
                      <td className="num">{r.metrics.dealVelocity}</td>
                      <td className="num">{r.metrics.satisfaction !== undefined ? `${r.metrics.satisfaction} (${r.metrics.ratingCount})` : "–"}</td>
                      <td className="num">{percent(r.metrics.priceVariancePercent, true)}</td>
                      <td className="num">{percent(r.metrics.fallThroughRate)}</td>
                      <td>{r.flagged ? <span className="ap-flag" title={r.flagReason}>High fall-through</span> : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted">{data.range.from} to {data.range.to}.</p>
          <ul className="ap-notes">{data.notes.map(n => <li key={n}>{n}</li>)}</ul>
        </>
      )}
    </main>
  );
}
