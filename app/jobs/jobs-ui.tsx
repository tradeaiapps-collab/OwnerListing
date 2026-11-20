"use client";
import { useState, type ReactNode } from "react";
import { JSON_HEADERS, price, tradeName, whenAu } from "../contractors/ui";

export type Job = {
  id: string; listingId: string; kind: string; status: string; jobNumber: number; role: "owner" | "contractor";
  listingTitle: string; address: string; ownerName: string; contractorName: string; contractorNo?: number; createdAt: string;
  serviceName?: string; priceCents?: number; note?: string; requestedTime?: string; proposedTime?: string; scheduledTime?: string;
  declineReason?: string; contractorDoneAt?: string; completedAt?: string; offerSource?: string; review?: { rating: number; body: string };
};
export const jobNo = (n: number) => `JOB-${n}`;
const STATUS: Record<string, [string, string]> = { proposed: ["Waiting for an answer", "wait"], approved: ["Accepted", "ok"], completed: ["Completed", "ok"], cancelled: ["Rejected or cancelled", "off"] };
export function StatusPill({ j }: { j: Job }): ReactNode {
  const [text, cls] = j.status === "approved" && j.contractorDoneAt ? ["Marked done, owner to confirm", "wait"] : STATUS[j.status] ?? [j.status, ""];
  return <span className={`cm-pill ${cls}`}>{text}</span>;
}

/** Everything a person can do to a job, for their own side. Used in the list and on the job page. */
export function JobActions({ job, onChange }: { job: Job; onChange: (j: Job) => void }): ReactNode {
  const [mode, setMode] = useState<"" | "decline" | "time">("");
  const [reason, setReason] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(body: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/jobs/${job.id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setMode(""); setReason(""); setTime(""); onChange({ ...d.job, role: job.role }); } else setError(d.error ?? "Could not do that.");
    } catch { setError("Could not do that. Try again."); } finally { setBusy(false); }
  }
  const mine = job.role === "contractor";
  const open = job.status === "proposed" || job.status === "approved";
  return (
    <div className="cm-book">
      <div className="cm-actions">
        {mine && job.status === "proposed" && <button type="button" disabled={busy} onClick={() => void act({ action: "accept" })}>Accept job</button>}
        {mine && job.status === "proposed" && <button type="button" className="secondary" disabled={busy} onClick={() => setMode(mode === "decline" ? "" : "decline")}>Reject</button>}
        {mine && open && <button type="button" className="secondary" disabled={busy} onClick={() => setMode(mode === "time" ? "" : "time")}>Propose another time</button>}
        {mine && job.status === "approved" && !job.contractorDoneAt && <button type="button" disabled={busy} onClick={() => void act({ action: "mark_done" })}>Mark as done</button>}
        {!mine && job.proposedTime && open && <>
          <button type="button" disabled={busy} onClick={() => void act({ action: "accept_time" })}>Accept {whenAu(job.proposedTime)}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void act({ action: "reject_time" })}>Decline that time</button>
        </>}
        {!mine && job.status === "approved" && <button type="button" disabled={busy} onClick={() => void act({ action: "complete" })}>Confirm job complete</button>}
        {!mine && open && <button type="button" className="secondary" disabled={busy} onClick={() => void act({ action: "cancel" })}>Cancel job</button>}
      </div>
      {mode === "decline" && (
        <form className="cm-inline" onSubmit={e => { e.preventDefault(); void act({ action: "decline", reason }); }}>
          <label className="field"><span>Why are you rejecting this job? The owner will see this.</span><textarea rows={3} value={reason} minLength={3} maxLength={500} required onChange={e => setReason(e.target.value)} /></label>
          <div className="cm-actions"><button type="submit" disabled={busy}>Reject job</button><button type="button" className="secondary" onClick={() => setMode("")}>Back</button></div>
        </form>
      )}
      {mode === "time" && (
        <form className="cm-inline" onSubmit={e => { e.preventDefault(); void act({ action: "propose_time", time: new Date(time).toISOString() }); }}>
          <label className="field"><span>A time that suits you</span><input type="datetime-local" value={time} required onChange={e => setTime(e.target.value)} /></label>
          <div className="cm-actions"><button type="submit" disabled={busy || !time}>Send this time</button><button type="button" className="secondary" onClick={() => setMode("")}>Back</button></div>
        </form>
      )}
      {error && <p role="alert" className="ma-error">{error}</p>}
    </div>
  );
}

export function JobFacts({ j }: { j: Job }): ReactNode {
  const rows: [string, string | undefined][] = [
    ["Trade", tradeName(j.kind)], ["Service", j.serviceName], ["Price shown", j.priceCents === undefined ? undefined : price(j.priceCents)],
    [j.role === "owner" ? "Contractor" : "Owner", j.role === "owner" ? j.contractorName : j.ownerName],
    ["Asked for", j.requestedTime ? whenAu(j.requestedTime) : undefined], ["Proposed time", j.proposedTime ? whenAu(j.proposedTime) : undefined],
    ["Booked time", j.scheduledTime ? whenAu(j.scheduledTime) : undefined], ["Reason for rejecting", j.declineReason], ["Message", j.note],
    ["Chosen by", j.offerSource === "elena" ? "Elena" : undefined]
  ];
  return <dl className="cm-facts">{rows.filter((r): r is [string, string] => !!r[1]).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
