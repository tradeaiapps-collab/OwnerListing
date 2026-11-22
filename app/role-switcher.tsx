"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ROLE_LABEL, USER_ROLES, type UserRole } from "../src/domain/roles";
import { JSON_HEADERS } from "./listings/ui";

export interface RoleInfo { roles: UserRole[]; currentRole: UserRole | null }

export async function loadRoles(): Promise<RoleInfo | null> {
  const r = await fetch("/api/auth/roles").catch(() => null);
  return r && r.ok ? ((await r.json()) as RoleInfo) : null;
}

/** Switches the session to a held role, then sends the person to that role's dashboard (the page they were on may not belong to the new role). */
export async function switchRole(role: UserRole): Promise<boolean> {
  const r = await fetch("/api/auth/roles/switch", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ role }) }).catch(() => null);
  if (!r || !r.ok) return false;
  const { next } = (await r.json()) as { next: string };
  window.location.assign(next);
  return true;
}

/** Header menu: shows the role being viewed and lists the account's other roles. Hiding it is cosmetic; the server checks every switch. */
export default function RoleSwitcher() {
  const [info, setInfo] = useState<RoleInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<UserRole | null>(null);
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { void loadRoles().then(setInfo); }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onPointer = (e: Event) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onPointer); };
  }, [open]);
  const pick = useCallback(async (role: UserRole) => {
    setBusy(role); setErr("");
    if (!(await switchRole(role))) { setBusy(null); setErr("Could not switch. Try again."); }
  }, []);
  if (!info || !info.currentRole) return null;
  const cur = info.currentRole;
  return (
    <div className="role-switch" ref={box} data-role={cur}>
      <button type="button" className="role-switch-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="role-dot" aria-hidden="true" />
        <span className="role-switch-label"><span className="role-switch-hint">Viewing as</span> {ROLE_LABEL[cur]}</span>
        <span className="role-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="role-menu" role="menu" aria-label="Switch role">
          {USER_ROLES.filter(r => info.roles.includes(r)).map(r => (
            <button key={r} type="button" role="menuitemradio" aria-checked={r === cur} className="role-item" disabled={busy !== null} onClick={() => (r === cur ? setOpen(false) : void pick(r))}>
              <span className="role-dot" data-role={r} aria-hidden="true" />{ROLE_LABEL[r]}{r === cur ? <span className="role-current">Current</span> : null}
            </button>
          ))}
          <a className="role-item role-manage" role="menuitem" href="/settings/roles">Manage roles</a>
          {err && <p className="role-err" role="alert">{err}</p>}
        </div>
      )}
    </div>
  );
}
