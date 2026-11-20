"use client";
import { useCallback, useEffect, useState } from "react";
import { JSON_HEADERS } from "./ui";

type LogEntry = { id: string; direction: "in" | "out"; party: string; kind: string; body: string; status: string; reason?: string; at: string };
type Job = { id: string; ref: string; kind: string; contractorName: string; state: string; proposedAt?: string; proposedBy?: string; appointmentAt?: string; needsOwnerReason?: string; filesPulled: number; log: LogEntry[] };
type Settings = { handleJobs: boolean; autoReply: boolean; hideNewFiles: boolean };

const STATE: Record<string, string> = {
  requested: "Request sent, waiting for them to accept", negotiating: "Agreeing a time", scheduled: "Time confirmed", awaiting_delivery: "Waiting for their photos and reports",
  delivered: "Work received", needs_owner: "Needs you", stopped: "Elena has stopped"
};
const KIND: Record<string, string> = { photographer: "Photographer", inspector: "Building inspection", solicitor: "Solicitor", agent: "Agent", other: "Contractor" };
const LOG_STATUS: Record<string, string> = { sent: "Sent", blocked: "Blocked by safety filter", rate_limited: "Held back (daily limit)", failed: "Not delivered", received: "Received", ignored: "Ignored" };
const when = (iso: string) => new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/**
 * "Let Elena handle it": the owner switches Elena on for this listing. She asks nearby contractors, chases replies, agrees a time with both sides,
 * follows up for the work and tells the owner. Everything she sends is listed here, and one switch turns her off.
 */
