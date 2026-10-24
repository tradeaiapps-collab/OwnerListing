"use client";
import { useCallback, useEffect, useState } from "react";
import { STAFF_ROLES } from "../../../src/domain/staff-invite";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";

interface Invite { id: string; email: string; role: string; createdAt: string | null; acceptedAt: string | null; revokedAt: string | null }
const label = (r: string) => r.replace("_", " ");
const when = (v: string | null) => (v ? new Date(v).toLocaleString() : "");

export default function StaffInvites() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("support");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/invites").catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    setInvites((await r.json()).invites);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function send(url: string, body: unknown, done?: () => void) {
    setMessage("");
    const r = await postStaff(url, body);
    if (r.ok) { done?.(); await load(); } else setMessage(String(r.data["error"] ?? "Could not save."));
  }

  const active = invites.filter(i => !i.revokedAt);
  return (
    <main>
      <h1>Staff access</h1>
      <p className="muted">Staff sign in with their own Google account. Only an email address invited here can sign in. Changes are logged, and earlier invites stay in the history. You cannot change your own access or remove the last admin.</p>
      <form className="stack" onSubmit={e => { e.preventDefault(); void send("/api/staff/invites", { email, role }, () => setEmail("")); }}>
        <label>Email address <input type="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} required /></label>
        <label>Role <select value={role} onChange={e => setRole(e.target.value)}>{STAFF_ROLES.map(r => <option key={r} value={r}>{label(r)}</option>)}</select></label>
        <button type="submit">Invite</button>
      </form>
      {message && <p role="alert">{message}</p>}
      <h2>Active</h2>
      {active.length === 0 ? <p className="empty">No active invites.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Email</th><th>Role</th><th>Invited</th><th>Signed in</th><th></th></tr></thead>
          <tbody>{active.map(i => (
            <tr key={i.id}>
              <td>{i.email}</td>
              <td><select aria-label={`Role for ${i.email}`} value={i.role} onChange={e => void send(`/api/staff/invites/${i.id}`, { action: "set_role", role: e.target.value })}>
                {STAFF_ROLES.map(r => <option key={r} value={r}>{label(r)}</option>)}</select></td>
              <td>{when(i.createdAt)}</td><td>{i.acceptedAt ? when(i.acceptedAt) : "not yet"}</td>
              <td><button type="button" onClick={() => void send(`/api/staff/invites/${i.id}`, { action: "revoke" })}>Revoke</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <h2>History</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Email</th><th>Role</th><th>Invited</th><th>Revoked</th></tr></thead>
        <tbody>{invites.filter(i => i.revokedAt).map(i => (
          <tr key={i.id}><td>{i.email}</td><td>{label(i.role)}</td><td>{when(i.createdAt)}</td><td>{when(i.revokedAt)}</td></tr>
        ))}</tbody>
      </table></div>
    </main>
  );
}
