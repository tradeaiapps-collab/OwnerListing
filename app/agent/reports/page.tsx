"use client";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import "../../styles/enquiries.css";
import "../../styles/agent-workspace.css";
import "../../styles/agent-reports.css";

type Kind = "count" | "money" | "percent" | "minutes";
type Metric = { key: string; label: string; kind: Kind };
type Template = { key: string; label: string; blurb: string; metrics: string[]; groupBy: string; days: number };
type Def = { template: string; metrics: string[]; groupBy: string; period: { days: number } | { from: string; to: string } };
type Values = Record<string, number | undefined>;
type Report = {
  title: string; groupLabel: string; period: { from: string; to: string }; previousPeriod: { from: string; to: string };
  columns: Metric[]; rows: { key: string; label: string; values: Values }[]; totals: Values; truncated: boolean;
  comparison: { key: string; label: string; kind: Kind; current?: number; previous?: number; change?: number }[];
};
type Insights = { headline: string; points: string[] };
type Saved = { id: string; name: string; definition: Def; schedule?: { frequency: string; nextRunAt: string; lastRunAt?: string; lastStatus?: string } };
type Run = { id: string; trigger: string; periodFrom: string; periodTo: string; totals: Values; createdAt: string };
type Catalogue = { templates: Template[]; metrics: Metric[]; groups: { key: string; label: string }[]; periodDays: number[]; reports: Saved[] };

