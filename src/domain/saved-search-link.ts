import type { SavedSearch } from "./buyer";
import type { SearchQuery } from "./listing-search";
import type { SavedSearchInput } from "./saved-search-service";
import { COMMERCIAL_TYPES } from "./search-vocab";

/**
 * Listings page address for a saved search. The page filters by one state, one type and one suburb, so a saved search that lists
 * several of these opens without that filter (a wider view, never a narrower one).
 */
export function savedSearchHref(s: SavedSearch): string {
  const p = new URLSearchParams({ transactionType: s.transactionType, useClass: s.useClass });
  if (s.jurisdictions.length === 1) p.set("jurisdiction", s.jurisdictions[0]!);
  if (s.propertyTypes.length === 1) p.set("propertyType", s.propertyTypes[0]!);
  if (s.suburbs.length === 1) p.set("suburb", s.suburbs[0]!);
  if (s.minPriceCents !== undefined) p.set("minPriceCents", String(s.minPriceCents));
  if (s.maxPriceCents !== undefined) p.set("maxPriceCents", String(s.maxPriceCents));
  if (s.minBedrooms !== undefined) p.set("minBedrooms", String(s.minBedrooms));
  if (s.minBathrooms !== undefined) p.set("minBathrooms", String(s.minBathrooms));
  if (s.minParking !== undefined) p.set("minParking", String(s.minParking));
  if (s.amenities?.length) p.set("amenities", s.amenities.join(","));
  if (s.near) { p.set("lat", String(s.near.latitude)); p.set("lng", String(s.near.longitude)); p.set("radiusKm", String(s.near.radiusKm)); }
  return `/listings?${p}`;
}

/**
 * The listing filters as a saved search. Needs sale or rent chosen (a price and a weekly rent are not comparable).
 * Words typed in the search bar and a postcode are not saved: alerts match on property facts only, never on titles or addresses.
 */
export function savedInputFromQuery(q: SearchQuery): { ok: true; value: SavedSearchInput; dropped: string[] } | { ok: false; message: string } {
  if (!q.transactionType) return { ok: false, message: "Choose sale or rent to save this search." };
  const dropped: string[] = [];
  if (q.q) dropped.push("search words");
  if (q.postcode) dropped.push("postcode");
  if (q.bbox) dropped.push("map area");
  const useClass = q.useClass ?? (q.propertyType && COMMERCIAL_TYPES.includes(q.propertyType) ? "commercial" : "residential");
  return {
    ok: true, dropped,
    value: {
      transactionType: q.transactionType, useClass,
      jurisdictions: q.jurisdiction ? [q.jurisdiction] : [], suburbs: q.suburb ? [q.suburb] : [], propertyTypes: q.propertyType ? [q.propertyType] : [],
      ...(q.minPriceCents !== undefined ? { minPriceCents: q.minPriceCents } : {}), ...(q.maxPriceCents !== undefined ? { maxPriceCents: q.maxPriceCents } : {}),
      ...(q.minBedrooms !== undefined ? { minBedrooms: q.minBedrooms } : {}), ...(q.minBathrooms !== undefined ? { minBathrooms: q.minBathrooms } : {}),
      ...(q.minParking !== undefined ? { minParking: q.minParking } : {}),
      ...(q.amenities?.length ? { amenities: q.amenities } : {}), ...(q.near ? { near: q.near } : {})
    }
  };
}
