"use client";
import { useCallback, useEffect, useState } from "react";
import { JSON_HEADERS, formatWhen } from "../inspections/ui";

const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];
type Profile = { businessName: string; licenceRef: string; jurisdictions: string[]; status: string; reviewNote: string };
type Req = { id: string; listingTitle: string; address: string; jurisdiction: string; slots: string[]; notes: string };
type Job = { id: string; listingTitle: string; status: string; scheduledAt?: string; inspectionId?: string };
const STATUS: Record<string, string> = { pending: "Waiting for review", approved: "Approved", rejected: "Not approved", suspended: "Suspended" };

/** Inspector portal: apply, then accept or pass on requests in your states. Reports are written on the inspection page. */
export default function InspectorPortal() {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [slot, setSlot] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ businessName: "", licenceRef: "", jurisdictions: [] as string[] });

  const load = useCallback(async () => {
    const p = await fetch("/api/inspector/profile").catch(() => null);
    if (!p || !p.ok) { setError(p?.status === 401 ? "Sign in to use the inspector portal." : "Could not load."); return; }
    const prof = ((await p.json()) as { profile: Profile | null }).profile;
    setProfile(prof);
    if (prof?.status === "approved") {
      const r = await fetch("/api/inspector/requests").catch(() => null);
      if (r?.ok) { const d = await r.json(); setReqs(d.requests); setJobs(d.jobs); }
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function apply(e: React.FormEvent) {
    e.preventDefault(); setBusy("apply"); setError(""); setNote("");
    const r = await fetch("/api/inspector/profile", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(form) }).catch(() => null);
    setBusy("");
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) { setError(r ? d.error ?? "Could not send." : "Network error."); return; }
    setNote("Application sent. Staff will review it."); await load();
  }
  async function act(id: string, body: Record<string, string>) {
    setBusy(id); setError(""); setNote("");
    const r = await fetch(`/api/inspector/requests/${id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
    setBusy("");
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) { setError(r ? d.error ?? "Could not save." : "Network error."); await load(); return; }
    setNote(body["action"] === "accept" ? "Accepted. Open the job to record your report." : "Passed. It is hidden from your list."); await load();
  }
  const toggleState = (s: string) => setForm(f => ({ ...f, jurisdictions: f.jurisdictions.includes(s) ? f.jurisdictions.filter(x => x !== s) : [...f.jurisdictions, s] }));

  return (
    <main className="insp-page">
      <h1>Inspector portal</h1>
      <div aria-live="polite">{error && <p role="alert">{error}</p>}{note && <p role="status">{note}</p>}</div>
      {profile === undefined && !error && <p className="muted" role="status">Loading…</p>}

      {(profile === null || profile?.status === "rejected") && (
        <form className="insp-form insp-panel" onSubmit={apply}>
          <h2>{profile ? "Apply again" : "Become an inspector"}</h2>
          {profile && <p>Your last application was not approved{profile.reviewNote ? `: ${profile.reviewNote}` : "."}</p>}
          <p className="muted">For vendor and agent accounts. Staff check your details before you can see requests.</p>
          <label>Business name<input required maxLength={120} value={form.businessName} onChange={e => setForm({ ...form, businessName: e.target.value })} /></label>
          <label>Licence or insurance reference (optional)<input maxLength={80} value={form.licenceRef} onChange={e => setForm({ ...form, licenceRef: e.target.value })} /></label>
          <fieldset className="insp-states"><legend>States you work in</legend>
            {STATES.map(s => <label key={s}><input type="checkbox" checked={form.jurisdictions.includes(s)} onChange={() => toggleState(s)} />{s}</label>)}
          </fieldset>
          <button type="submit" disabled={busy === "apply" || form.jurisdictions.length === 0}>{busy === "apply" ? "Sending…" : "Send application"}</button>
        </form>
      )}

      {profile && profile.status !== "rejected" && (
        <section className="insp-panel"><h2>{profile.businessName}</h2>
          <p><span className="badge">{STATUS[profile.status]}</span> · {profile.jurisdictions.join(", ")}</p>
          {profile.status === "suspended" && <p>{profile.reviewNote || "Contact support."}</p>}
        </section>
      )}

      {profile?.status === "approved" && (<>
        <h2>Open requests</h2>
        {reqs.length === 0 && <p className="empty">No open requests in {profile.jurisdictions.join(", ")} right now.</p>}
        <ul className="card-list insp-list">
          {reqs.map(r => (
            <li key={r.id}>
              <div className="top"><strong>{r.listingTitle}</strong><span className="badge">{r.jurisdiction}</span></div>
              <span>{r.address}</span>
              {r.notes && <span className="muted">Buyer notes: {r.notes}</span>}
              <fieldset className="insp-pick"><legend className="muted">Pick a time</legend>
                {r.slots.map(s => <label key={s}><input type="radio" name={`slot-${r.id}`} checked={slot[r.id] === s} onChange={() => setSlot({ ...slot, [r.id]: s })} />{formatWhen(s)}</label>)}
              </fieldset>
              <div className="actions">
                <button type="button" disabled={busy === r.id || !slot[r.id]} onClick={() => act(r.id, { action: "accept", slot: slot[r.id]! })}>Accept</button>
                <button type="button" className="secondary" disabled={busy === r.id} onClick={() => act(r.id, { action: "pass" })}>Pass</button>
              </div>
            </li>
          ))}
        </ul>
        <h2>Your jobs</h2>
        {jobs.length === 0 && <p className="empty">Accepted requests appear here.</p>}
        <ul className="card-list insp-list">
          {jobs.map(j => (
            <li key={j.id}>
              <div className="top"><strong>{j.listingTitle}</strong><span className="badge">{j.status === "completed" ? "Report complete" : j.status === "cancelled" ? "Cancelled" : "Booked"}</span></div>
              {j.scheduledAt && <span>{formatWhen(j.scheduledAt)}</span>}
              {j.inspectionId && j.status !== "cancelled" && <div className="actions"><a className="button" href={`/inspections/${j.inspectionId}`}>{j.status === "completed" ? "Open report" : "Open job"}</a></div>}
            </li>
          ))}
        </ul>
      </>)}
    </main>
  );
}
