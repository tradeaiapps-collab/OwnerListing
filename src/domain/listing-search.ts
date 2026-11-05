import { isJurisdiction, type Jurisdiction } from "./jurisdiction";
import { AMENITIES, AU_BOUNDS, MAX_ROOMS, isAmenity, type Amenity } from "./listing-details";
import type { PropertyListing, PropertyType, UseClass } from "./listing";

export const SORTS = ["newest", "price_asc", "price_desc", "bedrooms_desc", "distance"] as const;
export type Sort = (typeof SORTS)[number];
export const SEARCH_PAGE_SIZE = 12;
export const MAX_SEARCH_PAGE_SIZE = 50;
export const MAX_PAGE = 10_000;
/** Pins the map asks for at once. Beyond this the map tells the person to zoom in or filter. */
export const MAX_MAP_PINS = 500;

/** Visible map area in decimal degrees. Never crosses the antimeridian (Australia does not). */
export interface Bbox { south: number; west: number; north: number; east: number }

/** Search radius around a point. Needs listings with a map pin. */
export interface Near { latitude: number; longitude: number; radiusKm: number }
export const MAX_RADIUS_KM = 100;
export const MAX_SEARCH_WORDS = 8;
export const MAX_SEARCH_TEXT = 100;

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
  /** Words typed in the search bar. Every word must start a word in the title, address, suburb or description. */
  q?: string;
  /** Listings must have every one of these. */
  amenities?: Amenity[];
  /** Only listings with a map pin within radiusKm of the point. Sort "distance" needs it. */
  near?: Near;
  /** Only listings with a map pin inside this box. */
  bbox?: Bbox;
  /** Only listings that have a map pin. Set by the map endpoint, never read from the URL. */
  located?: boolean;
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
  const bbox = parseBbox(p.get("bbox"));
  if (bbox) q.bbox = bbox;
  const text = p.get("q")?.trim();
  if (text && text.length <= MAX_SEARCH_TEXT && searchWords(text).length > 0) q.q = text;
  const am = parseAmenityList(p.get("amenities"));
  if (am.length > 0) q.amenities = am;
  const near = parseNear(p.get("lat"), p.get("lng"), p.get("radiusKm"));
  if (near) q.near = near;
  const sort = SORTS.find(s => s === p.get("sort"));
  // Distance order only makes sense around a point; otherwise the default order applies.
  if (sort && (sort !== "distance" || near)) q.sort = sort;
  const size = int(p.get("pageSize"), 1, MAX_SEARCH_PAGE_SIZE);
  if (size !== undefined) q.pageSize = size;
  const page = int(p.get("page"), 1, MAX_PAGE);
  if (page !== undefined) q.page = page;
  return q;
}

/** Lower-case letters and digits, at most MAX_SEARCH_WORDS words of 40 characters. Same rule in memory and in SQL, so both agree. */
export function searchWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length <= 40).slice(0, MAX_SEARCH_WORDS);
}

/** "pool,solar" to known amenities in the fixed order. Unknown names are dropped. */
export function parseAmenityList(v: string | null): Amenity[] {
  if (!v) return [];
  const parts = v.split(",").map(x => x.trim());
  return AMENITIES.filter(a => parts.includes(a));
}
export { isAmenity };

/** lat, lng and radiusKm together, inside Australia, radius 1 to MAX_RADIUS_KM. Anything else is dropped. */
export function parseNear(lat: string | null, lng: string | null, radius: string | null): Near | undefined {
  const num = (v: string | null) => (v !== null && /^-?\d{1,3}(\.\d{1,6})?$/.test(v) ? Number(v) : undefined);
  const la = num(lat), lo = num(lng), r = radius !== null && /^\d{1,3}(\.\d)?$/.test(radius) ? Number(radius) : undefined;
  if (la === undefined || lo === undefined || r === undefined) return undefined;
  if (la < AU_BOUNDS.south || la > AU_BOUNDS.north || lo < AU_BOUNDS.west || lo > AU_BOUNDS.east || r < 1 || r > MAX_RADIUS_KM) return undefined;
  return { latitude: la, longitude: lo, radiusKm: r };
}

const EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
/** Great-circle distance in km (haversine). */
export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Box that contains the whole circle. Used to narrow the SQL scan before the exact distance check. */
export function bboxAround(n: Near): Bbox {
  const dLat = (n.radiusKm / EARTH_KM) * (180 / Math.PI);
  const dLng = dLat / Math.max(0.01, Math.cos(rad(n.latitude)));
  return { south: n.latitude - dLat, north: n.latitude + dLat, west: n.longitude - dLng, east: n.longitude + dLng };
}

/** "south,west,north,east" in decimal degrees. Undefined when malformed, inverted or out of range. */
export function parseBbox(v: string | null): Bbox | undefined {
  if (!v) return undefined;
  const parts = v.split(",");
  if (parts.length !== 4 || !parts.every(x => /^-?\d{1,3}(\.\d{1,8})?$/.test(x.trim()))) return undefined;
  const [south, west, north, east] = parts.map(Number) as [number, number, number, number];
  if (south < -90 || north > 90 || west < -180 || east > 180 || south >= north || west >= east) return undefined;
  return { south, west, north, east };
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
  if (q.q) {
    const words = (`${l.title} ${l.address} ${l.suburb ?? ""} ${l.description ?? ""}`.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    if (!searchWords(q.q).every(w => words.some(x => x.startsWith(w)))) return false;
  }
  if (q.amenities && !q.amenities.every(a => l.amenities?.includes(a))) return false;
  if ((q.located || q.bbox || q.near) && (l.latitude === undefined || l.longitude === undefined)) return false;
  if (q.bbox && !(l.latitude! >= q.bbox.south && l.latitude! <= q.bbox.north && l.longitude! >= q.bbox.west && l.longitude! <= q.bbox.east)) return false;
  if (q.near && distanceKm(q.near.latitude, q.near.longitude, l.latitude!, l.longitude!) > q.near.radiusKm) return false;
  return true;
}

/** Listings without the sort field go last. Ties break by newest, then id, so pages never overlap. */
export function compareListings(sort: Sort, near?: Near): (a: PropertyListing, b: PropertyListing) => number {
  const tie = (a: PropertyListing, b: PropertyListing) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  const num = (get: (l: PropertyListing) => number | undefined, dir: 1 | -1) => (a: PropertyListing, b: PropertyListing) => {
    const x = get(a), y = get(b);
    if (x === undefined && y === undefined) return tie(a, b);
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    return x === y ? tie(a, b) : (x - y) * dir;
  };
  if (sort === "distance" && near) return num(l => (l.latitude === undefined || l.longitude === undefined ? undefined : distanceKm(near.latitude, near.longitude, l.latitude, l.longitude)), 1);
  if (sort === "price_asc") return num(l => l.priceCents, 1);
  if (sort === "price_desc") return num(l => l.priceCents, -1);
  if (sort === "bedrooms_desc") return num(l => l.bedrooms, -1);
  return tie;
}

/** In-memory reference implementation, used by the test repository. The PostgreSQL repository does the same in SQL. */
export function searchInMemory(all: readonly PropertyListing[], q: SearchQuery): SearchPage<PropertyListing> {
  const hits = all.filter(l => l.status === "published" && matchesQuery(l, q)).sort(compareListings(q.sort, q.near));
  const start = (q.page - 1) * q.pageSize;
  return { items: hits.slice(start, start + q.pageSize), total: hits.length, page: q.page, pageSize: q.pageSize };
}
