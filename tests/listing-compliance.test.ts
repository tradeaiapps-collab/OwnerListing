import { describe, expect, it } from "vitest";
import { disclosureLabel, listingReference, toComplianceView, type ComplianceFacts } from "../src/domain/listing-compliance";

const base: ComplianceFacts = { jurisdiction: "QLD", createdAt: "2026-10-01T00:00:00.000Z", disclosures: [], required: null };
const TODAY = "2026-10-25";

describe("toComplianceView", () => {
  it("an owner-run listing with nothing set up", () => {
    const v = toComplianceView(base, TODAY);
    expect(v.seller).toEqual({ handledBy: "owner", agentLicenceVerified: false });
    expect(v.deposit).toEqual({ status: "not_set" });
    expect(v.requirementsConfigured).toBe(false);
    expect(v.outstanding).toBe(0);
    expect(v.listedAt).toBe(base.createdAt);
  });

  it("an appointed agent counts as licensed only with a verified, unexpired licence in the listing's state", () => {
    const agent = (jurisdiction: "QLD" | "NSW", expiresAt?: string) => ({
      userId: "a1", appointedAt: "2026-10-02T00:00:00.000Z",
      licences: [{ userId: "a1", jurisdiction, status: "verified" as const, ...(expiresAt ? { expiresAt } : {}) }]
    });
    expect(toComplianceView({ ...base, agent: agent("QLD", "2027-01-01") }, TODAY).seller)
      .toEqual({ handledBy: "agent", agentLicenceVerified: true, agentState: "QLD" });
    expect(toComplianceView({ ...base, agent: agent("NSW") }, TODAY).seller.agentLicenceVerified).toBe(false);
    expect(toComplianceView({ ...base, agent: agent("QLD", "2026-10-24") }, TODAY).seller.agentLicenceVerified).toBe(false);
  });

  it("deposits are verified only on an approved trust check; other decisions show as being checked without reasons", () => {
    expect(toComplianceView({ ...base, trust: { kind: "approved", reasons: [] }, firmName: "Harbour Legal" }, TODAY).deposit)
      .toEqual({ status: "verified", firmName: "Harbour Legal" });
    const pending = toComplianceView({ ...base, trust: { kind: "flagged_for_admin", reasons: ["internal note"] }, firmName: "X" }, TODAY).deposit;
    expect(pending).toEqual({ status: "checking" });
  });

  it("lists required disclosures even when missing, provided ones first, and counts what is outstanding", () => {
    const v = toComplianceView({
      ...base,
      required: ["pool_safety_certificate", "qld_seller_disclosure_statement"],
      disclosures: [
        { key: "qld_seller_disclosure_statement", satisfied: true, verifiedAt: "2026-10-03T00:00:00.000Z" },
        { key: "energy_rating", satisfied: false, verifiedAt: "2026-10-03T00:00:00.000Z" }
      ]
    }, TODAY);
    expect(v.disclosures.map(d => [d.key, d.satisfied, d.required])).toEqual([
      ["qld_seller_disclosure_statement", true, true],
      ["pool_safety_certificate", false, true],
      ["energy_rating", false, false]
    ]);
    expect(v.disclosures[0]?.verifiedAt).toBe("2026-10-03T00:00:00.000Z");
    // A verification date is only shown for something actually provided.
    expect(v.disclosures[2]?.verifiedAt).toBeUndefined();
    expect(v.outstanding).toBe(1);
    expect(v.requirementsConfigured).toBe(true);
  });

  it("never carries user ids into the view", () => {
    const v = toComplianceView({ ...base, agent: { userId: "secret-user-id", appointedAt: "x", licences: [] } }, TODAY);
    expect(JSON.stringify(v)).not.toContain("secret-user-id");
  });
});

describe("labels and reference", () => {
  it("names known keys and humanises unknown ones", () => {
    expect(disclosureLabel("vic_section_32")).toBe("Vendor's statement, section 32 (VIC)");
    expect(disclosureLabel("flood_overlay-notice")).toBe("Flood overlay notice");
    expect(disclosureLabel("__")).toBe("Disclosure");
  });
  it("makes a short upper-case reference from the id", () => {
    expect(listingReference("3f2a9c1e-7b4d-4c2a-9e1f-0a1b2c3d4e5f")).toBe("3F2A9C1E");
  });
});
