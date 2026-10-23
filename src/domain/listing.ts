import type { Jurisdiction } from "./jurisdiction";

export type ListingStatus = "draft" | "pending_review" | "published" | "withdrawn";

export interface ListingDisclosure {
  key: string;
  jurisdiction: Jurisdiction;
  satisfied: boolean;
  evidenceReference?: string;
}

export type UseClass = "residential" | "commercial";
export type PropertyType =
  | "house" | "unit" | "townhouse" | "land"
  | "office" | "retail" | "industrial" | "warehouse" | "hospitality" | "other";

const RESIDENTIAL_ONLY: readonly PropertyType[] = ["house", "unit", "townhouse"];
const COMMERCIAL_ONLY: readonly PropertyType[] = ["office", "retail", "industrial", "warehouse", "hospitality"];

export interface PropertyListing {
  id: string;
  ownerUserId: string;
  /** Mirrors app_user.user_type for the listing's owner. Never inferred from IDs. */
  ownerUserType: "owner" | "agent" | "vendor" | "admin" | "project_owner" | "investor";
  jurisdiction: Jurisdiction;
  status: ListingStatus;
  title: string;
  propertyType: PropertyType;
  useClass: UseClass;
  transactionType: "sale" | "rent";
  address: string;
  disclosures: ListingDisclosure[];
  createdAt: string;
  updatedAt: string;
}

export interface PublishDecision {
  allowed: boolean;
  reasons: string[];
}

/**
 * Disclosure requirements are intentionally supplied by a compliance-owned
 * configuration. This function does not invent legal requirements.
 */
export function evaluatePublish(
  listing: PropertyListing,
  requiredDisclosureKeys: readonly string[],
  agentLicenceVerified: boolean
): PublishDecision {
  const reasons: string[] = [];

  if (!listing.title.trim()) reasons.push("Listing title is required.");
  if (!listing.address.trim()) reasons.push("Property address is required.");
  if (
    (listing.useClass === "commercial" && RESIDENTIAL_ONLY.includes(listing.propertyType)) ||
    (listing.useClass === "residential" && COMMERCIAL_ONLY.includes(listing.propertyType))
  ) {
    reasons.push("Property type does not match the residential or commercial setting.");
  }
  if (listing.status !== "draft" && listing.status !== "pending_review") {
    reasons.push("Only draft or pending-review listings can be published.");
  }

  const satisfiedKeys = new Set(
    listing.disclosures
      .filter(d => d.jurisdiction === listing.jurisdiction && d.satisfied)
      .map(d => d.key)
  );

  for (const key of requiredDisclosureKeys) {
    if (!satisfiedKeys.has(key)) {
      reasons.push(`Required disclosure is incomplete: ${key}.`);
    }
  }

  // The playbook requires agent licence verification before an agent can publish.
  // Owner publishing permissions must be governed by a separate legal/policy decision.
  if (listing.ownerUserType === "agent" && !agentLicenceVerified) {
    reasons.push("Agent licence must be verified before publication.");
  }

  return { allowed: reasons.length === 0, reasons };
}
