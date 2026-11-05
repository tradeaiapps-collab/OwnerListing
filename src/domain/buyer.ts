import type { Jurisdiction } from "./jurisdiction";
import type { Amenity } from "./listing-details";
import { distanceKm, type Near } from "./listing-search";
import type { ListingStatus, PropertyListing, PropertyType, UseClass } from "./listing";

/** Searches use only property facts. There are deliberately no demographic fields. */
export interface SavedSearch {
  id: string;
  buyerUserId: string;
  transactionType: "sale" | "rent";
  useClass: UseClass;
  jurisdictions: readonly Jurisdiction[];
  suburbs: readonly string[];
  propertyTypes: readonly PropertyType[];
  minPriceCents?: number;
  maxPriceCents?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  minParking?: number;
  /** The listing must have every one of these. */
  amenities?: readonly Amenity[];
  /** Within radiusKm of a point. A listing with no map pin never matches. */
  near?: Near;
  active: boolean;
}

export interface ListingSummary {
  id: string;
  status: ListingStatus;
  jurisdiction: Jurisdiction;
  /** Missing until the owner fills it in. A search that names suburbs never matches a listing without one. */
  suburb?: string;
  transactionType: "sale" | "rent";
  useClass: UseClass;
  propertyType: PropertyType;
  /** Sale price, or rent per week, in cents. A search with a price limit never matches a listing without a price. */
  priceCents?: number;
  bedrooms?: number;
  bathrooms?: number;
  parking?: number;
  amenities?: readonly Amenity[];
  /** Map pin, only used for distance searches. */
  latitude?: number;
  longitude?: number;
}

/** The only fields alerts and saved searches may see of a listing. Owner, address, title and documents are left out on purpose. */
export function toListingSummary(l: PropertyListing): ListingSummary {
  return {
    id: l.id, status: l.status, jurisdiction: l.jurisdiction, transactionType: l.transactionType,
    useClass: l.useClass, propertyType: l.propertyType,
    ...(l.suburb !== undefined ? { suburb: l.suburb } : {}),
    ...(l.priceCents !== undefined ? { priceCents: l.priceCents } : {}),
    ...(l.bedrooms !== undefined ? { bedrooms: l.bedrooms } : {}),
    ...(l.bathrooms !== undefined ? { bathrooms: l.bathrooms } : {}),
    ...(l.parking !== undefined ? { parking: l.parking } : {}),
    ...(l.amenities !== undefined ? { amenities: l.amenities } : {}),
    ...(l.latitude !== undefined && l.longitude !== undefined ? { latitude: l.latitude, longitude: l.longitude } : {})
  };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function matchesSearch(s: SavedSearch, l: ListingSummary): boolean {
  if (!s.active || l.status !== "published") return false;
  if (s.transactionType !== l.transactionType || s.useClass !== l.useClass) return false;
  if (s.jurisdictions.length > 0 && !s.jurisdictions.includes(l.jurisdiction)) return false;
  const suburb = l.suburb;
  if (s.suburbs.length > 0 && (suburb === undefined || !s.suburbs.some(x => same(x, suburb)))) return false;
  if (s.propertyTypes.length > 0 && !s.propertyTypes.includes(l.propertyType)) return false;
  if (s.minPriceCents !== undefined && (l.priceCents === undefined || l.priceCents < s.minPriceCents)) return false;
  if (s.maxPriceCents !== undefined && (l.priceCents === undefined || l.priceCents > s.maxPriceCents)) return false;
  if (s.minBedrooms !== undefined && (l.bedrooms === undefined || l.bedrooms < s.minBedrooms)) return false;
  if (s.minBathrooms !== undefined && (l.bathrooms === undefined || l.bathrooms < s.minBathrooms)) return false;
  if (s.minParking !== undefined && (l.parking === undefined || l.parking < s.minParking)) return false;
  if (s.amenities && !s.amenities.every(a => l.amenities?.includes(a))) return false;
  if (s.near) {
    if (l.latitude === undefined || l.longitude === undefined) return false;
    if (distanceKm(s.near.latitude, s.near.longitude, l.latitude, l.longitude) > s.near.radiusKm) return false;
  }
  return true;
}

export interface AlertPreference {
  channel: "email" | "sms";
  /** Set when the buyer opted in. No consent, no alerts. */
  consentGivenAt?: string;
  unsubscribedAt?: string;
}

export function mayAlert(p: AlertPreference | undefined): boolean {
  return p !== undefined && p.consentGivenAt !== undefined && p.unsubscribedAt === undefined;
}

export interface PlannedAlert { buyerUserId: string; searchId: string; channel: "email" | "sms"; listingId: string }

/** One alert per buyer and channel for a new listing, even if several of their searches match. */
export function planAlerts(
  listing: ListingSummary, searches: readonly SavedSearch[],
  prefsByBuyer: Readonly<Record<string, readonly AlertPreference[]>>
): PlannedAlert[] {
  const seen = new Set<string>();
  const out: PlannedAlert[] = [];
  for (const s of searches) {
    if (!matchesSearch(s, listing)) continue;
    for (const p of prefsByBuyer[s.buyerUserId] ?? []) {
      const key = `${s.buyerUserId}:${p.channel}`;
      if (!mayAlert(p) || seen.has(key)) continue;
      seen.add(key);
      out.push({ buyerUserId: s.buyerUserId, searchId: s.id, channel: p.channel, listingId: listing.id });
    }
  }
  return out;
}

/** idVerified means the ID document was checked against government records and a live selfie matched the photo. */
export interface BuyerVerification { emailVerified: boolean; phoneVerified: boolean; idVerified: boolean }

/** Anyone with a verified email can sign up, browse, save searches and set alerts. */
export function canExplore(v: BuyerVerification): boolean {
  return v.emailVerified;
}

/** Enquiring, chatting with an owner, making an offer and applying all need the full check. */
export function canContactSeller(v: BuyerVerification): boolean {
  return v.emailVerified && v.phoneVerified && v.idVerified;
}

export type VerificationStep = "verify_email" | "verify_phone" | "verify_id";

/** The next step to show when a buyer tries to contact a seller. null means they may go ahead. */
export function nextVerificationStep(v: BuyerVerification): VerificationStep | null {
  if (!v.emailVerified) return "verify_email";
  if (!v.phoneVerified) return "verify_phone";
  if (!v.idVerified) return "verify_id";
  return null;
}

export type StepStatus = "done" | "current" | "waiting";
export interface StepState { step: VerificationStep; status: StepStatus }

/** Status of each step in order: finished steps are done, the next one is current, later ones wait. Status only, no personal data. */
export function verificationSteps(v: BuyerVerification): StepState[] {
  const order: VerificationStep[] = ["verify_email", "verify_phone", "verify_id"];
  const next = nextVerificationStep(v);
  const reached = next === null ? order.length : order.indexOf(next);
  return order.map((step, i) => ({ step, status: i < reached ? "done" : i === reached ? "current" : "waiting" }));
}
