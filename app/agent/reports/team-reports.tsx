"use client";
import { useEffect, useMemo, useState } from "react";
import { PERIOD_DAYS, TEMPLATES, type MetricKind, type TemplateKey } from "../../../src/domain/agent-reports";
import { PROPERTY_TYPES, type TeamReportResult } from "../../../src/domain/team-reports";

type Mine = { id: string; name: string; role: string };
const aud = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
const fmt = (k: MetricKind, v: number | undefined) => (v === undefined ? "–" : k === "money" ? aud(v) : k === "percent" ? `${v}%` : String(v));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const GROUPS = [["none", "Agent"], ["listing", "Listing"], ["month", "Month"]] as const;

/** Team reports for managers: totals for the whole team, a row per agent, two agents side by side, filtered by period, agent and property type. */
export default function TeamReports() {
  const [teams, setTeams] = useState<Mine[] | null>(null);
  const [teamId, setTeamId] = useState("");
  const [template, setTemplate] = useState<TemplateKey>("sales");
  const [groupBy, setGroupBy] = useState<"none" | "listing" | "month">("none");
  const [days, setDays] = useState<number | "fixed">(90);
  const [range, setRange] = useState({ from: "", to: "" });
  const [propertyType, setPropertyType] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [data, setData] = useState<TeamReportResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/teams").catch(() => null);
      if (!r?.ok) return setTeams([]);
      const mine: Mine[] = ((await r.json().catch(() => ({}))).teams ?? []).filter((t: Mine) => t.role === "manager");
      setTeams(mine);
      const want = new URLSearchParams(window.location.search).get("team");
      setTeamId(mine.find(t => t.id === want)?.id ?? mine[0]?.id ?? "");
    })();
  }, []);

  const query = useMemo(() => {
    const p = new URLSearchParams({ template, groupBy });
    if (days === "fixed") { if (!range.from || !range.to) return ""; p.set("from", range.from); p.set("to", range.to); } else p.set("days", String(days));
    if (propertyType) p.set("propertyType", propertyType);
    if (picked.length) p.set("agents", picked.join(","));
    return p.toString();
  }, [template, groupBy, days, range, propertyType, picked]);

  useEffect(() => {
    if (!teamId || !query) return;
    let live = true;
    setBusy(true);
    void (async () => {
      const r = await fetch(`/api/teams/${teamId}/reports?${query}`).catch(() => null);
      if (!live) return;
      setBusy(false);
      if (!r) return setError("Network problem. Try again.");
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return setError(body.error ?? "Could not run the team report.");
      setError(""); setData(body);
    })();
    return () => { live = false; };
  }, [teamId, query]);

  if (!teams || teams.length === 0) return null;
  const report = data?.report;
  const togglePick = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  const exportBase = `/api/teams/${teamId}/reports?${query}&`;

  return (
    <section className="aw-card ar-team" aria-labelledby="team-rep-h">
      <h2 id="team-rep-h">Team reports</h2>
      <p className="aw-meta">For teams you manage. Totals count each enquiry and offer once, even when two agents share a listing. Reports never include buyer names.</p>
      <div className="ar-row">
        <label>Team
          <select value={teamId} onChange={e => { setTeamId(e.target.value); setPicked([]); setData(null); }}>{teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </label>
        <label>Report
          <select value={template} onChange={e => setTemplate(e.target.value as TemplateKey)}>{(Object.keys(TEMPLATES) as TemplateKey[]).map(k => <option key={k} value={k}>{TEMPLATES[k].label}</option>)}</select>
        </label>
        <label>Show by
          <select value={groupBy} onChange={e => setGroupBy(e.target.value as typeof groupBy)}>{GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        <label>Period
          <select value={days} onChange={e => setDays(e.target.value === "fixed" ? "fixed" : Number(e.target.value))}>
            {PERIOD_DAYS.map(d => <option key={d} value={d}>Last {d} days</option>)}<option value="fixed">Choose dates</option>
          </select>
        </label>
        {days === "fixed" && (<>
          <label>From <input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} /></label>
          <label>To <input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} /></label>
        </>)}
        <label>Property type
          <select value={propertyType} onChange={e => setPropertyType(e.target.value)}><option value="">All types</option>{PROPERTY_TYPES.map(t => <option key={t} value={t}>{cap(t)}</option>)}</select>
        </label>
      </div>
      {data && (
        <fieldset><legend>Agents (none ticked means everyone; tick two to compare them side by side)</legend>
          <div className="ar-metrics">{data.members.map(m => (
            <label key={m.userId}><input type="checkbox" checked={picked.includes(m.userId)} onChange={() => togglePick(m.userId)} /> {m.displayName}</label>
          ))}</div>
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
      {busy && !data && <p className="muted" role="status">Running…</p>}

      {data && report && (
        <div aria-busy={busy}>
          <aside className="aw-elena ar-elena" aria-label="Elena's summary">
            <div className="aw-elena-head"><img src="/assistant/elena-pose-tablet.jpg" alt="" width={44} height={44} /><div><strong>Elena</strong><br /><small>AI assistant, not a licensed agent</small></div></div>
            <p className="aw-answer">{data.insights.headline}</p>
            {data.insights.points.length > 0 && <ul>{data.insights.points.map((p, i) => <li key={i}>{p}</li>)}</ul>}
          </aside>
          <p className="aw-meta">{report.period.from} to {report.period.to}, compared with {report.previousPeriod.from} to {report.previousPeriod.to}. {data.truncatedMembers && "Only the first 50 people are included."}</p>
          <ul className="aw-kpis ar-kpis" aria-label="Team totals">
            {report.comparison.map(c => (
              <li key={c.key} className="aw-kpi"><span>{c.label}</span><strong>{fmt(c.kind, c.current)}</strong>
                <small>{c.previous === undefined ? "No earlier figure" : `Before: ${fmt(c.kind, c.previous)}${c.change !== undefined ? ` (${c.change > 0 ? "+" : ""}${c.change}%)` : ""}`}</small></li>
            ))}
          </ul>

          <div className="ar-scroll" tabIndex={0} role="region" aria-label="Team report table">
            <table>
              <thead><tr><th scope="col">{report.groupLabel}</th>{report.columns.map(c => <th key={c.key} scope="col" className="num">{c.label}</th>)}</tr></thead>
              <tbody>
                {report.rows.length === 0 && <tr><td colSpan={report.columns.length + 1} className="empty">No activity in this period.</td></tr>}
                {report.rows.map(r => <tr key={r.key}><th scope="row">{r.label}</th>{report.columns.map(c => <td key={c.key} className="num">{fmt(c.kind, r.values[c.key])}</td>)}</tr>)}
              </tbody>
              <tfoot><tr><th scope="row">Team total</th>{report.columns.map(c => <td key={c.key} className="num">{fmt(c.kind, report.totals[c.key])}</td>)}</tr></tfoot>
            </table>
          </div>

          {data.versus && (
            <div className="ar-scroll" tabIndex={0} role="region" aria-label={`${data.versus.a.displayName} compared with ${data.versus.b.displayName}`}>
              <table className="team-versus">
                <caption>{data.versus.a.displayName} and {data.versus.b.displayName}, side by side</caption>
                <thead><tr><th scope="col">Measure</th><th scope="col" className="num">{data.versus.a.displayName}</th><th scope="col" className="num">{data.versus.b.displayName}</th></tr></thead>
                <tbody>
                  {data.versus.rows.map(r => (
                    <tr key={r.key}><th scope="row">{r.label}</th>
                      <td className="num" data-lead={r.leader === "a"}>{fmt(r.kind, r.a)}{r.leader === "a" ? " ▲" : ""}</td>
                      <td className="num" data-lead={r.leader === "b"}>{fmt(r.kind, r.b)}{r.leader === "b" ? " ▲" : ""}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="aw-meta">▲ marks the better figure (for reply time and waiting buyers, the lower one).</p>
            </div>
          )}
          <p className="ar-actions" aria-label="Export">
            Export: <a className="button secondary" href={`${exportBase}format=csv`}>CSV</a> <a className="button secondary" href={`${exportBase}format=xlsx`}>Excel</a> <a className="button secondary" href={`${exportBase}format=pdf`}>PDF</a>
            {" "}<a href={`/teams/${teamId}/analytics`}>Team analytics</a>
          </p>
        </div>
      )}
    </section>
  );
}
