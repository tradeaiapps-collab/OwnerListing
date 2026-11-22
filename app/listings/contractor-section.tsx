"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { JSON_HEADERS } from "./ui";

type Assignment = { id: string; kind: string; status: string; counterpartName: string };
type Doc = { kind: string; status: string };

const ROLES = [
  { kind: "photographer", title: "Photographer", gives: "Professional photos, floor plan or video" },
  { kind: "inspector", title: "Building inspector", gives: "Building inspection and pest reports" }
] as const;
const STATUS: Record<string, string> = { proposed: "Waiting for them to accept", approved: "Accepted, work in progress", completed: "Delivered", cancelled: "Declined or cancelled" };

/**
 * "Photographer and building inspection": where the owner orders the photographer and the building inspector for this draft.
 * The invited person adds their photos and reports to the listing themselves. Nothing here publishes anything.
 */
export function ContractorSection({ listingId, onChange }: { listingId: string; onChange?: () => void }) {
  const [items, setItems] = useState<Assignment[] | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [open, setOpen] = useState<string>("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/listings/${listingId}/assignments`);
      if (r.ok) setItems((await r.json()).assignments);
      else setError("Could not load your photographer and inspector.");
    } catch { setError("Could not load your photographer and inspector."); }
    try {
      const r = await fetch(`/api/listings/${listingId}/documents`);
      if (r.ok) setDocs((await r.json()).documents ?? []);
    } catch { /* counts are optional */ }
  }, [listingId]);
  const asked = useRef(false);
  const [auto, setAuto] = useState<{ kind: string; result: string; name?: string }[]>([]);
  useEffect(() => {
    void (async () => {
      await load();
      // Once per visit: ask nearby photographers and inspectors who opted in. Anyone already invited is skipped by the server.
      if (asked.current) return;
      asked.current = true;
      try {
        const r = await fetch(`/api/listings/${listingId}/assignments/auto`, { method: "POST" });
        if (r.ok) { setAuto((await r.json()).outcomes ?? []); await load(); onChange?.(); }
      } catch { /* the invite form below still works */ }
    })();
  }, [load, listingId, onChange]);

  async function invite(kind: string) {
    const value = contact.trim();
    if (!value) { setError("Enter their email address or user id."); return; }
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/listings/${listingId}/assignments`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(value.includes("@") ? { kind, email: value } : { kind, contractorUserId: value }) });
      const d = await r.json();
      if (r.ok) { setContact(""); setOpen(""); await load(); onChange?.(); }
      else setError(r.status === 401 ? "Sign in to invite someone." : d.error ?? "Could not send the invitation.");
    } catch { setError("Could not send the invitation."); } finally { setBusy(false); }
  }

  const count = (kinds: string[]) => docs.filter(d => d.status === "active" && kinds.includes(d.kind)).length;
  return (
    <section className="panel ctr" aria-labelledby="ctr-h">
      <h2 id="ctr-h">Photographer and building inspection</h2>
      <p className="muted">Elena asks a photographer and an inspector who work in your suburb. You can invite your own too. They add their photos and reports straight to this listing. They need an account and must accept first.</p>
      <ul className="ctr-list">
        {ROLES.map(role => {
          const mine = (items ?? []).filter(a => a.kind === role.kind && a.status !== "cancelled");
          const files = role.kind === "photographer" ? count(["photo", "photo_360", "video", "video_360", "floorplan"]) : count(["building_inspection", "pest_report"]);
          return (
            <li key={role.kind} className="ctr-row">
              <div className="ctr-main">
                <strong>{role.title}</strong>
                <span className="muted">{role.gives}</span>
                {items === null ? <span className="muted" role="status">Loading…</span> : mine.length === 0
                  ? <span className="muted">{auto.some(x => x.kind === role.kind && x.result === "none_nearby") ? "No one has signed up for your area yet. Invite someone you know." : "Not invited yet"}</span>
                  : mine.map(a => <span key={a.id}>{a.counterpartName}: {STATUS[a.status] ?? a.status}{auto.some(x => x.kind === role.kind && x.result === "invited") ? " (Elena asked them for you)" : ""}</span>)}
                {role.kind === "inspector" && files > 0 && <span>{files} report{files === 1 ? "" : "s"} attached</span>}
              </div>
              {items !== null && (open === role.kind
                ? <form className="ctr-form" onSubmit={e => { e.preventDefault(); void invite(role.kind); }}>
                    <label className="field"><span>Their email or user id</span><input value={contact} onChange={e => setContact(e.target.value)} maxLength={254} autoFocus /></label>
                    <span className="qs-nav"><button type="submit" disabled={busy}>{busy ? "Sending…" : "Send invitation"}</button><button type="button" className="secondary" onClick={() => { setOpen(""); setError(""); }}>Cancel</button></span>
                  </form>
                : <button type="button" className="secondary" onClick={() => { setOpen(role.kind); setError(""); }}>{mine.length === 0 ? `Invite a ${role.title.toLowerCase()}` : "Invite another"}</button>)}
            </li>
          );
        })}
      </ul>
      {error && <p role="alert">{error}</p>}
      <p className="muted"><a href={`/listings/${listingId}/assignments`}>Manage everyone on this listing</a>. Photos they add appear in your photo list above. Elena reads inspection reports on the approval screen.</p>
    </section>
  );
}
