"use client";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import "../../../styles/open-inspections.css";
import { call, dateText, dayKey, send, timeText, tzName, whenText } from "../../../open-inspections/ui";

type Slot = { startsAt: string; endsAt: string; spotsLeft: number };
type Info = { listing: { id: string; title: string; address: string; timezone: string; contactName: string; contactEmail: string }; slots: Slot[] };
type Profile = { name: string; email: string; phone: string };

/** Buyer view: pick an open inspection time for a property, add contact details and an optional question, and confirm. */
export default function BookInspection() {
  const { id } = useParams<{ id: string }>();
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState("");
  const [me, setMe] = useState<"loading" | "out" | "buyer" | "other">("loading");
  const [day, setDay] = useState("");
  const [slot, setSlot] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const loadSlots = useCallback(async () => {
    const r = await call<Info>(`/api/listings/${id}/open-slots`).catch(() => null);
    if (!r?.ok) return setLoadError(r?.body.error ?? "Could not load inspection times.");
    setLoadError(""); setInfo(r.body);
  }, [id]);
  useEffect(() => { void loadSlots(); }, [loadSlots]);
  useEffect(() => {
    (async () => {
      const m = await call<{ user: { userType: string } | null }>("/api/auth/me").catch(() => null);
      const type = m?.body.user?.userType;
      if (!type) return setMe("out");
      setMe(type === "buyer" ? "buyer" : "other");
      if (type !== "buyer") return;
      const p = await call<{ profile: Profile }>("/api/open-inspections").catch(() => null);
      if (p?.ok) { setName(n => n || p.body.profile.name); setEmail(v => v || p.body.profile.email); setPhone(v => v || p.body.profile.phone); }
    })();
  }, []);

  const tz = info?.listing.timezone ?? "Australia/Sydney";
  const days = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of info?.slots ?? []) { const k = dayKey(s.startsAt, tz); map.set(k, [...(map.get(k) ?? []), s]); }
    return [...map.entries()];
  }, [info, tz]);
  useEffect(() => { if (!day && days[0]) setDay(days[0][0]); }, [days, day]);
  const times = days.find(([k]) => k === day)?.[1] ?? [];
  const chosen = info?.slots.find(s => s.startsAt === slot);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!slot) return setError("Choose a time first.");
    setBusy(true); setError("");
    const r = await call<{ id: string }>("/api/open-inspections", send("POST", { listingId: id, startsAt: slot, name, phone, email, notes })).catch(() => null);
    setBusy(false);
    if (r?.ok) return setDone(slot);
    setError(r?.body.error ?? "Could not book that time.");
    if (r?.status === 409) { setSlot(""); void loadSlots(); }
  }

  if (loadError) return <main className="oi"><p role="alert" className="oi-error">{loadError}</p><p><a href={`/listings/${id}`}>Back to the listing</a></p></main>;
  if (!info) return <main className="oi"><p className="oi-muted" role="status">Loading times…</p></main>;
  const contact = [info.listing.contactName, info.listing.contactEmail].filter(Boolean).join(", ");

  return (
    <main className="oi">
      <header>
        <h1>Book an open inspection</h1>
        <p className="oi-muted">{info.listing.address}</p>
      </header>
      {done ? (
        <section className="oi-card" aria-live="polite">
          <h2>You are booked</h2>
          <p className="oi-ok" role="status">{whenText(done, tz)} ({tzName(tz)} time)</p>
          <p>{info.listing.address}</p>
          {contact && <p>Agent contact: {contact}</p>}
          <p className="oi-muted">We have sent you a confirmation, and we will remind you the day before and an hour before. Bring photo ID. You can cancel from My open inspections.</p>
          <div className="actions"><a className="button" href="/open-inspections">My open inspections</a><a className="button secondary" href={`/listings/${id}`}>Back to the listing</a></div>
        </section>
      ) : days.length === 0 ? (
        <p className="oi-state">No inspection times are open in the next four weeks. Check back soon{contact ? `, or contact ${contact}` : ""}.</p>
      ) : me === "out" ? (
        <section className="oi-card"><p>Sign in as a buyer to book an inspection time.</p><div className="actions"><a className="button" href={`/login?as=buyer`}>Sign in</a><a className="button secondary" href="/signup">Create an account</a></div></section>
      ) : me === "other" ? (
        <p className="oi-state">Only buyers can book inspections.</p>
      ) : (
        <form className="oi-form" onSubmit={submit}>
          <section className="oi-card">
            <div>
              <p id="oi-day-h" className="oi-label">Day <span className="oi-muted" style={{ fontWeight: 400 }}>(times in {tzName(tz)} time)</span></p>
              <div className="oi-days" role="group" aria-labelledby="oi-day-h">
                {days.map(([k, s]) => (
                  <button type="button" key={k} className="oi-day" aria-pressed={day === k} onClick={() => { setDay(k); setSlot(""); }}>
                    <small>{new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short" }).format(new Date(s[0]!.startsAt))}</small>
                    <strong>{new Intl.DateTimeFormat("en-AU", { timeZone: tz, day: "numeric", month: "short" }).format(new Date(s[0]!.startsAt))}</strong>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p id="oi-time-h" className="oi-label">{times[0] ? dateText(times[0].startsAt, tz) : "Time"}</p>
              <div className="oi-times" role="group" aria-labelledby="oi-time-h">
                {times.map(s => <button type="button" key={s.startsAt} className="oi-time" aria-pressed={slot === s.startsAt} onClick={() => setSlot(s.startsAt)}>{timeText(s.startsAt, tz)}{s.spotsLeft > 1 && <small>{s.spotsLeft} spots</small>}</button>)}
              </div>
            </div>
          </section>
          <section className="oi-card">
            <h2>Your details</h2>
            <label className="field">Name<input value={name} onChange={e => setName(e.target.value)} maxLength={120} autoComplete="name" required /></label>
            <div className="oi-row">
              <label className="field">Phone<input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} maxLength={30} /></label>
              <label className="field">Email<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={200} /></label>
            </div>
            <p className="oi-muted">Add a phone number or an email address. Only the agent sees them.</p>
            <label className="field">A question or note <span className="oi-muted">Optional</span><textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} maxLength={500} placeholder="For example: interested in renovating the kitchen" /></label>
            {error && <p role="alert" className="oi-error">{error}</p>}
            <div className="actions"><button type="submit" disabled={busy || !chosen}>{busy ? "Booking…" : chosen ? `Confirm ${timeText(chosen.startsAt, tz)}` : "Choose a time"}</button></div>
          </section>
        </form>
      )}
    </main>
  );
}
