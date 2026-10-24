import { describe, expect, it } from "vitest";
import { decidePublish } from "../src/domain/publish";
import type { PropertyListing } from "../src/domain/listing";
import type { AgentLicence } from "../src/domain/licence";

const listing: PropertyListing = {
  id: "l1", ownerUserId: "owner1", ownerUserType: "owner", jurisdiction: "QLD", status: "draft",
  title: "Home", propertyType: "house", useClass: "residential", transactionType: "sale",
  address: "1 Test St", disclosures: [], createdAt: "2026-10-01", updatedAt: "2026-10-01"
};
const ok = { termsAccepted: true, listingFeePaid: true, trustAccount: { kind: "approved" as const, reasons: [] } };
const today = "2026-10-23";
const licenceReason = (r: string[]) => r.some(x => /licence/i.test(x));

describe("acting agent licence on an owner's listing", () => {
  it("allows publish with a verified, unexpired acting-agent licence", () => {
    const licences: AgentLicence[] = [{ userId: "ag1", jurisdiction: "QLD", status: "verified", expiresAt: "2027-01-01" }];
    expect(decidePublish(listing, [], licences, today, { ...ok, actingAgentId: "ag1" })).toEqual({ allowed: true, reasons: [] });
  });
  const bad: [string, AgentLicence[]][] = [
    ["missing", []],
    ["unverified", [{ userId: "ag1", jurisdiction: "QLD", status: "pending" }]],
    ["expired", [{ userId: "ag1", jurisdiction: "QLD", status: "verified", expiresAt: "2026-10-22" }]],
    ["for another state", [{ userId: "ag1", jurisdiction: "NSW", status: "verified" }]]
  ];
  for (const [name, licences] of bad) {
    it(`blocks with a licence reason when the acting agent's licence is ${name}`, () => {
      const d = decidePublish(listing, [], licences, today, { ...ok, actingAgentId: "ag1" });
      expect(d.allowed).toBe(false);
      expect(licenceReason(d.reasons)).toBe(true);
    });
  }
});
