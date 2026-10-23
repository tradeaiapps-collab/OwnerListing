export type OfferAction = "draft_reply" | "request_information" | "recommend_counter" | "accept" | "reject";

export interface NegotiationMandate {
  listingId: string;
  version: number;
  floorPriceCents: number;
  targetPriceCents: number;
  maxCounterRounds: number;
  maxConcessionBpsPerRound: number;
  autoModeEnabled: boolean;
  approvedConditions: string[];
}

export interface OfferContext {
  offerId: string;
  listingId: string;
  priceCents: number;
  counterRound: number;
  conditions: string[];
  /** Concession (in basis points off the previous ask) the AI proposes this round. Computed by the caller. */
  proposedConcessionBps: number;
}

export interface OfferPolicyDecision {
  /** True if the AI may produce a draft for human review. Never means a message was sent. */
  mayDraft: boolean;
  requiresHumanApproval: boolean;
  /** False when the situation is outside the owner's mandate and the owner must decide. */
  withinMandate: boolean;
  reason: string;
}

/**
 * AI is advisory. It can never accept an offer, and any response outside mandate
 * limits requires human approval. The floor price must never be included in buyer
 * messages or exposed through this decision object.
 */
export function evaluateOfferAction(
  action: OfferAction,
  offer: OfferContext,
  mandate: NegotiationMandate
): OfferPolicyDecision {
  if (offer.listingId !== mandate.listingId) {
    return { mayDraft: false, requiresHumanApproval: true, withinMandate: false, reason: "Mandate/listing mismatch." };
  }

  if (action === "accept") {
    return { mayDraft: false, requiresHumanApproval: true, withinMandate: false, reason: "Offer acceptance always requires explicit human action." };
  }

  if (offer.counterRound > mandate.maxCounterRounds) {
    return { mayDraft: true, requiresHumanApproval: true, withinMandate: false, reason: "Counter-round limit exceeded; escalate to owner." };
  }

  const unsupportedCondition = offer.conditions.some(c => !mandate.approvedConditions.includes(c));
  if (unsupportedCondition) {
    return { mayDraft: true, requiresHumanApproval: true, withinMandate: false, reason: "Offer contains a condition outside the approved mandate." };
  }

  if (offer.priceCents < mandate.floorPriceCents) {
    return { mayDraft: true, requiresHumanApproval: true, withinMandate: false, reason: "Offer is below the confidential floor; escalate without disclosing the floor." };
  }

  if (offer.proposedConcessionBps > mandate.maxConcessionBpsPerRound) {
    return { mayDraft: true, requiresHumanApproval: true, withinMandate: false, reason: "Proposed concession exceeds the per-round limit; escalate to owner." };
  }

  if (action === "recommend_counter" && !mandate.autoModeEnabled) {
    return { mayDraft: true, requiresHumanApproval: true, withinMandate: true, reason: "Assisted mode requires owner approval before sending." };
  }

  return { mayDraft: true, requiresHumanApproval: true, withinMandate: true, reason: "Draft only; human approval remains required in this initial build." };
}
