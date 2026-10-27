"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS } from "../../ui";

type Active = { id: string; agentName: string; scope: string; appointedAt: string; licensed: boolean };
type Invite = { id: string; agentName: string; scope: string; createdAt: string; licensed: boolean };
type View = { active: Active | null; invites: Invite[] };

const SCOPE_LABELS: Record<string, string> = {
  enquiries_and_offers: "Enquiries and offers",
  full: "Full (can also publish)"
};

/** Owner screen: appoint one agent to this listing, see open invitations, and revoke the agent at any time. */
export default function ListingAgent() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [contact, setContact] = useState("");
  const [scope, setScope] = useState("enquiries_and_offers");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch(`/api/listings/${id}/agent-appointments`);
      const d = await r.json();
      if (r.ok) setView(d);
      else setLoadError(r.status === 401 ? "Sign in to manage this listing's agent." : r.status === 404 ? "Listing not found." : d.error ?? "Could not load the agent.");
    } catch {
      setLoadError("Could not load the agent.");
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function send(url: string, body: unknown, fallback: string): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json();
      if (r.ok) { await load(); return true; }
      setError(d.error ?? fallback);
    } catch {
      setError(fallback);
    } finally {
      setBusy(false);
    }
    return false;
  }

  async function onInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = contact.trim();
    const body = value.includes("@") ? { email: value, scope } : { agentUserId: value, scope };
    if (await send(`/api/listings/${id}/agent-appointments`, body, "Could not send the invitation.")) setContact("");
  }

  return (
    <main>
      <h1>Your agent</h1>
      <p className="muted">An agent can answer enquiries and review offers for you. Only you can accept an offer. You can revoke the agent at any time.</p>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && view === null && <p className="muted" role="status">Loading…</p>}
      {view?.active && (
        <section className="card">
          <h2>{view.active.agentName}</h2>
          <p>{SCOPE_LABELS[view.active.scope] ?? view.active.scope}{view.active.licensed ? "" : " · Blocked: no verified licence for this state"}</p>
          <div className="actions">
            <a className="button" href={`/agent-appointments/${view.active.id}/messages`}>Messages</a>
            <button type="button" className="secondary" disabled={busy}
              onClick={() => void send(`/api/agent-appointments/${view.active!.id}`, { action: "revoke" }, "Could not revoke the agent.")}>Revoke agent</button>
          </div>
        </section>
      )}
      {view && view.invites.length > 0 && (
        <>
          <h2>Waiting for the agent to accept</h2>
          <ul className="card-list">
            {view.invites.map(i => (
              <li key={i.id}>
                <strong>{i.agentName}</strong> · {SCOPE_LABELS[i.scope] ?? i.scope}{i.licensed ? "" : " · Blocked: no verified licence for this state"}
                <div className="actions">
                  <button type="button" className="secondary" disabled={busy}
                    onClick={() => void send(`/api/agent-invites/${i.id}`, { action: "withdraw" }, "Could not withdraw the invitation.")}>Withdraw</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {view && !view.active && (
        <form className="stack" onSubmit={onInvite}>
          <h2>Appoint an agent</h2>
          <label>Agent's email or user id
            <input value={contact} onChange={e => setContact(e.target.value)} required maxLength={254} />
          </label>
          <label>What they can do
            <select value={scope} onChange={e => setScope(e.target.value)}>
              <option value="enquiries_and_offers">{SCOPE_LABELS["enquiries_and_offers"]}</option>
              <option value="full">{SCOPE_LABELS["full"]}</option>
            </select>
          </label>
          <button type="submit" disabled={busy}>{busy ? "Working…" : "Send invitation"}</button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
