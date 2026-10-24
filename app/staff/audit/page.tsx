"use client";
import { useState } from "react";

interface Row { id: string; occurredAt: string; actorType: string; actorId: string; aggregateType: string; aggregateId: string; eventType: string; payload: unknown }

export default function StaffAudit() {
  const [f, setF] = useState({ eventType: "", actorId: "", listingId: "", from: "", to: "" });
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  async function load(cursor?: string) {
    setError("");
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    if (cursor) p.set("cursor", cursor);
    const r = await fetch(`/api/staff/audit?${p}`).catch(() => null);
    if (!r) { setError("Could not load the audit log."); return; }
    if (r.status === 401) { setError("Sign in as staff to see the audit log."); return; }
    if (r.status === 403) { setError("Your role cannot view the audit log."); return; }
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? "Could not load the audit log."); return; }
    const body = await r.json();
    setRows(prev => (cursor ? [...prev, ...body.events] : body.events));
    setNext(body.nextCursor);
    setLoaded(true);
  }

  const field = (k: keyof typeof f, label: string, type = "text") => (
    <label>{label} <input type={type} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} /></label>
  );

  return (
    <main>
      <h1>Audit log</h1>
      <p>Read only. Personal data and credentials are removed.</p>
      <form onSubmit={e => { e.preventDefault(); void load(); }} style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {field("eventType", "Event")}{field("actorId", "Actor")}{field("listingId", "Listing")}
        {field("from", "From", "datetime-local")}{field("to", "To", "datetime-local")}
        <button type="submit">Search</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {loaded && rows.length === 0 && <p>No events found.</p>}
      {rows.length > 0 && (
        <table>
          <thead><tr><th>When</th><th>Event</th><th>Actor</th><th>Subject</th><th>Details</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{new Date(r.occurredAt).toLocaleString()}</td><td>{r.eventType}</td>
                <td>{r.actorType}:{r.actorId}</td><td>{r.aggregateType}:{r.aggregateId}</td>
                <td><code>{JSON.stringify(r.payload)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && <button onClick={() => void load(next)}>Load more</button>}
    </main>
  );
}
