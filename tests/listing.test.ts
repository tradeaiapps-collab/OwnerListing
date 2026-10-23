import { describe, expect, it } from "vitest";
import { evaluatePublish, type PropertyListing } from "../src/domain/listing";

const base: PropertyListing = {
  id: "lst-001",
  ownerUserId: "owner-001",
  ownerUserType: "owner",
  jurisdiction: "QLD",
  status: "draft",
  title: "Example property",
  propertyType: "house",
  useClass: "residential",
  transactionType: "sale",
  address: "Example address, QLD",
  disclosures: [{ key: "seller_disclosure_pack", jurisdiction: "QLD", satisfied: true }],
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z"
};

describe("evaluatePublish", () => {
  it("blocks publication when a required disclosure is missing", () => {
    const result = evaluatePublish(base, ["seller_disclosure_pack", "legal_review"], true);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes("legal_review"))).toBe(true);
  });

  it("allows a draft when required configured disclosures are satisfied", () => {
    const result = evaluatePublish(base, ["seller_disclosure_pack"], true);
    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("blocks an unverified agent", () => {
    const result = evaluatePublish({ ...base, ownerUserId: "agent-user-123", ownerUserType: "agent" }, ["seller_disclosure_pack"], false);
    expect(result.allowed).toBe(false);
  });
});
