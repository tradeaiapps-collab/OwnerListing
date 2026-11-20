"use client";
import { useCallback, useEffect, useState } from "react";
import { EMERGENCY_TRADES } from "../../../src/domain/emergency";
import { JSON_HEADERS } from "../../listings/ui";
import { DAYS, STATUS_TEXT, TRADE_OPTIONS, tradeLabel, type Window } from "../../emergency/shared";

type Saved = { trade: string; enabled: boolean; timeZone: string; allHours: boolean; windows: Window[]; callOutCents: number | null; businessName: string | null; contactPhone: string; contactEmail: string | null; note: string | null; serviceSuburbs: string[]; servicePostcodes: string[] };
type Form = { enabled: boolean; allHours: boolean; windows: Window[]; callOut: string; businessName: string; phone: string; email: string; note: string; suburbs: string; postcodes: string; timeZone: string };
type Req = { id: string; number: number; jobNumber: number | null; assignmentId: string | null; role: string; status: string; trade: string; description: string; suburb: string | null; postcode: string | null; createdAt: string; requesterName: string; addressText: string | null; callbackPhone: string | null; myStatus: string | null };

const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Brisbane"; } catch { return "Australia/Brisbane"; } };
const blank = (): Form => ({ enabled: true, allHours: false, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "18:00", end: "06:00" }], callOut: "", businessName: "", phone: "", email: "", note: "", suburbs: "", postcodes: "", timeZone: zone() });
const fromSaved = (p: Saved): Form => ({ enabled: p.enabled, allHours: p.allHours, windows: p.windows, callOut: p.callOutCents === null ? "" : String(p.callOutCents / 100), businessName: p.businessName ?? "", phone: p.contactPhone, email: p.contactEmail ?? "", note: p.note ?? "", suburbs: p.serviceSuburbs.join(", "), postcodes: p.servicePostcodes.join(", "), timeZone: p.timeZone });
const split = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean);

