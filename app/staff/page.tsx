"use client";
import { useEffect, useState } from "react";
import { sectionsFor, type StaffSection } from "../../src/domain/staff-admin";
import type { StaffRole } from "../../src/domain/staff-access";
import "../styles/staff.css";

export default function StaffHome() {
  const [sections, setSections] = useState<StaffSection[] | null>(null);
  const [role, setRole] = useState<StaffRole | null>(null);

  useEffect(() => {
    void fetch("/api/staff/me").then(r => r.json()).then(b => {
      if (b.staff) { setRole(b.staff.role); setSections(sectionsFor(b.staff)); } else setSections([]);
    }).catch(() => setSections([]));
  }, []);

  return (
    <main>
      <h1>Staff</h1>
      {sections === null && <p className="muted">Loading…</p>}
      {sections !== null && role === null && <p role="alert">Sign in as staff.</p>}
      {role !== null && <p className="muted">Signed in as {role.replace("_", " ")}. You see only the sections your role allows.</p>}
      {role !== null && sections?.length === 0 && <p className="empty">Your role has no staff screens yet.</p>}
      <nav className="staff-links" aria-label="Staff sections">
        {sections?.map(s => <a key={s.href} href={s.href}>{s.label}</a>)}
      </nav>
    </main>
  );
}
