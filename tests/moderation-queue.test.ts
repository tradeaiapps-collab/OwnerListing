import { describe, expect, it } from "vitest";
import { decisionsFor, planDecision, planReinstate, planSuspension, subjectLink } from "../src/domain/moderation-queue";
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

describe("reject and suspend", () => {
  const OWNER = "33333333-3333-4333-8333-333333333333";
  const listingItem = { id: "i", status: "open", subjectOwnerId: OWNER, subjectType: "listing" as const, subjectId: "44444444-4444-4444-8444-444444444444" };
  const msgItem = { ...listingItem, subjectType: "message" as const };
  const user = { id: OWNER, userType: "owner", status: "active" };
  const body = (o: Record<string, unknown>) => ({ reason: REASON, ...o });
  const staff = actor("compliance");

  it("does nothing unless asked", () => {
    expect(planSuspension(staff, listingItem, "reject", body({}), {})).toEqual({ kind: "none" });
    expect(planSuspension(staff, listingItem, "approve", body({ suspend: "none" }), {})).toEqual({ kind: "none" });
  });
  it("needs an explicit confirm, a reject decision and a known choice", () => {
    expect(planSuspension(staff, listingItem, "reject", body({ suspend: "listing" }), { listingStatus: "published" })).toMatchObject({ action: "deny", status: 400 });
    expect(planSuspension(staff, listingItem, "reject", body({ suspend: "listing", confirm: "yes" }), { listingStatus: "published" })).toMatchObject({ action: "deny", status: 400 });
    expect(planSuspension(staff, listingItem, "escalate", body({ suspend: "listing", confirm: true }), { listingStatus: "published" })).toMatchObject({ action: "deny", status: 400 });
    expect(planSuspension(staff, listingItem, "reject", body({ suspend: "everything", confirm: true }), {})).toMatchObject({ action: "deny", status: 400 });
  });
  it("suspends a published listing the item is about, with the reason", () => {
    expect(planSuspension(staff, listingItem, "reject", body({ suspend: "listing", confirm: true }), { listingStatus: "published" }))
      .toEqual({ kind: "listing", listingId: listingItem.subjectId, from: "published", reason: REASON });
    expect(planSuspension(staff, listingItem, "reject", body({ suspend: "listing", confirm: true }), { listingStatus: "draft" })).toMatchObject({ action: "deny", status: 409 });
    expect(planSuspension(staff, msgItem, "reject", body({ suspend: "listing", confirm: true }), {})).toMatchObject({ action: "deny", status: 400 });
  });
  it("suspends the account behind the item and follows the user-screen rules", () => {
    expect(planSuspension(staff, msgItem, "reject", body({ suspend: "account", confirm: true }), { user })).toMatchObject({ kind: "account", userId: OWNER, withListings: true });
    expect(planSuspension(staff, msgItem, "reject", body({ suspend: "account", confirm: true, listings: "keep" }), { user })).toMatchObject({ kind: "account", withListings: false });
    expect(planSuspension(staff, msgItem, "reject", body({ suspend: "account", confirm: true }), { user: { ...user, status: "suspended" } })).toMatchObject({ action: "deny", status: 409 });
    expect(planSuspension(staff, msgItem, "reject", body({ suspend: "account", confirm: true }), { user: { ...user, userType: "admin" } })).toMatchObject({ action: "deny", status: 409 });
    expect(planSuspension(staff, { ...msgItem, subjectOwnerId: null }, "reject", body({ suspend: "account", confirm: true }), {})).toMatchObject({ action: "deny", status: 400 });
  });
  it("needs the listing and user permissions, not just the queue permission", () => {
    expect(planSuspension(actor("support"), listingItem, "reject", body({ suspend: "listing", confirm: true }), { listingStatus: "published" })).toMatchObject({ kind: "listing" });
    expect(planSuspension(actor("support"), msgItem, "reject", body({ suspend: "account", confirm: true }), { user })).toMatchObject({ action: "deny", status: 403 });
  });
});

describe("reinstate a queue suspension", () => {
  const OWNER = "33333333-3333-4333-8333-333333333333";
  const LID = "44444444-4444-4444-8444-444444444444";
  const rejected = { id: "i", status: "rejected", subjectOwnerId: OWNER, subjectType: "listing" as const, subjectId: LID };
  const asListing = { kind: "listing" as const, listingId: LID };
  const asAccount = { kind: "account" as const, userId: OWNER };
  const body = (o: Record<string, unknown> = {}) => ({ reason: REASON, ...o });
  const staff = actor("compliance");

  it("lifts a listing suspension with the reason, once the listing is suspended", () => {
    expect(planReinstate(staff, rejected, asListing, false, body(), { listingStatus: "suspended" })).toEqual({ kind: "listing", listingId: LID, reason: REASON });
    expect(planReinstate(staff, rejected, asListing, false, body(), { listingStatus: "published" })).toMatchObject({ action: "deny", status: 409 });
    expect(planReinstate(staff, rejected, asListing, false, body(), {})).toMatchObject({ action: "deny", status: 409 });
  });
  it("lifts an account suspension and follows the user-screen rules for its listings", () => {
    const user = { id: OWNER, userType: "owner", status: "suspended" };
    expect(planReinstate(staff, rejected, asAccount, false, body(), { user })).toMatchObject({ kind: "account", userId: OWNER, from: "suspended", withListings: true });
    expect(planReinstate(staff, rejected, asAccount, false, body({ listings: "keep" }), { user })).toMatchObject({ kind: "account", withListings: false });
    expect(planReinstate(staff, rejected, asAccount, false, body({ listings: "all" }), { user })).toMatchObject({ action: "deny", status: 400 });
    expect(planReinstate(staff, rejected, asAccount, false, body(), { user: { ...user, status: "active" } })).toMatchObject({ action: "deny", status: 409 });
  });
  it("needs a reason, a rejected item that suspended something, and happens once", () => {
    const facts = { listingStatus: "suspended" };
    expect(planReinstate(staff, rejected, asListing, false, body({ reason: "short" }), facts)).toMatchObject({ action: "deny", status: 400 });
    expect(planReinstate(staff, rejected, asListing, false, null, facts)).toMatchObject({ action: "deny", status: 400 });
    expect(planReinstate(staff, { ...rejected, status: "approved" }, asListing, false, body(), facts)).toMatchObject({ action: "deny", status: 409 });
    expect(planReinstate(staff, rejected, null, false, body(), facts)).toMatchObject({ action: "deny", status: 409 });
    expect(planReinstate(staff, rejected, asListing, true, body(), facts)).toMatchObject({ action: "deny", status: 409 });
  });
  it("checks permissions and blocks reviewing your own content", () => {
    expect(planReinstate(actor("accountant"), rejected, asListing, false, body(), { listingStatus: "suspended" })).toMatchObject({ action: "deny", status: 403 });
    expect(planReinstate(actor("compliance", OWNER), rejected, asListing, false, body(), { listingStatus: "suspended" })).toMatchObject({ action: "deny", status: 403 });
    // Support can moderate listings but cannot manage accounts.
    expect(planReinstate(actor("support"), rejected, asAccount, false, body(), { user: { id: OWNER, userType: "owner", status: "suspended" } })).toMatchObject({ action: "deny", status: 403 });
  });
});