const aud = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
const fmt = (k: Kind, v: number | undefined) => (v === undefined ? "–" : k === "money" ? aud(v) : k === "percent" ? `${v}%` : String(v));
const FREQ_LABEL: Record<string, string> = { daily: "every day", weekly: "every Monday", monthly: "on the 1st of each month" };

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as T & { error?: string } };
}
const send = (method: string, data: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

function query(d: Def): string {
  const p = new URLSearchParams({ metrics: d.metrics.join(","), groupBy: d.groupBy });
  if (d.template !== "custom") p.set("template", d.template);
  if ("days" in d.period) p.set("days", String(d.period.days)); else { p.set("from", d.period.from); p.set("to", d.period.to); }
  return p.toString();
}

/** Agent reports: pick a template or build your own, compare with the previous period, export, save, and schedule by email. */
export default function AgentReports() {
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [def, setDef] = useState<Def>({ template: "sales", metrics: [], groupBy: "listing", period: { days: 90 } });
  const [fixed, setFixed] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [history, setHistory] = useState<Run[]>([]);
  const [current, setCurrent] = useState<Saved | null>(null);
  const [name, setName] = useState("");
  const [freq, setFreq] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    const r = await call<Catalogue>("/api/agent/reports").catch(() => null);
    if (!r) return setError("Could not load your reports.");
    if (r.status === 401) return setError("Sign in to use reports.");
    if (!r.ok) return setError(r.body.error ?? "Could not load your reports.");
    setError(""); setCat(r.body);
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);

  const run = useCallback(async (d: Def) => {
    setBusy(true); setNotice("");
    const r = await call<{ report: Report; insights: Insights }>(`/api/agent/reports/run?${query(d)}`).catch(() => null);
    setBusy(false);
    if (!r?.ok) return setError(r?.body.error ?? "Could not run that report.");
    setError(""); setReport(r.body.report); setInsights(r.body.insights); setHistory([]);
  }, []);

  function pick(t: Template) {
    const d: Def = { template: t.key, metrics: t.metrics, groupBy: t.groupBy, period: { days: t.days } };
    setDef(d); setFixed(false); setCurrent(null); setName(""); setFreq(""); void run(d);
  }
  function toggle(key: string) {
    setDef(d => ({ ...d, template: "custom", metrics: d.metrics.includes(key) ? d.metrics.filter(m => m !== key) : [...d.metrics, key] }));
  }
  async function open(s: Saved) {
    setCurrent(s); setDef(s.definition); setName(s.name); setFreq(s.schedule?.frequency ?? ""); setFixed(!("days" in s.definition.period));
    setBusy(true);
    const r = await call<{ report: Report; insights: Insights; history: Run[] }>(`/api/agent/reports/${s.id}`).catch(() => null);
    setBusy(false);
    if (!r?.ok) return setError(r?.body.error ?? "Could not open that report.");
    setError(""); setReport(r.body.report); setInsights(r.body.insights); setHistory(r.body.history);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    const body = { name, definition: def, schedule: freq ? { frequency: freq } : current ? null : undefined };
    const r = current ? await call(`/api/agent/reports/${current.id}`, send("PUT", body)) : await call<{ id: string }>("/api/agent/reports", send("POST", body));
    if (!r.ok) return setError(r.body.error ?? "Could not save the report.");
    setError(""); setNotice(freq ? `Saved. It will be emailed to you ${FREQ_LABEL[freq]} at 8am Brisbane time.` : "Saved."); await loadList();
    if (!current) setName("");
  }
  async function snapshot(s: Saved) {
    const r = await call<{ history: Run[] }>(`/api/agent/reports/${s.id}?snapshot=1`).catch(() => null);
    if (!r?.ok) return setError(r?.body.error ?? "Could not store a snapshot.");
    setHistory(r.body.history); setNotice("This run's totals were added to the history.");
  }
  async function remove(s: Saved) {
    const r = await call(`/api/agent/reports/${s.id}`, { method: "DELETE" });
    if (!r.ok) return setError(r.body.error ?? "Could not delete the report.");
    if (current?.id === s.id) { setCurrent(null); setReport(null); setInsights(null); }
    await loadList();
  }

  const q = useMemo(() => query(def), [def]);
  const exportBase = current ? `/api/agent/reports/${current.id}?` : `/api/agent/reports/run?${q}&`;
  const bars = report?.groupLabel === "Month" ? report.columns[0] : undefined;
  const maxBar = bars ? Math.max(1, ...report!.rows.map(r => r.values[bars.key] ?? 0)) : 1;

  return (
    <main className="aw ar">
      <h1>Reports</h1>
      <p><a href="/agent/workspace">Agent workspace</a> · Reports use only your own appointed listings, enquiries and offers. They never include buyer names.</p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!cat && !error && <p className="muted" role="status">Loading…</p>}
      {cat && (
        <div className="aw-main ar-main">
          <div className="ar-col">
            <section className="aw-card" aria-labelledby="tpl-h">
              <h2 id="tpl-h">Start from a template</h2>
              <ul className="ar-tpls">
                {cat.templates.map(t => (
                  <li key={t.key}><button type="button" aria-pressed={def.template === t.key} onClick={() => pick(t)}><strong>{t.label}</strong><small>{t.blurb}</small></button></li>
                ))}
              </ul>
            </section>

            <form className="aw-card ar-form" onSubmit={e => void save(e)} aria-labelledby="build-h">
              <h2 id="build-h">{current ? "Edit report" : "Build your own"}</h2>
              <fieldset><legend>Columns</legend>
                <div className="ar-metrics">{cat.metrics.map(m => (
                  <label key={m.key}><input type="checkbox" checked={def.metrics.includes(m.key)} onChange={() => toggle(m.key)} /> {m.label}</label>
                ))}</div>
              </fieldset>
              <div className="ar-row">
                <label>Group by
                  <select value={def.groupBy} onChange={e => setDef({ ...def, template: "custom", groupBy: e.target.value })}>{cat.groups.map(g => <option key={g.key} value={g.key}>{g.label}</option>)}</select>
                </label>
                <label>Period
                  <select value={fixed ? "fixed" : "days" in def.period ? String(def.period.days) : "90"} onChange={e => {
                    if (e.target.value === "fixed") { setFixed(true); setFreq(""); setDef({ ...def, template: "custom", period: { from: "", to: "" } }); }
                    else { setFixed(false); setDef({ ...def, template: "custom", period: { days: Number(e.target.value) } }); }
                  }}>
                    {cat.periodDays.map(d => <option key={d} value={d}>Last {d} days</option>)}<option value="fixed">Choose dates</option>
                  </select>
                </label>
                {fixed && !("days" in def.period) && (<>
                  <label>From <input type="date" value={def.period.from} onChange={e => setDef({ ...def, period: { ...(def.period as { from: string; to: string }), from: e.target.value } })} /></label>
                  <label>To <input type="date" value={def.period.to} onChange={e => setDef({ ...def, period: { ...(def.period as { from: string; to: string }), to: e.target.value } })} /></label>
                </>)}
              </div>
              <div className="ar-actions">
                <button type="button" onClick={() => void run(def)} disabled={busy || def.metrics.length === 0}>{busy ? "Running…" : "Run report"}</button>
              </div>
              <hr />
              <div className="ar-row">
                <label>Name <input value={name} onChange={e => setName(e.target.value)} maxLength={80} required placeholder="e.g. Monthly sales" /></label>
                <label>Email me
                  <select value={freq} onChange={e => setFreq(e.target.value)} disabled={fixed}>
                    <option value="">Not scheduled</option><option value="daily">Every day</option><option value="weekly">Every Monday</option><option value="monthly">On the 1st of each month</option>
                  </select>
                </label>
              </div>
              <p className="aw-meta">Scheduled reports go to your account email at 8am Brisbane time{fixed ? ". Scheduling needs a rolling period, not fixed dates" : ""}.</p>
              <div className="ar-actions">
                <button type="submit" disabled={def.metrics.length === 0}>{current ? "Save changes" : "Save report"}</button>
                {current && <button type="button" className="secondary" onClick={() => { setCurrent(null); setName(""); setFreq(""); }}>Save as new instead</button>}
              </div>
            </form>

            <section className="aw-card" aria-labelledby="saved-h">
              <h2 id="saved-h">Saved reports</h2>
              {cat.reports.length === 0 && <p className="empty">Nothing saved yet. Run a template, then give it a name.</p>}
              <ul className="ar-saved">
                {cat.reports.map(s => (
                  <li key={s.id} className={current?.id === s.id ? "is-open" : ""}>
                    <div><strong>{s.name}</strong>
                      <p className="aw-meta">{s.schedule ? `Emailed ${FREQ_LABEL[s.schedule.frequency]}${s.schedule.lastStatus ? ` · last: ${s.schedule.lastStatus.replace("_", " ")}` : ""}` : "Not scheduled"}</p></div>
                    <div className="ar-actions">
                      <button type="button" onClick={() => void open(s)}>Open</button>
                      <button type="button" className="secondary" onClick={() => void snapshot(s)}>Add to history</button>
                      <button type="button" className="secondary" onClick={() => void remove(s)} aria-label={`Delete ${s.name}`}>Delete</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="ar-col">
            <section className="aw-card" aria-labelledby="out-h" aria-busy={busy}>
              <h2 id="out-h">{report ? report.title : "Report"}</h2>
              {!report && <p className="empty">Choose a template or build a report, then run it.</p>}
              {report && insights && (
                <>
                  <aside className="aw-elena ar-elena" aria-label="Elena's summary">
                    <div className="aw-elena-head"><img src="/assistant/elena-pose-tablet.jpg" alt="" width={44} height={44} /><div><strong>Elena</strong><br /><small>AI assistant, not a licensed agent</small></div></div>
                    <p className="aw-answer">{insights.headline}</p>
                    {insights.points.length > 0 && <ul>{insights.points.map((p, i) => <li key={i}>{p}</li>)}</ul>}
                  </aside>
                  <p className="aw-meta">{report.period.from} to {report.period.to}, compared with {report.previousPeriod.from} to {report.previousPeriod.to}.</p>
                  <ul className="aw-kpis ar-kpis" aria-label="Totals">
                    {report.comparison.map(c => (
                      <li key={c.key} className="aw-kpi"><span>{c.label}</span><strong>{fmt(c.kind, c.current)}</strong>
                        <small>{c.previous === undefined ? "No earlier figure" : `Before: ${fmt(c.kind, c.previous)}${c.change !== undefined ? ` (${c.change > 0 ? "+" : ""}${c.change}%)` : ""}`}</small></li>
                    ))}
                  </ul>
                  {bars && (
                    <figure className="ar-bars" aria-label={`${bars.label} by month`}>
                      <figcaption>{bars.label} by month</figcaption>
                      {report.rows.map(r => <div key={r.key} className="ar-bar"><span>{r.label}</span><i style={{ width: `${((r.values[bars.key] ?? 0) / maxBar) * 100}%` }} /><b>{fmt(bars.kind, r.values[bars.key])}</b></div>)}
                    </figure>
                  )}
                  <div className="ar-scroll" tabIndex={0} role="region" aria-label="Report table">
                    <table>
                      <thead><tr><th scope="col">{report.groupLabel === "Total only" ? "Scope" : report.groupLabel}</th>{report.columns.map(c => <th key={c.key} scope="col" className="num">{c.label}</th>)}</tr></thead>
                      <tbody>
                        {report.rows.length === 0 && <tr><td colSpan={report.columns.length + 1} className="empty">No activity in this period.</td></tr>}
                        {report.rows.map(r => <tr key={r.key}><th scope="row">{r.label}</th>{report.columns.map(c => <td key={c.key} className="num">{fmt(c.kind, r.values[c.key])}</td>)}</tr>)}
                      </tbody>
                      <tfoot><tr><th scope="row">{report.rows.length ? "Total" : "All listings"}</th>{report.columns.map(c => <td key={c.key} className="num">{fmt(c.kind, report.totals[c.key])}</td>)}</tr></tfoot>
                    </table>
                  </div>
                  {report.truncated && <p className="aw-meta">Only the first 200 rows are shown.</p>}
                  <p className="ar-actions" aria-label="Export">
                    Export: <a className="button secondary" href={`${exportBase}format=csv`}>CSV</a> <a className="button secondary" href={`${exportBase}format=xlsx`}>Excel</a> <a className="button secondary" href={`${exportBase}format=pdf`}>PDF</a>
                  </p>
                </>
              )}
            </section>
            {current && (
              <section className="aw-card" aria-labelledby="hist-h">
                <h2 id="hist-h">History of {current.name}</h2>
                {history.length === 0 ? <p className="empty">No runs stored yet. Scheduled emails are stored here; use “Add to history” to store one by hand.</p> : (
                  <div className="ar-scroll" tabIndex={0} role="region" aria-label="Run history">
                    <table><thead><tr><th scope="col">Run</th><th scope="col">Period</th>{report?.columns.map(c => <th key={c.key} scope="col" className="num">{c.label}</th>)}</tr></thead>
                      <tbody>{history.map(h => <tr key={h.id}><th scope="row">{h.createdAt.slice(0, 10)} · {h.trigger}</th><td>{h.periodFrom} to {h.periodTo}</td>{report?.columns.map(c => <td key={c.key} className="num">{fmt(c.kind, h.totals[c.key])}</td>)}</tr>)}</tbody></table>
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
