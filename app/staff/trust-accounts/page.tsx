"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";

interface Check {
  checkId: string; checkedAt: string; evidence: Record<string, unknown>; reasons: string[]; firmName: string; tier: string;
  jurisdiction: string; accountName: string; bsb: string; newOrChanged: boolean; approvals: { staffId: string; outcome: string }[];
  decision: string; checksToPerform: string[];
}
const EVIDENCE_LABELS: [string, string][] = [
  ["practisingCertificateCurrent", "Practising certificate current"], ["firmEmailVerified", "Firm confirmed by email"],
  ["accountNameMatches", "Account name matches"], ["bankLetterOnFile", "Bank letter on file"], ["callbackCompleted", "Phone call-back done"]
];
const show = (v: unknown) => (v === true ? "Yes" : v === false ? "No" : "Not available");

export default function StaffTrustAccounts() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [me, setMe] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/trust-accounts").catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    const b = await r.json();
    setChecks(b.checks); setMe(b.me); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function decide(id: string, outcome: "approve" | "reject") {
    setMessage("");
    const res = await postStaff(`/api/staff/trust-accounts/${id}/decision`, { outcome, reason: reasons[id] ?? "" });
    setMessage(res.ok ? (res.data["pendingSecondPerson"] ? "Your approval is recorded. A second person must approve." : "Done.") : String(res.data["error"] ?? "Failed."));
    await load();
  }

  return (
    <main>
      <h1>Trust account approvals</h1>
      <p><a href="/staff">Back to staff</a></p>
      {message && <p role="alert">{message}</p>}
      {loaded && checks.length === 0 && <p className="empty">No verification is waiting for a person.</p>}
      <ul className="card-list">
        {checks.map(c => {
          const decided = c.approvals.some(a => a.staffId === me);
          return (
            <li key={c.checkId} className="card">
              <h2>{c.firmName} <span className="muted">({c.tier}, {c.jurisdiction})</span></h2>
              <p>Account name: {c.accountName} · BSB {c.bsb}</p>
              <p className={c.newOrChanged ? "staff-notice" : "muted"}>{c.newOrChanged ? `New or changed details: two different people must approve (${c.approvals.filter(a => a.outcome === "approve").length} of 2 so far).` : "Details unchanged since a person last approved them."}</p>
              <ul className="plain-list">
                {EVIDENCE_LABELS.map(([k, label]) => <li key={k}>{label}: {show(c.evidence[k])}</li>)}
                {typeof c.evidence["automationError"] === "string" && <li>Automation error: {c.evidence["automationError"]}</li>}
              </ul>
              {c.reasons.map(r => <p key={r} className="muted">{r}</p>)}
              {c.checksToPerform.length > 0 && (
                <>
                  <h3>Checks to perform</h3>
                  <ul className="plain-list">{c.checksToPerform.map(t => <li key={t}>{t}</li>)}</ul>
                </>
              )}
              {c.decision !== "awaiting_human_approval" ? <p className="staff-notice">Cannot be approved yet. Complete the checks, then a new verification is run. Nothing publishes until a check is approved.</p> : decided ?<p className="muted">You have already decided on this check.</p> : (
                <form className="stack" onSubmit={e => e.preventDefault()}>
                  <label>Reason (required, at least 10 characters)
                    <textarea className="staff-reason" value={reasons[c.checkId] ?? ""} onChange={e => setReasons({ ...reasons, [c.checkId]: e.target.value })} />
                  </label>
                  <div className="actions">
                    <button type="button" onClick={() => void decide(c.checkId, "approve")}>Approve</button>
                    <button type="button" className="secondary" onClick={() => void decide(c.checkId, "reject")}>Reject</button>
                  </div>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
