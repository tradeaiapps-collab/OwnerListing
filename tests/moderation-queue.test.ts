import { describe, expect, it } from "vitest";
import { decisionsFor, planDecision, subjectLink } from "../src/domain/moderation-queue";
import { sectionsFor } from "../src/domain/staff-admin";
import type { StaffActor } from "../src/domain/staff-access";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const actor = (role: string, id = A): StaffActor => ({ id, role });
const item = (status: string, owner: string | null = null) => ({ id: "i", status, subjectOwnerId: owner });
const REASON = "Checked against the listing rules.";

describe("moderation queue decisions", () => {
  it("lets a reviewer approve, reject or escalate an open item", () => {
    for (const d of ["approve", "reject", "escalate"]) {
      const p = planDecision(actor("support"), item("open"), d, REASON);
      expect(p).toMatchObject({ action: "plan", decision: d, from: "open" });
    }
  });
  it("needs a reason of 10 characters and a known decision", () => {
    expect(planDecision(actor("support"), item("open"), "approve", "short")).toMatchObject({ action: "deny", status: 400 });
    expect(planDecision(actor("support"), item("open"), "delete", REASON)).toMatchObject({ action: "deny", status: 400 });
  });
  it("refuses roles without the permission", () => {
    expect(planDecision(actor("accountant"), item("open"), "approve", REASON)).toMatchObject({ action: "deny", status: 403 });
    expect(decisionsFor(actor("accountant"), "open")).toEqual([]);
  });
  it("never lets someone review their own content", () => {
    expect(planDecision(actor("compliance"), item("open", A), "approve", REASON)).toMatchObject({ action: "deny", status: 403 });
    expect(planDecision(actor("compliance"), item("open", B), "approve", REASON)).toMatchObject({ action: "plan" });
  });
  it("leaves escalated items to senior reviewers, who cannot escalate again", () => {
    expect(planDecision(actor("support"), item("escalated"), "reject", REASON)).toMatchObject({ action: "deny", status: 403 });
    expect(planDecision(actor("compliance"), item("escalated"), "reject", REASON)).toMatchObject({ action: "plan", from: "escalated", to: "rejected" });
    expect(planDecision(actor("compliance"), item("escalated"), "escalate", REASON)).toMatchObject({ action: "deny", status: 409 });
    expect(decisionsFor(actor("support"), "escalated")).toEqual([]);
    expect(decisionsFor(actor("compliance"), "escalated")).toEqual(["approve", "reject"]);
  });
  it("refuses an item that is already decided", () => {
    expect(planDecision(actor("compliance"), item("approved"), "reject", REASON)).toMatchObject({ action: "deny", status: 409 });
  });
  it("shows the screen to support and compliance only, and links listings", () => {
    expect(sectionsFor(actor("support")).map(s => s.href)).toContain("/staff/review-queue");
    expect(sectionsFor(actor("compliance")).map(s => s.href)).toContain("/staff/review-queue");
    expect(sectionsFor(actor("accountant")).map(s => s.href)).not.toContain("/staff/review-queue");
    expect(subjectLink("listing", A)).toBe(`/listings/${A}`);
    expect(subjectLink("message", A)).toBeNull();
  });
});
