"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import "../../styles/open-inspections.css";
import { STATUS_LABEL, call, dayKey, send, timeText, tzName } from "../../open-inspections/ui";

type Listing = { id: string; title: string; address: string; status: string };
type Booking = {
  id: string; listingId: string; title: string; address: string; timezone: string; startsAt: string; endsAt: string; status: string;
  buyerName: string; buyerPhone: string; buyerEmail: string; notes: string;
};
type Data = { bookings: Booking[]; listings: Listing[]; today: number };
type Action = "cancel" | "complete" | "no_show" | "remind";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ACTIONS: { key: Action; label: string }[] = [{ key: "remind", label: "Send reminder" }, { key: "complete", label: "Mark completed" }, { key: "no_show", label: "Mark no-show" }, { key: "cancel", label: "Cancel booking" }];
const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const heading = (first: Date) => new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", month: "long", year: "numeric" }).format(first);

/** Agent calendar: every booked open inspection across the listings you manage, colour coded by listing, with bulk actions. */
export default function InspectionCalendar() {
  const today = useMemo(() => ymd(new Date()), []);
  const [month, setMonth] = useState(() => new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [data, setData] = useState<Data | null>(null);
  const [listing, setListing] = useState("");
  const [day, setDay] = useState(today);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Action | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const from = new Date(month.getTime() - 7 * 86_400_000), to = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) + 8 * 86_400_000);
    const q = new URLSearchParams({ from: ymd(from), to: ymd(to) });
    if (listing) q.set("listingId", listing);
    const r = await call<Data>(`/api/agent/open-inspections?${q}`).catch(() => null);
    if (r?.status === 401) return setError("Sign in to see your inspection calendar.");
    if (!r?.ok) return setError(r?.body.error ?? "Could not load your calendar.");
    setError(""); setData(r.body);
  }, [month, listing]);
  useEffect(() => { void load(); }, [load]);

  const colour = useMemo(() => new Map((data?.listings ?? []).map((l, i) => [l.id, i % 6] as const)), [data]);
  const byDay = useMemo(() => {
    const m = new Map<string, Booking[]>();
    for (const b of data?.bookings ?? []) { const k = dayKey(b.startsAt, b.timezone); m.set(k, [...(m.get(k) ?? []), b]); }
    return m;
  }, [data]);
  const cells = useMemo(() => {
    const lead = (month.getUTCDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1 - lead + i)));
  }, [month]);
  const rows = byDay.get(day) ?? [];
  const live = (b: Booking) => b.status === "booked";

  function move(delta: number) { setMonth(m => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + delta, 1))); setPicked(new Set()); }
  function toggle(id: string) { setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }); setConfirm(""); }

  async function run(action: Action) {
    if (action === "cancel" && confirm !== "cancel") return setConfirm("cancel");
    setBusy(true); setConfirm(""); setNotice(""); setError("");
    const r = await call<{ changed: number }>("/api/agent/open-inspections", send("POST", { ids: [...picked], action })).catch(() => null);
    setBusy(false);
    if (!r?.ok) return setError(r?.body.error ?? "That did not work.");
    const n = r.body.changed, verb = { cancel: "cancelled", complete: "marked completed", no_show: "marked no-show", remind: "reminded" }[action];
    setNotice(n === 0 ? "Nothing changed. That action does not fit the bookings you chose (a past inspection cannot be cancelled, and an upcoming one cannot be completed yet)." : `${n} booking${n === 1 ? "" : "s"} ${verb}.`);
    setPicked(new Set()); await load();
  }

  return (
    <main className="oi">
      <header className="oi-bar">
        <div><h1>Inspection calendar</h1><p className="oi-muted">Booked open inspections across your listings. Times are in each property&apos;s time zone.</p></div>
        <a className="button secondary" href="/agent/inspection-availability">Set inspection times</a>
      </header>
      {data && data.today > 0 && <p className="oi-alert" role="status">{data.today === 1 ? "1 inspection today" : `${data.today} inspections today`}. <button type="button" className="secondary" onClick={() => { setDay(today); setMonth(new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1))); }}>Show today</button></p>}
      {error && <p role="alert" className="oi-error">{error}</p>}
      {notice && <p role="status" className="oi-ok">{notice}</p>}
      {!data && !error ? <p className="oi-muted" role="status">Loading…</p> : data && (
        <>
          <div className="oi-bar">
            <label className="field">Listing
              <select value={listing} onChange={e => { setListing(e.target.value); setPicked(new Set()); }}>
                <option value="">All listings</option>
                {data.listings.map(l => <option key={l.id} value={l.id}>{l.address}</option>)}
              </select>
            </label>
            <ul className="oi-legend" aria-label="Listing colours">
              {data.listings.map(l => <li key={l.id}><span className="oi-dot" data-c={colour.get(l.id)} aria-hidden="true" />{l.address}</li>)}
            </ul>
          </div>
          <div className="oi-split">
            <section className="oi-card" aria-label="Month calendar">
              <div className="oi-bar">
                <button type="button" className="secondary" onClick={() => move(-1)} aria-label="Previous month">‹</button>
                <h2 aria-live="polite">{heading(month)}</h2>
                <button type="button" className="secondary" onClick={() => move(1)} aria-label="Next month">›</button>
              </div>
              <div className="oi-grid" role="grid" aria-label={heading(month)}>
                {DOW.map(d => <div key={d} className="oi-dow" role="columnheader">{d}</div>)}
                {cells.map(c => {
                  const k = ymd(c), list = byDay.get(k) ?? [], liveCount = list.filter(live).length;
                  return (
                    <button type="button" key={k} className="oi-cell" role="gridcell" aria-pressed={day === k} data-out={c.getUTCMonth() !== month.getUTCMonth()} data-today={k === today}
                      aria-label={`${new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(c)}, ${liveCount} booked`} onClick={() => { setDay(k); setPicked(new Set()); setConfirm(""); }}>
                      <span>{c.getUTCDate()}</span>
                      <span className="oi-dots" aria-hidden="true">{list.slice(0, 6).map(b => <span key={b.id} className="oi-dot" data-c={colour.get(b.listingId)} />)}</span>
                      {list.slice(0, 2).map(b => <span key={b.id} className="oi-chip" data-c={colour.get(b.listingId)} aria-hidden="true">{timeText(b.startsAt, b.timezone)} {b.buyerName}</span>)}
                      {list.length > 2 && <span className="oi-chip" aria-hidden="true">+{list.length - 2} more</span>}
                    </button>
                  );
                })}
              </div>
            </section>
            <section className="oi-card" aria-label="Selected day">
              <h2>{new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${day}T00:00:00Z`))}</h2>
              {rows.length === 0 ? <p className="oi-state">No inspections booked this day.</p> : (
                <>
                  <div className="oi-bulk" role="group" aria-label="Actions for the selected bookings">
                    {ACTIONS.map(a => (
                      <button key={a.key} type="button" className={a.key === "cancel" ? "danger" : "secondary"} disabled={busy || picked.size === 0} onClick={() => run(a.key)}>
                        {a.key === "cancel" && confirm === "cancel" ? `Confirm: cancel ${picked.size}` : a.label}
                      </button>
                    ))}
                    {confirm === "cancel" && <button type="button" className="secondary" onClick={() => setConfirm("")}>Keep them</button>}
                  </div>
                  <ul className="oi-list">
                    {rows.map(b => (
                      <li key={b.id} className="oi-booking" data-c={colour.get(b.listingId)} data-status={b.status}>
                        <label className="oi-check"><input type="checkbox" checked={picked.has(b.id)} onChange={() => toggle(b.id)} aria-label={`Select ${b.buyerName} at ${timeText(b.startsAt, b.timezone)}`} /></label>
                        <p><strong>{timeText(b.startsAt, b.timezone)}</strong> · {b.buyerName} <span className="oi-pill" data-status={b.status}>{STATUS_LABEL[b.status] ?? b.status}</span></p>
                        <p className="oi-muted">{b.address} ({tzName(b.timezone)} time)</p>
                        <p className="oi-muted">{[b.buyerPhone && <a key="p" href={`tel:${b.buyerPhone}`}>{b.buyerPhone}</a>, b.buyerEmail && <a key="e" href={`mailto:${b.buyerEmail}`}>{b.buyerEmail}</a>].filter(Boolean).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, " · ", x] : [x]), [])}</p>
                        {b.notes && <p className="oi-muted">Note: {b.notes}</p>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </div>
        </>
      )}
    </main>
  );
}
