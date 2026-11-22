"use client";
import { useEffect } from "react";
import { canGoBack, currentScroll, isBackLabel, parseNav, setScroll, visit, type LoadKind, type NavKind, type NavState } from "../src/domain/nav-history";

const KEY = "ol-nav-history";
const here = () => window.location.pathname + window.location.search;

/**
 * Remembers every page of this visit and its scroll position, so any "back" (browser button or an on-page "Back to…" link)
 * returns to the exact page and spot the visitor left, instead of a fixed parent page. Renders nothing.
 */
export default function NavMemory() {
  useEffect(() => {
    const h = window.history;
    const prevRestoration = h.scrollRestoration;
    h.scrollRestoration = "manual";
    const loadType = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
    const load: LoadKind = loadType === "back_forward" || loadType === "reload" ? loadType : "navigate";
    let state: NavState = parseNav(sessionStorage.getItem(KEY), here(), load);
    let lastUrl = here();
    let restoreToken = 0;
    const persist = () => { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode: still works for this page view */ } };

    const restore = (y: number) => {
      const token = ++restoreToken;
      if (y <= 0) { window.scrollTo({ top: 0, behavior: "instant" }); return; }
      const start = Date.now();
      const stop = () => { restoreToken++; };
      for (const ev of ["wheel", "touchstart", "keydown"] as const) window.addEventListener(ev, stop, { once: true, passive: true });
      // Pages load their data after mounting, so keep trying until the page is tall enough (or the visitor scrolls themselves).
      const tick = () => {
        if (token !== restoreToken) return;
        window.scrollTo({ top: y, behavior: "instant" });
        const reached = Math.abs(window.scrollY - y) < 2;
        if (Date.now() - start < (reached ? 500 : 4000)) setTimeout(tick, 60);
      };
      tick();
    };

    const onNav = (kind: NavKind) => {
      const url = here();
      // Same page (path + query), e.g. an in-page #anchor click, which also fires popstate: leave the browser's own jump alone.
      if (url === lastUrl) return;
      lastUrl = url;
      state = visit(state, url, kind);
      persist();
      if (kind === "pop") restore(currentScroll(state)); else restoreToken++;
    };

    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; state = setScroll(state, Math.round(window.scrollY)); });
    };
    const flush = () => { state = setScroll(state, Math.round(window.scrollY)); persist(); };

    const origPush = h.pushState, origReplace = h.replaceState;
    h.pushState = function (...a: Parameters<History["pushState"]>) { flush(); origPush.apply(this, a); queueMicrotask(() => onNav("push")); };
    h.replaceState = function (...a: Parameters<History["replaceState"]>) { origReplace.apply(this, a); queueMicrotask(() => onNav("replace")); };
    // In-page #anchor clicks add history entries on the same page: remember where each was left so Back returns there.
    const hashY = new Map<string, number>();
    let fromHashClick = false;
    const onPop = () => {
      if (here() === lastUrl) {
        if (fromHashClick) return; // a forward #anchor click: the browser has already jumped
        const y = hashY.get(window.location.hash);
        if (y !== undefined) restore(y);
        else if (window.location.hash) document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView();
        else restore(0);
        return;
      }
      state = setScroll(state, state.stack[state.index]?.y ?? 0); onNav("pop");
    };

    const onClick = (e: MouseEvent) => {
      const hashLink = (e.target as Element | null)?.closest?.("a[href^='#']");
      if (hashLink) {
        hashY.set(window.location.hash, Math.round(window.scrollY));
        fromHashClick = true;
        setTimeout(() => { fromHashClick = false; }, 300);
      }
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download") || a.hasAttribute("data-no-history-back")) return;
      if (a.origin !== window.location.origin) return;
      if (!(a.hasAttribute("data-back") || a.classList.contains("back-link") || isBackLabel(a.textContent ?? ""))) return;
      if (!canGoBack(state) || window.history.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const before = here();
      window.history.back();
      // If the browser had nothing to go back to, fall back to the link's own target.
      setTimeout(() => { if (here() === before) window.location.assign(a.href); }, 600);
    };

    window.addEventListener("popstate", onPop);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    document.addEventListener("click", onClick, true);
    // A reload or restored tab: put the visitor back where they were.
    if (currentScroll(state) > 0) restore(currentScroll(state));
    persist();
    return () => {
      h.pushState = origPush; h.replaceState = origReplace;
      h.scrollRestoration = prevRestoration;
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      document.removeEventListener("click", onClick, true);
    };
  }, []);
  return null;
}
