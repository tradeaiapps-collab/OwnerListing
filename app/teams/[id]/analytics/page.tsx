"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Change, TeamAnalytics } from "../../../../src/domain/team-analytics";
import { PRESENTER_SPEAK_EVENT } from "../../../presenter/presenter-core";

const PRESETS = [{ label: "Last 30 days", days: 30 }, { label: "Last 90 days", days: 90 }, { label: "Last 12 months", days: 365 }] as const;
const money = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
const shift = (c: Change) => (c.changePct === undefined ? "No earlier figure" : `${c.changePct > 0 ? "▲" : c.changePct < 0 ? "▼" : "■"} ${Math.abs(c.changePct)}% on the period before`);

function Bars({ title, rows, format }: { title: string; rows: { key: string; label: string; value: number }[]; format: (n: number) => string }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <figure className="team-bars">
      <figcaption>{title}</figcaption>
      {rows.length === 0 ? <p className="muted">Nothing to show in this period.</p> : rows.map(r => (
        <div key={r.key} className="team-bar"><span>{r.label}</span><i aria-hidden="true" style={{ width: `${(r.value / max) * 100}%` }} /><b>{format(r.value)}</b></div>
      ))}
    </figure>
  );
}

/** Team analytics for managers: what the team listed and sold, each agent's numbers, monthly trends and Elena's alerts. */
export default function TeamAnalyticsPage() {
  const id = String(useParams<{ id: string }>().id);
  const [data, setData] = useState<TeamAnalytics | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState({ from: "", to: "" });

  const load = useCallback(async (query: string) => {
    setBusy(true); setError("");
    const r = await fetch(`/api/teams/${id}/analytics?${query}`).catch(() => null);
    setBusy(false);
    if (!r) return setError("Network problem. Try again.");
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return setError(body.error ?? "Could not load analytics for this team.");
    setData(body.analytics);
    setRange({ from: body.analytics.period.from, to: body.analytics.period.to });
  }, [id]);
  useEffect(() => { void load("days=90"); }, [load]);

  if (error && !data) return <main className="team-page"><p role="alert">{error}</p><p><Link href={`/teams/${id}`}>Back to the team</Link></p></main>;
  if (!data) return <main className="team-page"><p className="muted" role="status">Loading…</p></main>;
  const { overview: o, agents, trends, alerts } = data;

  return (
    <main className="team-page">
      <p><Link href={`/teams/${id}`}>Back to {data.team.name}</Link> · <Link href={`/agent/reports?team=${id}`}>Team reports</Link></p>
      <h1>{data.team.name} analytics</h1>
      <form className="team-inline" onSubmit={e => { e.preventDefault(); void load(new URLSearchParams(range).toString()); }}>
        <label>From <input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} required /></label>
        <label>To <input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} required /></label>
        <button type="submit" disabled={busy}>{busy ? "Loading…" : "Show"}</button>
        {PRESETS.map(p => <button key={p.days} type="button" className="secondary" disabled={busy} onClick={() => void load(`days=${p.days}`)}>{p.label}</button>)}
      </form>
      {error && <p role="alert">{error}</p>}
      <p className="muted">{data.period.from} to {data.period.to}, compared with {data.previousPeriod.from} to {data.previousPeriod.to}.</p>

      <div className="elena-card">
        <img src="/assistant/elena-icon.png" alt="" width={56} height={56} />
        <div>
          <h2>Elena&apos;s read</h2>
          <p>{data.summary}</p>
          <button type="button" className="secondary" onClick={() => window.dispatchEvent(new CustomEvent(PRESENTER_SPEAK_EVENT, { detail: { text: data.summary } }))}>Read it aloud</button>
          {alerts.length > 0 && (
            <ul className="elena-list" aria-label="Alerts">
              {alerts.map(a => <li key={a.id} data-sev={a.severity}><strong>{a.title}</strong>{a.detail} <em>{a.suggestion}</em></li>)}
            </ul>
          )}
          <p className="muted">Suggestions only, worked out from the numbers on this page. Nothing changes until you act.</p>
        </div>
      </div>

      <dl className="team-kpis" aria-label="Overview">
        <div className="team-kpi"><dt>Listed now</dt><dd>{o.listedNow}</dd></div>
        <div className="team-kpi"><dt>Enquiries</dt><dd>{o.enquiries.current}</dd><dd className="team-kpi-sub">{shift(o.enquiries)}</dd></div>
        <div className="team-kpi"><dt>Offers</dt><dd>{o.offers.current}</dd><dd className="team-kpi-sub">{shift(o.offers)}</dd></div>
        <div className="team-kpi"><dt>Sold (offers accepted)</dt><dd>{o.sold.current}</dd><dd className="team-kpi-sub">{shift(o.sold)}</dd></div>
        <div className="team-kpi"><dt>Sales value</dt><dd>{money(o.soldCents.current)}</dd><dd className="team-kpi-sub">{shift(o.soldCents)}</dd></div>
        <div className="team-kpi"><dt>Commission recorded</dt><dd>{money(o.commissionGrossCents)}</dd><dd className="team-kpi-sub">{money(o.commissionAgentCents)} agents, {money(o.commissionOfficeCents)} agency</dd></div>
        <div className="team-kpi"><dt>Commission owed</dt><dd>{money(o.commissionOwedCents)}</dd><dd className="team-kpi-sub">Not yet marked paid</dd></div>
        <div className="team-kpi"><dt>Overdue tasks</dt><dd>{o.overdueTasks}</dd></div>
      </dl>

      <h2>Agents</h2>
      <div className="team-table-wrap">
        <table className="team-table">
          <caption className="sr-only">Performance by agent for the chosen period</caption>
          <thead><tr>
            <th scope="col">Agent</th><th scope="col" className="num">Listings</th><th scope="col" className="num">Enquiries</th><th scope="col" className="num">Offers</th>
            <th scope="col" className="num">Sold</th><th scope="col" className="num">Sales value</th><th scope="col" className="num">Acceptance</th>
            <th scope="col" className="num">Commission</th><th scope="col" className="num">Overdue</th>
          </tr></thead>
          <tbody>
            {agents.length === 0 && <tr><td colSpan={9} className="muted">No agents on this team yet.</td></tr>}
            {agents.map(a => (
              <tr key={a.userId}>
                <td className="name">{a.displayName}</td><td className="num">{a.activeListings}</td><td className="num">{a.enquiries}</td><td className="num">{a.offers}</td>
                <td className="num">{a.sold}</td><td className="num">{money(a.soldCents)}</td><td className="num">{a.acceptanceRate === undefined ? "–" : `${a.acceptanceRate}%`}</td>
                <td className="num">{money(a.commissionGrossCents)}</td><td className="num">{a.overdueTasks > 0 ? <span className="team-late">{a.overdueTasks}</span> : 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Trends</h2>
      <div className="team-charts">
        <Bars title="Sales per month (offers accepted)" rows={trends.buckets.map((b, n) => ({ key: b, label: trends.labels[n]!, value: trends.sold[n]! }))} format={String} />
        <Bars title="Sales value per month" rows={trends.buckets.map((b, n) => ({ key: b, label: trends.labels[n]!, value: trends.soldCents[n]! }))} format={money} />
        <Bars title="Sales value per agent" rows={trends.perAgent.map(a => ({ key: a.userId, label: a.displayName, value: a.total })).sort((x, y) => y.value - x.value)} format={money} />
      </div>
      <p className="muted">{data.basis}</p>
    </main>
  );
}
