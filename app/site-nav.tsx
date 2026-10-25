"use client";
import { useEffect, useState } from "react";
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

  useEffect(() => {
    const get = (url: string) => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
    // 404 unless the investor module is live (both keys), so nothing about investing shows while it is off.
    void get("/api/investments/status").then(s => setInvest(s?.live === true));
    Promise.all([get("/api/auth/me"), get("/api/staff/me")]).then(([me, staff]) => {
      if (staff?.staff) setWho("staff");
      else if (me?.user) setWho(me.user.userType === "buyer" ? "buyer" : "owner");
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
    <nav className="site-nav" aria-label="Main">
      {list.map(it => {
        const def = NAV_CATALOG.find(n => n.id === it.id);
        if (!def || !it.visible || !shown[it.id]) return null;
        const href = it.id === "signin" && signInHref ? signInHref : def.href;
        return <a key={it.id} href={href}><Icon name={def.icon} style={style} />{it.label}</a>;
      })}
      {/* Not in the admin nav catalogue on purpose: shown only while the investor module is live (status answers 404 when off). */}
      {invest && (who === "owner" || who === "buyer") && <a href="/investments">Investor projects</a>}
      {(who === "owner" || who === "buyer" || who === "staff") && <button type="button" className="nav-signout" onClick={signOut}>Sign out</button>}
    </nav>
  );
}
