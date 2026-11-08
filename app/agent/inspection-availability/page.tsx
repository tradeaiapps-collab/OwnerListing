"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import "../../styles/open-inspections.css";
import { DAYS, call, clock, send, tzName, whenText } from "../../open-inspections/ui";

type Listing = { id: string; title: string; address: string; status: string };
type Rule = { id: string; recurrence: "once" | "weekly"; dayOfWeek: number | null; onDate: string | null; startMin: number; endMin: number; slotMinutes: number; capacity: number; endDate: string | null };
type Block = { id: string; startsAt: string; endsAt: string; note: string };
type Schedule = { listing: { id: string; title: string; address: string; timezone: string }; rules: Rule[]; blocks: Block[] };

const dateLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const ruleText = (r: Rule) =>
  `${r.recurrence === "weekly" ? `Every ${DAYS[r.dayOfWeek ?? 0]}${r.endDate ? ` until ${dateLabel(r.endDate)}` : ""}` : dateLabel(r.onDate ?? "")}, ${clock(r.startMin)} to ${clock(r.endMin)}, ${r.slotMinutes} minute slots${r.capacity > 1 ? `, ${r.capacity} bookings each` : ""}`;

/** Set the open inspection times for a listing: weekly or one-off windows, and times to block off. */
export default function InspectionAvailability() {
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [listingId, setListingId] = useState("");
  const [sched, setSched] = useState<Schedule | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"weekly" | "once">("weekly");
  const [dow, setDow] = useState("6");
  const [date, setDate] = useState("");
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("14:00");
  const [slot, setSlot] = useState("30");
  const [capacity, setCapacity] = useState("1");
  const [until, setUntil] = useState("");
  const [bDate, setBDate] = useState("");
  const [bStart, setBStart] = useState("12:00");
  const [bEnd, setBEnd] = useState("13:00");
  const [bNote, setBNote] = useState("");

  useEffect(() => {
    (async () => {
      const r = await call<{ listings: Listing[] }>("/api/agent/open-inspections").catch(() => null);
      if (r?.status === 401) return setError("Sign in to set inspection times.");
      if (!r?.ok) return setError(r?.body.error ?? "Could not load your listings.");
      setListings(r.body.listings);
      const wanted = new URLSearchParams(window.location.search).get("listing");
      setListingId(r.body.listings.find(l => l.id === wanted)?.id ?? r.body.listings[0]?.id ?? "");
    })();
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return setSched(null);
    const r = await call<Schedule>(`/api/listings/${id}/open-times`).catch(() => null);
    if (!r?.ok) return setError(r?.body.error ?? "Could not load the times for that listing.");
    setError(""); setSched(r.body);
  }, []);
  useEffect(() => { setSched(null); setNotice(""); void load(listingId); }, [listingId, load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setNotice(""); setError("");
    const body = mode === "weekly"
      ? { type: "rule", recurrence: "weekly", dayOfWeek: Number(dow), start, end, slotMinutes: Number(slot), capacity: Number(capacity), ...(until ? { endDate: until } : {}) }
      : { type: "rule", recurrence: "once", date, start, end, slotMinutes: Number(slot), capacity: Number(capacity) };
    const r = await call(`/api/listings/${listingId}/open-times`, send("POST", body)).catch(() => null);
    setBusy(false);
    if (!r?.ok) return setError(r?.body.error ?? "Could not publish that time.");
    setNotice("Published. Buyers can book these times now."); await load(listingId);
  }
  async function block(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setNotice(""); setError("");
    const r = await call<{ cancelled?: number }>(`/api/listings/${listingId}/open-times`, send("POST", { type: "block", date: bDate, start: bStart, end: bEnd, note: bNote })).catch(() => null);
    setBusy(false);
    if (!r?.ok) return setError(r?.body.error ?? "Could not block that time.");
    const n = r.body.cancelled ?? 0;
    setNotice(n > 0 ? `Blocked. ${n} booking${n === 1 ? " was" : "s were"} cancelled and the buyer${n === 1 ? " was" : "s were"} sent the next free times.` : "Blocked.");
    setBNote(""); await load(listingId);
  }
  async function remove(kind: "rule" | "block", id: string) {
    setBusy(true); setNotice(""); setError("");
    const r = await call(`/api/listings/${listingId}/open-times/${id}?kind=${kind}`, send("DELETE")).catch(() => null);
    setBusy(false);
    if (!r?.ok) setError(r?.body.error ?? "Could not remove that."); else setNotice(kind === "rule" ? "Removed. Bookings already made are kept; cancel them from the calendar." : "Block removed.");
    await load(listingId);
  }

  const tz = sched?.listing.timezone ?? "Australia/Sydney";
  return (
    <main className="oi">
      <header>
        <h1>Inspection times</h1>
        <p className="oi-muted">Publish when buyers can walk through a property. They book from these times, and you see every booking in the <a href="/agent/inspections">inspection calendar</a>.</p>
      </header>
      {error && <p role="alert" className="oi-error">{error}</p>}
      {notice && <p role="status" className="oi-ok">{notice}</p>}
      {!listings && !error ? <p className="oi-muted" role="status">Loading…</p> : listings && listings.length === 0 ? (
        <p className="oi-state">You do not manage a listing yet. Own listings and listings you are appointed to appear here.</p>
      ) : listings && (
        <>
          <label className="field">Listing
            <select value={listingId} onChange={e => setListingId(e.target.value)}>
              {listings.map(l => <option key={l.id} value={l.id}>{l.address}{l.status !== "published" ? ` (${l.status.replace("_", " ")}, not open to buyers yet)` : ""}</option>)}
            </select>
          </label>
          <div className="oi-split">
            <div className="oi">
              <form className="oi-card" onSubmit={add}>
                <h2>Add open times</h2>
                <div className="actions" role="group" aria-label="Repeat">
                  <button type="button" className="oi-tab" aria-pressed={mode === "weekly"} onClick={() => setMode("weekly")}>Every week</button>
                  <button type="button" className="oi-tab" aria-pressed={mode === "once"} onClick={() => setMode("once")}>One date</button>
                </div>
                {mode === "weekly" ? (
                  <div className="oi-row">
                    <label className="field">Day<select value={dow} onChange={e => setDow(e.target.value)}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
                    <label className="field">Repeat until <span className="oi-muted">Optional</span><input type="date" value={until} onChange={e => setUntil(e.target.value)} /></label>
                  </div>
                ) : <label className="field">Date<input type="date" value={date} onChange={e => setDate(e.target.value)} required /></label>}
                <div className="oi-row three">
                  <label className="field">From<input type="time" value={start} onChange={e => setStart(e.target.value)} required /></label>
                  <label className="field">To<input type="time" value={end} onChange={e => setEnd(e.target.value)} required /></label>
                  <label className="field">Slot length<select value={slot} onChange={e => setSlot(e.target.value)}>{[15, 20, 30, 45, 60].map(m => <option key={m} value={m}>{m} minutes</option>)}</select></label>
                </div>
                <label className="field">Bookings per slot<input type="number" min={1} max={10} value={capacity} onChange={e => setCapacity(e.target.value)} /><span className="oi-muted">1 gives each buyer a private time. Raise it to let a few groups share a slot.</span></label>
                <p className="oi-muted">Times are in {tzName(tz)} time, where the property is.</p>
                <div className="actions"><button type="submit" disabled={busy || !listingId}>{busy ? "Saving…" : "Publish times"}</button></div>
              </form>
              <form className="oi-card" onSubmit={block}>
                <h2>Block a time</h2>
                <p className="oi-muted">Take a time off the calendar, for a private viewing or a clash. Buyers already booked inside it are cancelled and told the next free times.</p>
                <div className="oi-row three">
                  <label className="field">Date<input type="date" value={bDate} onChange={e => setBDate(e.target.value)} required /></label>
                  <label className="field">From<input type="time" value={bStart} onChange={e => setBStart(e.target.value)} required /></label>
                  <label className="field">To<input type="time" value={bEnd} onChange={e => setBEnd(e.target.value)} required /></label>
                </div>
                <label className="field">Reason <span className="oi-muted">Optional, only you see it</span><input value={bNote} onChange={e => setBNote(e.target.value)} maxLength={200} /></label>
                <div className="actions"><button type="submit" className="secondary" disabled={busy || !listingId}>Block this time</button></div>
              </form>
            </div>
            <div className="oi">
              <section className="oi-card">
                <h2>Published times</h2>
                {!sched ? <p className="oi-muted" role="status">Loading…</p> : sched.rules.length === 0 ? <p className="oi-state">Nothing published yet. Buyers cannot book until you add a time.</p> : (
                  <ul className="oi-list">
                    {sched.rules.map(r => <li key={r.id}><span>{ruleText(r)}</span><button type="button" className="secondary" disabled={busy} onClick={() => remove("rule", r.id)} aria-label={`Remove ${ruleText(r)}`}>Remove</button></li>)}
                  </ul>
                )}
              </section>
              <section className="oi-card">
                <h2>Blocked times</h2>
                {!sched ? null : sched.blocks.length === 0 ? <p className="oi-muted">No blocked times.</p> : (
                  <ul className="oi-list">
                    {sched.blocks.map(b => <li key={b.id}><span>{whenText(b.startsAt, tz)} to {new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(b.endsAt))}{b.note ? ` · ${b.note}` : ""}</span><button type="button" className="secondary" disabled={busy} onClick={() => remove("block", b.id)} aria-label="Remove this blocked time">Remove</button></li>)}
                  </ul>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