/** A contractor opts in to emergency jobs: trade, days and hours (in their own time zone), the call-out price and the contact details shown. Also where they accept or pass on urgent requests. */
export default function ContractorEmergency() {
  const [trade, setTrade] = useState<string>(EMERGENCY_TRADES[0]);
  const [saved, setSaved] = useState<Record<string, Saved>>({});
  const [form, setForm] = useState<Form>(blank());
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [eta, setEta] = useState<Record<string, string>>({});

  const loadReqs = useCallback(async () => {
    try { const r = await fetch("/api/emergency/requests"); if (r.ok) setReqs(((await r.json()).requests as Req[]).filter(x => x.role === "contractor")); else setReqs([]); } catch { setReqs([]); }
  }, []);
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/emergency/profile");
        if (r.status === 401) { setError("Sign in to set up emergency jobs."); setReqs([]); return; }
        const d = await r.json();
        const list = d.profiles as Saved[];
        setSaved(Object.fromEntries(list.map(p => [p.trade, p])));
        if (list[0]) setTrade(list[0].trade);
      } catch { setError("Could not load your emergency settings."); }
      await loadReqs();
    })();
  }, [loadReqs]);
  useEffect(() => { setForm(saved[trade] ? fromSaved(saved[trade]) : blank()); }, [trade, saved]);

  const set = (patch: Partial<Form>) => setForm(f => ({ ...f, ...patch }));
  const setWin = (i: number, patch: Partial<Window>) => set({ windows: form.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  const toggleDay = (i: number, d: number) => { const w = form.windows[i]!; setWin(i, { days: w.days.includes(d) ? w.days.filter(x => x !== d) : [...w.days, d].sort() }); };

  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(""); setError(""); setBusy(true);
    const cents = form.callOut.trim() === "" ? null : Math.round(Number(form.callOut) * 100);
    const r = await fetch("/api/emergency/profile", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({
      trade, enabled: form.enabled, timeZone: form.timeZone, allHours: form.allHours, windows: form.allHours ? [] : form.windows, callOutCents: cents,
      businessName: form.businessName, contactPhone: form.phone, contactEmail: form.email, note: form.note, serviceSuburbs: split(form.suburbs), servicePostcodes: split(form.postcodes)
    }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { setSaved(s => ({ ...s, [trade]: d.profile })); setMsg(form.enabled ? "Saved. You are listed for emergency jobs." : "Saved. You are not listed."); } else setError(d.error ?? "Could not save.");
  }
  async function reply(id: string, kind: "accept" | "decline") {
    setError(""); setBusy(true);
    const minutes = Number(eta[id]);
    const r = await fetch(`/api/emergency/requests/${id}/reply`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ kind, ...(kind === "accept" && minutes > 0 ? { etaMinutes: minutes } : {}) }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) setError(d.error ?? "Could not send your reply.");
    await loadReqs();
  }

  return (
    <main className="emg-page">
      <header className="emg-head">
        <h1>Emergency jobs</h1>
        <p className="muted">Take urgent call-outs. Choose your trade, the days and hours you accept them, and the contact details owners see. Customers pay you directly. {" "}
          <a href="/contractor/profile">Your service areas</a></p>
      </header>
      {error && <p role="alert" className="emg-alert">{error}</p>}

      <div className="emg-panel emg-one">
      <section className="emg-sec" aria-labelledby="emg-incoming">
        <h2 id="emg-incoming">Urgent requests for you</h2>
        {reqs === null ? <p className="muted" role="status">Loading…</p> : reqs.length === 0 ? <p className="empty">No urgent requests yet. When someone nearby needs your trade while you are available, Elena sends it here and to you by email or text.</p> : (
          <ul className="emg-list">
            {reqs.map(r => (
              <li key={r.id} className="emg-item">
                <div className="emg-top"><strong>{r.myStatus === "accepted" && r.jobNumber ? `JOB-${r.jobNumber}` : `EMG-${r.number}`} · {tradeLabel(r.trade)}</strong><span className={`emg-badge st-${r.myStatus ?? r.status}`}>{STATUS_TEXT[r.myStatus ?? r.status] ?? r.status}</span></div>
                <p className="muted">{[r.suburb, r.postcode].filter(Boolean).join(" ")} · from {r.requesterName}</p>
                <p className="emg-quote">“{r.description}”</p>
                {r.myStatus === "accepted" && <p className="emg-contact"><strong>Address:</strong> {r.addressText}{r.callbackPhone && <> · <a href={`tel:${r.callbackPhone}`}>{r.callbackPhone}</a></>}{r.assignmentId && <> · <a href={`/jobs/${r.assignmentId}`}>Open the job</a></>}</p>}
                {r.status === "open" && r.myStatus === "sent" && (
                  <div className="emg-actions">
                    <label className="emg-eta"><span>Arrive in (minutes)</span><input inputMode="numeric" value={eta[r.id] ?? ""} onChange={e => setEta({ ...eta, [r.id]: e.target.value.replace(/\D/g, "") })} /></label>
                    <button type="button" disabled={busy} onClick={() => void reply(r.id, "accept")}>Accept job</button>
                    <button type="button" className="secondary" disabled={busy} onClick={() => void reply(r.id, "decline")}>Pass</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <hr className="emg-rule" />

      <form className="emg-sec emg-form" onSubmit={e => void save(e)}>
        <h2>Your emergency listing</h2>
        <label className="field"><span>Trade</span>
          <select value={trade} onChange={e => { setTrade(e.target.value); setMsg(""); }}>{TRADE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}{saved[t.value]?.enabled ? " (listed)" : ""}</option>)}</select>
        </label>
        <label className="emg-check"><input type="checkbox" checked={form.enabled} onChange={e => set({ enabled: e.target.checked })} /> I accept emergency jobs for this trade</label>
        <label className="emg-check"><input type="checkbox" checked={form.allHours} onChange={e => set({ allHours: e.target.checked })} /> Available at all hours, every day</label>
        {!form.allHours && (
          <fieldset className="emg-hours">
            <legend>Hours I accept emergency jobs <span className="muted">({form.timeZone})</span></legend>
            {form.windows.map((w, i) => (
              <div key={i} className="emg-window">
                <div className="emg-days" role="group" aria-label={`Days for window ${i + 1}`}>
                  {DAYS.map((d, n) => <button key={d} type="button" className={w.days.includes(n) ? "on" : ""} aria-pressed={w.days.includes(n)} onClick={() => toggleDay(i, n)}>{d}</button>)}
                </div>
                <div className="emg-times">
                  <label><span>From</span><input type="time" value={w.start} onChange={e => setWin(i, { start: e.target.value })} /></label>
                  <label><span>To</span><input type="time" value={w.end} onChange={e => setWin(i, { end: e.target.value })} /></label>
                  <button type="button" className="secondary" onClick={() => set({ windows: form.windows.filter((_, j) => j !== i) })}>Remove</button>
                </div>
              </div>
            ))}
            <p className="muted emg-hint">A window that ends before it starts runs past midnight, for example 18:00 to 06:00.</p>
            <button type="button" className="secondary" disabled={form.windows.length >= 14} onClick={() => set({ windows: [...form.windows, { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" }] })}>Add hours</button>
          </fieldset>
        )}
        <label className="field"><span>Time zone</span><input value={form.timeZone} onChange={e => set({ timeZone: e.target.value })} autoCapitalize="off" /></label>
        <label className="field"><span>Call-out price in dollars, optional</span><input inputMode="decimal" value={form.callOut} onChange={e => set({ callOut: e.target.value.replace(/[^\d.]/g, "") })} placeholder="e.g. 180" /></label>
        <label className="field"><span>Business name, optional</span><input value={form.businessName} maxLength={80} onChange={e => set({ businessName: e.target.value })} /></label>
        <label className="field"><span>Phone shown to customers</span><input type="tel" inputMode="tel" value={form.phone} onChange={e => set({ phone: e.target.value })} required /></label>
        <label className="field"><span>Email shown to customers, optional</span><input type="email" value={form.email} onChange={e => set({ email: e.target.value })} /></label>
        <label className="field"><span>Suburbs you cover, separated by commas</span><input value={form.suburbs} onChange={e => set({ suburbs: e.target.value })} /></label>
        <label className="field"><span>Postcodes you cover, separated by commas</span><input inputMode="numeric" value={form.postcodes} onChange={e => set({ postcodes: e.target.value })} /></label>
        <label className="field"><span>Note to customers, optional</span><textarea rows={3} maxLength={300} value={form.note} onChange={e => set({ note: e.target.value })} /></label>
        <p className="muted emg-hint">Your phone and email are shown to signed-in customers who search. Urgent requests also go to your account email, and by text to this number if it is a mobile.</p>
        <button type="submit" disabled={busy}>Save {tradeLabel(trade).toLowerCase()} settings</button>
        {msg && <p role="status">{msg}</p>}
      </form>
      </div>
    </main>
  );
}
