/** Helpers for the buyer offer form. Pure, so they are tested without a browser. */

/** Whole dollars (optionally with cents) to integer cents. Undefined when not a plain non-negative amount. */
export function dollarsToCents(v: string): number | undefined {
  const t = v.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const cents = Math.round(Number(t) * 100);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

/** One condition per line; blank lines are dropped. */
export function parseConditionLines(text: string): string[] {
  return text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
}

/** The link token from the URL fragment (`#token=...`), falling back to the query string (`?token=...`). */
export function readOfferToken(hash: string, search: string): string {
  const fromHash = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return fromHash ?? new URLSearchParams(search).get("token") ?? "";
}

/** The link the owner shares. The token sits in the fragment so it is not sent to servers or logged. */
export function buildOfferUrl(origin: string, listingId: string, token: string): string {
  return `${origin}/offers/new?listing=${encodeURIComponent(listingId)}#token=${encodeURIComponent(token)}`;
}
