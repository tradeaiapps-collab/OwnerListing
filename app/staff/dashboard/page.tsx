"use client";
import { useEffect, useState } from "react";
import { labelFor, type Overview } from "../../../src/domain/admin-dashboard";
import { sectionsFor, type StaffSection } from "../../../src/domain/staff-admin";
import { BarList, KpiTile } from "../charts";
import { SectionCards } from "../section-cards";
import { loadError } from "../staff-api";
import "../../styles/staff.css";

/** Admin dashboard: headline figures for the last 30 days and links to every staff screen this role can open. */
export default function AdminDashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [sections, setSections] = useState<StaffSection[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/staff/dashboard").then(async r => {
      if (!r.ok) { setError(loadError(r.status)); return; }
      setOverview((await r.json()).overview);
    }).catch(() => setError("Could not load."));
    void fetch("/api/staff/me").then(r => r.json()).then(b => { if (b.staff) setSections(sectionsFor(b.staff)); }).catch(() => undefined);
  }, []);

  return (
    <main className="admin-page">
      <h1>Admin dashboard</h1>
      {error && <p role="alert">{error}{error === "Sign in as staff." && <> <a href="/api/auth/google/start?as=staff">Sign in</a>.</>}</p>}
      {!overview && !error && <p className="muted">Loading…</p>}
      {overview && (
        <>
          <p className="muted">Last {overview.windowDays} days, compared with the {overview.windowDays} days before. You see only the figures your role allows.</p>
          <section className="kpis" aria-label="Headline figures">
            {overview.kpis.map(k => <KpiTile key={k.key} kpi={k} />)}
          </section>
          <div className="charts">
            {overview.listingsByStatus && (
              <BarList title="Listings by status" data={overview.listingsByStatus.map(r => ({ key: r.key, label: labelFor(r.key), value: r.count }))} />
            )}
            {overview.usersByType && (
              <BarList title="Accounts by type" data={overview.usersByType.map(r => ({ key: r.key, label: labelFor(r.key), value: r.count }))} />
            )}
          </div>
        </>
      )}
      {sections.length > 0 && (
        <>
          <h2>Staff screens</h2>
          <SectionCards sections={sections.filter(s => s.href !== "/staff/dashboard")} compact headingLevel={3} />
        </>
      )}
    </main>
  );
}
