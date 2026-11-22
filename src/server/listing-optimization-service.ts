import type { PropertyListing } from "../domain/listing";
import { generateSuggestions, type ListingFacts, type OptimizationSettings, type PhotoFacts, type PriceFacts } from "../domain/listing-optimization";
import { VARIANT_WIDTH } from "../domain/listing-photos";
import type { Comparable } from "../domain/price-guidance";
import { pricingAdvice, type SellerSubject } from "../domain/seller-insights";
import type { Queryable } from "./db";
import { noteMany } from "./elena-wiring-db";
import { listSuggestions, syncSuggestions, type StoredSuggestion } from "./listing-optimization-db";
import { createPgPhotoStore } from "./photos-db";
import { getIntelligenceSource } from "./property-intelligence";
import { getSellerInsights } from "./seller-insights-db";

/** What the gallery records for a listing: visible photos only, judged by size, room and caption (never by the picture itself). */
export async function photoFacts(db: Queryable, listingId: string): Promise<PhotoFacts> {
  const store = createPgPhotoStore(db);
  const [layout, records] = await Promise.all([store.currentLayout(listingId), store.photosForListing(listingId)]);
  const byId = new Map(records.map(r => [r.id, r]));
  const f: PhotoFacts = { visibleCount: 0, floorplans: 0, lowResCount: 0, categories: {}, captioned: 0, hasTour: layout.tourUrl !== null };
  for (const e of layout.entries) {
    const r = byId.get(e.photoId);
    if (!r || e.hidden) continue;
    if (r.kind === "floorplan") { f.floorplans++; continue; }
    if (r.kind !== "photo") continue;
    f.visibleCount++;
    if (r.width < VARIANT_WIDTH.medium) f.lowResCount++;
    if (e.caption.trim()) f.captioned++;
    const k = e.category ?? "";
    f.categories[k] = (f.categories[k] ?? 0) + 1;
  }
  return f;
}

async function priceFacts(db: Queryable, l: PropertyListing, now: string): Promise<PriceFacts | undefined> {
  if (l.transactionType !== "sale" || !l.priceCents || (!l.suburb && !l.postcode)) return undefined;
  const subject: SellerSubject = {
    transactionType: "sale", propertyType: l.propertyType,
    ...(l.suburb !== undefined ? { suburb: l.suburb } : {}), ...(l.postcode !== undefined ? { postcode: l.postcode } : {}),
    ...(l.bedrooms !== undefined ? { bedrooms: l.bedrooms } : {}), ...(l.bathrooms !== undefined ? { bathrooms: l.bathrooms } : {}), ...(l.parking !== undefined ? { parking: l.parking } : {})
  };
  let comps: Comparable[] | undefined;
  const load = async () => (comps ??= await getIntelligenceSource(db).find(subject, now).catch(() => []));
  const insights = await getSellerInsights(db, subject, now, load);
  if (insights.comparables.state !== "ready") return undefined;
  const advice = pricingAdvice("balanced", subject, await load(), now);
  if (advice.state !== "ready") return undefined;
  const dir = insights.comparables.direction;
  return { medianCents: insights.comparables.medianCents, balancedCents: advice.recommendedCents, sample: insights.comparables.count, ...(dir === "up" || dir === "down" || dir === "flat" ? { trend: dir } : {}) };
}

/** Works out the suggestions for one listing now, keeps them in step with the stored ones and returns everything stored. */
export async function optimizeListing(db: Queryable, l: PropertyListing, settings: OptimizationSettings, now: string): Promise<StoredSuggestion[]> {
  const facts: ListingFacts = {
    transactionType: l.transactionType, propertyType: l.propertyType, description: l.description, priceCents: l.priceCents,
    bedrooms: l.bedrooms, bathrooms: l.bathrooms, parking: l.parking, suburb: l.suburb, postcode: l.postcode, amenities: l.amenities ?? [],
    photos: await photoFacts(db, l.id)
  };
  const found = generateSuggestions(facts, await priceFacts(db, l, now).catch(() => undefined), settings);
  await syncSuggestions(db, l.id, found, now);
  const stored = await listSuggestions(db, l.id, now);
  // The stored row's id is the suggestion id: the weekly sweep reads implemented / dismissed from that row.
  await noteMany(db, stored.filter(s => s.status === "open").map(s => ({ id: s.id, feature: "listing_optimization" as const, type: s.type, userId: l.ownerUserId, userRole: "owner", region: l.jurisdiction, listingId: l.id })));
  return stored;
}
