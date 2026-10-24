"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS } from "../../ui";

type Assignment = { id: string; kind: string; status: string; counterpartName: string };

const STATUS_LABELS: Record<string, string> = {
  proposed: "Waiting for the contractor",
  approved: "Accepted",
  completed: "Completed",
  cancelled: "Declined or cancelled"
};

export default function ListingAssignments() {
  const { id } = useParams<{ id: string }>();
  const [items, setItems] = useState<Assignment[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState("photographer");
  const [contact, setContact] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch(`/api/listings/${id}/assignments`);
      const d = await r.json();
      if (r.ok) setItems(d.assignments);
      else setLoadError(r.status === 401 ? "Sign in to see this listing's contractors." : r.status === 404 ? "Listing not found." : d.error ?? "Could not load contractors.");
    } catch {
      setLoadError("Could not load contractors.");
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function onInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const value = contact.trim();
    const body = value.includes("@") ? { kind, email: value } : { kind, contractorUserId: value };
    try {
      const r = await fetch(`/api/listings/${id}/assignments`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json();
      if (r.ok) {
        setContact("");
        await load();
      } else setError(r.status === 401 ? "Sign in to invite a contractor." : d.error ?? "Could not send the invitation.");
    } catch {
      setError("Could not send the invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function act(assignmentId: string, action: "cancel" | "complete") {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/assignments/${assignmentId}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action }) });
      const d = await r.json();
      if (r.ok) await load();
      else setError(d.error ?? "Could not update the job.");
    } catch {
      setError("Could not update the job.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Contractors</h1>
      <p className="muted">Invite someone who already has an account. They must accept before the job chat opens.</p>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && items === null && <p className="muted" role="status">Loading…</p>}
      {items && items.length === 0 && <p className="empty">No contractors invited yet.</p>}
      <ul className="card-list">
        {items?.map(a => (
          <li key={a.id}>
            <strong>{a.counterpartName}</strong> · {a.kind} · {STATUS_LABELS[a.status] ?? a.status}
            <div className="actions">
              {a.status === "approved" && <a className="button" href={`/jobs/${a.id}/chat`}>Open chat</a>}
              {a.status === "approved" && <button type="button" className="secondary" disabled={busy} onClick={() => void act(a.id, "complete")}>Mark completed</button>}
              {(a.status === "proposed" || a.status === "approved") && <button type="button" className="secondary" disabled={busy} onClick={() => void act(a.id, "cancel")}>Cancel</button>}
            </div>
          </li>
        ))}
      </ul>
      {items && (
        <form className="stack" onSubmit={onInvite}>
          <label>Role
            <select value={kind} onChange={e => setKind(e.target.value)}>
              <option value="photographer">Photographer</option>
              <option value="solicitor">Solicitor</option>
              <option value="inspector">Inspector</option>
              <option value="agent">Agent</option>
            </select>
          </label>
          <label>Contractor's email or user id
            <input value={contact} onChange={e => setContact(e.target.value)} required maxLength={254} />
          </label>
          <button type="submit" disabled={busy}>{busy ? "Working…" : "Send invitation"}</button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </main>
  );
}
