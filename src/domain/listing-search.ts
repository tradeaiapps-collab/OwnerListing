import { isJurisdiction, type Jurisdiction } from "./jurisdiction";
import { MAX_ROOMS } from "./listing-details";
import type { PropertyListing, PropertyType, UseClass } from "./listing";

export const SORTS = ["newest", "price_asc", "price_desc", "bedrooms_desc"] as const;
export type Sort = (typeof SORTS)[number];
export const SEARCH_PAGE_SIZE = 12;
export const MAX_SEARCH_PAGE_SIZE = 50;
export const MAX_PAGE = 10_000;

/** Browse filters for published listings. Price filters are AUD cents and only apply together with transactionType. */
export interface SearchQuery {
  jurisdiction?: Jurisdiction;
  transactionType?: "sale" | "rent";
  useClass?: UseClass;
  propertyType?: PropertyType;
  minPriceCents?: number;
  maxPriceCents?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  minParking?: number;
  /** Prefix match, case-insensitive. */
  suburb?: string;
  postcode?: string;
  sort: Sort;
  page: number;
  pageSize: number;
}

export interface SearchPage<T> { items: T[]; total: number; page: number; pageSize: number }

const TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"] as const;
const int = (v: string | null, min: number, max: number): number | undefined => {
  if (v === null || !/^\d{1,12}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= min && n <= max ? n : undefined;
};

/** Reads URL parameters. Unknown or invalid values are dropped, never an error, so a stale link still loads. */
export function parseSearchQuery(p: URLSearchParams): SearchQuery {
  const q: SearchQuery = { sort: "newest", page: 1, pageSize: SEARCH_PAGE_SIZE };
  const j = p.get("jurisdiction");
  if (j && isJurisdiction(j)) q.jurisdiction = j;
  const tx = p.get("transactionType");
  if (tx === "sale" || tx === "rent") q.transactionType = tx;
  const use = p.get("useClass");
  if (use === "residential" || use === "commercial") q.useClass = use;
  const type = TYPES.find(t => t === p.get("propertyType"));
  if (type) q.propertyType = type;
  // A sale price and a weekly rent are not comparable, so price filters need sale or rent chosen.
  if (q.transactionType) {
    const lo = int(p.get("minPriceCents"), 0, Number.MAX_SAFE_INTEGER);
    const hi = int(p.get("maxPriceCents"), 0, Number.MAX_SAFE_INTEGER);
    if (lo !== undefined) q.minPriceCents = lo;
    if (hi !== undefined) q.maxPriceCents = hi;
  }
  const beds = int(p.get("minBedrooms"), 0, MAX_ROOMS);
  if (beds !== undefined) q.minBedrooms = beds;
  const baths = int(p.get("minBathrooms"), 0, MAX_ROOMS);
  if (baths !== undefined) q.minBathrooms = baths;
  const park = int(p.get("minParking"), 0, MAX_ROOMS);
  if (park !== undefined) q.minParking = park;
  const suburb = p.get("suburb")?.trim();
  if (suburb && suburb.length <= 80) q.suburb = suburb;
  const postcode = p.get("postcode");
  if (postcode && /^\d{4}$/.test(postcode)) q.postcode = postcode;
  const sort = SORTS.find(s => s === p.get("sort"));
  if (sort) q.sort = sort;
  const size = int(p.get("pageSize"), 1, MAX_SEARCH_PAGE_SIZE);
  if (size !== undefined) q.pageSize = size;
  const page = int(p.get("page"), 1, MAX_PAGE);
  if (page !== undefined) q.page = page;
  return q;
}

/** True when the listing passes every filter. Status is not checked here. */
export function matchesQuery(l: PropertyListing, q: SearchQuery): boolean {
  if (q.jurisdiction && l.jurisdiction !== q.jurisdiction) return false;
  if (q.transactionType && l.transactionType !== q.transactionType) return false;
  if (q.useClass && l.useClass !== q.useClass) return false;
  if (q.propertyType && l.propertyType !== q.propertyType) return false;
  if (q.minPriceCents !== undefined && (l.priceCents === undefined || l.priceCents < q.minPriceCents)) return false;
  if (q.maxPriceCents !== undefined && (l.priceCents === undefined || l.priceCents > q.maxPriceCents)) return false;
  if (q.minBedrooms !== undefined && (l.bedrooms === undefined || l.bedrooms < q.minBedrooms)) return false;
  if (q.minBathrooms !== undefined && (l.bathrooms === undefined || l.bathrooms < q.minBathrooms)) return false;
  if (q.minParking !== undefined && (l.parking === undefined || l.parking < q.minParking)) return false;
  if (q.suburb && !(l.suburb ?? "").toLowerCase().startsWith(q.suburb.toLowerCase())) return false;
  if (q.postcode && l.postcode !== q.postcode) return false;
  return true;
}

/** Listings without the sort field go last. Ties break by newest, then id, so pages never overlap. */
export function compareListings(sort: Sort): (a: PropertyListing, b: PropertyListing) => number {
  const tie = (a: PropertyListing, b: PropertyListing) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  const num = (get: (l: PropertyListing) => number | undefined, dir: 1 | -1) => (a: PropertyListing, b: PropertyListing) => {
    const x = get(a), y = get(b);
    if (x === undefined && y === undefined) return tie(a, b);
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    return x === y ? tie(a, b) : (x - y) * dir;
  };
  if (sort === "price_asc") return num(l => l.priceCents, 1);
  if (sort === "price_desc") return num(l => l.priceCents, -1);
  if (sort === "bedrooms_desc") return num(l => l.bedrooms, -1);
  return tie;
}

/** In-memory reference implementation, used by the test repository. The PostgreSQL repository does the same in SQL. */
export function searchInMemory(all: readonly PropertyListing[], q: SearchQuery): SearchPage<PropertyListing> {
  const hits = all.filter(l => l.status === "published" && matchesQuery(l, q)).sort(compareListings(q.sort));
  const start = (q.page - 1) * q.pageSize;
  return { items: hits.slice(start, start + q.pageSize), total: hits.length, page: q.page, pageSize: q.pageSize };
}
