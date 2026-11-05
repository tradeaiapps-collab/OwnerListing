"use client";
import { useCallback, useEffect, useState } from "react";
import type { AgentPermission } from "../../../src/domain/access";
import { JSON_HEADERS } from "../../listings/ui";
import { PermissionList } from "../permission-picker";
import "../../styles/enquiries.css";

type Item = { kind: "invite" | "appointment"; id: string; listingId: string; listingTitle: string; jurisdiction: string; ownerName: string; scope: string; licensed: boolean; granted: AgentPermission[] };

const SCOPE_LABELS: Record<string, string> = { enquiries_and_offers: "Enquiries and offers", full: "Full (can also publish)" };

/** Agent screen: accept or decline owners' invitations, and see the listings you are appointed to. */
export default function AgentAppointments() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch("/api/agent/appointments");
      const d = await r.json().catch(() => ({}));
      if (r.ok) setItems(d.items ?? []);
      else setLoadError(r.status === 401 ? "Sign in to see your appointments." : d.error ?? "Could not load appointments.");
    } catch {
      setLoadError("Could not load appointments.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function act(inviteId: string, action: "accept" | "decline") {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/agent-invites/${inviteId}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) await load();
      else setError(d.error ?? "Could not update the invitation.");
    } catch {
      setError("Could not update the invitation.");
    } finally {
      setBusy(false);
    }
  }

  const invites = items?.filter(i => i.kind === "invite") ?? [];
  const live = items?.filter(i => i.kind === "appointment") ?? [];

  return (
    <main>
      <h1>Appointments</h1>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && items === null && <p className="muted" role="status">Loading…</p>}
      {items && (
        <>
          <h2>Invitations</h2>
          {invites.length === 0 && <p className="empty">No open invitations.</p>}
          <ul className="card-list">
            {invites.map(i => (
              <li key={i.id}>
                <strong>{i.listingTitle}</strong> <small className="muted">({i.jurisdiction}) from {i.ownerName}</small>
                <div>{SCOPE_LABELS[i.scope] ?? i.scope}</div>
                <PermissionList granted={i.granted} />
                {!i.licensed && <p className="muted">You need a verified licence for {i.jurisdiction} before you can accept.</p>}
                <div className="actions">
                  <button type="button" disabled={busy || !i.licensed} onClick={() => void act(i.id, "accept")}>Accept</button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void act(i.id, "decline")}>Decline</button>
                </div>
              </li>
            ))}
          </ul>
          <h2>Active appointments</h2>
          {live.length === 0 && <p className="empty">You have no active appointments.</p>}
          <ul className="card-list">
            {live.map(i => (
              <li key={i.id}>
                <a href={`/listings/${i.listingId}`}>{i.listingTitle}</a> <small className="muted">({i.jurisdiction}) for {i.ownerName} · {SCOPE_LABELS[i.scope] ?? i.scope}</small>
                <PermissionList granted={i.granted} />
                <div className="actions"><a className="button secondary" href={`/agent-appointments/${i.id}/messages`}>Messages with owner</a></div>
              </li>
            ))}
          </ul>
          <p><a href="/agent/listings">Enquiry inbox</a> · <a href="/agent/commissions">Commissions</a> · <a href="/agent/market-forecast">Market forecast</a> · <a href="/agent/profile">Your agent profile</a></p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
