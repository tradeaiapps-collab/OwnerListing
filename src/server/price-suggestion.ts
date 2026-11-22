import { parseComparables, type Comparable } from "../domain/price-guidance";
import {
  buildPriceSuggestion, type AskingListing, type PriceProvider, type PriceSuggestion, type SuggestionSubject
} from "../domain/price-suggestion";
import type { Jurisdiction } from "../domain/jurisdiction";
import type { Queryable } from "./db";
import { getIntelligenceSource } from "./property-intelligence";
import { getSuburbPg } from "./suburb-data-db";

const ASKING_LOOKBACK_DAYS = 365;

/**
 * Licensed provider hook. None is connected today: set up PRICE_PROVIDER in a later change by returning a PriceProvider here
 * (see docs/ELENA_PRICE_SUGGESTION.md). The file source (PRICE_DATA_SOURCE=file) already feeds sold results through getIntelligenceSource.
 */
export function getPriceProvider(_env: Record<string, string | undefined> = process.env): PriceProvider | undefined {
  return undefined;
}

/**
 * Other published listings with a price in the same suburb or postcode (asking prices, never the subject itself), newest first, at most 60.
 * Parameterised SQL. Land size comes from the linked property record when there is one.
 */
export async function loadAskingListings(db: Queryable, listingId: string, s: SuggestionSubject, now: string): Promise<AskingListing[]> {
  if (!s.suburb && !s.postcode) return [];
  try {
    const r = await db.query(
      `SELECT l.id, l.transaction_type, l.property_type, l.price_cents, l.created_at, l.suburb, l.postcode, l.bedrooms, l.bathrooms, l.parking, l.address_text, p.land_area_sqm
         FROM property_listing l LEFT JOIN property p ON p.id = l.property_id
        WHERE l.status = 'published' AND l.deleted_at IS NULL AND l.outcome IS NULL AND l.id <> $1::uuid AND l.transaction_type = $2 AND l.price_cents > 0
          AND l.created_at >= $3::timestamptz - ($4::int * interval '1 day') AND l.created_at <= $3::timestamptz
          AND (($5::text IS NOT NULL AND lower(btrim(l.suburb)) = lower(btrim($5::text))) OR ($6::text IS NOT NULL AND l.postcode = $6::text))
        ORDER BY l.created_at DESC LIMIT 60`,
      [listingId, s.transactionType, now, ASKING_LOOKBACK_DAYS, s.suburb ?? null, s.postcode ?? null]
    );
    const rows = r.rows.map(x => ({
      id: `listing:${String(x["id"])}`, transactionType: x["transaction_type"], propertyType: x["property_type"], priceCents: Number(x["price_cents"]),
      date: new Date(String(x["created_at"])).toISOString(), suburb: x["suburb"] ?? s.suburb ?? "", ...(x["postcode"] ? { postcode: String(x["postcode"]).trim() } : {}),
      ...(x["bedrooms"] != null ? { bedrooms: Number(x["bedrooms"]) } : {}), ...(x["bathrooms"] != null ? { bathrooms: Number(x["bathrooms"]) } : {}),
      ...(x["parking"] != null ? { parking: Number(x["parking"]) } : {}), ...(x["land_area_sqm"] != null ? { areaSqm: Number(x["land_area_sqm"]) } : {}),
      // Street number and name are not shown to other owners: suburb only.
      label: `Listing in ${String(x["suburb"] ?? s.suburb ?? "the area")}`
    }));
    return parseComparables(rows) as AskingListing[];
  } catch { return []; }
}

async function inspectionReportCount(db: Queryable, listingId: string): Promise<number> {
  try {
    const r = await db.query("SELECT count(*)::int AS n FROM property_document WHERE listing_id = $1::uuid AND kind IN ('building_inspection','pest_report')", [listingId]);
    return Number(r.rows[0]?.["n"] ?? 0);
  } catch { return 0; }
}

async function landSize(db: Queryable, listingId: string): Promise<number | undefined> {
  try {
    const r = await db.query("SELECT p.land_area_sqm FROM property_listing l JOIN property p ON p.id = l.property_id WHERE l.id = $1::uuid", [listingId]);
    const v = r.rows[0]?.["land_area_sqm"];
    return v != null && Number(v) > 0 ? Number(v) : undefined;
  } catch { return undefined; }
}

/** Gathers what the database holds and runs the pure rules. Never throws: failures just mean less data. */
export async function suggestPrice(
  db: Queryable, listingId: string, jurisdiction: string, subject: SuggestionSubject, now: string, env: Record<string, string | undefined> = process.env
): Promise<PriceSuggestion> {
  const provider = getPriceProvider(env);
  const withLand: SuggestionSubject = { ...subject, ...(subject.landAreaSqm === undefined ? await landSize(db, listingId).then(v => (v ? { landAreaSqm: v } : {})) : {}) };
  const [intel, extra, asking, suburbRow, reports, valuation] = await Promise.all([
    getIntelligenceSource(db, env).find(withLand, now).catch((): Comparable[] => []),
    provider?.sales ? provider.sales(withLand, now).catch((): Comparable[] => []) : Promise.resolve([] as Comparable[]),
    loadAskingListings(db, listingId, withLand, now),
    withLand.suburb ? getSuburbPg(db, jurisdiction as Jurisdiction, withLand.suburb).catch(() => null) : Promise.resolve(null),
    inspectionReportCount(db, listingId),
    provider?.valuation ? provider.valuation(withLand, now).catch(() => undefined) : Promise.resolve(undefined)
  ]);
  const seen = new Set<string>();
  const sales = [...intel, ...extra].filter(c => !seen.has(c.id) && (seen.add(c.id), true));
  return buildPriceSuggestion({
    subject: withLand, sales, asking,
    ...(suburbRow ? { suburb: { metrics: suburbRow.metrics, source: suburbRow.source, asAt: suburbRow.asAt } } : {}),
    ...(provider && valuation ? { valuation: { provider: provider.id, label: provider.label, value: valuation } } : {}),
    inspectionReports: reports, now
  });
}
