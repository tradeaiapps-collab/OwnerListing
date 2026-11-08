"use client";
import { useEffect, useState } from "react";
import { safeNext } from "../src/server/auth/safe-next";

/** The page to return to: an explicit ?from= (same-site paths only), else the same-site page the visitor came from. */
export function pickReturnPath(search: string, referrer: string, origin: string, current: string): string | undefined {
  const from = safeNext(new URLSearchParams(search).get("from"));
  if (from && from.split("?")[0] !== current) return from;
  if (!referrer.startsWith(`${origin}/`)) return undefined;
  const path = referrer.slice(origin.length);
  return safeNext(path) && path.split("?")[0] !== current ? path : undefined;
}

/** "Back" link for detail pages. Returns to where the visitor left off (browser history keeps scroll), falling back to a fixed page. */
export default function BackLink({ fallback = "/listings", label = "Back" }: { fallback?: string; label?: string }) {
  const [href, setHref] = useState(fallback);
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    const ret = pickReturnPath(window.location.search, document.referrer, window.location.origin, window.location.pathname);
    if (ret) { setHref(ret); setCanGoBack(window.history.length > 1 && !new URLSearchParams(window.location.search).get("from")); }
  }, []);
  return (
    <a className="back-link" href={href} onClick={e => { if (canGoBack) { e.preventDefault(); window.history.back(); } }}>
      <span aria-hidden="true">←</span> {label}
    </a>
  );
}
