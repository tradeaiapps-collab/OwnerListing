import type { SearchQuery, Sort } from "../domain/listing-search";

/** Fixed ORDER BY text per sort. Never built from user input. NULLS LAST keeps unpriced listings at the end. */
const ORDER: Record<Sort, string> = {
  newest: "l.created_at DESC, l.id DESC",
  price_asc: "l.price_cents ASC NULLS LAST, l.created_at DESC, l.id DESC",
  price_desc: "l.price_cents DESC NULLS LAST, l.created_at DESC, l.id DESC",
  bedrooms_desc: "l.bedrooms DESC NULLS LAST, l.created_at DESC, l.id DESC"
};

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
  return { where: clauses.join(" AND "), params, orderBy: ORDER[q.sort] };
}
