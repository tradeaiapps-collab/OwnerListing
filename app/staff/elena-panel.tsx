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

type Evidence = { abnRegister: boolean; insuranceCertificate: boolean; licenceRegister: boolean };
const NO_EVIDENCE: Evidence = { abnRegister: false, insuranceCertificate: false, licenceRegister: false };

/**
 * Off by default. When on, the list shows only items Elena would approve, and staff can confirm the high-confidence ones together.
 * Verification is stricter: Elena cannot see the ABN register or the certificates, so each contractor needs its own "I checked" ticks.
 */
export function ElenaBulkBar({ queue, items, filterOn, setFilterOn, onDone, setMessage }: {
  queue: "moderation" | "verification"; items: { id: string; elena: ElenaRec | null; label?: string; hasLicence?: boolean }[]; filterOn: boolean; setFilterOn: (v: boolean) => void;
  onDone: () => void; setMessage: (m: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [evidence, setEvidence] = useState<Record<string, Evidence>>({});
  const verification = queue === "verification";
  const candidates = items.filter(i => isBulkReady(i.elena)).slice(0, 25);
  const complete = (i: { id: string; hasLicence?: boolean }) => { const e = evidence[i.id]; return !!e && e.abnRegister && e.insuranceCertificate && (!i.hasLicence || e.licenceRegister); };
  const ready = verification ? candidates.filter(complete) : candidates;
  const tick = (id: string, k: keyof Evidence, v: boolean) => { setConfirm(false); setEvidence(cur => ({ ...cur, [id]: { ...(cur[id] ?? NO_EVIDENCE), [k]: v } })); };
  async function run() {
    setMessage("");
    const body: Record<string, unknown> = { queue, ids: ready.map(i => i.id), confirm: true };
    if (verification) body["evidence"] = Object.fromEntries(ready.map(i => [i.id, { abnRegister: true, insuranceCertificate: true, ...(i.hasLicence ? { licenceRegister: true } : {}) }]));
    const res = await postStaff("/api/staff/elena-prescreen/bulk", body);
    const results = Array.isArray(res.data["results"]) ? (res.data["results"] as { ok: boolean }[]) : [];
    const skipped = results.filter(r => !r.ok).length;
    setMessage(res.ok ? `Confirmed ${String(res.data["applied"])} of Elena's recommendations${skipped ? `. ${skipped} were skipped because they changed, someone else decided them or they need a closer look` : ""}.` : String(res.data["error"] ?? "Failed."));
    setConfirm(false); setEvidence({});
    onDone();
  }
  return (
    <div className="elena-bar">
      <label><input type="checkbox" checked={filterOn} onChange={e => { setFilterOn(e.target.checked); setConfirm(false); }} /> Show only what Elena recommends approving</label>
      {filterOn && verification && candidates.length > 0 && (
        <fieldset>
          <legend>For each contractor, tick what you checked yourself</legend>
          <p className="muted">Elena only compares the typed text. She cannot see the ABN register or the certificates, so bulk verifying needs your own check of each one.</p>
          <ul className="card-list">
            {candidates.map(i => (
              <li key={i.id}>
                <strong>{i.label ?? i.id}</strong>
                <label><input type="checkbox" checked={evidence[i.id]?.abnRegister ?? false} onChange={e => tick(i.id, "abnRegister", e.target.checked)} /> ABN checked on the ABN register</label>
                <label><input type="checkbox" checked={evidence[i.id]?.insuranceCertificate ?? false} onChange={e => tick(i.id, "insuranceCertificate", e.target.checked)} /> Insurance certificate of currency checked</label>
                {i.hasLicence && <label><input type="checkbox" checked={evidence[i.id]?.licenceRegister ?? false} onChange={e => tick(i.id, "licenceRegister", e.target.checked)} /> Licence checked with the issuing authority</label>}
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {filterOn && ready.length > 0 && (<>
        <label><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
          I looked at these {ready.length} high-confidence item{ready.length === 1 ? "" : "s"} and agree. Approve them now. Each is logged under my name with Elena&apos;s rule.</label>
        <div className="actions"><button type="button" disabled={!confirm} onClick={() => void run()}>Approve {ready.length} high-confidence item{ready.length === 1 ? "" : "s"}</button></div>
      </>)}
      {filterOn && candidates.length === 0 && <p className="muted">Nothing here is both recommended for approval and high confidence.</p>}
      {filterOn && verification && candidates.length > 0 && ready.length === 0 && <p className="muted">Tick what you checked for a contractor to include it.</p>}
    </div>
  );
}
