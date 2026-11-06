"use client";
import { useEffect, useState } from "react";
import { ROLE_BLURB, ROLE_LABEL, USER_ROLES, type UserRole } from "../../../src/domain/roles";
import { JSON_HEADERS } from "../../listings/ui";
import { loadRoles, switchRole, type RoleInfo } from "../../role-switcher";
import Breadcrumbs from "../../breadcrumbs";
import "../../styles/settings.css";

/** Role management: every role on the account, which one is being viewed, and a way to add or switch. */
export default function Roles() {
  const [state, setState] = useState<"loading" | "out" | "ok">("loading");
  const [info, setInfo] = useState<RoleInfo>({ roles: [], currentRole: null });
  const [busy, setBusy] = useState<UserRole | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => { void loadRoles().then(i => { if (i) { setInfo(i); setState("ok"); } else setState("out"); }); }, []);

  const add = async (role: UserRole) => {
    setBusy(role); setMsg("");
    const r = await fetch("/api/auth/roles", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ role }) }).catch(() => null);
    setBusy(null);
    if (!r || !r.ok) return setMsg("Could not add that role. Try again.");
    setInfo(await loadRoles() ?? info);
    setMsg(`${ROLE_LABEL[role]} added. Your data stays as it is; only the screens change.`);
  };
  const go = async (role: UserRole) => { setBusy(role); setMsg(""); if (!(await switchRole(role))) { setBusy(null); setMsg("Could not switch. Try again."); } };

  const crumbs = <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Settings", href: "/settings" }, { label: "Roles" }]} />;
  if (state === "loading") return <main>{crumbs}<p className="muted" role="status">Loading…</p></main>;
  if (state === "out") return <main>{crumbs}<h1>Roles</h1><div className="empty-state"><p>Sign in to manage your roles.</p><a className="button" href="/login?next=/settings/roles">Sign in</a></div></main>;
  return (
    <main>
      {crumbs}
      <h1>Roles</h1>
      <p className="muted">One account, several roles. Switch to see the screens for that role; your listings, offers and messages stay with you.</p>
      {msg && <p className="muted" role="status">{msg}</p>}
      <ul className="role-cards">
        {USER_ROLES.map(r => {
          const held = info.roles.includes(r);
          const current = info.currentRole === r;
          return (
            <li key={r} className="role-card" data-role={r} {...(current ? { "aria-current": "true" } : {})}>
              <div className="role-card-text">
                <strong><span className="role-dot" data-role={r} aria-hidden="true" />{ROLE_LABEL[r]}{current ? <span className="role-current">Current</span> : null}</strong>
                <span className="muted">{ROLE_BLURB[r]}</span>
              </div>
              {current ? null : held
                ? <button type="button" className="button" disabled={busy !== null} onClick={() => void go(r)}>Switch to {ROLE_LABEL[r]}</button>
                : <button type="button" className="button secondary" disabled={busy !== null} onClick={() => void add(r)}>Add role</button>}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
