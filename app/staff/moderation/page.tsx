"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";

interface Flag {
  id: string; enquiryId: string; listingId: string; severity: string; tone: string; body: string; createdAt: string; status: string; reviewNote?: string;
  senderName: string; senderFlags30d: number; trainingSuggested: boolean;
  flags: { category: string; severity: string; explanation: string; match: string }[];
}

/** Seller and agent messages Elena flagged (compliance, discrimination, off-platform promises, tone). Messages are never blocked or changed. */
export default function StaffModeration() {
  const [view, setView] = useState<"open" | "reviewed">("open");
  const [flags, setFlags] = useState<Flag[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const r = await fetch(`/api/staff/moderation?status=${view}`).catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    setFlags((await r.json()).flags); setLoaded(true);
  }, [view]);
  useEffect(() => { void load(); }, [load]);

  async function act(id: string, action: "approve" | "request_revision" | "educate") {
    setMessage("");
    const note = notes[id]?.trim();
    const res = await postStaff(`/api/staff/moderation/${id}`, note ? { action, note } : { action });
    setMessage(res.ok ? "Recorded." : String(res.data["error"] ?? "Failed."));
    await load();
  }

  return (
    <main>
      <h1>Message moderation</h1>
      <p><a href="/staff">Back to staff</a></p>
      <p className="muted">Messages from owners and agents that Elena flagged. Approve a message, ask the sender to revise, or send an educational note. Nothing is blocked or edited.</p>
      <div className="actions" role="group" aria-label="Show">
        <button type="button" aria-pressed={view === "open"} className={view === "open" ? undefined : "secondary"} onClick={() => setView("open")}>Open</button>
        <button type="button" aria-pressed={view === "reviewed"} className={view === "reviewed" ? undefined : "secondary"} onClick={() => setView("reviewed")}>Reviewed</button>
      </div>
      {message && <p role="alert">{message}</p>}
      {loaded && flags.length === 0 && <p className="empty">{view === "open" ? "Nothing to review." : "Nothing reviewed yet."}</p>}
      <ul className="card-list">
        {flags.map(f => (
          <li key={f.id} className="card">
            <h2>{f.severity} severity · {[...new Set(f.flags.map(x => x.category.replace(/_/g, " ")))].join(", ")}</h2>
            <p><strong>{f.senderName || "Unnamed sender"}</strong> · {f.senderFlags30d} flag{f.senderFlags30d === 1 ? "" : "s"} in 30 days{f.trainingSuggested ? " · compliance training suggested" : ""}</p>
            <blockquote style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{f.body}</blockquote>
            <ul>{f.flags.map(x => <li key={x.category}>{x.explanation}{x.match ? ` (matched "${x.match}")` : ""}</li>)}</ul>
            <p className="muted">Sent {new Date(f.createdAt).toLocaleString("en-AU")} · listing {f.listingId}{f.status !== "open" ? ` · ${f.status.replace(/_/g, " ")}${f.reviewNote ? `: ${f.reviewNote}` : ""}` : ""}</p>
            {f.status === "open" && (
              <>
                <label>Note to the sender (needed to request a revision or educate)
                  <textarea className="staff-reason" maxLength={500} value={notes[f.id] ?? ""} onChange={e => setNotes({ ...notes, [f.id]: e.target.value })} />
                </label>
                <div className="actions">
                  <button type="button" onClick={() => void act(f.id, "approve")}>Approve message</button>
                  <button type="button" className="secondary" onClick={() => void act(f.id, "request_revision")}>Request revision</button>
                  <button type="button" className="secondary" onClick={() => void act(f.id, "educate")}>Educate agent</button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
