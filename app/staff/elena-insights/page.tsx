"use client";
import { useEffect, useState } from "react";
import type { Insights, Trend } from "../../../src/domain/admin-elena-insights";
import { loadError } from "../staff-api";

interface Payload { insights: Insights; range: { from: string; to: string }; timeZone: string; persona: string }
const PRESETS = [{ label: "Last 30 days", days: 30 }, { label: "Last 90 days", days: 90 }, { label: "Last 180 days", days: 180 }];
const change = (t: Trend) => (t.changePct === undefined ? "new" : `${t.changePct > 0 ? "+" : ""}${t.changePct}%`);
const mins = (m?: number) => (m === undefined ? "–" : m < 90 ? `${m} min` : `${Math.round(m / 60)} h`);

/** Elena's read of the platform for admins: summary, alerts, agent comparison, area trends and recommendations. Read only. */
export default function ElenaInsights() {
  const [f, setF] = useState({ from: "", to: "" });
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(q: typeof f) {
    setBusy(true); setError("");
    const p = new URLSearchParams();
    if (q.from) p.set("from", q.from);
    if (q.to) p.set("to", q.to);
    const r = await fetch(`/api/staff/elena-insights?${p}`).catch(() => null);
    setBusy(false);
    if (!r) { setError(loadError(0)); return; }
    if (!r.ok) { setError(r.status === 400 ? (await r.json().catch(() => ({}))).error ?? "Check the dates." : loadError(r.status)); return; }
    const d: Payload = await r.json();
    setData(d); setF({ from: d.range.from, to: d.range.to });
  }
  useEffect(() => { void load(f); }, []);

  const preset = (days: number) => {
    const to = data?.range.to ?? "";
    if (to) void load({ to, from: new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10) });
  };
  const i = data?.insights;

  return (
    <main className="admin-page">
      <h1>{data ? `${data.persona}'s insights` : "Elena's insights"}</h1>
      <p><a href="/staff/analytics">Back to platform analytics</a></p>
      <form className="filters" onSubmit={e => { e.preventDefault(); void load(f); }}>
        <label>From <input type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} /></label>
        <label>To <input type="date" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} /></label>
        <button type="submit" disabled={busy}>{busy ? "Loading…" : "Show"}</button>
        {PRESETS.map(p => <button key={p.label} type="button" className="secondary" disabled={busy || !data} onClick={() => preset(p.days)}>{p.label}</button>)}
      </form>
      {error && <p role="alert">{error}</p>}
      {busy && !data && <p className="muted" role="status">Loading insights…</p>}
      {data && i && (
        <>
          <p className="muted">{data.range.from} to {data.range.to} ({data.timeZone}), compared with the equal period before it.</p>
          <p><strong>{i.summary}</strong></p>

          <h2>Alerts</h2>
          {i.alerts.length === 0 ? <p className="muted">No alerts for this period.</p> : (
            <ul className="card-list">
              {i.alerts.map(a => (
                <li key={a.id}><span className={`badge ${a.severity === "high" ? "badge-rejected" : "badge-countered"}`}>{a.severity === "high" ? "High" : "Watch"}</span> {a.message}</li>
              ))}
            </ul>
          )}

          <h2>Recommendations</h2>
          <ul>{i.recommendations.map(r => <li key={r}>{r}</li>)}</ul>

          <h2>Platform</h2>
          <div className="table-wrap"><table>
            <thead><tr><th scope="col">Measure</th><th scope="col" className="num">This period</th><th scope="col" className="num">Before</th><th scope="col" className="num">Change</th></tr></thead>
            <tbody>
              {([["Listings created", i.platform.listings], ["Enquiries", i.platform.enquiries], ["Offers", i.platform.offers], ["Offers accepted", i.platform.accepted]] as const).map(([label, t]) => (
                <tr key={label}><td>{label}</td><td className="num">{t.current}</td><td className="num">{t.previous}</td><td className="num">{change(t)}</td></tr>
              ))}
            </tbody>
          </table></div>
          <p className="muted">
            {i.platform.acceptanceRate !== undefined ? `${i.platform.acceptanceRate}% of decided offers accepted. ` : "Too few decided offers for an acceptance rate. "}
            {i.platform.offersPerEnquiryPct !== undefined ? `${i.platform.offersPerEnquiryPct} offers per 100 enquiries.` : ""}
          </p>

          <h2>Agents</h2>
          {i.agents.length === 0 ? <p className="muted">No agents are appointed to listings yet.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th scope="col">Agent</th><th scope="col" className="num">Rank</th><th scope="col" className="num">Listings</th><th scope="col" className="num">Enquiries</th>
                <th scope="col" className="num">Offers</th><th scope="col" className="num">Accepted</th><th scope="col" className="num">First reply</th><th scope="col" className="num">Unanswered</th><th scope="col">Notes</th></tr></thead>
              <tbody>
                {i.agents.map(a => (
                  <tr key={a.label}><td style={{ whiteSpace: "nowrap" }}>{a.label}</td><td className="num">{a.rank ?? "–"}</td><td className="num">{a.listings}</td><td className="num">{a.enquiries}</td><td className="num">{a.offers}</td>
                    <td className="num">{a.acceptanceRate === undefined ? "–" : `${a.acceptanceRate}%`}</td><td className="num">{mins(a.medianResponseMinutes)}</td><td className="num">{a.unanswered}</td><td>{a.note}</td></tr>
                ))}
              </tbody>
            </table></div>
          )}
          {i.agentsNote && <p className="muted">{i.agentsNote}</p>}
          <p className="muted">{i.teamNote}</p>

          <h2>Areas</h2>
          {i.areas.length === 0 ? <p className="muted">No area activity in this period.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th scope="col">Area</th><th scope="col" className="num">Enquiries</th><th scope="col" className="num">Change</th><th scope="col" className="num">Offers</th>
                <th scope="col" className="num">Offers per 100 enquiries</th><th scope="col" className="num">Live listings</th><th scope="col">Notes</th></tr></thead>
              <tbody>
                {i.areas.map(a => (
                  <tr key={a.area}><td style={{ whiteSpace: "nowrap" }}>{a.area}</td><td className="num">{a.enquiries.current}</td><td className="num">{change(a.enquiries)}</td><td className="num">{a.offers.current}</td>
                    <td className="num">{a.offersPerEnquiryPct ?? "–"}</td><td className="num">{a.publishedNow}</td><td>{a.note}</td></tr>
                ))}
              </tbody>
            </table></div>
          )}
          <p className="muted">{i.basis}</p>
        </>
      )}
    </main>
  );
}
