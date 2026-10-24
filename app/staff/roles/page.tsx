"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PermissionInfo } from "../../../src/domain/staff-access";
import type { RoleDef } from "../../../src/domain/staff-roles";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";

interface Data {
  areas: { key: string; label: string }[];
  catalogue: PermissionInfo[];
  roles: RoleDef[];
  me: { role: string; permissions: string[]; canEditRoles: boolean };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(x => b.includes(x));

export default function StaffRoles() {
  const [data, setData] = useState<Data | null>(null);
  const [message, setMessage] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [focus, setFocus] = useState<string>("super_admin");
  const [form, setForm] = useState({ key: "", label: "", description: "", from: "" });

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/roles", { cache: "no-store" }).catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    setData(await r.json());
    setDrafts({});
  }, []);
  useEffect(() => { void load(); }, [load]);

  const permsOf = useCallback((r: RoleDef) => drafts[r.key] ?? [...r.permissions], [drafts]);
  const focused = data?.roles.find(r => r.key === focus) ?? data?.roles[0];

  const summary = useMemo(() => {
    if (!data || !focused) return [];
    const held = permsOf(focused);
    return data.areas
      .map(a => ({ area: a.label, items: data.catalogue.filter(p => p.area === a.key && held.includes(p.key)) }))
      .filter(g => g.items.length > 0);
  }, [data, focused, permsOf]);

  async function send(url: string, body: unknown, ok: string) {
    setMessage("");
    const r = await postStaff(url, body);
    setMessage(r.ok ? ok : String(r.data["error"] ?? "Could not save."));
    if (r.ok || r.status === 409) await load();
  }

  if (!data) return <main><h1>Roles and permissions</h1>{message ? <p role="alert">{message}</p> : <p className="muted">Loading…</p>}</main>;

  const { me } = data;
  const canEdit = (r: RoleDef) => me.canEditRoles && !r.isSystem && r.key !== me.role;
  const toggle = (r: RoleDef, p: string) => {
    const cur = permsOf(r);
    setDrafts({ ...drafts, [r.key]: cur.includes(p) ? cur.filter(x => x !== p) : [...cur, p] });
  };

  return (
    <main className="roles-page">
      <h1>Roles and permissions</h1>
      <p className="muted">
        Each role is a set of permissions; tick a box to add one. Built-in roles are fixed. Only a super admin can create or change custom roles,
        and nobody can grant a permission they do not hold. Changes apply to every staff member with that role on their next click.
        Trust account approvals and safety-gate overrides always need two different people, whatever the role. Every change is logged.
      </p>
      <p><a href="/api/staff/roles/export">Download access review (CSV)</a> · <a href="/staff/invites">Staff access</a></p>
      {message && <p role="alert" className="staff-notice">{message}</p>}

      <div className="table-wrap roles-matrix">
        <table>
          <caption className="muted">Permissions down, roles across. <span className="badge sensitive">Sensitive</span> permissions can only be granted by a super admin.</caption>
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {data.roles.map(r => (
                <th scope="col" key={r.key} className={r.disabled ? "role-disabled" : undefined}>
                  <button type="button" className="linklike" onClick={() => setFocus(r.key)} aria-pressed={focused?.key === r.key}>{r.label}</button>
                  <small>{r.isSystem ? "built-in" : `custom · v${r.version}`}{r.disabled ? " · disabled" : ""}</small>
                </th>
              ))}
            </tr>
          </thead>
          {data.areas.map(a => {
            const perms = data.catalogue.filter(p => p.area === a.key);
            if (perms.length === 0) return null;
            return (
              <tbody key={a.key}>
                <tr className="area-row"><th scope="rowgroup" colSpan={data.roles.length + 1}>{a.label}</th></tr>
                {perms.map(p => (
                  <tr key={p.key}>
                    <th scope="row">
                      <span className="perm-label">{p.label}</span>{p.sensitive && <span className="badge sensitive">Sensitive</span>}
                      <small className="muted perm-desc">{p.description}</small>
                    </th>
                    {data.roles.map(r => {
                      const on = permsOf(r).includes(p.key);
                      const editable = canEdit(r) && (on || me.permissions.includes(p.key));
                      return (
                        <td key={r.key} className="cell">
                          {r.isSystem
                            ? <span aria-label={on ? "Granted" : "Not granted"}>{on ? "✓" : "–"}</span>
                            : <input type="checkbox" checked={on} disabled={!editable} onChange={() => toggle(r, p.key)} aria-label={`${p.label} for ${r.label}`} />}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            );
          })}
          {me.canEditRoles && (
            <tfoot>
              <tr>
                <th scope="row">Save or disable</th>
                {data.roles.map(r => (
                  <td key={r.key} className="cell">
                    {canEdit(r) && (
                      <div className="stack-tight">
                        <button type="button" disabled={sameSet(permsOf(r), r.permissions)}
                          onClick={() => void send(`/api/staff/roles/${r.key}`, { action: "update", expectedVersion: r.version, label: r.label, description: r.description, permissions: permsOf(r) }, `Saved ${r.label}.`)}>Save</button>
                        <button type="button" onClick={() => void send(`/api/staff/roles/${r.key}`, { action: r.disabled ? "enable" : "disable", expectedVersion: r.version }, `${r.label} ${r.disabled ? "enabled" : "disabled"}.`)}>
                          {r.disabled ? "Enable" : "Disable"}</button>
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {focused && (
        <section aria-labelledby="summary-h" className="role-summary">
          <h2 id="summary-h">What can {focused.label} do?</h2>
          {focused.description && <p className="muted">{focused.description}</p>}
          {focused.disabled && <p className="staff-notice">This role is disabled: anyone holding it has no staff access until it is enabled again.</p>}
          {summary.length === 0 ? <p className="empty">No permissions. Staff with this role can sign in but see no staff screens.</p> : (
            <ul>
              {summary.map(g => (
                <li key={g.area}><strong>{g.area}:</strong> {g.items.map(i => i.label + (i.sensitive ? " (sensitive)" : "")).join(", ")}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {me.canEditRoles && (
        <section aria-labelledby="new-h">
          <h2 id="new-h">New custom role</h2>
          <form className="stack" onSubmit={e => {
            e.preventDefault();
            const from = data.roles.find(r => r.key === form.from);
            const start = from ? from.permissions.filter(p => me.permissions.includes(p)) : [];
            void send("/api/staff/roles", { key: `custom_${form.key}`, label: form.label, description: form.description, permissions: start }, `Created ${form.label}.`)
              .then(() => setForm({ key: "", label: "", description: "", from: "" }));
          }}>
            <label>Name <input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} maxLength={60} required /></label>
            <label>Key <span className="muted">custom_</span><input value={form.key} pattern="[a-z0-9_]{2,40}" title="2 to 40 lower-case letters, digits or underscores"
              onChange={e => setForm({ ...form, key: e.target.value.toLowerCase() })} required /></label>
            <label>Description <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} maxLength={300} /></label>
            <label>Start from <select value={form.from} onChange={e => setForm({ ...form, from: e.target.value })}>
              <option value="">No permissions</option>
              {data.roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select></label>
            <button type="submit">Create role</button>
          </form>
        </section>
      )}
    </main>
  );
}
