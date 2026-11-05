"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import "../../styles/admin.css";
import "../../styles/report-builder.css";
import { formatMeasure, type Insights } from "../../../src/domain/report-insights";
import { change, comparable, measureOf, type MeasureKey, type PeriodKey, type ReportDefinition, type ReportResult, type ReportSchedule, type Values } from "../../../src/domain/saved-reports";
import { loadError } from "../staff-api";

type Catalogue = {
  dimensions: readonly { key: string; label: string }[]; periods: readonly { key: PeriodKey; label: string }[];
  measures: readonly { key: MeasureKey; label: string }[];
  templates: readonly { id: string; label: string; blurb: string; definition: Omit<ReportDefinition, "shared"> }[];
};
type SavedItem = { id: string; mine: boolean; definition: ReportDefinition; shared: boolean; lastRunAt: string | null; schedule: (ReportSchedule & { enabled: boolean; description: string; lastStatus: string | null }) | null };
type RunItem = { id: string; trigger: string; periodFrom: string; periodTo: string; createdAt: string };
type Out = { result: ReportResult; insights: Insights };

const BLANK: ReportDefinition = { name: "My report", dimension: "category", measures: ["listingsCreated", "offers", "accepted"], period: "last_30_days", compare: true, shared: false };
const DEFAULT_SCHEDULE: ReportSchedule = { frequency: "weekly", weekday: 1, dayOfMonth: 1, hour: 7 };
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const STATUS_TEXT: Record<string, string> = { sent: "Last run emailed", not_configured: "Last run saved, but email is not set up", failed: "Last run could not be emailed", owner_no_access: "Switched off: you no longer have access" };

const post = async (url: string, method: string, body?: unknown) => {
  const r = await fetch(url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }).catch(() => null);
  return { status: r?.status ?? 0, data: r ? await r.json().catch(() => ({})) : {} } as { status: number; data: Record<string, unknown> };
};
const errorText = (s: number, d: Record<string, unknown>) => (typeof d["error"] === "string" ? d["error"] : loadError(s));

function Delta({ m, now, before }: { m: MeasureKey; now: number; before: number }) {
  const c = change(now, before);
  if (c.abs === 0) return <span className="rb-delta">no change</span>;
  const text = c.pct === null ? "new" : `${c.pct > 0 ? "+" : ""}${c.pct}%`;
  return <span className={`rb-delta ${c.abs > 0 ? "up" : "down"}`}>{c.abs > 0 ? "▲" : "▼"} {text}<span className="sr-only"> against {formatMeasure(m, before)} before</span></span>;
}

