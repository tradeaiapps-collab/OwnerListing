"use client";
import { useEffect, useState } from "react";
import { sectionsFor, type StaffSection } from "../../src/domain/staff-admin";
import { AdminIcon } from "../admin-icons";
import { SectionCards } from "./section-cards";
import "../styles/staff.css";

const greeting = (h: number) => (h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");

export default function StaffHome() {
  const [sections, setSections] = useState<StaffSection[] | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [hello, setHello] = useState("Welcome");

  useEffect(() => {
    setHello(greeting(new Date().getHours()));
    void fetch("/api/staff/me").then(r => r.json()).then(b => {
      if (b.staff) { setRole(b.staff.roleLabel ?? b.staff.role); setSections(sectionsFor(b.staff)); } else setSections([]);
    }).catch(() => setSections([]));
  }, []);

  const has = (href: string) => sections?.some(s => s.href === href) ?? false;

  if (sections !== null && role === null) {
    return (
      <main className="staff-signin">
        <div className="staff-signin-card">
          <span className="staff-signin-mark" aria-hidden="true"><AdminIcon name="key" size={26} /></span>
          <p className="eyebrow">Admin console</p>
          <h1>Staff sign in</h1>
          <p className="muted">Sign in with your staff Google account. You see only the sections your role allows.</p>
          <p className="staff-signin-action"><a className="button" href="/api/auth/google/start?as=staff">Sign in as staff</a></p>
        </div>
      </main>
    );
  }

  return (
    <main className="staff-home">
      <section className="staff-hero" aria-labelledby="staff-hero-title">
        <p className="eyebrow">Admin console</p>
        <h1 id="staff-hero-title">{role ? `${hello}.` : "Staff"}</h1>
        {sections === null && <p className="muted">Loading…</p>}
        {role !== null && <p className="staff-hero-sub">Signed in as <strong>{role}</strong>. You see only the sections your role allows; changes to your role apply at once.</p>}
        {role !== null && (has("/staff/dashboard") || has("/staff/listings")) && (
          <div className="staff-hero-actions">
            {has("/staff/dashboard") && <a className="button" href="/staff/dashboard">Open dashboard</a>}
            {has("/staff/listings") && <a className="button secondary" href="/staff/listings">Review listings</a>}
          </div>
        )}
      </section>
      {role !== null && sections?.length === 0 && <p className="empty">Your role has no staff screens yet.</p>}
      {sections && sections.length > 0 && <SectionCards sections={sections} />}
    </main>
  );
}
