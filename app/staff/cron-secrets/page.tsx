"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError } from "../staff-api";

interface Job {
  job: string; label: string; schedule: string; workflow: string; repoSecret: string; envVar: string;
  source: "database" | "environment" | "none"; enabled: boolean; active: boolean; last4: string | null; rotatedAt: string | null; lastCalledAt: string | null; envFallbackSet: boolean;
}
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-AU") : "Never");
const sourceText = { database: "Stored here", environment: "Environment variable", none: "Not set" } as const;

/** Staff page for the secrets that scheduled jobs send to the internal endpoints. Needs config.edit. */
export default function CronSecrets() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [shown, setShown] = useState<{ job: string; secret: string } | null>(null);
  const [confirm, setConfirm] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/cron-secrets").catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    setJobs(((await r.json()) as { jobs: Job[] }).jobs);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(job: string, action: "rotate" | "enable" | "disable") {
    setBusy(job); setError(""); setNote(""); setConfirm("");
    const r = await fetch("/api/staff/cron-secrets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job, action }) }).catch(() => null);
    setBusy("");
    const data = r ? await r.json().catch(() => ({})) as { jobs?: Job[]; secret?: string; error?: string } : {};
    if (!r?.ok) { setError(r ? String(data.error ?? "Could not save.") : "Network error."); return; }
    setJobs(data.jobs ?? null);
    if (data.secret) { setShown({ job, secret: data.secret }); setNote("New secret generated. Copy it now; it cannot be shown again."); }
    else { setShown(null); setNote(action === "enable" ? "Job switched on." : "Job paused. Its endpoint now refuses every call."); }
  }

  return (
    <main className="admin-page">
      <h1>Scheduler secrets</h1>
      <p className="muted">Scheduled jobs prove who they are with a secret in the <code>x-cron-secret</code> header. Generate it here, then paste the same value into the repository secret named below. Only a one-way hash is kept, so a lost secret is replaced, not recovered. A secret stored here wins over the environment variable.</p>
      <div aria-live="polite">
        {error && <p role="alert">{error}</p>}
        {note && <p role="status">{note}</p>}
      </div>
      {!jobs && !error && <p className="muted" role="status">Loading…</p>}
      {jobs && (
        <div className="table-wrap"><table>
          <thead><tr>
            <th scope="col">Job</th><th scope="col">Status</th><th scope="col">Secret</th><th scope="col">Last call</th><th scope="col">Actions</th>
          </tr></thead>
          <tbody>
            {jobs.map(j => (
              <tr key={j.job}>
                <td><strong>{j.label}</strong><br /><span className="muted">{j.schedule}</span></td>
                <td>{!j.enabled ? "Paused" : j.active ? "On" : "Off: no secret"}</td>
                <td>
                  {sourceText[j.source]}
                  <br /><span className="muted">{j.last4 ? `•••• •••• ${j.last4}` : j.source === "environment" ? `From ${j.envVar}` : "None"}</span>
                  {j.rotatedAt && <><br /><span className="muted">Generated {when(j.rotatedAt)}</span></>}
                </td>
                <td>{when(j.lastCalledAt)}</td>
                <td>
                  {confirm === j.job ? (
                    <>
                      <span className="muted">The old secret stops working at once. </span>
                      <button type="button" disabled={!!busy} onClick={() => void act(j.job, "rotate")}>Yes, replace it</button>{" "}
                      <button type="button" className="secondary" disabled={!!busy} onClick={() => setConfirm("")}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button type="button" disabled={!!busy} onClick={() => (j.source === "database" ? setConfirm(j.job) : void act(j.job, "rotate"))}>{j.source === "database" ? "Regenerate" : "Generate secret"}</button>{" "}
                      <button type="button" className="secondary" disabled={!!busy} onClick={() => void act(j.job, j.enabled ? "disable" : "enable")}>{j.enabled ? "Pause" : "Switch on"}</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {shown && jobs && (() => {
        const j = jobs.find(x => x.job === shown.job);
        return (
          <section aria-label="New secret">
            <h2>New secret for {j?.label}</h2>
            <p><input readOnly aria-label="New secret" value={shown.secret} onFocus={e => e.currentTarget.select()} style={{ width: "100%", maxWidth: "36rem", fontFamily: "monospace" }} /></p>
            <p>
              <button type="button" onClick={() => void navigator.clipboard?.writeText(shown.secret).then(() => setNote("Copied."))}>Copy</button>{" "}
              <button type="button" className="secondary" onClick={() => setShown(null)}>I have saved it</button>
            </p>
            <p className="muted">Set repository secret <code>{j?.repoSecret}</code> to this value (Settings, Secrets and variables, Actions). Until you do, the {j?.schedule.toLowerCase()} run will be refused.</p>
          </section>
        );
      })()}
    </main>
  );
}
