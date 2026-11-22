/** Sold and rented events: the pure rules for what staff may enter by hand. The database layer is src/server/sale-events-db.ts. */

export const SALE_EVENT_TYPES = ["sold", "rented"] as const;
export type SaleEventType = (typeof SALE_EVENT_TYPES)[number];
export const SALE_EVENT_SOURCES = ["public_record", "platform"] as const;
export const SALE_EVENT_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"] as const;
export const SALE_PROPERTY_TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"] as const;
/** Largest amount accepted: $1 billion for a sale, $1 million a week for a rental. A guard against a slipped decimal. */
export const MAX_SALE_CENTS = 100_000_000_000;
export const MAX_RENT_CENTS = 100_000_000;

export interface ManualSaleEvent {
  eventType: SaleEventType; amountCents: number; occurredAt: string; source: (typeof SALE_EVENT_SOURCES)[number];
  address: string; state: (typeof SALE_EVENT_STATES)[number]; suburb: string; postcode: string; propertyType: (typeof SALE_PROPERTY_TYPES)[number];
  bedrooms?: number; bathrooms?: number; carSpaces?: number; landAreaSqm?: number; counterparty?: string; note?: string;
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined => (typeof v === "string" ? list.find(x => x === v) : undefined);
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim().length > 0 && v.trim().length <= max ? v.trim() : undefined);
const count = (v: unknown, max: number): number | undefined | null =>
  v === undefined || v === null || v === "" ? undefined : typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null;

/** Checks a staff-entered historical sale or rental. `now` keeps future dates out; the error names the first thing wrong. */
export function parseManualSaleEvent(body: unknown, now: string): { ok: true; value: ManualSaleEvent } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const eventType = oneOf(SALE_EVENT_TYPES, b["eventType"]);
  if (!eventType) return { ok: false, error: "Choose sold or rented." };
  const cap = eventType === "sold" ? MAX_SALE_CENTS : MAX_RENT_CENTS;
  const amountCents = b["amountCents"];
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0 || amountCents > cap) {
    return { ok: false, error: eventType === "sold" ? "Enter the sale price in dollars, above zero." : "Enter the weekly rent in dollars, above zero." };
  }
  const when = typeof b["occurredAt"] === "string" ? Date.parse(b["occurredAt"]) : NaN;
  if (!Number.isFinite(when)) return { ok: false, error: "Enter the date it sold or was let." };
  if (when > Date.parse(now)) return { ok: false, error: "The date cannot be in the future." };
  if (when < Date.parse("1990-01-01T00:00:00Z")) return { ok: false, error: "The date is too far back." };
  const source = oneOf(SALE_EVENT_SOURCES, b["source"]);
  if (!source) return { ok: false, error: "Choose where the figure came from." };
  const address = text(b["address"], 200);
  if (!address) return { ok: false, error: "Enter the street address." };
  const state = oneOf(SALE_EVENT_STATES, b["state"]);
  if (!state) return { ok: false, error: "Choose the state or territory." };
  const suburb = text(b["suburb"], 80);
  if (!suburb) return { ok: false, error: "Enter the suburb." };
  const postcode = typeof b["postcode"] === "string" && /^\d{4}$/.test(b["postcode"].trim()) ? b["postcode"].trim() : undefined;
  if (!postcode) return { ok: false, error: "Enter a 4-digit postcode." };
  const propertyType = oneOf(SALE_PROPERTY_TYPES, b["propertyType"]);
  if (!propertyType) return { ok: false, error: "Choose the property type." };
  const bedrooms = count(b["bedrooms"], 30), bathrooms = count(b["bathrooms"], 30), carSpaces = count(b["carSpaces"], 20);
  if (bedrooms === null || bathrooms === null || carSpaces === null) return { ok: false, error: "Bedrooms, bathrooms and car spaces must be whole numbers." };
  const land = b["landAreaSqm"];
  if (land !== undefined && land !== null && land !== "" && !(typeof land === "number" && land > 0 && land <= 10_000_000)) return { ok: false, error: "Land area must be above zero." };
  const counterparty = b["counterparty"] ? text(b["counterparty"], 120) : undefined;
  if (b["counterparty"] && !counterparty) return { ok: false, error: "The buyer or tenant name is too long." };
  const note = b["note"] ? text(b["note"], 1000) : undefined;
  if (b["note"] && !note) return { ok: false, error: "The note is too long." };
  return {
    ok: true,
    value: {
      eventType, amountCents, occurredAt: new Date(when).toISOString(), source, address, state, suburb, postcode, propertyType,
      ...(bedrooms !== undefined ? { bedrooms } : {}), ...(bathrooms !== undefined ? { bathrooms } : {}), ...(carSpaces !== undefined ? { carSpaces } : {}),
      ...(typeof land === "number" ? { landAreaSqm: land } : {}), ...(counterparty ? { counterparty } : {}), ...(note ? { note } : {})
    }
  };
}

/** First letter of each word and stars, for staff who may not see full personal details. */
export const maskName = (n: string | null | undefined): string | null =>
  n ? n.trim().split(/\s+/).map(w => `${w[0] ?? ""}***`).join(" ") : null;
