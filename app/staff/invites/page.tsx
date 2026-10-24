"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import type { PermissionInfo } from "../../../src/domain/staff-access";
import type { RoleDef } from "../../../src/domain/staff-roles";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";

interface Invite { id: string; email: string; role: string; createdAt: string | null; acceptedAt: string | null; revokedAt: string | null }
interface Roles { areas: { key: string; label: string }[]; catalogue: PermissionInfo[]; roles: RoleDef[] }
const when = (v: string | null) => (v ? new Date(v).toLocaleString() : "");

export default function StaffInvites() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [roles, setRoles] = useState<Roles | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("support");
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const [r, rr] = await Promise.all([fetch("/api/staff/invites").catch(() => null), fetch("/api/staff/roles", { cache: "no-store" }).catch(() => null)]);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    setInvites((await r.json()).invites);
    if (rr?.ok) setRoles(await rr.json());
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function send(url: string, body: unknown, done?: () => void) {
    setMessage("");
    const r = await postStaff(url, body);
    if (r.ok) { done?.(); await load(); } else setMessage(String(r.data["error"] ?? "Could not save."));
  }

  const roleOf = (key: string) => roles?.roles.find(r => r.key === key);
  const label = (key: string) => roleOf(key)?.label ?? key;
  const assignable = (roles?.roles ?? []).filter(r => !r.disabled);
  const options = (current?: string) => {
    const list = assignable.some(r => r.key === current) || !current ? assignable : [...assignable, ...(roleOf(current) ? [roleOf(current)!] : [])];
    return list.map(r => <option key={r.key} value={r.key}>{r.label}{r.isSystem ? "" : " (custom)"}</option>);
  };
  function access(key: string) {
    const r = roleOf(key);
    if (!r || !roles) return <p className="muted">Unknown role: no access.</p>;
    if (r.disabled) return <p className="staff-notice">This role is disabled, so this person has no staff access.</p>;
    const groups = roles.areas.map(a => ({ a, items: roles.catalogue.filter(p => p.area === a.key && (r.permissions as readonly string[]).includes(p.key)) })).filter(g => g.items.length);
    return groups.length === 0 ? <p className="empty">No permissions.</p> : (
      <ul className="access-detail">{groups.map(g => <li key={g.a.key}><strong>{g.a.label}:</strong> {g.items.map(i => i.label + (i.sensitive ? " (sensitive)" : "")).join(", ")}</li>)}</ul>
    );
  }

  const active = invites.filter(i => !i.revokedAt);
  return (
    <main>
      <h1>Staff access</h1>
      <p className="muted">Staff sign in with their own Google account. Only an email address invited here can sign in. Changes are logged, and earlier invites stay in the history. You cannot change your own access, remove the last admin, or give access you do not hold yourself; roles with sensitive access can only be given by a super admin. Roles are defined in <a href="/staff/roles">Roles and permissions</a>.</p>
      <p><a href="/api/staff/roles/export">Download access review (CSV)</a></p>
      <form className="stack" onSubmit={e => { e.preventDefault(); void send("/api/staff/invites", { email, role }, () => setEmail("")); }}>
        <label>Email address <input type="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} required /></label>
        <label>Role <select value={role} onChange={e => setRole(e.target.value)}>{options()}</select></label>
        <button type="submit">Invite</button>
      </form>
      {message && <p role="alert">{message}</p>}
      <h2>Active</h2>
      {active.length === 0 ? <p className="empty">No active invites.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Email</th><th>Role</th><th>Access</th><th>Invited</th><th>Signed in</th><th></th></tr></thead>
          <tbody>{active.map(i => (
            <Fragment key={i.id}>
              <tr>
                <td>{i.email}</td>
                <td><select aria-label={`Role for ${i.email}`} value={i.role} onChange={e => void send(`/api/staff/invites/${i.id}`, { action: "set_role", role: e.target.value })}>
                  {options(i.role)}</select></td>
                <td><button type="button" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? null : i.id)}>View access</button></td>
                <td>{when(i.createdAt)}</td><td>{i.acceptedAt ? when(i.acceptedAt) : "not yet"}</td>
                <td><button type="button" onClick={() => void send(`/api/staff/invites/${i.id}`, { action: "revoke" })}>Revoke</button></td>
              </tr>
              {open === i.id && <tr><td colSpan={6}><strong>Effective access ({label(i.role)}):</strong>{access(i.role)}</td></tr>}
            </Fragment>
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