export function ElenaJobsPanel({ listingId }: { listingId: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [at, setAt] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/listings/${listingId}/elena-jobs`);
      if (!r.ok) { setError(r.status === 401 ? "Sign in to use Elena's job handling." : "Could not load Elena's jobs."); return; }
      const d = await r.json();
      setSettings(d.settings); setJobs(d.jobs); setError("");
    } catch { setError("Could not load Elena's jobs."); }
  }, [listingId]);
  useEffect(() => { void load(); }, [load]);

  async function save(next: Settings) {
    setBusy("settings"); setError("");
    try {
      const r = await fetch(`/api/listings/${listingId}/elena-jobs`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(next) });
      if (r.ok) { setSettings((await r.json()).settings); await load(); } else setError((await r.json().catch(() => ({}))).error ?? "Could not save.");
    } catch { setError("Could not save."); } finally { setBusy(""); }
  }
  async function act(jobId: string, body: Record<string, unknown>) {
    setBusy(jobId); setError("");
    try {
      const r = await fetch(`/api/elena-jobs/${jobId}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "That did not work.");
      await load();
    } catch { setError("That did not work."); } finally { setBusy(""); }
  }

  return (
    <section className="panel ej" aria-labelledby="ej-h">
      <h2 id="ej-h">Let Elena handle it</h2>
      <p className="muted">Elena asks a suitable photographer and inspector, chases replies, agrees a time with both of you, follows up for the photos and reports, and tells you when they arrive. She never agrees to a price or sends money: contractors are paid by you directly.</p>
      {settings === null ? <p className="muted" role="status">{error || "Loading…"}</p> : (
        <div className="ej-switches">
          <label className="ej-switch"><input type="checkbox" checked={settings.handleJobs} disabled={busy === "settings"} onChange={e => void save({ ...settings, handleJobs: e.target.checked })} />
            <span><strong>Elena handles my jobs</strong><span className="muted">Turn off at any time. She stops straight away.</span></span></label>
          <label className="ej-switch"><input type="checkbox" checked={settings.autoReply} disabled={busy === "settings" || !settings.handleJobs} onChange={e => void save({ ...settings, autoReply: e.target.checked })} />
            <span><strong>Let Elena reply to emails</strong><span className="muted">She reads replies from contractors and answers routine ones with a short fixed note. Anything about money or a question comes to you instead.</span></span></label>
          <label className="ej-switch"><input type="checkbox" checked={settings.hideNewFiles} disabled={busy === "settings" || !settings.handleJobs} onChange={e => void save({ ...settings, hideNewFiles: e.target.checked })} />
            <span><strong>Hide new contractor photos until I look</strong><span className="muted">Photos still go into your gallery; you choose when they show.</span></span></label>
        </div>
      )}
      {error && settings !== null && <p role="alert">{error}</p>}
      {settings?.handleJobs && jobs.length === 0 && <p className="muted">Elena will list each job here once she has asked someone.</p>}
      <ul className="ej-list">
        {jobs.map(j => {
          const waitingOnMe = j.state === "negotiating" && j.proposedAt && j.proposedBy === "contractor";
          const canPropose = j.state === "negotiating";
          return (
            <li key={j.id} className="ej-job">
              <div className="ej-head">
                <strong>{KIND[j.kind] ?? "Contractor"}: {j.contractorName}</strong>
                <span className={`ej-state ej-${j.state}`}>{STATE[j.state] ?? j.state}</span>
              </div>
              <p className="muted">Job {j.ref}{j.appointmentAt ? ` · ${when(j.appointmentAt)}` : ""}{j.filesPulled > 0 ? ` · ${j.filesPulled} file${j.filesPulled === 1 ? "" : "s"} received` : ""}</p>
              {j.needsOwnerReason && <p role="status">{j.needsOwnerReason}</p>}
              {waitingOnMe && (
                <div className="ej-ask">
                  <span>They suggest <strong>{when(j.proposedAt!)}</strong>.</span>
                  <span className="qs-nav"><button type="button" disabled={busy === j.id} onClick={() => void act(j.id, { action: "accept" })}>That works</button><button type="button" className="secondary" disabled={busy === j.id} onClick={() => void act(j.id, { action: "reject" })}>Doesn&apos;t suit</button></span>
                </div>
              )}
              {canPropose && !waitingOnMe && j.proposedAt && <p className="muted">You suggested {when(j.proposedAt)}. Waiting for them.</p>}
              {canPropose && (
                <form className="ej-form" onSubmit={e => { e.preventDefault(); const v = at[j.id]; if (v) void act(j.id, { action: "propose", at: new Date(v).toISOString() }); }}>
                  <label className="field"><span>Suggest a time</span><input type="datetime-local" value={at[j.id] ?? ""} onChange={e => setAt({ ...at, [j.id]: e.target.value })} /></label>
                  <button type="submit" className="secondary" disabled={busy === j.id || !at[j.id]}>Send to {j.contractorName.split(" ")[0]}</button>
                </form>
              )}
              <div className="ej-actions">
                {j.state === "stopped" || j.state === "needs_owner"
                  ? <button type="button" className="secondary" disabled={busy === j.id} onClick={() => void act(j.id, { action: "resume" })}>Let Elena carry on</button>
                  : j.state !== "delivered" && <button type="button" className="secondary" disabled={busy === j.id} onClick={() => void act(j.id, { action: "stop" })}>Stop Elena on this job</button>}
                {j.filesPulled > 0 && <>
                  <button type="button" className="secondary" disabled={busy === j.id} onClick={() => void act(j.id, { action: "hide_files" })}>Hide their photos</button>
                  <button type="button" className="secondary" disabled={busy === j.id} onClick={() => void act(j.id, { action: "show_files" })}>Show their photos</button>
                </>}
              </div>
              <details className="ej-log">
                <summary>What Elena sent and received ({j.log.length})</summary>
                <ul>{j.log.map(m => (
                  <li key={m.id}><span className="muted">{when(m.at)} · {m.direction === "out" ? "To" : "From"} {m.party === "owner" ? "you" : "contractor"} · {LOG_STATUS[m.status] ?? m.status}</span><span>{m.body}</span>{m.reason && <span className="muted">{m.reason}</span>}</li>
                ))}</ul>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
