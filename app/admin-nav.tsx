"use client";
import { useEffect, useState } from "react";

export type Who = { state: "loading" } | { state: "out" } | { state: "in"; role: string };

/** Reads the /api/staff/me answer: the role label when signed in, otherwise signed out. */
export function whoFromStaffMe(body: unknown): Who {
  const s = (body as { staff?: { roleLabel?: unknown; role?: unknown } | null } | null)?.staff;
  if (!s) return { state: "out" };
  const label = typeof s.roleLabel === "string" && s.roleLabel ? s.roleLabel : typeof s.role === "string" && s.role ? s.role : "Staff";
  return { state: "in", role: label };
}

/** Admin site header links. Shows the signed-in staff member's role label with a Sign out button, or "Sign in" when signed out. Read only: routes still enforce access. */
export default function AdminNav() {
  const [who, setWho] = useState<Who>({ state: "loading" });

  useEffect(() => {
    fetch("/api/staff/me").then(r => (r.ok ? r.json() : null)).catch(() => null).then(b => {
      setWho(whoFromStaffMe(b));
    });
  }, []);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    window.location.assign("/staff");
  };

  return <AdminNavView who={who} onSignOut={signOut} />;
}

export function AdminNavView({ who, onSignOut }: { who: Who; onSignOut?: () => void }) {
  return (
    <nav className="site-nav" aria-label="Admin">
      <a href="/staff">Staff home</a>
      {who.state === "in" && <span className="nav-role" aria-label={`Signed in as ${who.role}`}>{who.role}</span>}
      {who.state === "in" && <button type="button" className="nav-signout" onClick={onSignOut}>Sign out</button>}
      {who.state === "out" && <a href="/api/auth/google/start?as=staff">Sign in</a>}
    </nav>
  );
}
