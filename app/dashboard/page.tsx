"use client";
import { useEffect, useState } from "react";
import { dashboardLinks, dashboardRole, type DashboardRole } from "../../src/domain/dashboard";
import "../styles/settings.css";

/** Task links for the signed-in type. Links only guide; every page and API still enforces access on the server. */
export default function Dashboard() {
  const [role, setRole] = useState<DashboardRole | null | "loading">("loading");

  useEffect(() => {
    const get = (url: string) => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
    Promise.all([get("/api/auth/me"), get("/api/staff/me")]).then(([me, staff]) => setRole(dashboardRole(Boolean(staff?.staff), me?.user?.userType)));
  }, []);

  if (role === "loading") return <main><p className="muted" role="status">Loading…</p></main>;
  if (role === null) {
    return (
      <main>
        <h1>Dashboard</h1>
        <p role="alert"><a href="/api/auth/google/start?next=/dashboard">Sign in</a> to see your tasks.</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Dashboard</h1>
      <p className="muted">Your tasks as {{ owner: "an owner", agent: "an agent", buyer: "a buyer", staff: "staff" }[role]}.</p>
      <ul className="dash-grid">
        {dashboardLinks(role).map(l => (
          <li key={l.href}><a href={l.href}><strong>{l.label}</strong><span className="dash-text">{l.text}</span></a></li>
        ))}
      </ul>
    </main>
  );
}
