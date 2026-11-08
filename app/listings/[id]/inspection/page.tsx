"use client";
import { use, useEffect, useMemo, useState } from "react";
import { JSON_HEADERS, formatWhen } from "../../../inspections/ui";

type Booking = { id: string; listingId: string; status: string; slots: string[]; scheduledAt?: string };
const TIMES = [9, 11, 13, 15];
const MAX = 3;
const dayLabel = (d: Date) => d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });

/** Buyer books an inspection: pick up to three start times, add notes. An approved inspector then accepts one of them. */
export default function BookInspection({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [title, setTitle] = useState("");
  const [loadError, setLoadError] = useState("");
  const [existing, setExisting] = useState<Booking | null | undefined>(undefined);
  const [picked, setPicked] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  // Start of tomorrow, local time, so every offered time is at least 12 hours ahead.
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + 1 + i); d.setHours(0, 0, 0, 0); return d; }), []);

  useEffect(() => {
    fetch(`/api/listings/${id}`).then(async r => {
      const d = await r.json().catch(() => ({}));
      if (r.ok) setTitle(d.listing?.title ?? ""); else setLoadError(r.status === 404 ? "This listing was not found." : "Could not load the listing.");
    }).catch(() => setLoadError("Could not load the listing."));
    fetch("/api/inspection-bookings").then(async r => {
      if (r.status === 401) { setLoadError("Sign in as a buyer to book an inspection."); return; }
      const d = await r.json().catch(() => ({ bookings: [] }));
      setExisting((d.bookings as Booking[]).find(b => b.listingId === id && b.status !== "cancelled") ?? null);
    }).catch(() => setExisting(null));
  }, [id]);

  const iso = (d: Date, h: number) => { const t = new Date(d); t.setHours(h, 0, 0, 0); return t.toISOString(); };
  function toggle(s: string) {
    setError("");
    setPicked(p => p.includes(s) ? p.filter(x => x !== s) : p.length >= MAX ? p : [...p, s]);
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (picked.length === 0) { setError("Choose at least one time."); return; }
    setBusy(true); setError("");
    const r = await fetch("/api/inspection-bookings", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ listingId: id, slots: picked, notes }) }).catch(() => null);
    setBusy(false);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) setDone(true); else setError(r ? (d.error ?? "Could not send the request.") : "Network error.");
  }

  const back = <p><a href={`/listings/${id}`}>Back to the listing</a></p>;
  if (loadError) return <main className="insp-page">{back}<p role="alert">{loadError}</p></main>;
  if (existing === undefined) return <main className="insp-page">{back}<p className="muted" role="status">Loading…</p></main>;

  if (done || existing) {
    return (
      <main className="insp-page">
        {back}
        <h1>Inspection request</h1>
        <section className="insp-panel" aria-live="polite">
          <p><span className="badge">{done || existing?.status === "pending_inspector_response" ? "Waiting for an inspector" : existing?.status === "scheduled" ? "Booked" : "Report complete"}</span></p>
          <p>{done ? "Request sent. An approved inspector in your area will accept one of your times, and you will see it here." :
            existing?.scheduledAt ? `Inspection booked for ${formatWhen(existing.scheduledAt)}.` : `You already asked for an inspection of ${title || "this property"}.`}</p>
          <div className="actions"><a className="button" href="/inspections">See my inspections</a></div>
        </section>
      </main>
    );
  }

  return (
    <main className="insp-page">
      {back}
      <header className="insp-head">
        <h1>Book an inspection</h1>
        <p className="insp-meta">{title}</p>
      </header>
      <p className="muted">Pick up to {MAX} times that suit you. An approved inspector accepts one. The seller sees the report once it is done.</p>
      <form className="insp-form" onSubmit={submit}>
        <fieldset className="insp-days">
          <legend>Times that suit you ({picked.length} of {MAX} chosen)</legend>
          {days.map(d => (
            <div className="insp-day" key={d.toISOString()}>
              <span>{dayLabel(d)}</span>
              <div className="insp-times">
                {TIMES.map(h => {
                  const s = iso(d, h), on = picked.includes(s);
                  return <button key={s} type="button" className="secondary" aria-pressed={on} disabled={!on && picked.length >= MAX} onClick={() => toggle(s)}>{h > 12 ? h - 12 : h}:00 {h >= 12 ? "pm" : "am"}</button>;
                })}
              </div>
            </div>
          ))}
        </fieldset>
        {picked.length > 0 && <ul className="insp-chosen" aria-label="Chosen times">{picked.slice().sort().map(s => <li key={s} className="badge">{formatWhen(s)}</li>)}</ul>}
        <label>Notes for the inspector (optional)
          <textarea value={notes} maxLength={1000} onChange={e => setNotes(e.target.value)} placeholder="Anything to look at closely, or access details" />
        </label>
        <div aria-live="polite">{error && <p role="alert">{error}</p>}</div>
        <button type="submit" disabled={busy}>{busy ? "Sending…" : "Send request"}</button>
      </form>
    </main>
  );
}
