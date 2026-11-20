"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";

interface State { status: string; badge: boolean; insuranceExpired: boolean; licenceExpired: boolean; insuranceExpiringInDays: number | null; licenceExpiringInDays: number | null }
interface Verification {
  userId: string; name: string; businessName: string; abn: string; licenceNumber: string | null; licenceAuthority: string | null; licenceExpiry: string | null;
  insurer: string; policyNumber: string; insuranceExpiry: string; status: string; reviewNote: string | null; submittedAt: string; state: State;
}
interface Report {
  id: string; kind: string; detail: string; status: string; createdAt: string; decisionNote: string | null; contractorId: string; contractorName: string; reporterName: string;
  listingTitle: string; contractorSuspended: boolean; reportsAgainst: number;
}
const KINDS: Record<string, string> = { no_show: "Did not turn up", poor_work: "Poor work", unsafe: "Unsafe or inappropriate behaviour", other: "Something else" };
type Tab = "verifications" | "reports";

/** Staff check what contractors supplied (nothing is looked up automatically), review owner reports, and suspend or reinstate contractors. */
export default function StaffContractors() {
  const [tab, setTab] = useState<Tab>("verifications");
  const [showAll, setShowAll] = useState(false);
  const [showDecided, setShowDecided] = useState(false);
  const [vs, setVs] = useState<Verification[]>([]);
  const [rs, setRs] = useState<Report[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setMessage("");
    const url = tab === "verifications" ? `/api/staff/contractors/verifications?view=${showAll ? "all" : "pending"}` : `/api/staff/contractors/reports?view=${showDecided ? "decided" : "open"}`;
    const r = await fetch(url).catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); setLoaded(true); return; }
    const d = await r.json();
    if (tab === "verifications") setVs(d.verifications); else setRs(d.reports);
    setLoaded(true);
  }, [tab, showAll, showDecided]);
  useEffect(() => { setLoaded(false); void load(); }, [load]);

  async function post(url: string, body: Record<string, unknown>) {
    const res = await postStaff(url, body);
    setMessage(res.ok ? "Recorded." : String(res.data["error"] ?? "Failed."));
    await load();
  }
  const note = (id: string) => notes[id]?.trim() ?? "";
  const noteBox = (id: string, label: string) => (
    <label>{label}
      <textarea className="staff-reason" maxLength={500} value={notes[id] ?? ""} onChange={e => setNotes({ ...notes, [id]: e.target.value })} />
    </label>
  );

  return (
    <main>
      <h1>Contractor trust</h1>
      <p><a href="/staff">Back to staff</a></p>
      <div className="actions" role="group" aria-label="Section">
        <button type="button" aria-pressed={tab === "verifications"} className={tab === "verifications" ? undefined : "secondary"} onClick={() => setTab("verifications")}>Verification</button>
        <button type="button" aria-pressed={tab === "reports"} className={tab === "reports" ? undefined : "secondary"} onClick={() => setTab("reports")}>Owner reports</button>
      </div>
      {message && <p role="alert">{message}</p>}

      {tab === "verifications" && (<>
        <p className="muted">Compare the details below with the contractor&apos;s real licence, insurance certificate and the ABN register. Nothing is checked automatically; only the ABN format was validated. Insurance that has expired removes the badge by itself.</p>
        <label><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Include decided (to find expiring or expired insurance)</label>
        {loaded && vs.length === 0 && <p className="empty">{showAll ? "No contractor has submitted details." : "Nothing waiting for a check."}</p>}
        <ul className="card-list">
          {vs.map(v => (
            <li key={v.userId} className="card">
              <h2>{v.businessName} <span className="badge">{v.status}</span>{v.state.badge && <span className="badge"> badge on</span>}</h2>
              <p><strong>{v.name}</strong> · ABN {v.abn} · submitted {new Date(v.submittedAt).toLocaleDateString("en-AU")}</p>
              <p>Insurance: {v.insurer}, policy {v.policyNumber}, expires {v.insuranceExpiry}
                {v.state.insuranceExpired ? " (EXPIRED)" : v.state.insuranceExpiringInDays !== null && v.state.insuranceExpiringInDays <= 30 ? ` (in ${v.state.insuranceExpiringInDays} days)` : ""}</p>
              <p>{v.licenceNumber ? `Licence: ${v.licenceNumber}, issued by ${v.licenceAuthority}, expires ${v.licenceExpiry}${v.state.licenceExpired ? " (EXPIRED)" : ""}` : "No licence given."}</p>
              {v.reviewNote && <p className="muted">Last note: {v.reviewNote}</p>}
              {v.status === "pending" && (<>
                {noteBox(v.userId, "Note to the contractor (needed to reject)")}
                <div className="actions">
                  <button type="button" onClick={() => void post(`/api/staff/contractors/verifications/${v.userId}`, { action: "verify", ...(note(v.userId) ? { note: note(v.userId) } : {}) })}>Verify</button>
                  <button type="button" className="secondary" disabled={!note(v.userId)} onClick={() => void post(`/api/staff/contractors/verifications/${v.userId}`, { action: "reject", note: note(v.userId) })}>Reject</button>
                </div>
              </>)}
            </li>
          ))}
        </ul>
      </>)}

      {tab === "reports" && (<>
        <p className="muted">Reports from owners about a contractor on their job. Uphold, or uphold and suspend (a suspended contractor cannot be invited, accept jobs or be matched). A decision needs a note.</p>
        <label><input type="checkbox" checked={showDecided} onChange={e => setShowDecided(e.target.checked)} /> Show decided reports</label>
        {loaded && rs.length === 0 && <p className="empty">{showDecided ? "No decided reports yet." : "No open reports."}</p>}
        <ul className="card-list">
          {rs.map(r => (
            <li key={r.id} className="card">
              <h2>{KINDS[r.kind] ?? r.kind} <span className="badge">{r.status}</span>{r.contractorSuspended && <span className="badge"> suspended</span>}</h2>
              <p><strong>{r.contractorName}</strong> · {r.reportsAgainst} report{r.reportsAgainst === 1 ? "" : "s"} not dismissed · job at {r.listingTitle} · reported by {r.reporterName}</p>
              <blockquote style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.detail}</blockquote>
              <p className="muted">{new Date(r.createdAt).toLocaleString("en-AU")}{r.decisionNote ? ` · Decision: ${r.decisionNote}` : ""}</p>
              {r.status === "open" && (<>
                {noteBox(r.id, "Decision note")}
                <div className="actions">
                  <button type="button" className="secondary" disabled={!note(r.id)} onClick={() => void post(`/api/staff/contractors/reports/${r.id}`, { action: "dismiss", note: note(r.id) })}>Dismiss</button>
                  <button type="button" disabled={!note(r.id)} onClick={() => void post(`/api/staff/contractors/reports/${r.id}`, { action: "uphold", note: note(r.id) })}>Uphold</button>
                  {!r.contractorSuspended && <button type="button" disabled={!note(r.id)} onClick={() => void post(`/api/staff/contractors/reports/${r.id}`, { action: "uphold_and_suspend", note: note(r.id) })}>Uphold and suspend</button>}
                </div>
              </>)}
              {r.contractorSuspended && (
                <div className="actions">
                  {r.status !== "open" && noteBox(`s-${r.id}`, "Reason to reinstate")}
                  <button type="button" className="secondary" disabled={!note(r.status === "open" ? r.id : `s-${r.id}`)} onClick={() => void post(`/api/staff/contractors/${r.contractorId}/standing`, { action: "reinstate", note: note(r.status === "open" ? r.id : `s-${r.id}`) })}>Reinstate contractor</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </>)}
    </main>
  );
}
