"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../../staff-api";
import "../../../styles/staff.css";

interface Row {
  id: string; listingId: string; listingTitle: string; jurisdiction: string; transactionType: string; useClass: string; propertyType: string;
  key: string; item: { label: string; description: string; legalRef: string } | null; notApplicable: boolean; ownerNote: string | null;
  evidenceDocumentId: string | null; evidenceKind: string | null; submittedAt: string;
}

/** Compliance queue: check each owner's evidence (or "not applicable" claim) and verify or reject it with a reason. */
export default function StaffDisclosureReviews() {
  const [queue, setQueue] = useState<Row[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/disclosure-reviews").catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    setQueue((await r.json()).queue); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function decide(id: string, decision: "verify" | "reject") {
    setMessage("");
    const res = await postStaff(`/api/staff/disclosure-reviews/${id}`, { decision, reason: reasons[id] ?? "" });
    setMessage(res.ok ? (decision === "verify" ? "Verified." : "Rejected. The owner sees your reason.") : String(res.data["error"] ?? "Failed."));
    if (res.ok) await load();
  }

  return (
    <main>
      <h1>Disclosure evidence review</h1>
      <p><a href="/staff">Back to staff</a> · <a href="/staff/disclosures">Requirements</a></p>
      {message && <p role="alert">{message}</p>}
      {loaded && queue.length === 0 && <p className="empty">Nothing is waiting.</p>}
      <ul className="card-list">
        {queue.map(q => (
          <li key={q.id} className="card">
            <h2>{q.item?.label ?? q.key} <span className="muted">· {q.listingTitle}</span></h2>
            <p className="muted">{q.jurisdiction} {q.transactionType} ({q.useClass}, {q.propertyType}) · sent {new Date(q.submittedAt).toLocaleString("en-AU")}</p>
            {q.item && <p>{q.item.description} <small className="muted">{q.item.legalRef}</small></p>}
            {q.notApplicable
              ? <p className="staff-notice">Owner says this does not apply: &ldquo;{q.ownerNote}&rdquo;</p>
              : <p>Evidence: <a href={`/api/staff/disclosure-reviews/${q.id}/evidence`}>download {q.evidenceKind?.replace(/_/g, " ") ?? "file"}</a> (logged)</p>}
            <form className="stack" onSubmit={e => e.preventDefault()}>
              <label>Reason (required, at least 10 characters; the owner sees it if you reject)
                <textarea className="staff-reason" value={reasons[q.id] ?? ""} onChange={e => setReasons({ ...reasons, [q.id]: e.target.value })} />
              </label>
              <div className="actions">
                <button type="button" onClick={() => void decide(q.id, "verify")}>Verify</button>
                <button type="button" className="secondary" onClick={() => void decide(q.id, "reject")}>Reject</button>
              </div>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