/** Report builder: pick a template or build your own, compare with the previous period, save it, schedule it by email, download CSV, Excel or PDF. */
export default function ReportBuilder() {
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [saved, setSaved] = useState<SavedItem[]>([]);
  const [def, setDef] = useState<ReportDefinition>(BLANK);
  const [selected, setSelected] = useState<SavedItem | null>(null);
  const [emailMe, setEmailMe] = useState(false);
  const [sched, setSched] = useState<ReportSchedule>(DEFAULT_SCHEDULE);
  const [out, setOut] = useState<Out | null>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/staff/saved-reports").catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return null; }
    const d = await r.json();
    setCat(d.catalogue); setSaved(d.reports);
    return d.reports as SavedItem[];
  }, []);

  const run = useCallback(async (body: unknown) => {
    setBusy(true); setError(""); setSnapshot(null);
    const r = await post("/api/staff/saved-reports/run", "POST", body);
    setBusy(false);
    if (r.status !== 200) { setError(errorText(r.status, r.data)); return null; }
    setOut({ result: r.data["result"] as ReportResult, insights: r.data["insights"] as Insights });
    return r.data;
  }, []);

  const open = useCallback(async (item: SavedItem) => {
    setSelected(item); setDef(item.definition); setEmailMe(item.schedule !== null); setSched(item.schedule ?? DEFAULT_SCHEDULE); setNote(""); setRuns([]);
    void run({ id: item.id });
    if (item.mine) {
      const r = await fetch(`/api/staff/saved-reports/${item.id}`).catch(() => null);
      if (r?.ok) setRuns((await r.json()).runs);
    }
  }, [run]);

  useEffect(() => {
    void (async () => {
      const list = await refresh();
      if (!list) return;
      const want = new URLSearchParams(window.location.search).get("report");
      const hit = want ? list.find(x => x.id === want) : undefined;
      if (hit) void open(hit); else void run({ definition: BLANK });
    })();
  }, [refresh, open, run]);

  const set = <K extends keyof ReportDefinition>(k: K, v: ReportDefinition[K]) => setDef(d => ({ ...d, [k]: v }));
  const toggle = (m: MeasureKey) => setDef(d => ({ ...d, measures: d.measures.includes(m) ? d.measures.filter(x => x !== m) : [...d.measures, m] }));
  const body = (): Record<string, unknown> => ({ ...def, ...(def.period !== "custom" ? { from: undefined, to: undefined } : {}) });
  const dlParams = useMemo(() => {
    const p = new URLSearchParams({ name: def.name, dimension: def.dimension, measures: def.measures.join(","), period: def.period });
    if (def.period === "custom") { p.set("from", def.from ?? ""); p.set("to", def.to ?? ""); }
    if (def.compare) p.set("compare", "1");
    return p;
  }, [def]);
  const href = (format: string) => (snapshot && selected ? `/api/staff/saved-reports/export?id=${selected.id}&run=${snapshot}&format=${format}` : `/api/staff/saved-reports/export?${dlParams}&format=${format}`);

  async function save() {
    setBusy(true); setError(""); setNote("");
    const payload = { definition: body(), schedule: emailMe ? sched : null };
    const r = selected?.mine ? await post(`/api/staff/saved-reports/${selected.id}`, "PATCH", payload) : await post("/api/staff/saved-reports", "POST", payload);
    setBusy(false);
    if (r.status >= 300 || r.status === 0) { setError(errorText(r.status, r.data)); return; }
    setNote(emailMe ? "Saved. It will be emailed to you on the schedule below." : "Saved.");
    const list = await refresh();
    const id = selected?.mine ? selected.id : (r.data["id"] as string);
    const hit = list?.find(x => x.id === id);
    if (hit) { setSelected(hit); setEmailMe(hit.schedule !== null); }
  }

  async function remove() {
    if (!selected?.mine) return;
    setBusy(true);
    const r = await post(`/api/staff/saved-reports/${selected.id}`, "DELETE");
    setBusy(false);
    if (r.status !== 200) { setError(errorText(r.status, r.data)); return; }
    setSelected(null); setDef(BLANK); setEmailMe(false); setNote("Report deleted."); await refresh();
  }

  async function keepSnapshot() {
    if (!selected?.mine) return;
    const d = await run({ id: selected.id, record: true });
    if (d) { setNote("Snapshot kept in history."); const r = await fetch(`/api/staff/saved-reports/${selected.id}`).catch(() => null); if (r?.ok) setRuns((await r.json()).runs); }
  }

  async function viewRun(id: string) {
    if (!selected) return;
    setBusy(true);
    const r = await fetch(`/api/staff/saved-reports/${selected.id}/runs/${id}`).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setError(loadError(r?.status ?? 0)); return; }
    setOut(await r.json()); setSnapshot(id); setError("");
  }

  function startFrom(t: Catalogue["templates"][number]) {
    setSelected(null); setRuns([]); setEmailMe(false); setNote("");
    const d = { ...t.definition, shared: false };
    setDef(d); void run({ definition: d });
  }

  const r = out?.result;
  const showCompare = r?.previousTotals !== undefined;
  const cell = (v: Values, m: MeasureKey) => formatMeasure(m, v[m] ?? 0);

  return (
    <main className="admin-page">
      <h1>Report builder</h1>
      <p className="muted">Build a report, compare it with the previous period, save it and have it emailed to you on a schedule. Elena summarises what changed.</p>
      {error && <p role="alert" className="admin-notice">{error}</p>}
      {note && <p role="status" className="muted">{note}</p>}
      <div className="rb">
        <div className="rb-side">
          <section className="rb-panel" aria-labelledby="rb-t">
            <h2 id="rb-t">Start from a template</h2>
            <div className="rb-templates">
              {cat?.templates.map(t => <button key={t.id} type="button" className="rb-template secondary" onClick={() => startFrom(t)}><strong>{t.label}</strong><small>{t.blurb}</small></button>)}
            </div>
          </section>
          <section className="rb-panel" aria-labelledby="rb-s">
            <h2 id="rb-s">Saved reports</h2>
            {saved.length === 0 ? <p className="empty">Nothing saved yet. Build a report and choose Save.</p> : (
              <ul className="rb-saved">
                {saved.map(s => (
                  <li key={s.id}>
                    <button type="button" className="secondary" aria-current={selected?.id === s.id} onClick={() => void open(s)}>
                      <span>{s.definition.name}</span>
                      <span className="rb-tags">
                        {s.schedule && <span className="status-pill">{s.schedule.frequency}</span>}
                        {s.shared && <span className="status-pill">{s.mine ? "shared" : "shared with you"}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="secondary" onClick={() => { setSelected(null); setDef(BLANK); setEmailMe(false); setRuns([]); setNote(""); void run({ definition: BLANK }); }}>New blank report</button>
          </section>
        </div>

        <div className="rb-main">
          <form className="rb-panel" aria-labelledby="rb-e" onSubmit={e => { e.preventDefault(); void run(selected && !selected.mine ? { id: selected.id } : { definition: body() }); }}>
            <h2 id="rb-e">{selected ? (selected.mine ? "Edit report" : "Shared report (view only)") : "New report"}</h2>
            <fieldset disabled={selected !== null && !selected.mine} className="rb-form" style={{ border: 0, padding: 0 }}>
              <label className="rb-wide">Name<input type="text" value={def.name} maxLength={80} onChange={e => set("name", e.target.value)} /></label>
              <label>Group by
                <select value={def.dimension} onChange={e => set("dimension", e.target.value as ReportDefinition["dimension"])}>
                  {cat?.dimensions.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
              </label>
              <label>Period
                <select value={def.period} onChange={e => set("period", e.target.value as PeriodKey)}>
                  {cat?.periods.filter(p => !(emailMe && p.key === "custom")).map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </label>
              {def.period === "custom" && <>
                <label>From<input type="date" value={def.from ?? ""} onChange={e => set("from", e.target.value)} /></label>
                <label>To<input type="date" value={def.to ?? ""} onChange={e => set("to", e.target.value)} /></label>
              </>}
              <fieldset className="rb-measures rb-wide">
                <legend>Measures</legend>
                {cat?.measures.map(m => <label key={m.key} className="rb-check"><input type="checkbox" checked={def.measures.includes(m.key)} onChange={() => toggle(m.key)} />{m.label}</label>)}
              </fieldset>
              <label className="rb-check"><input type="checkbox" checked={def.compare} onChange={e => set("compare", e.target.checked)} />Compare with the previous period</label>
              <label className="rb-check"><input type="checkbox" checked={def.shared} onChange={e => set("shared", e.target.checked)} />Let other staff with report access open this report</label>
            </fieldset>

            {(!selected || selected.mine) && (
              <div className="rb-wide">
                <label className="rb-check"><input type="checkbox" checked={emailMe} onChange={e => { setEmailMe(e.target.checked); if (e.target.checked && def.period === "custom") set("period", "last_30_days"); }} />Email me this report on a schedule</label>
                {emailMe && (
                  <div className="rb-sched">
                    <label>How often
                      <select value={sched.frequency} onChange={e => setSched({ ...sched, frequency: e.target.value as ReportSchedule["frequency"] })}>
                        <option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option>
                      </select>
                    </label>
                    {sched.frequency === "weekly" && <label>On<select value={sched.weekday} onChange={e => setSched({ ...sched, weekday: Number(e.target.value) })}>{WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></label>}
                    {sched.frequency === "monthly" && <label>On day<select value={sched.dayOfMonth} onChange={e => setSched({ ...sched, dayOfMonth: Number(e.target.value) })}>{Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>}
                    <label>At (Brisbane time)<select value={sched.hour} onChange={e => setSched({ ...sched, hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, "0")}:00</option>)}</select></label>
                    <p className="muted rb-wide">Sent to your own sign-in email only. A scheduled report always covers the latest dates for its period.</p>
                  </div>
                )}
                {selected?.schedule && <p className="muted">{selected.schedule.description}. {selected.schedule.lastStatus ? STATUS_TEXT[selected.schedule.lastStatus] ?? "" : "Not run yet."}</p>}
              </div>
            )}

            <div className="rb-actions">
              <button type="submit" disabled={busy || def.measures.length === 0}>{busy ? "Working…" : "Run report"}</button>
              {(!selected || selected.mine) && <button type="button" className="secondary" disabled={busy || def.measures.length === 0} onClick={() => void save()}>{selected?.mine ? "Save changes" : "Save report"}</button>}
              {selected?.mine && <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>Delete</button>}
            </div>
          </form>

          {r && out && (
            <section className="rb-panel" aria-labelledby="rb-r" aria-live="polite">
              <h2 id="rb-r">{r.name}</h2>
              <p className="muted">{r.range.from} to {r.range.to}{r.previousRange ? `, compared with ${r.previousRange.from} to ${r.previousRange.to}` : ""}. &ldquo;Live now&rdquo; is today&apos;s status.{snapshot ? " This is a stored snapshot." : ""}</p>
              <div className="rb-elena">
                <img src="/assistant/elena-icon.png" alt="" width={56} height={56} />
                <div>
                  <span className="rb-elena-name">Elena&apos;s summary</span>
                  <p><strong>{out.insights.headline}</strong></p>
                  {out.insights.points.length > 0 && <ul>{out.insights.points.map(p => <li key={p}>{p}</li>)}</ul>}
                </div>
              </div>
              {r.rows.length === 0 ? <p className="empty">Nothing in this period.</p> : (
                <div className="table-wrap"><table className="rb-table">
                  <thead><tr><th scope="col">{r.dimensionLabel}</th>{r.measures.map(m => <th key={m} scope="col" className="num">{measureOf(m).label}</th>)}</tr></thead>
                  <tbody>
                    {r.rows.map(x => (
                      <tr key={x.key}><th scope="row">{x.label}</th>{r.measures.map(m => (
                        <td key={m} className="num">{cell(x.values, m)}{showCompare && x.previous && comparable(m) && <Delta m={m} now={x.values[m] ?? 0} before={x.previous[m] ?? 0} />}</td>
                      ))}</tr>
                    ))}
                  </tbody>
                  <tfoot><tr><th scope="row">Total</th>{r.measures.map(m => (
                    <td key={m} className="num"><strong>{cell(r.totals, m)}</strong>{showCompare && r.previousTotals && comparable(m) && <Delta m={m} now={r.totals[m] ?? 0} before={r.previousTotals[m] ?? 0} />}</td>
                  ))}</tr></tfoot>
                </table></div>
              )}
              <div className="rb-actions">
                <a className="button secondary" href={href("pdf")} download>Download PDF</a>
                <a className="button secondary" href={href("xlsx")} download>Download Excel</a>
                <a className="button secondary" href={href("csv")} download>Download CSV</a>
                {selected?.mine && !snapshot && <button type="button" className="secondary" disabled={busy} onClick={() => void keepSnapshot()}>Keep a snapshot</button>}
              </div>
            </section>
          )}

          {selected?.mine && (
            <section className="rb-panel" aria-labelledby="rb-h">
              <h2 id="rb-h">History</h2>
              {runs.length === 0 ? <p className="empty">No snapshots yet. Scheduled runs and &ldquo;Keep a snapshot&rdquo; are stored here so you can look back.</p> : (
                <ul className="rb-history">
                  {runs.map(h => (
                    <li key={h.id}>
                      <span>{h.periodFrom} to {h.periodTo} <span className="status-pill">{h.trigger === "schedule" ? "scheduled" : "manual"}</span></span>
                      <button type="button" className="secondary" disabled={busy} aria-pressed={snapshot === h.id} onClick={() => void viewRun(h.id)}>View</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
