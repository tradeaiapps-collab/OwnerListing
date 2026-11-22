"use client";
import { useCallback, useEffect, useState } from "react";
import { REMINDER_HOURS, type JobPrefs } from "../../../src/domain/contractor-ops";
import "../../styles/contractor-ops.css";

type Item = { assignmentId: string; kind: string; status: string; listingTitle: string; address: string | null; startsAt: string; endsAt: string; visitState: string; clashesWith: string[] };

const fmt = (iso: string) => new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const time = (iso: string) => new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const dayKey = (iso: string) => new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long" }).format(new Date(iso));

/** A contractor's jobs by day, with a warning where two accepted or waiting jobs overlap, and their own alert choices. */
export default function ContractorCalendar() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  const [prefs, setPrefs] = useState<JobPrefs | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);

  const load = useCallback(async () => {
    setError("");
    const [c, p] = await Promise.all([fetch("/api/contractor/calendar").catch(() => null), fetch("/api/contractor/job-preferences").catch(() => null)]);
    if (!c || !c.ok) { setItems(null); setError(c?.status === 401 ? "Sign in to see your calendar." : "Could not load your calendar."); return; }
    setItems((await c.json()).items);
    if (p?.ok) setPrefs((await p.json()).preferences);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function savePrefs(next: JobPrefs) {
    setPrefs(next); setMsg(null);
    const r = await fetch("/api/contractor/job-preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) }).catch(() => null);
    setMsg(r?.ok ? { text: "Saved.", bad: false } : { text: "Could not save. Try again.", bad: true });
  }

  const days = new Map<string, Item[]>();
  for (const i of items ?? []) { const k = dayKey(i.startsAt); days.set(k, [...(days.get(k) ?? []), i]); }

  return (
    <main className="co">
      <div>
        <h1>Your calendar</h1>
        <p className="muted">Jobs with a time, soonest first. Times are in your device's time zone.</p>
      </div>
      {error && <p role="alert" className="co-error">{error}</p>}
      {!items && !error && <p className="co-state" role="status">Loading…</p>}
      {items && items.length === 0 && <p className="co-state">No jobs have a time yet. When an owner proposes one it will appear here.</p>}
      {[...days.entries()].map(([day, list]) => (
        <section key={day} className="co-section" aria-label={day}>
          <h2>{day}</h2>
          <ul className="co-list">
            {list.map(i => (
              <li key={i.assignmentId} className={`co-item${i.clashesWith.length ? " clash" : ""}`}>
                <div className="co-item-head">
                  <strong>{time(i.startsAt)} to {time(i.endsAt)} · {i.kind}</strong>
                  <span className={`co-badge ${i.status === "approved" && i.visitState === "confirmed" ? "ok" : "warn"}`}>{i.status === "proposed" ? "Not accepted yet" : i.visitState === "confirmed" ? "Confirmed" : "Time to confirm"}</span>
                </div>
                <p>{i.address ?? i.listingTitle}</p>
                {i.clashesWith.length > 0 && <p className="co-error" role="alert">Overlaps another job on this calendar.</p>}
                <div className="actions"><a className="button secondary" href={`/jobs/${i.assignmentId}/visit`}>Open job</a></div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {prefs && (
        <section className="co-section" aria-labelledby="co-alerts">
          <h2 id="co-alerts">How we tell you about jobs</h2>
          <p className="muted">You always see new jobs in the app. Texts also need a verified phone number and texts turned on under Notifications.</p>
          <label className="co-check"><input type="checkbox" checked={prefs.email} onChange={e => void savePrefs({ ...prefs, email: e.target.checked })} /> Email me about new jobs and time changes</label>
          <label className="co-check"><input type="checkbox" checked={prefs.sms} onChange={e => void savePrefs({ ...prefs, sms: e.target.checked })} /> Text me about new jobs and time changes</label>
          <label>Reminder before a confirmed job
            <select value={prefs.reminderHours} onChange={e => void savePrefs({ ...prefs, reminderHours: Number(e.target.value) })}>
              {REMINDER_HOURS.map(h => <option key={h} value={h}>{h === 0 ? "No reminder" : `${h} hours before`}</option>)}
            </select>
          </label>
          {msg && <p role={msg.bad ? "alert" : "status"} className={msg.bad ? "co-error" : "co-ok"}>{msg.text}</p>}
        </section>
      )}
    </main>
  );
}
