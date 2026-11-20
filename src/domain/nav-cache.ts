/**
 * The header menu is rebuilt on every full page load. Remembering who was last seen for this tab lets it draw the
 * right links straight away while it re-checks, so repeated taps on the same link never leave the menu empty.
 */
export type NavWho = "out" | "staff" | "owner" | "buyer" | "vendor";
export interface NavSnapshot { who: NavWho; role: string | null }

export const NAV_CACHE_KEY = "ol.nav.v1";
const WHO: readonly string[] = ["out", "staff", "owner", "buyer", "vendor"];

export function parseNavSnapshot(raw: string | null | undefined): NavSnapshot | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { who?: unknown; role?: unknown };
    if (typeof v.who !== "string" || !WHO.includes(v.who)) return null;
    const role = typeof v.role === "string" && v.role.length <= 32 ? v.role : null;
    return { who: v.who as NavWho, role };
  } catch { return null; }
}

export const serializeNavSnapshot = (s: NavSnapshot): string => JSON.stringify(s);
