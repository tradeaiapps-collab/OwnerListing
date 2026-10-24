import type { DocumentKind } from "./documents";

export type Feature =
  | "video" | "photo_360" | "video_360"
  | "ai_description" | "ai_auto_reply" | "ai_applicant_report" | "contract_drafting";

export interface PlanDef {
  id: string;
  name: string;
  maxPhotos: number;
  storageGb: number;
  features: readonly Feature[];
  /** Set by an admin, in cents excluding GST. null means not priced yet, so it cannot be bought. */
  priceCents: number | null;
}

/** Starting entitlements only. Prices are deliberately unset: an admin allocates them. */
export const DEFAULT_PLANS: readonly PlanDef[] = [
  { id: "basic", name: "Basic", maxPhotos: 15, storageGb: 1, features: [], priceCents: null },
  { id: "standard", name: "Standard", maxPhotos: 40, storageGb: 10,
    features: ["video", "photo_360", "ai_description", "ai_auto_reply"], priceCents: null },
  { id: "premium", name: "Premium", maxPhotos: 100, storageGb: 50,
    features: ["video", "photo_360", "video_360", "ai_description", "ai_auto_reply", "ai_applicant_report", "contract_drafting"],
    priceCents: null }
];

export interface Subscription {
  ownerUserId: string;
  planId: string;
  addOns: readonly Feature[];
  status: "active" | "expired" | "cancelled";
  /** ISO timestamp. */
  endsAt: string;
  /** Price locked at purchase. Later admin price changes do not alter it. */
  priceSnapshotCents: number;
}

export function hasFeature(plan: PlanDef, sub: Subscription | undefined, feature: Feature, now: string): boolean {
  if (!sub || sub.status !== "active" || sub.endsAt < now || sub.planId !== plan.id) return false;
  return plan.features.includes(feature) || sub.addOns.includes(feature);
}

export function featureForKind(kind: DocumentKind): Feature | null {
  return kind === "video" || kind === "photo_360" || kind === "video_360" ? kind : null;
}

/** Ordinary photos, floorplans and documents are open to everyone. Video and 360 need the feature. */
export function canUploadKind(plan: PlanDef, sub: Subscription | undefined, kind: DocumentKind, now: string): boolean {
  const f = featureForKind(kind);
  return f === null || hasFeature(plan, sub, f, now);
}

export function withinPhotoLimit(plan: PlanDef, currentPhotoCount: number): boolean {
  return currentPhotoCount < plan.maxPhotos;
}

export type Quote = { ok: true; totalCents: number } | { ok: false; missing: string[] };

/** A plan can be bought only when the plan and every chosen add-on have an admin-set price. */
export function quote(plan: PlanDef, addOns: readonly Feature[], addOnPrices: Partial<Record<Feature, number>>): Quote {
  const missing: string[] = [];
  if (plan.priceCents === null) missing.push(`plan:${plan.id}`);
  let total = plan.priceCents ?? 0;
  for (const a of addOns) {
    const p = addOnPrices[a];
    if (p === undefined) missing.push(`add-on:${a}`); else total += p;
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, totalCents: total };
}

/** Entitlements from code with the admin-set prices (plan id to cents excluding GST) laid over them. Plans without a price stay null. */
export function withPrices(plans: readonly PlanDef[], prices: Readonly<Record<string, number>>): PlanDef[] {
  return plans.map(p => ({ ...p, priceCents: prices[p.id] ?? null }));
}
