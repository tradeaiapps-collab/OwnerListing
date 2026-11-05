import { dollarsToCents } from "../../src/domain/listing-details";
import type { SearchQuery } from "../../src/domain/listing-search";

/** Initial browse filters from the URL (home page search, shared links). Unknown or invalid values are dropped, never an error. */
export interface UrlFilters {
  jurisdiction?: string; transactionType?: "sale" | "rent"; useClass?: "residential" | "commercial";
  location?: string; minBedrooms?: string; maxPrice?: string;
}

const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

/** Params: state, type (sale|rent), use, suburb, postcode, location (suburb or 4-digit postcode), beds (1-5), price (max, whole dollars). */
export function filtersFromParams(p: URLSearchParams): UrlFilters {
  const out: UrlFilters = {};
  const state = p.get("state")?.trim().toUpperCase();
  if (state && STATES.includes(state)) out.jurisdiction = state;
  const type = p.get("type");
  if (type === "sale" || type === "rent") out.transactionType = type;
  const use = p.get("use");
  if (use === "residential" || use === "commercial") out.useClass = use;
  const loc = (p.get("postcode") ?? p.get("suburb") ?? p.get("location") ?? "").trim().replace(/\s+/g, " ");
  if (loc && loc.length <= 80) out.location = loc;
  const beds = p.get("beds");
  if (beds && /^[1-5]$/.test(beds)) out.minBedrooms = beds;
  const price = p.get("price");
  // Price only means something with sale or rent chosen (a sale price and a weekly rent are not comparable).
  if (out.transactionType && price && /^\d{1,10}$/.test(price) && Number(price) > 0) out.maxPrice = price;
  return out;
}

/** The browse filter form. Text values exactly as typed; prices are whole dollars. */
export const BLANK_FILTERS = { jurisdiction: "", transactionType: "", useClass: "", propertyType: "", location: "", minPrice: "", maxPrice: "", minBedrooms: "", minBathrooms: "", minParking: "", q: "", amenities: "", lat: "", lng: "", radiusKm: "" };
export type FilterForm = typeof BLANK_FILTERS;

/** Form values to API parameters (shared by the list and the map). Price fields are dollars in the form and cents in the API; only used with sale or rent. */
export function filterParams(f: FilterForm): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of ["jurisdiction", "transactionType", "useClass", "propertyType", "minBedrooms", "minBathrooms", "minParking"] as const) if (f[k]) p.set(k, f[k]);
  for (const k of ["amenities", "lat", "lng", "radiusKm"] as const) if (f[k]) p.set(k, f[k]);
  if (f.q.trim()) p.set("q", f.q.trim());
  const loc = f.location.trim();
  if (loc) p.set(/^\d{4}$/.test(loc) ? "postcode" : "suburb", loc);
  if (f.transactionType) {
    const lo = f.minPrice ? dollarsToCents(f.minPrice) : undefined;
    const hi = f.maxPrice ? dollarsToCents(f.maxPrice) : undefined;
    if (lo !== undefined) p.set("minPriceCents", String(lo));
    if (hi !== undefined) p.set("maxPriceCents", String(hi));
  }
  return p;
}

const dollars = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

/** A parsed search (shared link, saved search, Elena) as the filter form. Cents become dollars; a postcode goes in the location box. */
export function formFromQuery(q: SearchQuery): FilterForm {
  return {
    ...BLANK_FILTERS,
    jurisdiction: q.jurisdiction ?? "", transactionType: q.transactionType ?? "", useClass: q.useClass ?? "", propertyType: q.propertyType ?? "",
    location: q.postcode ?? q.suburb ?? "",
    minPrice: q.minPriceCents !== undefined ? dollars(q.minPriceCents) : "", maxPrice: q.maxPriceCents !== undefined ? dollars(q.maxPriceCents) : "",
    minBedrooms: q.minBedrooms !== undefined ? String(q.minBedrooms) : "", minBathrooms: q.minBathrooms !== undefined ? String(q.minBathrooms) : "",
    minParking: q.minParking !== undefined ? String(q.minParking) : "",
    q: q.q ?? "", amenities: q.amenities?.join(",") ?? "",
    lat: q.near ? String(q.near.latitude) : "", lng: q.near ? String(q.near.longitude) : "", radiusKm: q.near ? String(q.near.radiusKm) : ""
  };
}
