/** Display helpers shared by the screens. Money is whole AUD cents (sale price, or rent per week). */
export function formatPrice(cents: number | null | undefined, transactionType: "sale" | "rent"): string {
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents <= 0) return transactionType === "rent" ? "Rent on request" : "Contact owner";
  const text = `$${Math.round(cents / 100).toLocaleString("en-AU")}`;
  return transactionType === "rent" ? `${text} per week` : text;
}

export function roomsLine(l: { bedrooms?: number | null; bathrooms?: number | null; parking?: number | null }): string {
  const parts: string[] = [];
  if (typeof l.bedrooms === "number") parts.push(`${l.bedrooms} bed`);
  if (typeof l.bathrooms === "number") parts.push(`${l.bathrooms} bath`);
  if (typeof l.parking === "number") parts.push(`${l.parking} car`);
  return parts.join(" · ");
}

/** "5 Nov, 3:04 pm" in the phone's time zone; empty for a bad date. */
export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export interface SearchFields { q?: string; transactionType?: "sale" | "rent"; minBedrooms?: number; maxPriceDollars?: number; page?: number }

/** Query string for GET /api/listings from the search screen. Prices are typed in dollars and sent in cents (only with sale/rent). */
export function searchQuery(f: SearchFields): string {
  const p = new URLSearchParams();
  const q = f.q?.trim();
  if (q) p.set("q", q.slice(0, 100));
  if (f.transactionType) p.set("transactionType", f.transactionType);
  if (f.minBedrooms !== undefined && f.minBedrooms > 0) p.set("minBedrooms", String(Math.floor(f.minBedrooms)));
  if (f.transactionType && f.maxPriceDollars !== undefined && f.maxPriceDollars > 0) p.set("maxPriceCents", String(Math.round(f.maxPriceDollars * 100)));
  if (f.page !== undefined && f.page > 1) p.set("page", String(Math.floor(f.page)));
  const s = p.toString();
  return s ? `?${s}` : "";
}
