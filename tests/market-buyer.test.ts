import { describe, expect, it } from "vitest";
import { canContactSeller, canExplore, matchesSearch, nextVerificationStep, planAlerts, type ListingSummary, type SavedSearch } from "../src/domain/buyer";
import { evaluatePublish, type PropertyListing } from "../src/domain/listing";
import { decidePublish } from "../src/domain/publish";
import { getRequiredDisclosureKeys } from "../src/config/disclosures";

const listing: ListingSummary = { id: "l1", status: "published", jurisdiction: "QLD", suburb: "New Farm", transactionType: "sale", useClass: "residential", propertyType: "house", priceCents: 120000000, bedrooms: 4 };
const search: SavedSearch = { id: "s1", buyerUserId: "b1", transactionType: "sale", useClass: "residential", jurisdictions: ["QLD"], suburbs: ["new farm"], propertyTypes: ["house"], maxPriceCents: 150000000, minBedrooms: 3, active: true };

describe("saved searches", () => {
  it("matches published listings that fit, and not others", () => {
    expect(matchesSearch(search, listing)).toBe(true);
    expect(matchesSearch(search, { ...listing, status: "draft" })).toBe(false);
    expect(matchesSearch(search, { ...listing, useClass: "commercial", propertyType: "office" })).toBe(false);
    expect(matchesSearch(search, { ...listing, transactionType: "rent" })).toBe(false);
    expect(matchesSearch(search, { ...listing, priceCents: 200000000 })).toBe(false);
  });
  it("alerts only consenting buyers, once per channel", () => {
    const prefs = { b1: [{ channel: "email" as const, consentGivenAt: "2026-10-01T00:00:00Z" }, { channel: "sms" as const }] };
    const alerts = planAlerts(listing, [search, { ...search, id: "s2" }], prefs);
    expect(alerts).toEqual([{ buyerUserId: "b1", searchId: "s1", channel: "email", listingId: "l1" }]);
    expect(planAlerts(listing, [search], { b1: [{ channel: "email", consentGivenAt: "x", unsubscribedAt: "y" }] })).toEqual([]);
  });
  it("lets anyone explore with a verified email, but needs full ID before contacting a seller", () => {
    const v = { emailVerified: true, phoneVerified: false, idVerified: false };
    expect(canExplore(v)).toBe(true);
    expect(canContactSeller(v)).toBe(false);
    expect(nextVerificationStep(v)).toBe("verify_phone");
    expect(nextVerificationStep({ ...v, phoneVerified: true })).toBe("verify_id");
    expect(nextVerificationStep({ emailVerified: false, phoneVerified: false, idVerified: false })).toBe("verify_email");
    expect(canContactSeller({ ...v, phoneVerified: true, idVerified: true })).toBe(true);
    expect(nextVerificationStep({ emailVerified: true, phoneVerified: true, idVerified: true })).toBeNull();
  });
});

const base: PropertyListing = {
  id: "l", ownerUserId: "o", ownerUserType: "owner", jurisdiction: "QLD", status: "draft", title: "T",
  propertyType: "house", useClass: "residential", transactionType: "rent", address: "A",
  disclosures: [], createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z"
};

describe("residential, commercial, sale and rent", () => {
  it("rejects a type that does not match residential or commercial", () => {
    expect(evaluatePublish({ ...base, propertyType: "office" }, [], true).allowed).toBe(false);
    expect(evaluatePublish({ ...base, useClass: "commercial", propertyType: "retail" }, [], true).allowed).toBe(true);
  });
  it("a rental needs a confirmed bond arrangement, but not a trust account unless the bond goes there", () => {
    const common = { termsAccepted: true, listingFeePaid: true };
    expect(decidePublish(base, [], [], "2026-10-23", common).allowed).toBe(false);
    expect(decidePublish(base, [], [], "2026-10-23", { ...common, rentalBondPathway: "state_bond_authority" }).allowed).toBe(true);
    expect(decidePublish(base, [], [], "2026-10-23", { ...common, rentalBondPathway: "solicitor_trust" }).allowed).toBe(false);
  });
  it("a sale still needs an approved trust account", () => {
    const sale = { ...base, transactionType: "sale" as const };
    expect(decidePublish(sale, [], [], "2026-10-23", { termsAccepted: true }).allowed).toBe(false);
    const paid = { termsAccepted: true, listingFeePaid: true, trustAccount: { kind: "approved" as const, reasons: [] } };
    expect(decidePublish(sale, [], [], "2026-10-23", paid).allowed).toBe(true);
    const unpaid = decidePublish(sale, [], [], "2026-10-23", { ...paid, listingFeePaid: false });
    expect(unpaid.allowed).toBe(false);
    expect(unpaid.reasons.join(" ")).toMatch(/not been paid/);
  });
  it("has no disclosure configuration until compliance supplies it", () => {
    expect(getRequiredDisclosureKeys("QLD", "rent", "commercial")).toBeNull();
  });
});
