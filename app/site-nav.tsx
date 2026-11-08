"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import RoleSwitcher, { loadRoles } from "./role-switcher";
import { roleNav } from "../src/domain/role-nav";
import type { UserRole } from "../src/domain/roles";
import ThemeToggle from "./theme-toggle";
import { NAV_CACHE_KEY, parseNavSnapshot, serializeNavSnapshot } from "../src/domain/nav-cache";
import { NAV_CATALOG, type IconStyle, type NavItem } from "../src/domain/site-theme";

type Who = "loading" | "out" | "staff" | "owner" | "buyer";

/**
 * Links follow the signed-in type. This only hides links; every route still enforces access on the server.
 * `items` is the admin's navigation setting (order, labels, hidden items); targets and icons come from the fixed catalogue.
 */
export default function SiteNav({ items, iconStyle, themeToggle }: { items?: NavItem[]; iconStyle?: IconStyle; themeToggle?: boolean }) {
  const [who, setWho] = useState<Who>("loading");
  const [invest, setInvest] = useState(false);
  const [role, setRole] = useState<UserRole | null>(null);
  // Phone menu. `ready` flips on after hydration, so without JavaScript every link stays visible (CSS only collapses when data-js is set).
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstRender = useRef(true);

  useEffect(() => setReady(true), []);

  // Draw the last known menu before the first paint; the checks below then confirm or correct it.
  useLayoutEffect(() => {
    try {
      const c = parseNavSnapshot(window.sessionStorage.getItem(NAV_CACHE_KEY));
      if (c && c.who !== "out") { setWho(c.who); setRole(c.role as UserRole | null); }
    } catch { /* storage blocked: the menu simply waits for the checks */ }
  }, []);
  const remember = (w: Who, r: UserRole | null) => {
    try {
      if (w === "loading") return;
      if (w === "out") window.sessionStorage.removeItem(NAV_CACHE_KEY);
      else window.sessionStorage.setItem(NAV_CACHE_KEY, serializeNavSnapshot({ who: w, role: r }));
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (open) navRef.current?.querySelector<HTMLElement>(".site-nav-links a, .site-nav-links button")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); toggleRef.current?.focus(); } };
    const onPointer = (e: Event) => { if (navRef.current && !navRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onPointer); };
  }, [open]);

  useEffect(() => {
    const get = (url: string) => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
    // 404 unless the investor module is live (both keys), so nothing about investing shows while it is off.
    void get("/api/investments/status").then(s => setInvest(s?.live === true));
    Promise.all([get("/api/auth/me"), get("/api/staff/me")]).then(([me, staff]) => {
      if (staff?.staff) { setWho("staff"); remember("staff", null); }
      else if (me?.mfaPending && window.location.pathname !== "/mfa") {
        // Signed in with Google but the second step is still to do: every API treats the session as signed out until then.
        window.location.assign(`/mfa?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      } else if (me?.user) {
        const w: Who = me.user.userType === "buyer" ? "buyer" : "owner";
        setWho(w);
        void loadRoles().then(r => {
          const cr = (r?.currentRole ?? (me.user.userType === "buyer" ? "buyer" : me.user.userType === "agent" ? "agent" : "owner")) as UserRole;
          setRole(cr); remember(w, cr);
        });
      }
      else { setWho("out"); remember("out", null); }
    });
  }, []);

  const signOut = async () => {
    try { window.sessionStorage.removeItem(NAV_CACHE_KEY); } catch { /* ignore */ }
    await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    window.location.assign("/");
  };

  // Signed-in people get the focused menu for the role they are viewing as; it updates on the reload that follows a role switch.
  const pending = (who === "owner" || who === "buyer") && role === null;
  const signedIn = (who === "owner" || who === "buyer") && role !== null;
  const owner = who === "owner" || who === "out";
  const buyer = who === "buyer" || who === "out";
  const shown: Record<string, boolean> = {
    browse: true, plans: true, projects: true, list: owner, mine: who === "owner", offers: who === "owner", searches: buyer,
    saved: who === "buyer", verification: who === "buyer", dashboard: who !== "loading" && who !== "out", staff: who === "staff", signin: who === "out"
  };
  const list = items ?? NAV_CATALOG.map(n => ({ id: n.id, label: n.label, visible: true }));
  const style = iconStyle ?? "outline";
  return (
    <nav className="site-nav has-menu" aria-label="Main" ref={navRef} {...(ready ? { "data-js": "" } : {})} {...(open ? { "data-open": "" } : {})}
      onBlur={e => { if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <button type="button" ref={toggleRef} className="nav-toggle" aria-expanded={open} aria-controls="site-nav-links" onClick={() => setOpen(o => !o)}>
        <span className="nav-toggle-bars" aria-hidden="true" />
        <span>Menu</span>
      </button>
      <div className="site-nav-links" id="site-nav-links">
      {signedIn ? roleNav(role).filter(it => invest || it.id !== "portfolio").map(it => <a key={it.id} href={it.href}>{it.label}</a>) : pending ? null : list.map(it => {
        const def = NAV_CATALOG.find(n => n.id === it.id);
        if (!def || !it.visible || !shown[it.id]) return null;
        const href = def.href;
        return <a key={it.id} href={href}><Icon name={def.icon} style={style} />{it.label}</a>;
      })}
      {(who === "owner" || who === "buyer" || who === "staff") && <button type="button" className="nav-signout" onClick={signOut}>Sign out</button>}
      </div>
      {(who === "owner" || who === "buyer") && <RoleSwitcher />}
      {themeToggle && <ThemeToggle />}
    </nav>
  );
}
