"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff, sendStaff } from "../staff-api";
import "../../styles/staff.css";

interface Holiday { id: string; state: string; date: string; name: string }
const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "ACT", "NT"] as const;
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Public holidays by state. They are left out when cooling-off business days are counted, so a missing year means weekdays only.
 * "Fill in the usual holidays" adds the standard dates for a year; add the ones announced year to year by hand.
 */
export default function StaffPublicHolidays() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [state, setState] = useState<string>("ALL");
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [form, setForm] = useState({ state: "NSW", date: "", name: "" });
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoaded(false);
    const r = await fetch(`/api/staff/public-holidays?year=${year}${state === "ALL" ? "" : `&state=${state}`}`).catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    setHolidays((await r.json()).holidays); setLoaded(true);
  }, [year, state]);
  useEffect(() => { void load(); }, [load]);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setMessage("");
    const res = await postStaff("/api/staff/public-holidays", form);
    setMessage(res.ok ? (res.data["created"] ? "Holiday added." : "Holiday renamed.") : String(res.data["error"] ?? "Could not save."));
    if (res.ok) { setForm({ ...form, date: "", name: "" }); await load(); }
  }
  async function fill() {
    setMessage("");
    const res = await postStaff("/api/staff/public-holidays", { action: "generate", state, year });
    setMessage(res.ok ? `${res.data["added"]} holiday${res.data["added"] === 1 ? "" : "s"} added for ${year}.` : String(res.data["error"] ?? "Could not fill in holidays."));
    if (res.ok) await load();
  }
  async function remove(h: Holiday) {
    setMessage("");
    const res = await sendStaff("DELETE", `/api/staff/public-holidays/${h.id}`, {});
    setMessage(res.ok ? "Holiday removed." : String(res.data["error"] ?? "Could not remove."));
    if (res.ok) await load();
  }

  return (
    <main>
      <h1>Public holidays</h1>
      <p><a href="/staff">Back to staff</a></p>
      <p className="muted">
        Public holidays are not counted as business days in the cooling-off period, so the period runs longer past a holiday. Easter and the
        Monday holidays move every year. Fill in the usual dates, then add anything announced year to year (for example the Western Australia
        King&apos;s Birthday or the Friday before the AFL Grand Final). A lawyer has not confirmed which days count. A year with no holidays on file counts weekdays only.
      </p>
      <div className="actions">
        <label>Year <input type="number" min={2000} max={2100} value={year} onChange={e => setYear(Number(e.target.value) || thisYear)} /></label>
        <label>State <select value={state} onChange={e => setState(e.target.value)}><option value="ALL">All states</option>{STATES.map(s => <option key={s}>{s}</option>)}</select></label>
        <button type="button" className="secondary" onClick={() => void fill()}>Fill in the usual holidays</button>
      </div>
      <form className="stack" onSubmit={e => void save(e)}>
        <h2>Add or rename a holiday</h2>
        <label>State <select value={form.state} onChange={e => setForm({ ...form, state: e.target.value })}>{STATES.map(s => <option key={s}>{s}</option>)}</select></label>
        <label>Date <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} required /></label>
        <label>Name <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} minLength={2} maxLength={80} required /></label>
        <button type="submit">Save holiday</button>
      </form>
      {message && <p role="alert">{message}</p>}
      {loaded && holidays.length === 0 && <p className="empty">No holidays on file for {year}. Fill in the usual holidays or add them by hand.</p>}
      {holidays.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>State</th><th>Holiday</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{holidays.map(h => (
            <tr key={h.id}><td>{dayLabel(h.date)}</td><td>{h.state}</td><td>{h.name}</td><td><button type="button" className="secondary" onClick={() => void remove(h)}>Remove</button></td></tr>
          ))}</tbody>
        </table></div>
      )}
    </main>
  );
}
