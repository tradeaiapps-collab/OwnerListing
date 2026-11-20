"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError } from "../staff-api";
import "../../styles/agent-performance.css";

type Row = { label: string; invited: number; accepted: number; declined: number; completed: number; cancelledAfterAccept: number; avgResponseMinutes: number | null; completionRate: number | null; complaints: number };

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const mins = (m: number | null) => (m === null ? "–" : m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`);

/** Jobs, response times, completion and complaints for every contractor in a date range, with a CSV export. */
export default function StaffContractors() {
  const [from, setFrom] = useState(daysAgo(89));
  const [to, setTo] = useState(today());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (f: string, t: string) => {
    setError("");
    const r = await fetch(`/api/staff/contractors-report?from=${f}&to=${t}`).catch(() => null);
    if (!r || !r.ok) { setRows(null); setError(r?.status === 400 ? ((await r.json().catch(() => ({}))).error ?? "Check the dates.") : loadError(r?.status ?? 0)); return; }
    setRows((await r.json()).rows);
  }, []);
  useEffect(() => { if (from && to) void load(from, to); }, [from, to, load]);

  const total = (k: "invited" | "completed" | "complaints") => (rows ?? []).reduce((n, r) => n + r[k], 0);
  return (
    <main className="admin-page ap">
      <div>
        <h1>Contractor report</h1>
        <p className="ap-lead">Photographers, inspectors and other contractors, for jobs invited in the range (UTC dates). Response time runs from the invitation to the first answer.</p>
      </div>
      <div className="ap-filters">
        <label>From<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label>
        <div className="actions"><a className="button secondary" href={`/api/staff/contractors-report?from=${from}&to=${to}&format=csv`}>Export CSV</a></div>
      </div>
      {error && <p role="alert" className="ap-error">{error}</p>}
      {!rows && !error && <p className="ap-state" role="status">Loading…</p>}
      {rows && (
        <>
          <div className="ap-kpis">
            <div className="ap-kpi"><span>Contractors</span><strong>{rows.length}</strong></div>
            <div className="ap-kpi"><span>Jobs invited</span><strong>{total("invited")}</strong></div>
            <div className="ap-kpi"><span>Jobs completed</span><strong>{total("completed")}</strong></div>
            <div className="ap-kpi"><span>Complaints</span><strong>{total("complaints")}</strong></div>
          </div>
          {rows.length === 0 ? <div className="ap-state">No contractor jobs were invited in this range.</div> : (
            <div className="ap-table-wrap">
              <table className="ap-table">
                <caption className="sr-only">Contractors with jobs, response time, completion rate and complaints</caption>
                <thead><tr>
                  <th scope="col">Contractor</th><th scope="col" className="num">Invited</th><th scope="col" className="num">Accepted</th>
                  <th scope="col" className="num">Declined</th><th scope="col" className="num">Completed</th><th scope="col" className="num">Avg response</th>
                  <th scope="col" className="num">Completion</th><th scope="col" className="num">Complaints</th>
                </tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.label} className={r.complaints > 0 ? "flagged" : undefined}>
                      <td className="agent">{r.label}<small>{r.cancelledAfterAccept} cancelled after accepting</small></td>
                      <td className="num">{r.invited}</td><td className="num">{r.accepted}</td><td className="num">{r.declined}</td><td className="num">{r.completed}</td>
                      <td className="num">{mins(r.avgResponseMinutes)}</td>
                      <td className="num">{r.completionRate === null ? "–" : `${r.completionRate}%`}</td>
                      <td className="num">{r.complaints}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ul className="ap-notes"><li>Completion rate is completed jobs divided by accepted jobs.</li><li>Names follow your personal-data permission.</li></ul>
        </>
      )}
    </main>
  );
}
