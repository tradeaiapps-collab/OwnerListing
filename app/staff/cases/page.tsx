"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";

interface Case {
  id: string; kind: string; subjectId: string; reason: string; status: string; assignedTo: string | null;
  openedAt: string; resolutionReason: string | null; proposedBy: string | null; proposedReason: string | null;
}
const GATES = ["trust_account_verification", "licence_verification"];

export default function StaffCases() {
  const [cases, setCases] = useState<Case[]>([]);
  const [me, setMe] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/cases").catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    const b = await r.json();
    setCases(b.cases); setMe(b.me); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(id: string, action: "claim" | "resolve") {
    setMessage("");
    const res = await postStaff(`/api/staff/cases/${id}/${action}`, action === "resolve" ? { reason: reasons[id] ?? "" } : {});
    setMessage(res.ok ? (res.status === 202 ? "Recorded. A different authorised person must confirm." : "Done.") : String(res.data["error"] ?? "Failed."));
    await load();
  }

  return (
    <main>
      <h1>Admin cases</h1>
      <p><a href="/staff">Back to staff</a></p>
      {message && <p role="alert">{message}</p>}
      {loaded && cases.length === 0 && <p className="empty">No open cases.</p>}
      <ul className="card-list">
        {cases.map(c => (
          <li key={c.id} className="card">
            <h2>{c.kind.replace(/_/g, " ")}</h2>
            <p>{c.reason}</p>
            <p className="muted">{c.status.replace("_", " ")} · opened {new Date(c.openedAt).toLocaleString()}{c.assignedTo === me ? " · yours" : c.assignedTo ? " · claimed" : ""}</p>
            {c.proposedBy && <p className="staff-notice">Resolution proposed{c.proposedBy === me ? " by you" : ""}: {c.proposedReason}. A different authorised person must confirm.</p>}
            <div className="actions">
              {c.assignedTo === null && <button type="button" onClick={() => void act(c.id, "claim")}>Claim</button>}
              {c.kind !== "identity_verification" && <button type="button" className="secondary" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? "Cancel" : GATES.includes(c.kind) ? "Resolve (override)" : "Resolve"}</button>}
            </div>
            {c.kind === "identity_verification" && <p className="muted">Close this through the <a href="/staff/id-review">identity review queue</a>.</p>}
            {open === c.id && (
              <form className="stack" onSubmit={e => { e.preventDefault(); void act(c.id, "resolve"); }}>
                <label>Reason (required, at least 10 characters)
                  <textarea className="staff-reason" required minLength={10} value={reasons[c.id] ?? ""} onChange={e => setReasons({ ...reasons, [c.id]: e.target.value })} />
                </label>
                <button type="submit">{c.proposedBy && c.proposedBy !== me ? "Confirm resolution" : GATES.includes(c.kind) ? "Propose resolution" : "Resolve case"}</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
