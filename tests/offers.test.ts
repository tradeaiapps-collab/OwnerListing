import { describe, expect, it } from "vitest";
import { evaluateOfferAction, type NegotiationMandate, type OfferContext } from "../src/domain/offers";

const mandate: NegotiationMandate = {
  listingId: "lst-1",
  version: 1,
  floorPriceCents: 115000000,
  targetPriceCents: 124000000,
  maxCounterRounds: 3,
  maxConcessionBpsPerRound: 200,
  autoModeEnabled: false,
  approvedConditions: ["finance_14_days", "building_pest"]
};

const offer: OfferContext = {
  offerId: "off-1",
  listingId: "lst-1",
  priceCents: 120000000,
  counterRound: 1,
  conditions: ["finance_14_days"],
  proposedConcessionBps: 100
};

describe("evaluateOfferAction", () => {
  it("never allows AI to accept an offer", () => {
    const result = evaluateOfferAction("accept", offer, mandate);
    expect(result.mayDraft).toBe(false);
    expect(result.requiresHumanApproval).toBe(true);
  });

  it("escalates offers below confidential floor without returning the floor value", () => {
    const result = evaluateOfferAction("recommend_counter", { ...offer, priceCents: 100000000 }, mandate);
    expect(result.requiresHumanApproval).toBe(true);
    expect(JSON.stringify(result)).not.toContain("115000000");
  });

  it("requires owner approval in assisted mode", () => {
    const result = evaluateOfferAction("recommend_counter", offer, mandate);
    expect(result.requiresHumanApproval).toBe(true);
  });

  it("escalates a counter that concedes more than the per-round limit", () => {
    const result = evaluateOfferAction("recommend_counter", { ...offer, proposedConcessionBps: 300 }, mandate);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.reason).toMatch(/per-round limit/);
  });

  it("escalates unsupported conditions", () => {
    const result = evaluateOfferAction("recommend_counter", { ...offer, conditions: ["subject_to_sale"] }, mandate);
    expect(result.requiresHumanApproval).toBe(true);
  });
});
