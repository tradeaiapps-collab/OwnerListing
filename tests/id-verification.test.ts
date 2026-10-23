import { describe, expect, it } from "vitest";
import {
  canSubmitAgain, imagesDueForDeletion, isIdVerified, requiredApprovals, reviewSubmission, validateSubmission,
  type IdSubmission, type ReviewChecklist
} from "../src/domain/id-verification";

const today = "2026-10-23";
const sub: IdSubmission = {
  id: "s1", userId: "buyer1", documentKind: "drivers_licence", documentCountry: "AU", expiryDate: "2028-01-01",
  frontImageRef: "f", backImageRef: "b", selfieRef: "s", selfieCapturedInApp: true,
  submittedAt: "2026-10-23T00:00:00.000Z", status: "pending", approvals: []
};
const ok: ReviewChecklist = { documentLooksGenuine: true, photoMatchesSelfie: true, nameMatchesAccount: true, notExpired: true, officialStatusCheck: "done" };
const r1 = { id: "r1", role: "compliance" as const };
const r2 = { id: "r2", role: "super_admin" as const };
const now = "2026-10-23T01:00:00.000Z";

describe("id submission", () => {
  it("needs the right images, a live selfie and an in-date document", () => {
    expect(validateSubmission(sub, today)).toEqual([]);
    expect(validateSubmission({ ...sub, selfieCapturedInApp: false }, today).length).toBe(1);
    expect(validateSubmission({ ...sub, backImageRef: undefined as unknown as string }, today).length).toBe(1);
    expect(validateSubmission({ ...sub, documentKind: "passport", backImageRef: undefined as unknown as string }, today)).toEqual([]);
    expect(validateSubmission({ ...sub, expiryDate: "2025-01-01" }, today).length).toBe(1);
  });
  it("limits repeat attempts", () => {
    const t = ["2026-10-22T23:00:00.000Z", "2026-10-22T23:10:00.000Z", "2026-10-22T23:20:00.000Z"];
    expect(canSubmitAgain(t, now)).toBe(false);
    expect(canSubmitAgain(t.slice(0, 2), now)).toBe(true);
  });
});

describe("review", () => {
  it("approves an Australian document with one reviewer and every check passed", () => {
    const a = reviewSubmission(sub, r1, "approve", ok, now);
    expect(isIdVerified(a)).toBe(true);
    expect(() => reviewSubmission(sub, r1, "approve", { ...ok, photoMatchesSelfie: false }, now)).toThrow(/Every check/);
  });
  it("needs the official licence status check recorded for an Australian licence", () => {
    const { officialStatusCheck: _omit, ...noStatus } = ok;
    expect(() => reviewSubmission(sub, r1, "approve", noStatus, now)).toThrow(/official licence status/);
    expect(() => reviewSubmission(sub, r1, "approve", { ...ok, officialStatusCheck: "failed" }, now)).toThrow(/failed/);
    expect(isIdVerified(reviewSubmission(sub, r1, "approve", { ...ok, officialStatusCheck: "not_available" }, now))).toBe(true);
    expect(isIdVerified(reviewSubmission({ ...sub, documentKind: "passport" }, r1, "approve", noStatus, now))).toBe(true);
  });
  it("needs two different reviewers for an overseas document", () => {
    const o = { ...sub, documentCountry: "IR" };
    expect(requiredApprovals(o)).toBe(2);
    const first = reviewSubmission(o, r1, "approve", ok, now);
    expect(isIdVerified(first)).toBe(false);
    expect(() => reviewSubmission(first, r1, "approve", ok, now)).toThrow(/different reviewer/);
    expect(isIdVerified(reviewSubmission(first, r2, "approve", ok, now))).toBe(true);
  });
  it("blocks the wrong people and own submissions", () => {
    expect(() => reviewSubmission(sub, { id: "x", role: "technical" }, "approve", ok, now)).toThrow(/cannot review/);
    expect(() => reviewSubmission(sub, { id: "buyer1", role: "compliance" }, "approve", ok, now)).toThrow(/own/);
    expect(() => reviewSubmission({ ...sub, status: "approved" }, r1, "reject", ok, now)).toThrow(/waiting/);
  });
  it("deletes images soon after a decision", () => {
    const done = reviewSubmission(sub, r1, "approve", ok, now);
    expect(imagesDueForDeletion(done, "2026-10-24T00:00:00.000Z")).toBe(false);
    expect(imagesDueForDeletion(done, "2026-11-01T00:00:00.000Z")).toBe(true);
    expect(imagesDueForDeletion(sub, "2027-01-01T00:00:00.000Z")).toBe(false);
  });
});
