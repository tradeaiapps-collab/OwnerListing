"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";

interface Sub {
  id: string; userId: string; accountName: string; documentKind: string; documentCountry: string;
  expiryDate: string; submittedAt: string; approvals: number; selfieCapturedInApp: boolean;
  assignedTo: string | null; assignedAt: string | null; hasImages: boolean; hasBack: boolean;
}
const CLAIM_MS = 30 * 60 * 1000;
const TICKS = [
  ["documentLooksGenuine", "Document looks genuine"], ["photoMatchesSelfie", "Photo matches the selfie"],
  ["nameMatchesAccount", "Name matches the account"], ["notExpired", "Document is in date"]
] as const;
type Form = { ticks: Record<string, boolean>; status: string; reason: string };
const blank: Form = { ticks: {}, status: "", reason: "" };

export default function StaffIdReview() {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [me, setMe] = useState("");
  const [imagesAvailable, setImagesAvailable] = useState(false);
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/id-review").catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    const b = await r.json();
    setSubs(b.submissions); setMe(b.me); setImagesAvailable(b.imagesAvailable === true); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const form = (id: string) => forms[id] ?? blank;
  const patch = (id: string, p: Partial<Form>) => setForms({ ...forms, [id]: { ...form(id), ...p } });

  async function claim(s: Sub) {
    setMessage("");
    const res = await postStaff(`/api/staff/id-review/${s.id}/claim`, {});
    setMessage(res.ok ? "Claimed for 30 minutes. Open every image before approving." : String(res.data["error"] ?? "Failed."));
    await load();
  }

  async function decide(s: Sub, outcome: "approve" | "reject" | "needs_more") {
    setMessage("");
    const f = form(s.id);
    const res = await postStaff(`/api/staff/id-review/${s.id}/decision`, {
      outcome, reason: f.reason, checklist: { ...f.ticks, ...(f.status ? { officialStatusCheck: f.status } : {}) }
    });
    setMessage(res.ok ? "Done." : String(res.data["error"] ?? "Failed."));
    await load();
  }

  return (
    <main>
      <h1>Identity review</h1>
      <p><a href="/staff">Back to staff</a></p>
      {loaded && !imagesAvailable && <p className="staff-notice">Document images unavailable: image storage, the malware scanner or the image key is not configured, so approval is blocked. You can still reject or ask for more.</p>}
      {loaded && imagesAvailable && <p className="muted">Claim a check to see its images (30 minutes; every view is logged with your name). Do not copy, screenshot or download images. The selfie camera can be bypassed, so look for photos of screens or prints.</p>}
      {message && <p role="alert">{message}</p>}
      {loaded && subs.length === 0 && <p className="empty">No identity checks are waiting.</p>}
      <ul className="card-list">
        {subs.map(s => {
          const f = form(s.id);
          const own = s.userId === me;
          const mine = s.assignedTo === me && s.assignedAt !== null && Date.now() - Date.parse(s.assignedAt) < CLAIM_MS;
          const heldByOther = !mine && s.assignedTo !== null && s.assignedAt !== null && Date.now() - Date.parse(s.assignedAt) < CLAIM_MS;
          const parts = s.hasBack ? ["front", "back", "selfie"] : ["front", "selfie"];
          return (
            <li key={s.id} className="card">
              <h2>{s.accountName}</h2>
              <p>{s.documentKind.replace(/_/g, " ")} · {s.documentCountry.toUpperCase()} · expires {s.expiryDate} · {s.approvals} approval(s) so far</p>
              <p className="muted">{s.hasImages ? (mine ? "Claimed by you." : heldByOther ? "Another reviewer is working on this." : "Claim to view images.") : "No images."} Submitted {new Date(s.submittedAt).toLocaleString()}.</p>
              {imagesAvailable && s.hasImages && !own && !mine && !heldByOther && <button type="button" onClick={() => void claim(s)}>Claim and view images</button>}
              {imagesAvailable && mine && (
                <div className="staff-checks">
                  {parts.map(p => <figure key={p}><img src={`/api/staff/id-review/${s.id}/image/${p}`} alt={`ID ${p}`} referrerPolicy="no-referrer" draggable={false} /><figcaption>{p}</figcaption></figure>)}
                </div>
              )}
              {own ? <p className="staff-notice">This is your own identity check; another reviewer must review it.</p> : (
                <form className="stack" onSubmit={e => e.preventDefault()}>
                  <div className="staff-checks">
                    {TICKS.map(([k, label]) => (
                      <label key={k} className="check"><input type="checkbox" checked={f.ticks[k] === true} onChange={e => patch(s.id, { ticks: { ...f.ticks, [k]: e.target.checked } })} /> {label}</label>
                    ))}
                  </div>
                  <label>Licence status check (Australian driver licences)
                    <select value={f.status} onChange={e => patch(s.id, { status: e.target.value })}>
                      <option value="">Not recorded</option><option value="done">Done: licence is current</option>
                      <option value="not_available">Not available for this state</option><option value="failed">Failed</option>
                    </select>
                  </label>
                  <label>Reason (required, at least 10 characters)
                    <textarea className="staff-reason" value={f.reason} onChange={e => patch(s.id, { reason: e.target.value })} />
                  </label>
                  <div className="actions">
                    <button type="button" disabled={!imagesAvailable || !mine} onClick={() => void decide(s, "approve")}>Approve</button>
                    <button type="button" className="secondary" onClick={() => void decide(s, "needs_more")}>Needs more</button>
                    <button type="button" className="secondary" onClick={() => void decide(s, "reject")}>Reject</button>
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
