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

describe("licence expiry uses the listing state's local date (QLD midnight = 14:00Z)", () => {
  const lic = (userId: string): AgentLicence[] => [{ userId, jurisdiction: "QLD", status: "verified", expiresAt: "2026-10-24" }];
  const agentOwned: PropertyListing = { ...listing, ownerUserId: "ag1", ownerUserType: "agent" };
  const at = (l: PropertyListing, licences: AgentLicence[], now: string, extra = {}) => decidePublish(l, [], licences, now, { ...ok, ...extra });

  it("owner-agent path: valid at 13:59Z on expiry day, expired at 14:00Z", () => {
    expect(at(agentOwned, lic("ag1"), "2026-10-24T13:59:00.000Z").allowed).toBe(true);
    const d = at(agentOwned, lic("ag1"), "2026-10-24T14:00:00.000Z");
    expect(d.allowed).toBe(false);
    expect(licenceReason(d.reasons)).toBe(true);
  });
  it("acting-agent path: valid at 13:59Z on expiry day, expired at 14:00Z", () => {
    expect(at(listing, lic("ag1"), "2026-10-24T13:59:00.000Z", { actingAgentId: "ag1" }).allowed).toBe(true);
    const d = at(listing, lic("ag1"), "2026-10-24T14:00:00.000Z", { actingAgentId: "ag1" });
    expect(d.allowed).toBe(false);
    expect(licenceReason(d.reasons)).toBe(true);
  });
  it("fails closed when the jurisdiction has no time zone", () => {
    const odd = { ...agentOwned, jurisdiction: "XX" } as unknown as PropertyListing;
    const licences: AgentLicence[] = [{ userId: "ag1", jurisdiction: "XX" as never, status: "verified" }];
    expect(at(odd, licences, "2026-10-24T00:00:00.000Z").allowed).toBe(false);
    expect(at({ ...odd, ownerUserType: "owner" }, licences, "2026-10-24T00:00:00.000Z", { actingAgentId: "ag1" }).allowed).toBe(false);
  });
});

