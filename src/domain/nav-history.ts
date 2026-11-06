/** Session navigation stack: remembers each page the visitor opened and how far they had scrolled, so "back" lands exactly where they left. Pure; the browser wiring is in app/nav-memory.tsx. */
export type NavEntry = { url: string; y: number };
export type NavState = { stack: NavEntry[]; index: number };
export type NavKind = "push" | "replace" | "pop";

export const NAV_MAX_ENTRIES = 100;

export function emptyNav(url: string): NavState {
  return { stack: [{ url, y: 0 }], index: 0 };
}

/** Records the scroll position of the page being viewed. */
export function setScroll(s: NavState, y: number): NavState {
  const cur = s.stack[s.index];
  if (!cur || cur.y === y) return s;
  const stack = s.stack.slice();
  stack[s.index] = { ...cur, y };
  return { stack, index: s.index };
}

/** Applies a navigation to the stack. `pop` is browser back/forward: the index moves to the matching neighbour. */
export function visit(s: NavState, url: string, kind: NavKind): NavState {
  const cur = s.stack[s.index];
  if (kind === "replace") {
    if (!cur || cur.url === url) return s;
    const stack = s.stack.slice();
    stack[s.index] = { url, y: 0 };
    return { stack, index: s.index };
  }
  if (kind === "pop") {
    if (s.stack[s.index - 1]?.url === url) return { stack: s.stack, index: s.index - 1 };
    if (s.stack[s.index + 1]?.url === url) return { stack: s.stack, index: s.index + 1 };
    // Jumped more than one step (long-press history menu): pick the nearest entry with that address.
    let best = -1;
    s.stack.forEach((e, i) => { if (e.url === url && (best < 0 || Math.abs(i - s.index) < Math.abs(best - s.index))) best = i; });
    if (best >= 0) return { stack: s.stack, index: best };
  }
  if (cur?.url === url && kind === "push") return s;
  const kept = s.stack.slice(0, s.index + 1);
  kept.push({ url, y: 0 });
  const trimmed = kept.length > NAV_MAX_ENTRIES ? kept.slice(kept.length - NAV_MAX_ENTRIES) : kept;
  return { stack: trimmed, index: trimmed.length - 1 };
}

export function canGoBack(s: NavState): boolean {
  return s.index > 0;
}

/** Where the visitor was one step ago (what "back" will show). */
export function previousEntry(s: NavState): NavEntry | undefined {
  return s.stack[s.index - 1];
}

/** The scroll position to restore for the page now showing. */
export function currentScroll(s: NavState): number {
  return s.stack[s.index]?.y ?? 0;
}

export function parseNav(raw: string | null, url: string): NavState {
  try {
    const p = raw ? (JSON.parse(raw) as NavState) : null;
    if (p && Array.isArray(p.stack) && Number.isInteger(p.index) && p.stack[p.index]?.url === url && p.stack.every(e => typeof e?.url === "string" && typeof e?.y === "number")) return p;
  } catch { /* fall through */ }
  return emptyNav(url);
}

/** Whether a link is a "go back" link: marked, or its text starts with "Back" (optionally after an arrow). */
export function isBackLabel(text: string): boolean {
  return /^\s*(?:[←‹«]\s*)?back\b/i.test(text);
}
