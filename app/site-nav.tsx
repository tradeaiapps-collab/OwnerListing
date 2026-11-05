"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { NAV_CATALOG, type IconStyle, type NavItem } from "../src/domain/site-theme";

type Who = "loading" | "out" | "staff" | "owner" | "buyer";

/**
 * Links follow the signed-in type. This only hides links; every route still enforces access on the server.
 * `items` is the admin's navigation setting (order, labels, hidden items); targets and icons come from the fixed catalogue.
 */
export default function SiteNav({ items, iconStyle, signInHref }: { items?: NavItem[]; iconStyle?: IconStyle; signInHref?: "/dev-login" }) {
  const [who, setWho] = useState<Who>("loading");
  const [invest, setInvest] = useState(false);
  const [unread, setUnread] = useState(0);
  // Phone menu. `ready` flips on after hydration, so without JavaScript every link stays visible (CSS only collapses when data-js is set).
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstRender = useRef(true);

  useEffect(() => setReady(true), []);

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
      if (staff?.staff) setWho("staff");
      else if (me?.mfaPending && window.location.pathname !== "/mfa") {
        // Signed in with Google but the second step is still to do: every API treats the session as signed out until then.
        window.location.assign(`/mfa?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      } else if (me?.user) {
        setWho(me.user.userType === "buyer" ? "buyer" : "owner");
        void get("/api/notifications?limit=1").then(n => setUnread(typeof n?.unread === "number" ? n.unread : 0));
      }
      else setWho("out");
    });
  }, []);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    window.location.assign("/");
  };

  const owner = who === "owner" || who === "out";
  const buyer = who === "buyer" || who === "out";
  const shown: Record<string, boolean> = {
    browse: true, plans: true, list: owner, mine: who === "owner", offers: who === "owner", searches: buyer,
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
      {list.map(it => {
        const def = NAV_CATALOG.find(n => n.id === it.id);
        if (!def || !it.visible || !shown[it.id]) return null;
        const href = it.id === "signin" && signInHref ? signInHref : def.href;
        return <a key={it.id} href={href}><Icon name={def.icon} style={style} />{it.label}</a>;
      })}
      {/* Not in the admin nav catalogue on purpose: shown only while the investor module is live (status answers 404 when off). */}
      {invest && (who === "owner" || who === "buyer") && <a href="/investments">Investor projects</a>}
      {/* Not in the admin nav catalogue: adding an id there would invalidate every saved theme's navigation list. */}
      {who === "buyer" && <a href="/offers">My offers</a>}
      {(who === "owner" || who === "buyer") && <a href="/notifications">Notifications{unread > 0 ? <span className="nt-badge nt-bell-badge" aria-label={`${unread} unread`}>{unread}</span> : null}</a>}
      {(who === "owner" || who === "buyer") && <a href="/market">Market insights</a>}
      {(who === "owner" || who === "buyer") && <a href="/inspections">Inspections</a>}
      {who !== "staff" && who !== "loading" && <a href="/marketplace/agents">Find an agent</a>}
      {(who === "owner" || who === "buyer") && <a href="/marketplace/consultations">My consultations</a>}
      {(who === "owner" || who === "buyer" || who === "staff") && <button type="button" className="nav-signout" onClick={signOut}>Sign out</button>}
      </div>
    </nav>
  );
}
