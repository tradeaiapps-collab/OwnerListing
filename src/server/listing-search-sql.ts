import { bboxAround, searchWords, type SearchQuery, type Sort } from "../domain/listing-search";

/** Fixed ORDER BY text per sort. Never built from user input. NULLS LAST keeps unpriced listings at the end. */
const ORDER: Record<Sort, string> = {
  newest: "l.created_at DESC, l.id DESC",
  price_asc: "l.price_cents ASC NULLS LAST, l.created_at DESC, l.id DESC",
  price_desc: "l.price_cents DESC NULLS LAST, l.created_at DESC, l.id DESC",
  bedrooms_desc: "l.bedrooms DESC NULLS LAST, l.created_at DESC, l.id DESC",
  // Replaced by the distance expression in buildSearch when a point is given; without one it is the newest order.
  distance: "l.created_at DESC, l.id DESC"
};

/** Same expression as property_listing_fts_idx (db/20261105100000_listing_search.sql), with the table alias. */
export const SEARCH_DOC = "to_tsvector('simple', coalesce(l.title, '') || ' ' || coalesce(l.address_text, '') || ' ' || coalesce(l.suburb, '') || ' ' || coalesce(l.description, ''))";
const distanceSql = (lat: string, lng: string) =>
  `(2 * 6371 * asin(sqrt(least(1, power(sin(radians(l.latitude - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(l.latitude)) * power(sin(radians(l.longitude - ${lng}) / 2), 2)))))`;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

/**
 * Builds the WHERE clause and parameters for published-listing browse. Every user value goes in `params`;
 * the SQL text only ever contains fixed fragments and $n placeholders.
 */
export function buildSearch(q: SearchQuery): { where: string; params: unknown[]; orderBy: string } {
  const params: unknown[] = [];
  const clauses = ["l.status = 'published'"];
  const add = (sql: (ph: string) => string, value: unknown) => {
    params.push(value);
    clauses.push(sql(`$${params.length}`));
  };
  if (q.jurisdiction) add(p => `l.jurisdiction = ${p}`, q.jurisdiction);
  if (q.transactionType) add(p => `l.transaction_type = ${p}`, q.transactionType);
  if (q.useClass) add(p => `l.use_class = ${p}`, q.useClass);
  if (q.propertyType) add(p => `l.property_type = ${p}`, q.propertyType);
  if (q.minPriceCents !== undefined) add(p => `l.price_cents >= ${p}`, q.minPriceCents);
  if (q.maxPriceCents !== undefined) add(p => `l.price_cents <= ${p}`, q.maxPriceCents);
  if (q.minBedrooms !== undefined) add(p => `l.bedrooms >= ${p}`, q.minBedrooms);
  if (q.minBathrooms !== undefined) add(p => `l.bathrooms >= ${p}`, q.minBathrooms);
  if (q.minParking !== undefined) add(p => `l.parking >= ${p}`, q.minParking);
  if (q.suburb) add(p => `lower(l.suburb) LIKE ${p} ESCAPE '\\'`, `${escapeLike(q.suburb!.toLowerCase())}%`);
  if (q.postcode) add(p => `l.postcode = ${p}`, q.postcode);
  if (q.q) {
    // Each word is a prefix term, all required. Words are letters and digits only (searchWords), so the tsquery text cannot carry operators.
    add(p => `${SEARCH_DOC} @@ to_tsquery('simple', ${p})`, searchWords(q.q!).map(w => `${w}:*`).join(" & "));
  }
  if (q.amenities) add(p => `l.amenities @> ${p}::text[]`, q.amenities);
  if (q.located || q.bbox || q.near) clauses.push("l.latitude IS NOT NULL AND l.longitude IS NOT NULL");
  if (q.bbox) {
    add(p => `l.latitude >= ${p}`, q.bbox.south);
    add(p => `l.latitude <= ${p}`, q.bbox.north);
    add(p => `l.longitude >= ${p}`, q.bbox.west);
    add(p => `l.longitude <= ${p}`, q.bbox.east);
  }
  let orderBy = ORDER[q.sort];
  if (q.near) {
    const box = bboxAround(q.near);
    params.push(box.south, box.north, box.west, box.east, q.near.latitude, q.near.longitude, q.near.radiusKm);
    const n = params.length;
    const [s, no, w, e, lat, lng, km] = [n - 6, n - 5, n - 4, n - 3, n - 2, n - 1, n].map(i => `$${i}`) as [string, string, string, string, string, string, string];
    clauses.push(`l.latitude BETWEEN ${s} AND ${no} AND l.longitude BETWEEN ${w} AND ${e}`, `${distanceSql(lat, lng)} <= ${km}`);
    if (q.sort === "distance") orderBy = `${distanceSql(lat, lng)} ASC, l.created_at DESC, l.id DESC`;
  }
  return { where: clauses.join(" AND "), params, orderBy };
}
