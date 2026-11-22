"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { defaultLocal, formatWhen, JSON_HEADERS, localToIso, STATUS_LABELS, TYPE_LABELS } from "../../../inspections/ui";

type Row = { id: string; type: string; scheduledAt: string; status: string; counterpartName: string; openFollowUps: number; criticalCount: number };

export default function ListingInspections() {
  const { id } = useParams<{ id: string }>();
  const [items, setItems] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState("building");
  const [when, setWhen] = useState(defaultLocal);
  const [contact, setContact] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch(`/api/listings/${id}/inspections`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) setItems(d.inspections);
      else setLoadError(r.status === 401 ? "Sign in to see this listing's inspections." : r.status === 404 ? "Listing not found." : d.error ?? "Could not load inspections.");
    } catch { setLoadError("Could not load inspections."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function onSchedule(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError("");
    const value = contact.trim();
    try {
      const body = { type, scheduledAt: localToIso(when), notes, ...(value.includes("@") ? { email: value } : { userId: value }) };
      const r = await fetch(`/api/listings/${id}/inspections`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setContact(""); setNotes(""); await load(); }
      else setError(r.status === 401 ? "Sign in to book an inspection." : d.error ?? "Could not send the booking.");
    } catch { setError("Could not send the booking. Check the date and try again."); }
    finally { setBusy(false); }
  }

  return (
    <main className="insp-page">
      <p><a href="/inspections">All inspections</a></p>
      <h1>Inspections</h1>
      <p className="muted">Book an inspector who already has an account. They accept, record findings and photos on site, and you share the finished report.</p>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && items === null && <p className="muted" role="status">Loading…</p>}
      {items && items.length === 0 && <p className="empty">No inspections booked for this listing yet.</p>}
      <ul className="card-list insp-list">
        {items?.map(r => (
          <li key={r.id}>
            <div className="top">
              <strong>{TYPE_LABELS[r.type] ?? r.type}</strong>
              <span className="badge">{STATUS_LABELS[r.status] ?? r.status}</span>
              {r.criticalCount > 0 && <span className="insp-sev sev-critical">{r.criticalCount} critical</span>}
            </div>
            <span>{formatWhen(r.scheduledAt)} · Inspector: {r.counterpartName}</span>
            {r.openFollowUps > 0 && <span className="muted">{r.openFollowUps} open follow-up{r.openFollowUps === 1 ? "" : "s"}</span>}
            <div className="actions"><a className="button" href={`/inspections/${r.id}`}>Open</a></div>
          </li>
        ))}
      </ul>
      {items && (
        <form className="insp-form two insp-panel" onSubmit={onSchedule}>
          <h2 className="wide">Book an inspection</h2>
          <label>Type
            <select value={type} onChange={e => setType(e.target.value)}>
              {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Date and time
            <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} required />
          </label>
          <label className="wide">Inspector's email or user id
            <input value={contact} onChange={e => setContact(e.target.value)} required maxLength={254} autoComplete="off" />
          </label>
          <label className="wide">Notes for the inspector (access, parking, contact on site)
            <textarea value={notes} onChange={e => setNotes(e.target.value)} maxLength={2000} />
          </label>
          <button type="submit" className="wide" disabled={busy}>{busy ? "Working…" : "Send booking"}</button>
          {error && <p role="alert" className="wide">{error}</p>}
        </form>
      )}
    </main>
  );
}
