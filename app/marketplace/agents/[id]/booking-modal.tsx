"use client";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { JSON_HEADERS, whenLabel } from "../ui";

type Slot = { startsAt: string; endsAt: string };
type Info = { slots: Slot[]; modes: string[]; minutes: number; timezone: string };

/** Booking dialog: pick a day and time (shown in the agent's timezone), video or phone, then confirm. */
export function BookingModal({ agentId, agentName, signedIn, canBook, onClose }: { agentId: string; agentName: string; signedIn: boolean; canBook: boolean; onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState("");
  const [day, setDay] = useState("");
  const [slot, setSlot] = useState("");
  const [mode, setMode] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Slot | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/marketplace/agents/${agentId}/slots`);
        if (!r.ok) throw new Error();
        const d: Info = await r.json();
        setInfo(d); setMode(d.modes[0] ?? "");
      } catch { setLoadError("Could not load available times."); }
    })();
  }, [agentId]);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const days = useMemo(() => {
    const map = new Map<string, Slot[]>();
    if (info) for (const s of info.slots) {
      const key = new Intl.DateTimeFormat("en-CA", { timeZone: info.timezone }).format(new Date(s.startsAt));
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()];
  }, [info]);
  useEffect(() => { if (!day && days[0]) setDay(days[0][0]); }, [days, day]);
  const times = days.find(([k]) => k === day)?.[1] ?? [];
  const tf = (iso: string) => new Intl.DateTimeFormat("en-AU", { timeZone: info?.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!slot) return setError("Choose a time first.");
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/marketplace/agents/${agentId}/book`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ startsAt: slot, mode, phone, note }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setDone(d);
      else {
        setError(d.error ?? "Could not book that time.");
        if (r.status === 409) { setSlot(""); const s = await fetch(`/api/marketplace/agents/${agentId}/slots`); if (s.ok) setInfo(await s.json()); }
      }
    } catch { setError("Could not book that time."); } finally { setBusy(false); }
  }

  return (
    <div className="ma-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="ma-modal" role="dialog" aria-modal="true" aria-labelledby="ma-book-h">
        <header>
          <div><h2 id="ma-book-h">Book a consultation</h2><p className="muted" style={{ margin: 0 }}>with {agentName}{info ? ` · ${info.minutes} minutes · free` : ""}</p></div>
          <button type="button" className="secondary" onClick={onClose} aria-label="Close">✕</button>
        </header>
        {done ? (
          <>
            <p className="ma-ok" role="status">You are booked for {whenLabel(done.startsAt, info?.timezone ?? "Australia/Brisbane")}.</p>
            <p className="muted">{mode === "video" ? "Your video link is on your consultations page." : `${agentName} will call you on the number you gave.`} You can cancel there too. Both of you are notified.</p>
            <div className="actions"><a className="button" href="/marketplace/consultations">My consultations</a><button type="button" className="secondary" onClick={onClose}>Done</button></div>
          </>
        ) : !signedIn ? (
          <>
            <p>Sign in to book a time with {agentName}.</p>
            <div className="actions"><a className="button" href="/login?as=buyer">Sign in</a><a className="button secondary" href="/signup">Create an account</a></div>
          </>
        ) : !canBook ? (
          <p>Only buyers and owners can book consultations. Agents cannot book other agents.</p>
        ) : loadError ? <p role="alert" className="ma-error">{loadError}</p> : !info ? <p className="muted">Loading times…</p> : days.length === 0 ? (
          <p>No times are open in the next two weeks. Check back soon.</p>
        ) : (
          <form className="ma-form" onSubmit={submit}>
            <div>
              <p id="ma-day-h" style={{ margin: "0 0 var(--space-2)", fontWeight: 600 }}>Day <span className="muted" style={{ fontWeight: 400 }}>(times in {info.timezone.split("/")[1]?.replace("_", " ")} time)</span></p>
              <div className="ma-days" role="group" aria-labelledby="ma-day-h">
                {days.map(([k, s]) => {
                  const d = new Date(s[0]!.startsAt);
                  return <button type="button" key={k} className="ma-day" aria-pressed={day === k} onClick={() => { setDay(k); setSlot(""); }}>
                    <small>{new Intl.DateTimeFormat("en-AU", { timeZone: info.timezone, weekday: "short" }).format(d)}</small>
                    <strong>{new Intl.DateTimeFormat("en-AU", { timeZone: info.timezone, day: "numeric", month: "short" }).format(d)}</strong></button>;
                })}
              </div>
            </div>
            <div>
              <p id="ma-time-h" style={{ margin: "0 0 var(--space-2)", fontWeight: 600 }}>Time</p>
              <div className="ma-times" role="group" aria-labelledby="ma-time-h">
                {times.map(s => <button type="button" key={s.startsAt} className="ma-time" aria-pressed={slot === s.startsAt} onClick={() => setSlot(s.startsAt)}>{tf(s.startsAt)}</button>)}
              </div>
            </div>
            <fieldset className="ma-modes">
              <legend style={{ fontWeight: 600, marginBottom: "var(--space-1)" }}>How</legend>
              {info.modes.map(m => <label key={m}><input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} /> {m === "video" ? "Video call" : "Phone call"}</label>)}
            </fieldset>
            {mode === "phone" && <label className="field">Your phone number<input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} maxLength={30} required /><span className="hint">Only {agentName} sees this, for this call.</span></label>}
            <label className="field">What would you like to talk about? <span className="hint">Optional</span><textarea rows={3} value={note} onChange={e => setNote(e.target.value)} maxLength={500} /></label>
            {error && <p role="alert" className="ma-error">{error}</p>}
            <div className="actions" style={{ margin: 0 }}>
              <button type="submit" disabled={busy || !slot}>{busy ? "Booking…" : slot ? `Confirm ${tf(slot)}` : "Choose a time"}</button>
              <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
