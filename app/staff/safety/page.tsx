"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";

interface Flag {
  id: string; enquiryId: string; listingId: string; risk: string; body: string; createdAt: string;
  flags: { category: string; explanation: string; match: string }[];
}

/** Buyer messages the safety filter sent for a person to check. Staff confirm or dismiss each one; the message itself never changes. */
export default function StaffSafety() {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/safety-flags").catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    setFlags((await r.json()).flags); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function review(id: string, outcome: "confirmed" | "dismissed") {
    setMessage("");
    const note = notes[id]?.trim();
    const res = await postStaff(`/api/staff/safety-flags/${id}`, note ? { outcome, note } : { outcome });
    setMessage(res.ok ? "Recorded." : String(res.data["error"] ?? "Failed."));
    await load();
  }

  return (
    <main>
      <h1>Message safety review</h1>
      <p><a href="/staff">Back to staff</a></p>
      <p className="muted">High-risk buyer messages (possible scams, payment redirection, AI manipulation) and any mention of discrimination. Confirming tells the seller not to continue with the request.</p>
      {message && <p role="alert">{message}</p>}
      {loaded && flags.length === 0 && <p className="empty">Nothing to review.</p>}
      <ul className="card-list">
        {flags.map(f => (
          <li key={f.id} className="card">
            <h2>{f.risk} risk · {f.flags.map(x => x.category.replace(/_/g, " ")).join(", ")}</h2>
            <blockquote style={{ whiteSpace: "pre-wrap" }}>{f.body}</blockquote>
            <ul>{f.flags.map(x => <li key={x.category}>{x.explanation}{x.match ? ` (matched "${x.match}")` : ""}</li>)}</ul>
            <p className="muted">Flagged {new Date(f.createdAt).toLocaleString("en-AU")} · listing {f.listingId}</p>
            <label>Note (optional)
              <textarea className="staff-reason" maxLength={500} value={notes[f.id] ?? ""} onChange={e => setNotes({ ...notes, [f.id]: e.target.value })} />
            </label>
            <div className="actions">
              <button type="button" onClick={() => void review(f.id, "confirmed")}>Confirm problem</button>
              <button type="button" className="secondary" onClick={() => void review(f.id, "dismissed")}>Dismiss</button>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
