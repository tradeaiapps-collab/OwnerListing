export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function clampPageSize(n?: number): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(n)));
}

export interface Cursor { sortValue: string; id: string }

export function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Returns null for anything that is not a valid cursor. */
export function decodeCursor(s: string): Cursor | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const v = JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)));
    return typeof v?.sortValue === "string" && typeof v?.id === "string" ? { sortValue: v.sortValue, id: v.id } : null;
  } catch { return null; }
}

/** Keyset pagination: stays fast on very large tables, unlike OFFSET. Pass the cursor values as $1 and $2. */
export const KEYSET_WHERE = "(created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT $3";
