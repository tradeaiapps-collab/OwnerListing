"use client";
import { useCallback, useEffect, useState } from "react";
import "../styles/open-inspections.css";
import { STATUS_LABEL, call, send, tzName, whenText } from "./ui";

type Booking = { id: string; listingId: string; title: string; address: string; timezone: string; startsAt: string; endsAt: string; status: string; notes: string; contactName?: string; contactEmail?: string };

/** The signed-in buyer's open inspection bookings, with cancel. */
export default function MyInspections() {
  const [rows, setRows] = useState<Booking[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const r = await call<{ bookings: Booking[] }>("/api/open-inspections").catch(() => null);
    if (r?.status === 401) return setError("Sign in to see your inspections.");
    if (!r?.ok) return setError(r?.body.error ?? "Could not load your inspections.");
    setError(""); setRows(r.body.bookings);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function cancel(b: Booking) {
    setBusy(b.id);
    const r = await call(`/api/open-inspections/${b.id}/cancel`, send("POST")).catch(() => null);
    setBusy("");
    if (!r?.ok) setError(r?.body.error ?? "Could not cancel that inspection."); else setError("");
    await load();
  }

  const now = Date.now();
  return (
    <main className="oi">
      <header><h1>My open inspections</h1><p className="oi-muted">Open inspections you booked. Times are in each property&apos;s own time zone.</p></header>
      {error && <p role="alert" className="oi-error">{error}</p>}
      {!rows && !error ? <p className="oi-muted" role="status">Loading…</p> : rows && rows.length === 0 ? (
        <p className="oi-state">You have not booked an inspection yet. Open a listing and choose Book an open inspection.</p>
      ) : (
        <ul className="oi-list">
          {rows?.map(b => (
            <li key={b.id} data-status={b.status}>
              <div>
                <p><strong>{whenText(b.startsAt, b.timezone)}</strong> <span className="oi-muted">({tzName(b.timezone)} time)</span></p>
                <p><a href={`/listings/${b.listingId}`}>{b.address}</a></p>
                {b.contactName && <p className="oi-muted">Agent contact: {[b.contactName, b.contactEmail].filter(Boolean).join(", ")}</p>}
                {b.notes && <p className="oi-muted">Your note: {b.notes}</p>}
              </div>
              <div className="actions" style={{ margin: 0, alignItems: "center" }}>
                <span className="oi-pill" data-status={b.status}>{STATUS_LABEL[b.status] ?? b.status}</span>
                {b.status === "booked" && Date.parse(b.startsAt) > now && <button type="button" className="secondary" disabled={busy === b.id} onClick={() => cancel(b)}>{busy === b.id ? "Cancelling…" : "Cancel"}</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
