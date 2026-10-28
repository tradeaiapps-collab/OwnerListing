"use client";

export type Who = { state: "loading" } | { state: "out" } | { state: "in"; role: string };

/** Reads the /api/staff/me answer: the role label when signed in, otherwise signed out. */
export function whoFromStaffMe(body: unknown): Who {
  const s = (body as { staff?: { roleLabel?: unknown; role?: unknown } | null } | null)?.staff;
  if (!s) return { state: "out" };
  const label = typeof s.roleLabel === "string" && s.roleLabel ? s.roleLabel : typeof s.role === "string" && s.role ? s.role : "Staff";
  return { state: "in", role: label };
}

const initials = (role: string) => role.split(/[\s_]+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase()).join("") || "S";

/** The signed-in staff member's card at the foot of the admin sidebar: role label and Sign out, or Sign in when signed out. Read only: routes still enforce access. */
export function AdminNavView({ who, onSignOut }: { who: Who; onSignOut?: () => void }) {
  return (
    <div className="admin-user" aria-label="Your staff account" role="group">
      {who.state === "loading" && <span className="admin-user-skeleton" aria-hidden="true" />}
      {who.state === "in" && (
        <>
          <span className="admin-avatar" aria-hidden="true">{initials(who.role)}</span>
          <span className="admin-user-text">
            <span className="admin-user-label">Signed in as</span>
            <span className="nav-role" aria-label={`Signed in as ${who.role}`}>{who.role}</span>
          </span>
          <button type="button" className="nav-signout" onClick={onSignOut} aria-label="Sign out" title="Sign out">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10" /></svg>
            <span className="admin-signout-text">Sign out</span>
          </button>
        </>
      )}
      {who.state === "out" && <a className="button admin-signin" href="/api/auth/google/start?as=staff">Sign in</a>}
    </div>
  );
}
