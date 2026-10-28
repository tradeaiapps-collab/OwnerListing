"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { activeHref, adminLink, groupSections } from "../src/domain/admin-nav";
import { sectionsFor, type StaffSection } from "../src/domain/staff-admin";
import { AdminIcon } from "./admin-icons";
import { AdminNavView, whoFromStaffMe, type Who } from "./admin-nav";
import "./styles/admin-shell.css";

/** The admin console frame: grouped sidebar (a drawer below 1024px), top bar with breadcrumbs, and the page. */
export default function AdminShell({ brand, logo, siteHref, children }: { brand: string; logo: ReactNode; siteHref: string | null; children: ReactNode }) {
  const path = usePathname() ?? "/staff";
  const [who, setWho] = useState<Who>({ state: "loading" });
  const [sections, setSections] = useState<StaffSection[]>([]);
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    fetch("/api/staff/me").then(r => (r.ok ? r.json() : null)).catch(() => null).then(b => {
      setWho(whoFromStaffMe(b));
      const s = (b as { staff?: Parameters<typeof sectionsFor>[0] | null } | null)?.staff;
      setSections(s ? sectionsFor(s) : []);
    });
  }, []);

  const close = useCallback(() => { setOpen(false); toggleRef.current?.focus(); }, []);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    window.location.assign("/staff");
  };

  const groups = groupSections(sections);
  const current = activeHref(path, sections);
  const link = current ? adminLink(sections.find(s => s.href === current)!) : null;
  const group = link ? groups.find(g => g.key === link.group) : null;

  return (
    <div className="admin-shell" data-open={open || undefined}>
      <aside className="admin-side" id="admin-sidebar" aria-label="Admin">
        <div className="admin-side-head">
          <a className="admin-brand" href="/staff">
            <span className="admin-brand-mark" aria-hidden="true">{logo ?? brand.slice(0, 1)}</span>
            <span className="admin-brand-text"><span className="admin-brand-name">{brand}</span><span className="admin-brand-sub">Admin console</span></span>
          </a>
          <button type="button" className="admin-icon-btn admin-close" onClick={close} aria-label="Close menu"><AdminIcon name="close" /></button>
        </div>
        <nav className="admin-side-nav" aria-label="Admin sections">
          <a className="admin-link" href="/staff" aria-current={path === "/staff" ? "page" : undefined}><AdminIcon name="overview" /><span>Home</span></a>
          {who.state === "loading" && <div className="admin-side-skeleton" aria-hidden="true"><span /><span /><span /><span /></div>}
          {groups.map(g => (
            <div className="admin-group" key={g.key}>
              <p className="admin-group-label" id={`ag-${g.key}`}>{g.label}</p>
              <ul aria-labelledby={`ag-${g.key}`}>
                {g.links.map(l => (
                  <li key={l.href}>
                    <a className="admin-link" href={l.href} aria-current={current === l.href ? "page" : undefined}><AdminIcon name={l.icon} /><span>{l.label}</span></a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="admin-side-foot"><AdminNavView who={who} onSignOut={signOut} /></div>
      </aside>
      <div className="admin-scrim" onClick={close} aria-hidden="true" />
      <div className="admin-main">
        <header className="admin-topbar">
          <button ref={toggleRef} type="button" className="admin-icon-btn admin-menu" onClick={() => setOpen(true)} aria-label="Open menu" aria-controls="admin-sidebar" aria-expanded={open}><AdminIcon name="menu" /></button>
          <nav className="admin-crumbs" aria-label="Breadcrumb">
            <ol>
              <li><a href="/staff">Admin</a></li>
              {group && <li className="admin-crumb-group"><span>{group.label}</span></li>}
              {link && <li><span aria-current="page">{link.label}</span></li>}
            </ol>
          </nav>
          <div className="admin-topbar-end">
            <span className="admin-staff-only" role="note">Staff only</span>
            {siteHref && <a className="admin-site-link" href={siteHref} target="_blank" rel="noopener"><span>View website</span><AdminIcon name="external" size={16} /></a>}
          </div>
        </header>
        <div className="admin-content" id="main-content" tabIndex={-1}>{children}</div>
        <footer className="admin-foot"><p>© {new Date().getFullYear()} {brand}. Staff actions are recorded in the audit log.</p></footer>
      </div>
    </div>
  );
}
