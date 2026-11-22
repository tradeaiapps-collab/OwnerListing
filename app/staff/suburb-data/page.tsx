"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/admin.css";
import "../../styles/suburb-data.css";

interface Row { state: string; suburb: string; postcode: string | null; source: string; asAt: string; facts: { label: string; value: string }[] }
const SAMPLE = "state,suburb,postcode,median_house_price,median_weekly_rent,population\nNSW,Bondi,2026,3450000,1100,11400";

/**
 * Suburb figures shown to buyers as a "Suburb snapshot". Staff load a CSV from a source they are licensed to use and name it with a date;
 * a file is all or nothing. Prices are in dollars on screen and stored as cents.
 */
export default function StaffSuburbData() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [columns, setColumns] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lineErrors, setLineErrors] = useState<{ line: number; message: string }[]>([]);
  const [form, setForm] = useState({ source: "", asAt: "", csv: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (query: string) => {
    setError("");
    const r = await fetch(`/api/staff/suburb-data?q=${encodeURIComponent(query)}`).catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); setLoaded(true); return; }
    const d = await r.json();
    setRows(d.suburbs); setTotal(d.total); setColumns(d.columns); setLoaded(true);
  }, []);
  useEffect(() => { void load(""); }, [load]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) { const t = await f.text(); setForm(v => ({ ...v, csv: t })); }
  }

  async function onImport(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setNotice(""); setLineErrors([]);
    try {
      const r = await postStaff("/api/staff/suburb-data", form);
      if (!r.ok) { setError(String(r.data["error"] ?? "That did not work.")); setLineErrors((r.data["lines"] as { line: number; message: string }[] | undefined) ?? []); return; }
      setNotice(`Imported ${r.data["imported"]} suburbs (${r.data["created"]} new, ${r.data["updated"]} replaced).`);
      setForm(v => ({ ...v, csv: "" }));
      await load(q);
    } finally { setBusy(false); }
  }

  return (
    <main className="admin-page suburb-data">
      <h1>Suburb data</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">
        Figures loaded here appear to buyers as a &ldquo;Suburb snapshot&rdquo; on listings in that suburb, with the source and date you give.
        Only load data you are licensed to use. A file is all or nothing, and a suburb already loaded is replaced by the file&rsquo;s row.
      </p>

      <form className="sd-import stack" onSubmit={e => void onImport(e)}>
        <h2>Import a file</h2>
        <div className="sd-meta">
          <label>Source of the figures<input value={form.source} maxLength={120} placeholder="for example ABS Census 2021" onChange={e => setForm({ ...form, source: e.target.value })} required /></label>
          <label>Figures as at<input type="date" value={form.asAt} onChange={e => setForm({ ...form, asAt: e.target.value })} required /></label>
        </div>
        <label>CSV file<input type="file" accept=".csv,text/csv" onChange={e => void onFile(e)} /></label>
        <label>Or paste the CSV<textarea value={form.csv} spellCheck={false} placeholder={SAMPLE} onChange={e => setForm({ ...form, csv: e.target.value })} required /></label>
        <p className="muted sd-columns"><small>Columns: {columns.length ? columns.join(", ") : "state, suburb, postcode, and figure columns"}. State and suburb are required; money is in whole dollars; leave a cell empty for &ldquo;not provided&rdquo;.</small></p>
        {error && <div role="alert"><p>{error}</p>{lineErrors.length > 0 && <ul className="sd-errors">{lineErrors.map(l => <li key={`${l.line}-${l.message}`}>{l.line > 0 ? `Line ${l.line}: ` : ""}{l.message}</li>)}</ul>}</div>}
        {notice && <p role="status">{notice}</p>}
        <div className="actions"><button type="submit" disabled={busy}>{busy ? "Importing..." : "Import"}</button></div>
      </form>

      <h2>Loaded suburbs {loaded && <span className="muted">({total})</span>}</h2>
      <form className="filters" onSubmit={e => { e.preventDefault(); void load(q); }}>
        <label>Search <input value={q} placeholder="Suburb or postcode" onChange={e => setQ(e.target.value)} /></label>
        <button type="submit">Search</button>
      </form>
      {loaded && rows.length === 0 && !error && <p className="empty">No suburbs loaded yet. Buyers see no suburb snapshot until you import a file.</p>}
      {rows.length > 0 && (
        <div className="table-wrap"><table className="sd-table">
          <thead><tr><th scope="col">Suburb</th><th scope="col">Source and date</th><th scope="col">Figures</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={`${r.state}-${r.suburb}`}>
                <td>{r.suburb} {r.state}{r.postcode ? ` ${r.postcode}` : ""}</td>
                <td>{r.source}<br /><span className="muted">as at {r.asAt}</span></td>
                <td>{r.facts.map(f => `${f.label}: ${f.value}`).join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </main>
  );
}
