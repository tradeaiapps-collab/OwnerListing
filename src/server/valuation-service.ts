import type { PropertyListing } from "../domain/listing";
import { pricingGuideModel, type SellerSubject } from "../domain/seller-insights";
import { rentalYield, valuate, type Valuation, type ValuationSettings } from "../domain/valuation";
import type { Unavailable } from "../domain/seller-insights";
import type { Comparable } from "../domain/price-guidance";
import type { Queryable } from "./db";
import { getIntelligenceSource } from "./property-intelligence";
import { getSellerInsights } from "./seller-insights-db";

/**
 * The valuation for one sale listing: the cached seller figures for its area (comparable sales, price-to-days link) plus rental comparables
 * for the yield. Sale listings with a suburb or postcode only; anything else is "unavailable".
 */
export async function buildValuation(db: Queryable, l: PropertyListing, settings: ValuationSettings, now: string): Promise<Valuation | Unavailable> {
  if (l.transactionType !== "sale") return { state: "unavailable", message: "Valuations are for properties for sale." };
  if (!l.suburb && !l.postcode) return { state: "unavailable", message: "This listing has no suburb or postcode, so it cannot be compared with recent sales." };
  const subject: SellerSubject = {
    transactionType: "sale", propertyType: l.propertyType,
    ...(l.suburb !== undefined ? { suburb: l.suburb } : {}), ...(l.postcode !== undefined ? { postcode: l.postcode } : {}),
    ...(l.bedrooms !== undefined ? { bedrooms: l.bedrooms } : {}), ...(l.bathrooms !== undefined ? { bathrooms: l.bathrooms } : {}), ...(l.parking !== undefined ? { parking: l.parking } : {})
  };
  const source = getIntelligenceSource(db);
  let sales: Comparable[] | undefined;
  const loadSales = async () => (sales ??= await source.find(subject, now).catch(() => []));
  const insights = await getSellerInsights(db, subject, now, loadSales);
  const rentSubject = { ...subject, transactionType: "rent" as const };
  const rents = await source.find(rentSubject, now).catch((): Comparable[] => []);
  return valuate({
    askingCents: l.priceCents, propertyType: l.propertyType, amenities: l.amenities, comps: insights.comparables,
    priceDays: pricingGuideModel(insights.pricingGuide), rental: l.priceCents ? rentalYield(subject, rents, l.priceCents, now) : undefined, settings
  });
}
