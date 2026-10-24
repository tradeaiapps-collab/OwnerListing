import { evaluatePublish, type PropertyListing, type PublishDecision } from "./listing";
import { hasVerifiedLicence, type AgentLicence } from "./licence";
import type { TrustAccountDecision } from "./trust-account";
import { licenceLocalDate } from "./timezone";

/**
 * Single entry point for publish decisions. Derives the agent licence flag from
 * licence records so callers cannot pass an unverified agent as verified.
 */
/** Where a rental bond or deposit sits. The platform never holds it. Rules differ by state; counsel to confirm. */
export type BondPathway = "state_bond_authority" | "solicitor_trust" | "bank_guarantee" | "no_bond";

export function decidePublish(
  listing: PropertyListing,
  requiredDisclosureKeys: readonly string[],
  licences: readonly AgentLicence[],
  /** The current instant (ISO). Licence expiry is judged on its date in the listing state's own time zone. */
  now: string,
  options: { actingAgentId?: string; trustAccount?: TrustAccountDecision; termsAccepted?: boolean; rentalBondPathway?: BondPathway; listingFeePaid?: boolean } = {}
): PublishDecision {
  const { actingAgentId, trustAccount, termsAccepted, rentalBondPathway, listingFeePaid } = options;
  const today = licenceLocalDate(now, listing.jurisdiction); // undefined fails closed
  const ownerLicenceOk =
    listing.ownerUserType !== "agent" ||
    (today !== undefined && hasVerifiedLicence(licences, listing.ownerUserId, listing.jurisdiction, today));
  const actingAgentLicenceOk =
    actingAgentId === undefined ||
    (today !== undefined && hasVerifiedLicence(licences, actingAgentId, listing.jurisdiction, today));
  const licenceOk = ownerLicenceOk && actingAgentLicenceOk;
  const base = evaluatePublish(listing, requiredDisclosureKeys, licenceOk);
  // evaluatePublish only reports a licence failure for agent owners; report the acting agent's too (fail closed).
  if (!actingAgentLicenceOk) {
    base.reasons.push("Acting agent licence must be verified and current before publication.");
    base.allowed = false;
  }
  if (termsAccepted !== true) {
    base.reasons.push("The current terms and conditions have not been accepted.");
    base.allowed = false;
  }
  // The owner pays our listing or plan fee before anything is listed. This is the platform's own fee, not a deposit.
  if (listingFeePaid !== true) {
    base.reasons.push("The listing fee or plan has not been paid.");
    base.allowed = false;
  }
  // Fail closed. Sales need an approved trust account for the deposit. Rentals must confirm how the bond
  // is held, and need an approved trust account only if the bond goes to a solicitor's trust account.
  const isRent = listing.transactionType === "rent";
  if (isRent && rentalBondPathway === undefined) {
    base.reasons.push("The rental bond or deposit arrangement is not confirmed.");
    base.allowed = false;
  }
  const needsTrustAccount = !isRent || rentalBondPathway === "solicitor_trust";
  if (needsTrustAccount && (!trustAccount || trustAccount.kind !== "approved")) {
    base.reasons.push("Trust account is not verified and approved for this listing.");
    base.allowed = false;
  }
  return base;
}
