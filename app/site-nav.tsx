"use client";
import { useEffect, useState } from "react";
import "./styles/nav.css";

type Who = "loading" | "out" | "staff" | "owner" | "buyer";

/** Links follow the signed-in type. This only hides links; every route still enforces access on the server. */
export default function SiteNav() {
  const [who, setWho] = useState<Who>("loading");

  useEffect(() => {
    const get = (url: string) => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
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
  return (
    <nav className="site-nav" aria-label="Main">
      <a href="/listings">Browse</a>
      <a href="/plans">Plans</a>
      {owner && <a href="/listings/new">List a property</a>}
      {who === "owner" && <a href="/listings/mine">My listings</a>}
      {who === "owner" && <a href="/listings/mine">Offers</a>}
      {buyer && <a href="/buyer/saved-searches">Saved searches</a>}
      {who === "buyer" && <a href="/buyer/verification">Verification</a>}
      {who !== "loading" && who !== "out" && <a href="/dashboard">Dashboard</a>}
      {who === "staff" && <a href="/staff">Staff</a>}
      {who === "out" && <a href="/api/auth/google/start">Sign in</a>}
      {(who === "owner" || who === "buyer" || who === "staff") && <button type="button" className="nav-signout" onClick={signOut}>Sign out</button>}
    </nav>
  );
}
