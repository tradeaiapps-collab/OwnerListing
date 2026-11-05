"use client";
import { useEffect, useState } from "react";
import { dashboardLinks, dashboardRole, type DashboardRole } from "../../src/domain/dashboard";
import type { JourneyStep } from "../../src/domain/journey";
import Breadcrumbs from "../breadcrumbs";
import "../styles/settings.css";
import "../styles/journey.css";
import "../styles/assistant.css";

interface Journey { steps: JourneyStep[]; next: JourneyStep | null; progress: { done: number; total: number } }

/** Next-step checklist plus task links for the signed-in type. Links only guide; every page and API still enforces access on the server. */
export default function Dashboard() {
  const [role, setRole] = useState<DashboardRole | null | "loading">("loading");
  const [journey, setJourney] = useState<Journey | null>(null);

  useEffect(() => {
    const get = (url: string) => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
    Promise.all([get("/api/auth/me"), get("/api/staff/me")]).then(([me, staff]) => {
      const r = dashboardRole(Boolean(staff?.staff), me?.user?.userType);
      setRole(r);
      if (r === "owner" || r === "agent" || r === "buyer") void get("/api/journey").then(j => setJourney(j && Array.isArray(j.steps) && j.steps.length > 0 ? j : null));
    });
  }, []);

  const crumbs = <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Dashboard" }]} />;
  if (role === "loading") return <main>{crumbs}<p className="muted" role="status">Loading…</p></main>;
  if (role === null) {
    return (
      <main>
        {crumbs}
        <h1>Dashboard</h1>
        <div className="empty-state">
          <p>Sign in to see your progress and your tasks.</p>
          <a className="button" href="/login?next=/dashboard">Sign in</a>
        </div>
      </main>
    );
  }
  const pct = journey && journey.progress.total > 0 ? Math.round((journey.progress.done / journey.progress.total) * 100) : 0;
  return (
    <main>
      {crumbs}
      <h1>Dashboard</h1>
      <p className="muted">Your tasks as {{ owner: "an owner", agent: "an agent", buyer: "a buyer", staff: "staff" }[role]}.</p>
      {journey && (
        <section className="jr" aria-labelledby="jr-title">
          <div className="jr-head">
            <h2 id="jr-title">{journey.next ? "Your next step" : "You're all set"}</h2>
            <span className="jr-count">{journey.progress.done} of {journey.progress.total} done</span>
          </div>
          <div className="jr-bar" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></div>
          {journey.next && (
            <div className="jr-next">
              <div><strong>{journey.next.label}</strong><span className="muted">{journey.next.hint}</span></div>
              <a className="button" href={journey.next.href}>{journey.next.label}</a>
            </div>
          )}
          <ol className="jr-steps">
            {journey.steps.map(s => (
              <li key={s.id} className={`jr-step jr-${s.status}`}>
                <span className="jr-dot" aria-hidden="true">{s.status === "done" ? "✓" : ""}</span>
                <span className="jr-label">
                  {s.status === "todo" ? <a href={s.href}>{s.label}</a> : s.label}
                  <span className="jr-state">{s.status === "done" ? "Done" : s.status === "unavailable" ? "Not available yet" : "To do"}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <h2 className="dash-h">Shortcuts</h2>
      <ul className="dash-grid">
        {dashboardLinks(role).map(l => (
          <li key={l.href}><a href={l.href}><strong>{l.label}</strong><span className="dash-text">{l.text}</span></a></li>
        ))}
      </ul>
    </main>
  );
}
