"use client";
import { useEffect, useState } from "react";
import "../../styles/mortgage.css";

type Row = { date: string; ratePct: number };
const month = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" });

/** Agents: published average home-loan rate by month (RBA table F5), with the change from the month before. */
export default function AgentRates() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [months, setMonths] = useState(24);
  useEffect(() => {
    let live = true;
    setRows(null);
    fetch(`/api/mortgage/rates?history=${months}`).then(async r => {
      const b = (await r.json().catch(() => ({}))) as { history?: Row[]; error?: string };
      if (!live) return;
      if (!r.ok) setError(b.error ?? "Could not load rates."); else { setError(""); setRows(b.history ?? []); }
    }).catch(() => live && setError("Could not load rates."));
    return () => { live = false; };
  }, [months]);
  return (
    <main>
      <h1>Home-loan rates</h1>
      <p className="muted">Banks&apos; standard variable rate for owner-occupiers, as published by the Reserve Bank of Australia (table F5). Buyers see the latest figure in the calculator on the home page and on every sale listing.</p>
      <label>Show <select value={months} onChange={e => setMonths(Number(e.target.value))}>{[12, 24, 60, 120].map(m => <option key={m} value={m}>last {m} months</option>)}</select></label>
      {error && <p role="alert">{error}</p>}
      {!rows && !error && <p className="muted" role="status">Loading…</p>}
      {rows && rows.length === 0 && <p className="muted" role="status">No rates stored yet. They load once the daily rates job has run.</p>}
      {rows && rows.length > 0 && (
        <table className="mc-rate-table">
          <thead><tr><th scope="col">Month</th><th scope="col">Rate</th><th scope="col">Change</th></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const prev = rows[i + 1]; const d = prev ? Math.round((r.ratePct - prev.ratePct) * 100) / 100 : undefined;
              return <tr key={r.date}><td>{month(r.date)}</td><td>{r.ratePct.toFixed(2)}%</td><td>{d === undefined ? "–" : d === 0 ? "no change" : `${d > 0 ? "+" : ""}${d.toFixed(2)}`}</td></tr>;
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
