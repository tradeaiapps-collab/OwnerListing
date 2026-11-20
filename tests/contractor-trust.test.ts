import { describe, expect, it } from "vitest";
import {
  areaOnly, canSeeFullAddress, parseQuote, parseReportDecision, parseReview, parseVerification, parseVerificationDecision, summariseRatings, verificationState
} from "../src/domain/contractor-trust";
import { canUploadPhotos } from "../src/domain/listing-photos";

const TODAY = "2026-11-20";
const valid = { businessName: "Bright Snaps", abn: "51 824 753 556", insurer: "Allianz", policyNumber: "PL-123", insuranceExpiry: "2027-03-01" };

describe("parseVerification", () => {
  it("accepts insurance and a valid ABN; licence is optional", () => {
    const r = parseVerification(valid, TODAY);
    expect(r).toMatchObject({ ok: true, value: { abn: "51824753556", licenceNumber: null, licenceExpiry: null } });
  });
  it("checks the ABN format and checksum only", () => {
    expect(parseVerification({ ...valid, abn: "12345" }, TODAY)).toMatchObject({ ok: false });
    expect(parseVerification({ ...valid, abn: "51 824 753 557" }, TODAY)).toMatchObject({ ok: false, message: expect.stringMatching(/not valid/) });
  });
  it("refuses expired insurance and expired licences", () => {
    expect(parseVerification({ ...valid, insuranceExpiry: "2026-11-19" }, TODAY)).toMatchObject({ ok: false, message: expect.stringMatching(/expired/) });
    expect(parseVerification({ ...valid, licenceNumber: "L1", licenceAuthority: "NSW Fair Trading", licenceExpiry: "2026-01-01" }, TODAY)).toMatchObject({ ok: false });
  });
  it("needs licence number, issuer and expiry together", () => {
    expect(parseVerification({ ...valid, licenceNumber: "L1" }, TODAY)).toMatchObject({ ok: false });
    expect(parseVerification({ ...valid, licenceNumber: "L1", licenceAuthority: "QBCC" }, TODAY)).toMatchObject({ ok: false });
    expect(parseVerification({ ...valid, licenceNumber: "L1", licenceAuthority: "QBCC", licenceExpiry: "2027-02-30" }, TODAY)).toMatchObject({ ok: false });
    expect(parseVerification({ ...valid, licenceNumber: "L1", licenceAuthority: "QBCC", licenceExpiry: "2027-06-30" }, TODAY)).toMatchObject({ ok: true });
  });
});

describe("verificationState", () => {
  it("shows the badge only while verified and in date", () => {
    expect(verificationState(undefined, TODAY)).toMatchObject({ status: "none", badge: false });
    expect(verificationState({ status: "pending", insuranceExpiry: "2027-01-01", licenceExpiry: null }, TODAY).badge).toBe(false);
    expect(verificationState({ status: "verified", insuranceExpiry: "2027-01-01", licenceExpiry: null }, TODAY).badge).toBe(true);
  });
  it("removes the badge and warns the day after insurance expires", () => {
    const s = verificationState({ status: "verified", insuranceExpiry: "2026-11-19", licenceExpiry: null }, TODAY);
    expect(s).toMatchObject({ badge: false, insuranceExpired: true });
    expect(s.warnings[0]).toMatch(/expired/);
    expect(verificationState({ status: "verified", insuranceExpiry: TODAY, licenceExpiry: null }, TODAY).badge).toBe(true);
  });
  it("warns in the last 30 days and when the licence expires", () => {
    expect(verificationState({ status: "verified", insuranceExpiry: "2026-12-10", licenceExpiry: null }, TODAY).warnings[0]).toMatch(/in 20 days/);
    expect(verificationState({ status: "verified", insuranceExpiry: "2027-06-01", licenceExpiry: "2026-11-01" }, TODAY)).toMatchObject({ badge: false, licenceExpired: true });
  });
});

describe("other inputs", () => {
  it("validates reports, decisions, quotes and reviews", () => {
    expect(parseReportDecision({ action: "uphold_and_suspend", note: "Confirmed no-show twice." })).toMatchObject({ ok: true });
    expect(parseReportDecision({ action: "uphold" })).toMatchObject({ ok: false });
    expect(parseVerificationDecision({ action: "reject" })).toMatchObject({ ok: false });
    expect(parseVerificationDecision({ action: "verify" })).toMatchObject({ ok: true, value: { note: null } });
    expect(parseQuote({ amountCents: 45000, description: "Replace two taps and reseal." })).toMatchObject({ ok: true });
    expect(parseQuote({ amountCents: 4.5, description: "Replace two taps and reseal." })).toMatchObject({ ok: false });
    expect(parseQuote({ amountCents: 200_000_000, description: "Replace two taps and reseal." })).toMatchObject({ ok: false });
    expect(parseReview({ rating: 5 })).toMatchObject({ ok: true, value: { comment: null } });
    expect(parseReview({ rating: 6 })).toMatchObject({ ok: false });
  });
});

describe("privacy and ratings", () => {
  it("shows the area, never the street, before acceptance", () => {
    expect(areaOnly({ suburb: "Paddington", postcode: "4064", jurisdiction: "QLD" })).toBe("Paddington QLD 4064");
    expect(areaOnly({ suburb: null, postcode: null, jurisdiction: "QLD" })).toMatch(/shared once you accept/);
    expect(canSeeFullAddress("contractor", "proposed")).toBe(false);
    expect(canSeeFullAddress("contractor", "cancelled")).toBe(false);
    expect(canSeeFullAddress("contractor", "approved")).toBe(true);
    expect(canSeeFullAddress("owner", "proposed")).toBe(true);
  });
  it("blocks photo upload until the photographer confirms usage rights", () => {
    const a = { id: "a", listingId: "l", ownerUserId: "o", contractorUserId: "c", kind: "photographer" as const, status: "approved" as const };
    expect(canUploadPhotos("c", "o", "l", [{ ...a, usageRightsConfirmed: false }])).toBe(false);
    expect(canUploadPhotos("c", "o", "l", [{ ...a, usageRightsConfirmed: true }])).toBe(true);
  });
  it("averages ratings to one decimal", () => {
    expect(summariseRatings([])).toEqual({ average: null, count: 0 });
    expect(summariseRatings([5, 4, 4])).toEqual({ average: 4.3, count: 3 });
  });
});
