"use client";
import { useEffect, useState } from "react";
import type { Bucket } from "../../../src/domain/admin-analytics";
import { changePercent, formatKpi } from "../../../src/domain/admin-dashboard";
import type { TeamTrends } from "../../../src/domain/team-trends";
import { LineChart } from "../charts";
import { loadError } from "../staff-api";
import "../../styles/analytics-suite.css";

type Team = { id: string; name: string };
const dollars = (c: number) => formatKpi(c, "cents");
const compact = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", notation: "compact", maximumFractionDigits: 2 });
/** Short money for tiles and axes ("$20.79M"); the table view and titles keep whole dollars. */
const money = (c: number) => compact.format(c / 100);
const PRESETS: { label: string; days: number; bucket: Bucket }[] = [
  { label: "Last 30 days", days: 30, bucket: "day" },
  { label: "Last 90 days", days: 90, bucket: "week" },
  { label: "Last 12 months", days: 365, bucket: "month" }
];

export function TrendsPanel() {
  const [f, setF] = useState({ from: "", to: "", bucket: "week" as Bucket, team: "" });
  const [data, setData] = useState<{ trends: TeamTrends; teams: Team[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(q: typeof f) {
    setBusy(true); setError("");
    const p = new URLSearchParams({ bucket: q.bucket });
    if (q.from) p.set("from", q.from);
    if (q.to) p.set("to", q.to);
    if (q.team) p.set("team", q.team);
    const r = await fetch(`/api/staff/analytics/trends?${p}`).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) { setError(r?.status === 400 ? (await r.json().catch(() => ({}))).error ?? "Check the filters." : loadError(r?.status ?? 0)); return; }
    const body = await r.json();
    setData(body);
    setF({ ...q, from: body.trends.range.from, to: body.trends.range.to, bucket: body.trends.range.bucket });
  }
  useEffect(() => { void load(f); }, []);

  const preset = (days: number, bucket: Bucket) => {
    const to = data?.trends.range.to ?? "";
    const from = to ? new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10) : "";
    void load({ ...f, from, to, bucket });
  };
  const t = data?.trends;
  const series = (k: string) => t?.series.find(s => s.key === k);

  return (
    <section aria-label="Team trends">
      <p className="an-lead">The agents' combined results over time, with drops and growth spikes called out against the recent average.</p>
      <form className="filters" onSubmit={e => { e.preventDefault(); void load(f); }}>
        <label>From <input type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} /></label>
        <label>To <input type="date" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} /></label>
        <label>Group by
          <select value={f.bucket} onChange={e => setF({ ...f, bucket: e.target.value as Bucket })}>
            <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
          </select>
        </label>
        <label>Agents
          <select value={f.team} onChange={e => setF({ ...f, team: e.target.value })}>
            <option value="">All agents</option>
            {data?.teams.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <button type="submit" disabled={busy}>{busy ? "Loading…" : "Show"}</button>
        {PRESETS.map(p => <button key={p.label} type="button" className="secondary" disabled={busy} onClick={() => preset(p.days, p.bucket)}>{p.label}</button>)}
      </form>
      {error && <p role="alert">{error}</p>}
      {!t && !error && <p className="an-state" role="status">Loading team trends…</p>}
      {t && (
        <>
          <p className="muted">
            {t.scope}, {t.range.from} to {t.range.to} by {t.range.bucket}, compared with {t.previous.from} to {t.previous.to}.
            {(t.partial.first || t.partial.last) && ` The ${t.partial.first && t.partial.last ? "first and last" : t.partial.first ? "first" : "last"} ${t.range.bucket} is only partly in the period, so it is not used for alerts.`}
          </p>
          <div className="kpis">
            <Kpi label="Sales" value={t.totals.sales ?? 0} prev={t.previousTotals.sales} fmt={String} />
            {t.financial && <Kpi label="Sales volume" value={t.totals.volume ?? 0} prev={t.previousTotals.volume} fmt={money} />}
            {t.financial && <Kpi label="Average sale price" value={t.totals.averagePrice} prev={t.previousTotals.averagePrice} fmt={money} />}
            <Kpi label="Lead conversion" value={t.totals.conversion} prev={t.previousTotals.conversion} fmt={v => `${v}%`} />
          </div>
          <h2>What changed</h2>
          <p><span className={`status-pill ${t.direction.direction === "growing" ? "good" : t.direction.direction === "declining" ? "bad" : ""}`}>{cap(t.direction.direction)}</span> {t.direction.text}</p>
          {t.signals.length === 0
            ? <p className="an-state">No drops or spikes of 30% or more against the recent average in this period.</p>
            : <ul className="signals">{t.signals.map(s => (
                <li key={`${s.measure}-${s.bucket}`} className={s.kind}>
                  <span className={`status-pill ${s.kind === "drop" ? "bad" : "good"}`}>{s.kind === "drop" ? "Drop" : "Growth"}</span><span>{s.text}</span>
                </li>
              ))}</ul>}
          <div className="charts an-charts">
            <LineChart title={`Sales (${series("sales")!.total})`} labels={t.labels} series={[series("sales")!]} />
            {t.financial && <LineChart title={`Sales volume (${dollars(series("volume")!.total)})`} labels={t.labels} series={[series("volume")!]} format={money} />}
            {t.financial && <LineChart title={`Average sale price (${dollars(series("averagePrice")!.total)} over the period)`} labels={t.labels} series={[series("averagePrice")!]} format={money} />}
            <LineChart title={`Lead conversion (${series("conversion")!.total}% over the period)`} labels={t.labels} series={[series("conversion")!]} format={v => `${Math.round(v)}%`} />
          </div>
          <ul className="an-notes">
            <li>A sale is an accepted offer on a sale listing, dated by submission. Lead conversion is the share of enquiries whose buyer went on to make a formal offer.</li>
            <li>An alert needs at least 3 earlier {t.range.bucket}s and an average of 2 sales (or 5 enquiries for conversion), so small numbers do not raise false alarms.</li>
            {!t.financial && <li>Sales volume and average price are hidden: they need the financial reports permission.</li>}
          </ul>
        </>
      )}
    </section>
  );
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function Kpi({ label, value, prev, fmt }: { label: string; value: number | undefined; prev: number | undefined; fmt: (n: number) => string }) {
  const change = value === undefined || prev === undefined ? null : changePercent(value, prev);
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value === undefined ? "–" : fmt(value)}</strong>
      <span className="kpi-change">{change === null ? "No earlier figure" : `${change > 0 ? "▲" : change < 0 ? "▼" : "■"} ${Math.abs(change)}% vs previous period`}</span>
    </div>
  );
}
