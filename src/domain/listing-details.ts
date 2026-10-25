/** Price, rooms and location of a listing. Pure validation; money is whole AUD cents (sale price, or rent per week). */

export const MAX_SALE_PRICE_CENTS = 100_000_000_000; // $1,000,000,000
export const MAX_WEEKLY_RENT_CENTS = 10_000_000; // $100,000 per week
export const MAX_ROOMS = 20;
export const MAX_SUBURB_LENGTH = 80;

export interface ListingDetails {
  suburb?: string;
  postcode?: string;
  /** Sale: asking price. Rent: rent per week. AUD cents. */
  priceCents?: number;
  bedrooms?: number;
  bathrooms?: number;
  parking?: number;
  /** Map pin, WGS84 decimal degrees. Always set or cleared as a pair, and only inside Australia's bounds. */
  latitude?: number;
  longitude?: number;
}
export const DETAIL_KEYS = ["suburb", "postcode", "priceCents", "bedrooms", "bathrooms", "parking", "latitude", "longitude"] as const;

/** Australia including Tasmania and the external territories' mainland approaches. A pin outside is a typo. */
export const AU_BOUNDS = { south: -44, west: 112, north: -9, east: 154 } as const;
const COORD_RE = /^-?\d{1,3}(\.\d{1,6})?$/;
const coordOk = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max && COORD_RE.test(String(v));
export type DetailKey = (typeof DETAIL_KEYS)[number];

export function maxPriceCents(tx: "sale" | "rent"): number {
  return tx === "rent" ? MAX_WEEKLY_RENT_CENTS : MAX_SALE_PRICE_CENTS;
}

/** Parses "1,250.50" or "$900" into cents using string maths only. Undefined for anything else (more than 2 decimals, negatives, junk). */
export function dollarsToCents(input: string): number | undefined {
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return undefined;
  const cents = Number(m[1]!.replace(/,/g, "")) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : undefined;
}

export function formatAud(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

/** "$850,000" for a sale, "$650 per week" for a rent. */
export function formatPrice(cents: number, tx: "sale" | "rent"): string {
  return tx === "rent" ? `${formatAud(cents)} per week` : formatAud(cents);
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Checks one price against the transaction type. Returns an error message or undefined. */
export function priceError(priceCents: unknown, tx: "sale" | "rent"): string | undefined {
  if (!isInt(priceCents, 1, maxPriceCents(tx))) {
    return tx === "rent"
      ? "Weekly rent must be a whole number of cents between $0.01 and $100,000."
      : "Asking price must be a whole number of cents between $0.01 and $1,000,000,000.";
  }
  return undefined;
}

export type DetailsPatch = { [K in DetailKey]?: ListingDetails[K] | null };

/**
 * Validates the detail fields present in `b`. A null value clears the field. Unknown keys are ignored.
 * Price is checked against `tx`, so a rent cannot carry a sale-sized price.
 */
export function parseDetails(b: Record<string, unknown>, tx: "sale" | "rent"): { ok: true; value: DetailsPatch } | { ok: false; message: string } {
  const out: DetailsPatch = {};
  if ("suburb" in b) {
    const v = b["suburb"];
    if (v === null) out.suburb = null;
    else if (typeof v === "string" && v.trim().length >= 1 && v.trim().length <= MAX_SUBURB_LENGTH) out.suburb = v.trim();
    else return { ok: false, message: "Invalid suburb." };
  }
  if ("postcode" in b) {
    const v = b["postcode"];
    if (v === null) out.postcode = null;
    else if (typeof v === "string" && /^\d{4}$/.test(v)) out.postcode = v;
    else return { ok: false, message: "Postcode must be 4 digits." };
  }
  if ("priceCents" in b) {
    const v = b["priceCents"];
    if (v === null) out.priceCents = null;
    else { const e = priceError(v, tx); if (e) return { ok: false, message: e }; out.priceCents = v as number; }
  }
  for (const [k, label] of [["bedrooms", "Bedrooms"], ["bathrooms", "Bathrooms"], ["parking", "Parking spaces"]] as const) {
    if (!(k in b)) continue;
    const v = b[k];
    if (v === null) out[k] = null;
    else if (isInt(v, 0, MAX_ROOMS)) out[k] = v;
    else return { ok: false, message: `${label} must be a whole number from 0 to ${MAX_ROOMS}.` };
  }
  if ("latitude" in b || "longitude" in b) {
    const lat = b["latitude"], lng = b["longitude"];
    if (lat === null && lng === null) { out.latitude = null; out.longitude = null; }
    else if (coordOk(lat, AU_BOUNDS.south, AU_BOUNDS.north) && coordOk(lng, AU_BOUNDS.west, AU_BOUNDS.east)) { out.latitude = lat; out.longitude = lng; }
    else return { ok: false, message: "Map location must be a latitude and longitude pair inside Australia (up to 6 decimal places)." };
  }
  return { ok: true, value: out };
}

/** Applies a validated patch: null removes the field. */
export function applyDetails<T extends ListingDetails>(target: T, patch: DetailsPatch): T {
  const next: Record<string, unknown> = { ...(target as object) };
  for (const k of DETAIL_KEYS) {
    if (!(k in patch)) continue;
    if (patch[k] === null) delete next[k];
    else next[k] = patch[k];
  }
  return next as T;
}
