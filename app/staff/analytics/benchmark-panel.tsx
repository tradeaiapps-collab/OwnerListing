"use client";
import { useEffect, useState } from "react";
import { formatKpi } from "../../../src/domain/admin-dashboard";
import { METRIC_INFO, PERIOD_DAYS, type Benchmark, type MetricKey, type MetricValues } from "../../../src/domain/agent-benchmark";
import { LineChart } from "../charts";
import { loadError } from "../staff-api";
import "../../styles/analytics-suite.css";

type Team = { id: string; name: string };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;
const BASIS: Record<string, string> = { area: "area", price: "price band", experience: "experience" };

export function metricText(k: MetricKey, v: number | undefined): string {
  if (v === undefined) return "–";
  const unit = METRIC_INFO[k].unit;
  return unit === "cents" ? formatKpi(v, "cents") : unit === "percent" ? `${v}%` : unit === "days" ? `${v} d` : String(v);
}

/** Change against the previous period, coloured by whether it is better or worse for this metric (and always written in words). */
function Change({ k, now, before }: { k: MetricKey; now?: number | undefined; before?: number | undefined }) {
  if (now === undefined || before === undefined) return <span className="kpi-change">No earlier figure</span>;
  const d = Math.round((now - before) * 10) / 10;
  if (d === 0) return <span>No change</span>;
  const better = METRIC_INFO[k].higherIsBetter ? d > 0 : d < 0;
  const unit = METRIC_INFO[k].unit;
  const amount = unit === "cents" ? formatKpi(Math.abs(d), "cents") : unit === "percent" ? `${Math.abs(d)} pts` : unit === "days" ? `${Math.abs(d)} d` : String(Math.abs(d));
  return <span className={better ? "change-up" : "change-down"}>{d > 0 ? "▲" : "▼"} {amount} ({better ? "better" : "worse"})</span>;
}

export function BenchmarkPanel() {
  const [q, setQ] = useState({ days: "90", team: "" });
  const [data, setData] = useState<{ benchmark: Benchmark; teams: Team[] } | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(v: typeof q) {
    setBusy(true); setError("");
    const p = new URLSearchParams({ days: v.days });
    if (v.team) p.set("team", v.team);
    const r = await fetch(`/api/staff/analytics/benchmarks?${p}`).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) { setError(r?.status === 400 ? (await r.json().catch(() => ({}))).error ?? "Check the filters." : loadError(r?.status ?? 0)); return; }
    const body = await r.json();
    setData(body);
    setPick(body.benchmark.rows[0]?.key ?? null);
  }
  useEffect(() => { void load(q); }, []);

  const b = data?.benchmark;
  const row = b?.rows.find(r => r.key === pick);

  return (
    <section aria-label="Agent benchmarks">
      <p className="an-lead">Each agent against similar agents: same main suburb, price band and experience. Percentiles show the share of peers the agent does better than.</p>
      <form className="filters" onSubmit={e => { e.preventDefault(); void load(q); }}>
        <label>Period
          <select value={q.days} onChange={e => setQ({ ...q, days: e.target.value })}>
            {PERIOD_DAYS.map(d => <option key={d} value={d}>Last {d} days</option>)}
          </select>
        </label>
        <label>Agents
          <select value={q.team} onChange={e => setQ({ ...q, team: e.target.value })}>
            <option value="">All agents</option>
            {data?.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <button type="submit" disabled={busy}>{busy ? "Loading…" : "Show"}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {!b && !error && <p className="an-state" role="status">Loading benchmarks…</p>}
      {b && b.rows.length === 0 && <p className="an-state">No agents have been appointed to a listing yet, so there is nobody to compare.</p>}
      {b && b.rows.length > 0 && (
        <>
          <p className="muted">{b.period.from} to {b.period.to}, compared with {b.previousPeriod.from} to {b.previousPeriod.to}. Select an agent for the detail.</p>
          <div className="table-wrap bm-table">
            <table>
              <thead><tr>
                <th scope="col">Agent</th>
                {b.metrics.map(k => <th key={k} scope="col" className="num">{METRIC_INFO[k].label}</th>)}
                <th scope="col" className="num">Peers</th>
              </tr></thead>
              <tbody>
                {b.rows.map(r => (
                  <tr key={r.key} aria-selected={r.key === pick}>
                    <td className="agent">
                      <button type="button" className="row-pick" onClick={() => setPick(r.key)} aria-pressed={r.key === pick}>{r.label}</button>
                      <small>{r.area} · {r.priceBand} · {r.experienceBand}</small>
                    </td>
                    {b.metrics.map(k => <td key={k} className="num">{metricText(k, r.current[k])}<Pct v={r.percentiles[k]} /></td>)}
                    <td className="num">{r.peerCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {row && (
            <div className="bm-detail">
              <figure className="chart">
                <figcaption><span>{row.label} against {row.peerCount} peer{row.peerCount === 1 ? "" : "s"}</span></figcaption>
                <p className="muted">
                  {row.peerBasis.length ? `Peers share the agent's ${row.peerBasis.map(c => BASIS[c]).join(", ")}.` : "Too few similar agents, so peers are all other agents."}
                </p>
                <dl>
                  <dt className="head">Measure</dt><dd className="head">Agent</dd><dd className="head">Peer median</dd>
                  {b.metrics.map(k => (
                    <Row key={k} k={k} mine={row.current} peers={row.peerMedian} pct={row.percentiles[k]} />
                  ))}
                </dl>
              </figure>
              <figure className="chart">
                <figcaption><span>Change against the previous period</span></figcaption>
                <dl>
                  <dt className="head">Measure</dt><dd className="head">Before</dd><dd className="head">Change</dd>
                  {b.metrics.map(k => (
                    <ChangeRow key={k} k={k} now={row.current[k]} before={row.previous[k]} />
                  ))}
                </dl>
              </figure>
              <LineChart title={`${row.label}: sales per month`} labels={b.months.map(monthLabel)} series={[{ key: "sales", label: "Sales", values: row.monthlySales }]} />
            </div>
          )}
          <ul className="an-notes">{b.notes.map(n => <li key={n}>{n}</li>)}{!b.financial && <li>Commission is hidden: it needs the financial reports permission.</li>}</ul>
        </>
      )}
    </section>
  );
}

function Pct({ v }: { v: number | undefined }) {
  if (v === undefined) return null;
  return <span className="pct">{ordinal(v)} percentile<span className="pct-track" aria-hidden="true"><span className="pct-fill" style={{ width: `${Math.max(2, v)}%` }} /></span></span>;
}
function Row({ k, mine, peers, pct }: { k: MetricKey; mine: MetricValues; peers: MetricValues; pct: number | undefined }) {
  return (<><dt>{METRIC_INFO[k].label}{pct !== undefined && <span className="pct">{ordinal(pct)} percentile</span>}</dt><dd>{metricText(k, mine[k])}</dd><dd>{metricText(k, peers[k])}</dd></>);
}
function ChangeRow({ k, now, before }: { k: MetricKey; now: number | undefined; before: number | undefined }) {
  return (<><dt>{METRIC_INFO[k].label}</dt><dd>{metricText(k, before)}</dd><dd><Change k={k} now={now} before={before} /></dd></>);
}
export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}
