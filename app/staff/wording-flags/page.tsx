"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";

interface Flag {
  id: string; listingId: string; listingTitle: string; listingStatus: string; jurisdiction: string; field: string; matchText: string;
  category: string; ruleId: string; status: string; attempts: number; firstRaisedAt: string; lastRaisedAt: string;
  reviewedAt: string | null; reviewReason: string | null; context: string;
}
const TABS = [["open", "Waiting"], ["cleared", "Cleared"], ["upheld", "Upheld"]] as const;
const label = (s: string) => s.replace(/_/g, " ");

/** The matched words highlighted inside the field's current text (first occurrence, case-insensitive). */
function InContext({ text, match }: { text: string; match: string }) {
  const i = text.toLowerCase().indexOf(match.toLowerCase());
  if (i < 0) return <p className="muted">The owner has since changed this text; the match is no longer in it.</p>;
  const from = Math.max(0, i - 160), to = Math.min(text.length, i + match.length + 160);
  return (
    <p className="wording-context">
      {from > 0 && "..."}{text.slice(from, i)}<mark>{text.slice(i, i + match.length)}</mark>{text.slice(i + match.length, to)}{to < text.length && "..."}
    </p>
  );
}

/**
 * Compliance review of wording the anti-discrimination filter blocked at publish. Clearing allows that exact match on that listing
 * (for example lawful seniors housing, or share accommodation in the owner's own home). Upholding keeps it blocked.
 */
export default function StaffWordingFlags() {
  const [status, setStatus] = useState<(typeof TABS)[number][0]>("open");
  const [flags, setFlags] = useState<Flag[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoaded(false);
    const r = await fetch(`/api/staff/wording-flags?status=${status}`).catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    setFlags((await r.json()).flags); setLoaded(true);
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  async function decide(id: string, decision: "clear" | "uphold") {
    setMessage("");
    const res = await postStaff(`/api/staff/wording-flags/${id}`, { decision, reason: reasons[id] ?? "" });
    setMessage(res.ok ? (decision === "clear" ? "Cleared. The owner can publish with this wording." : "Upheld. The wording stays blocked.") : String(res.data["error"] ?? "Failed."));
    if (res.ok) await load();
  }

  return (
    <main>
      <h1>Discriminatory wording review</h1>
      <p><a href="/staff">Back to staff</a></p>
      <p className="muted">
        These are matches the anti-discrimination filter blocked when an owner tried to publish. Clear one only when the wording is
        lawful in context (for example a registered over-55s community, or a room in the owner&apos;s own home), and say why.
      </p>
      <div className="actions" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={status === k} className={status === k ? "" : "secondary"} onClick={() => setStatus(k)}>{l}</button>
        ))}
      </div>
      {message && <p role="alert">{message}</p>}
      {loaded && flags.length === 0 && <p className="empty">Nothing here.</p>}
      <ul className="card-list">
        {flags.map(f => (
          <li key={f.id} className="card">
            <h2><q>{f.matchText}</q> <span className="muted">in the {f.field}</span></h2>
            <p>
              <span className="badge sensitive">{label(f.category)}</span>{" "}
              <a href={`/listings/${f.listingId}`}>{f.listingTitle}</a> <span className="muted">({f.jurisdiction}, {f.listingStatus}) · {f.attempts} publish attempt{f.attempts === 1 ? "" : "s"} · first {new Date(f.firstRaisedAt).toLocaleString("en-AU")}</span>
            </p>
            <InContext text={f.context} match={f.matchText} />
            {f.status === "open" ? (
              <form className="stack" onSubmit={e => e.preventDefault()}>
                <label>Reason (required, at least 10 characters)
                  <textarea className="staff-reason" value={reasons[f.id] ?? ""} onChange={e => setReasons({ ...reasons, [f.id]: e.target.value })} />
                </label>
                <div className="actions">
                  <button type="button" onClick={() => void decide(f.id, "uphold")}>Uphold (keep blocked)</button>
                  <button type="button" className="secondary" onClick={() => void decide(f.id, "clear")}>Clear as lawful</button>
                </div>
              </form>
            ) : (
              <p className="muted">{f.status === "cleared" ? "Cleared" : "Upheld"} {f.reviewedAt ? new Date(f.reviewedAt).toLocaleString("en-AU") : ""}: {f.reviewReason}</p>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
