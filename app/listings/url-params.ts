import { dollarsToCents } from "../../src/domain/listing-details";

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
export const BLANK_FILTERS = { jurisdiction: "", transactionType: "", useClass: "", propertyType: "", location: "", minPrice: "", maxPrice: "", minBedrooms: "", minBathrooms: "", minParking: "" };
export type FilterForm = typeof BLANK_FILTERS;

/** Form values to API parameters (shared by the list and the map). Price fields are dollars in the form and cents in the API; only used with sale or rent. */
export function filterParams(f: FilterForm): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of ["jurisdiction", "transactionType", "useClass", "propertyType", "minBedrooms", "minBathrooms", "minParking"] as const) if (f[k]) p.set(k, f[k]);
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
