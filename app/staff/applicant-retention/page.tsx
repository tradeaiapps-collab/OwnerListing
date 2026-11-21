"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError } from "../staff-api";

interface Data {
  settings: { enabled: boolean; retentionDays: number; lastRunAt: string | null };
  pending: { applications: number; enquiryActions: number };
  runs: { id: string; trigger: "staff" | "schedule"; retentionDays: number; applications: number; enquiryActions: number; ranAt: string }[];
}
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-AU") : "Never");

/** Staff page: how long rental applicant data and Elena's enquiry drafts are kept, and a purge. Needs config.edit. */
export default function ApplicantRetention() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState("365");
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/elena-retention").catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    const d = (await r.json()) as Data;
    setData(d); setEnabled(d.settings.enabled); setDays(String(d.settings.retentionDays));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function post(body: Record<string, unknown>, done: string) {
    setBusy(true); setError(""); setNote(""); setConfirm(false);
    const r = await fetch("/api/staff/elena-retention", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    const res = r ? await r.json().catch(() => ({})) as { error?: string; applications?: number; enquiryActions?: number } : {};
    if (!r?.ok) { setError(r ? String(res.error ?? "Could not save.") : "Network error."); return; }
    setNote(body["action"] === "purge" ? `${done} ${res.applications ?? 0} applications and ${res.enquiryActions ?? 0} Elena enquiry drafts scrubbed.` : done);
    await load();
  }

  return (
    <main className="admin-page">
      <h1>Applicant data retention</h1>
      <p className="muted">Income, rental history, references, move-in date and notes on rental applications, and Elena&rsquo;s enquiry draft text, are scrubbed once nothing has changed for the period below. Records, statuses and the audit trail stay. Chat and sent messages are never deleted.</p>
      <div aria-live="polite">
        {error && <p role="alert">{error}</p>}
        {note && <p role="status">{note}</p>}
      </div>
      {!data && !error && <p className="muted" role="status">Loading…</p>}
      {data && (
        <>
          <section aria-labelledby="ret-settings">
            <h2 id="ret-settings">Settings</h2>
            <form onSubmit={e => { e.preventDefault(); void post({ action: "save", enabled, retentionDays: Number(days) }, "Saved."); }}>
              <p><label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Purge automatically once a day</label></p>
              <p><label>Keep for (days, 90 to 3650)<br /><input type="number" inputMode="numeric" style={{ maxWidth: "12rem" }} min={90} max={3650} value={days} onChange={e => setDays(e.target.value)} required /></label></p>
              <p><button type="submit" disabled={busy}>Save</button></p>
            </form>
            <p className="muted">Last run {when(data.settings.lastRunAt)}. The daily run needs the automation tick scheduled (see Scheduler secrets).</p>
          </section>
          <section aria-labelledby="ret-purge">
            <h2 id="ret-purge">Purge now</h2>
            <p>Ready to scrub with the saved period of {data.settings.retentionDays} days: <strong>{data.pending.applications}</strong> applications and <strong>{data.pending.enquiryActions}</strong> enquiry drafts.</p>
            {confirm ? (
              <p>
                <span className="muted">This cannot be undone. </span>
                <button type="button" disabled={busy} onClick={() => void post({ action: "purge" }, "Done.")}>Yes, scrub them</button>{" "}
                <button type="button" className="secondary" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
              </p>
            ) : (
              <p><button type="button" disabled={busy || (data.pending.applications + data.pending.enquiryActions === 0)} onClick={() => setConfirm(true)}>Purge now</button></p>
            )}
          </section>
          <section aria-labelledby="ret-runs">
            <h2 id="ret-runs">Recent runs</h2>
            {data.runs.length === 0 ? <p className="empty">No runs yet.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th scope="col">When</th><th scope="col">By</th><th scope="col">Period</th><th scope="col">Applications</th><th scope="col">Enquiry drafts</th></tr></thead>
                <tbody>{data.runs.map(r => (
                  <tr key={r.id}><td>{when(r.ranAt)}</td><td>{r.trigger === "staff" ? "Staff" : "Schedule"}</td><td>{r.retentionDays} days</td><td>{r.applications}</td><td>{r.enquiryActions}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
