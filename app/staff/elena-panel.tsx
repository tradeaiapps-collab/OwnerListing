"use client";
import { useState } from "react";
import { postStaff } from "./staff-api";

export interface ElenaRec {
  action: string; confidence: "high" | "medium" | "low"; rule: string; reason: string; draft?: string; summary?: string[]; nextSteps?: string[];
  duplicateOf?: string; groupSize?: number; recommendationId: string | null;
}
const ACTION_LABEL: Record<string, string> = {
  approve: "Approve", hide: "Hide (reject)", suspend: "Suspend the account", needs_info: "Ask for more information", uphold: "Uphold", dismiss: "Dismiss",
  uphold_and_suspend: "Uphold and suspend", review: "Look at this yourself"
};
export const isBulkReady = (e: ElenaRec | null | undefined): boolean => !!e && e.action === "approve" && e.confidence === "high";

/** What Elena thinks, why, and what she is not sure of. Staff always decide. */
export function ElenaPanel({ rec, onUseDraft }: { rec: ElenaRec | null | undefined; onUseDraft?: (draft: string) => void }) {
  if (!rec) return null;
  return (
    <section className={`elena-rec elena-rec-${rec.confidence}`} aria-label="Elena's recommendation">
      <h3>
        Elena suggests: {ACTION_LABEL[rec.action] ?? rec.action}
        <span className="badge">{rec.confidence} confidence</span>
        {rec.groupSize ? <span className="badge">{rec.duplicateOf ? "same as an older item" : `${rec.groupSize} similar items`}</span> : null}
      </h3>
      <p>{rec.reason}</p>
      <p className="muted">Rule: {rec.rule}. Elena only suggests; you decide.</p>
      {rec.summary && <ul aria-label="Summary">{rec.summary.map((s, n) => <li key={n}>{s}</li>)}</ul>}
      {rec.nextSteps && rec.nextSteps.length > 0 && (<><strong>Suggested next steps</strong><ul>{rec.nextSteps.map((s, n) => <li key={n}>{s}</li>)}</ul></>)}
      {rec.draft && (<>
        <strong>Drafted request to the contractor</strong>
        <pre className="elena-draft">{rec.draft}</pre>
        {onUseDraft && <div className="actions"><button type="button" className="secondary" onClick={() => onUseDraft(rec.draft!)}>Use this draft as my note</button></div>}
      </>)}
    </section>
  );
}

/** Off by default. When on, the list shows only items Elena would approve, and staff can confirm the high-confidence ones together. */
export function ElenaBulkBar({ queue, items, filterOn, setFilterOn, onDone, setMessage }: {
  queue: "moderation" | "verification"; items: { id: string; elena: ElenaRec | null }[]; filterOn: boolean; setFilterOn: (v: boolean) => void;
  onDone: () => void; setMessage: (m: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const ready = items.filter(i => isBulkReady(i.elena)).slice(0, 25);
  async function run() {
    setMessage("");
    const res = await postStaff("/api/staff/elena-prescreen/bulk", { queue, ids: ready.map(i => i.id), confirm: true });
    const results = Array.isArray(res.data["results"]) ? (res.data["results"] as { ok: boolean }[]) : [];
    const skipped = results.filter(r => !r.ok).length;
    setMessage(res.ok ? `Confirmed ${String(res.data["applied"])} of Elena's recommendations${skipped ? `. ${skipped} were skipped because they changed or someone else decided them` : ""}.` : String(res.data["error"] ?? "Failed."));
    setConfirm(false);
    onDone();
  }
  return (
    <div className="elena-bar">
      <label><input type="checkbox" checked={filterOn} onChange={e => { setFilterOn(e.target.checked); setConfirm(false); }} /> Show only what Elena recommends approving</label>
      {filterOn && ready.length > 0 && (<>
        <label><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
          I looked at these {ready.length} high-confidence item{ready.length === 1 ? "" : "s"} and agree. Approve them now. Each is logged under my name with Elena&apos;s rule.</label>
        <div className="actions"><button type="button" disabled={!confirm} onClick={() => void run()}>Approve {ready.length} high-confidence item{ready.length === 1 ? "" : "s"}</button></div>
      </>)}
      {filterOn && ready.length === 0 && <p className="muted">Nothing here is both recommended for approval and high confidence.</p>}
    </div>
  );
}
