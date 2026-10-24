import type { Jurisdiction } from "./jurisdiction";
import type { PropertyType, UseClass } from "./listing";

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
  active: boolean;
}

export interface ListingSummary {
  id: string;
  status: "draft" | "pending_review" | "published" | "withdrawn";
  jurisdiction: Jurisdiction;
  suburb: string;
  transactionType: "sale" | "rent";
  useClass: UseClass;
  propertyType: PropertyType;
  /** Sale price, or rent per period, in cents. */
  priceCents: number;
  bedrooms?: number;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function matchesSearch(s: SavedSearch, l: ListingSummary): boolean {
  if (!s.active || l.status !== "published") return false;
  if (s.transactionType !== l.transactionType || s.useClass !== l.useClass) return false;
  if (s.jurisdictions.length > 0 && !s.jurisdictions.includes(l.jurisdiction)) return false;
  if (s.suburbs.length > 0 && !s.suburbs.some(x => same(x, l.suburb))) return false;
  if (s.propertyTypes.length > 0 && !s.propertyTypes.includes(l.propertyType)) return false;
  if (s.minPriceCents !== undefined && l.priceCents < s.minPriceCents) return false;
  if (s.maxPriceCents !== undefined && l.priceCents > s.maxPriceCents) return false;
  if (s.minBedrooms !== undefined && (l.bedrooms === undefined || l.bedrooms < s.minBedrooms)) return false;
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
