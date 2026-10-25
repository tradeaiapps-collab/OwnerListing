import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  complianceNotes, listingActionsFor, maskEmail, planListingAction, planUserAction, showPersonal, type ComplianceFacts
} from "../src/domain/admin-moderation";
import { transitionListing } from "../src/domain/listing-transitions";
import type { PropertyListing } from "../src/domain/listing";
import type { StaffActor } from "../src/domain/staff-access";
import { everPublished } from "../src/domain/listing-photos";

const state = vi.hoisted(() => ({
  staff: null as StaffActor | null,
  rec: null as Record<string, unknown> | null,
  gate: { allowed: true, reasons: [] as string[] },
  target: null as Record<string, unknown> | null,
  writes: [] as unknown[][],
  writeOk: true
}));
vi.mock("../src/server/context", () => ({
  getDb: () => ({ query: async () => ({ rows: [] }) }), getStaff: async () => state.staff,
  getDeps: () => ({ repo: { get: async () => state.rec }, now: () => "2026-10-25T00:00:00.000Z" })
}));
vi.mock("../src/domain/listing-service", () => ({ evaluateListingPublish: async () => state.gate }));
vi.mock("../src/server/admin-moderation-db", () => ({
  moderateListing: async (...a: unknown[]) => { state.writes.push(a); return state.writeOk; },
  userTarget: async () => state.target,
  setUserStatus: async (...a: unknown[]) => { state.writes.push(a); return state.writeOk; },
  searchListings: async () => ({ rows: [], nextCursor: null }), searchUsers: async () => ({ rows: [], nextCursor: null })
}));

import * as listingAction from "../app/api/staff/listings/[id]/action/route";
import * as userAction from "../app/api/staff/users/[id]/action/route";
process.env["APP_URL"] = "http://test";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const comp: StaffActor = { id: U(1), role: "compliance" };
const support: StaffActor = { id: U(2), role: "support" };
const accountant: StaffActor = { id: U(3), role: "accountant" };
const REASON = "Photos show a different property.";
const listing = (status: PropertyListing["status"]): PropertyListing => ({
  id: U(100), ownerUserId: U(50), ownerUserType: "owner", jurisdiction: "QLD", transactionType: "sale", useClass: "residential",
  propertyType: "house", title: "Home", address: "1 Test St", status, disclosures: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z"
} as PropertyListing);

describe("listing moderation rules", () => {
  it("offers only the moves that fit the status", () => {
    expect(listingActionsFor("published").map(a => a.action)).toEqual(["suspend"]);
    expect(listingActionsFor("suspended").map(a => a.action)).toEqual(["reinstate"]);
    expect(listingActionsFor("pending_review").map(a => a.action)).toEqual(["send_back"]);
    expect(listingActionsFor("draft")).toEqual([]);
  });
  it("needs the permission, a known action, a reason and the right status", () => {
    expect(planListingAction(accountant, "published", "suspend", REASON)).toMatchObject({ action: "deny", status: 403 });
    expect(planListingAction(support, "published", "delete", REASON)).toMatchObject({ action: "deny", status: 400 });
    expect(planListingAction(support, "published", "suspend", "bad")).toMatchObject({ action: "deny", status: 400 });
    expect(planListingAction(support, "draft", "suspend", REASON)).toMatchObject({ action: "deny", status: 409 });
    expect(planListingAction(support, "published", "suspend", `  ${REASON} `)).toEqual({ action: "suspend", from: "published", to: "suspended", reason: REASON, needsPublishGate: false });
    expect(planListingAction(support, "suspended", "reinstate", REASON)).toMatchObject({ to: "published", needsPublishGate: true });
  });
  it("transitions allow suspend and reinstate, and reinstating still needs an allowed publish decision", () => {
    const ctx = { eventId: "e", correlationId: "c", actorType: "user" as const, actorId: "s", now: "2026-10-25T00:00:00Z" };
    expect(transitionListing(listing("published"), "suspended", ctx).event.eventType).toBe("listing.suspended");
    expect(() => transitionListing(listing("suspended"), "published", ctx)).toThrow(/publish decision/);
    expect(() => transitionListing(listing("draft"), "suspended", ctx)).toThrow(/Invalid/);
    expect(transitionListing(listing("suspended"), "withdrawn", ctx).listing.status).toBe("withdrawn");
  });
  it("a suspended listing's files count as published (never deletable)", () => {
    expect(everPublished("suspended")).toBe(true);
  });
});

describe("account moderation rules", () => {
  const t = (o: Record<string, string> = {}) => ({ id: U(60), userType: "owner", status: "active", ...o });
  it("suspends active and reinstates suspended accounts only", () => {
    expect(planUserAction(comp, t(), "suspend", REASON)).toEqual({ action: "suspend", from: "active", to: "suspended", reason: REASON });
    expect(planUserAction(comp, t({ status: "suspended" }), "reinstate", REASON)).toMatchObject({ to: "active" });
    expect(planUserAction(comp, t({ status: "pending" }), "suspend", REASON)).toMatchObject({ status: 409 });
    expect(planUserAction(comp, t({ status: "closed" }), "reinstate", REASON)).toMatchObject({ status: 409 });
  });
  it("never touches staff accounts or the actor's own account, and needs user.manage", () => {
    expect(planUserAction(comp, t({ userType: "admin" }), "suspend", REASON)).toMatchObject({ status: 409 });
    expect(planUserAction(comp, t({ id: comp.id }), "suspend", REASON)).toMatchObject({ status: 403 });
    expect(planUserAction(support, t(), "suspend", REASON)).toMatchObject({ status: 403 });
    expect(planUserAction(comp, t(), "suspend", "")).toMatchObject({ status: 400 });
  });
  it("masks personal details unless the role may see them in full", () => {
    expect(maskEmail("jane.citizen@gmail.com")).toBe("j***n@gmail.com");
    expect(maskEmail("jo@x.au")).toBe("j***@x.au");
    expect(maskEmail("nope")).toBe("***");
    expect(showPersonal(comp, { name: "Jane Citizen", email: "jane@x.au" })).toEqual({ name: "Jane Citizen", email: "jane@x.au" });
    expect(showPersonal({ id: "c", role: "custom_m", permissions: ["user.manage"] }, { name: "Jane Citizen", email: "jane@x.au" })).toEqual({ name: "Jane C.", email: "j***e@x.au" });
  });
  it("lists what still needs attention in plain words", () => {
    const ok: ComplianceFacts = { emailVerified: true, phoneVerified: true, idVerified: true, idPending: false, licence: "not_needed", termsCurrent: true, openCases: 0 };
    expect(complianceNotes("buyer", ok)).toEqual([]);
    expect(complianceNotes("buyer", { ...ok, phoneVerified: false, idVerified: false, idPending: true, openCases: 2 }))
      .toEqual(["Phone not verified", "ID check waiting for review", "2 open admin cases"]);
    expect(complianceNotes("agent", { ...ok, licence: "expired", termsCurrent: false })).toEqual(["Agent licence expired", "Current terms not accepted"]);
    expect(complianceNotes("owner", { ...ok, emailVerified: false })).toEqual([]);
  });
});

describe("moderation routes", () => {
  beforeEach(() => {
    state.staff = null; state.rec = { listing: listing("published") }; state.gate = { allowed: true, reasons: [] };
    state.target = { id: U(60), userType: "owner", status: "active" }; state.writes = []; state.writeOk = true;
  });
  const ctx = (id = U(100)) => ({ params: Promise.resolve({ id }) });
  const post = (route: { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> }, body: unknown, id?: string, headers: Record<string, string> = { "content-type": "application/json", origin: "http://test" }) =>
    route.POST(new Request("http://test/api/staff/x", { method: "POST", headers, body: JSON.stringify(body) }), ctx(id));

  it("refuse without a session, across origins, and without the permission", async () => {
    expect((await post(listingAction, { action: "suspend", reason: REASON })).status).toBe(401);
    state.staff = support;
    expect((await post(listingAction, { action: "suspend", reason: REASON }, undefined, { "content-type": "application/json", origin: "http://evil" })).status).toBe(403);
    expect((await post(userAction, { action: "suspend", reason: REASON }, U(60))).status).toBe(403);
    state.staff = accountant;
    expect((await post(listingAction, { action: "suspend", reason: REASON })).status).toBe(403);
    expect(state.writes).toEqual([]);
  });
  it("suspends a live listing with an audited event carrying the reason", async () => {
    state.staff = support;
    const r = await post(listingAction, { action: "suspend", reason: REASON });
    expect(r.status).toBe(200);
    const [, id, from, to, event] = state.writes[0] as [unknown, string, string, string, { eventType: string; actorId: string; payload: Record<string, unknown> }];
    expect([id, from, to]).toEqual([U(100), "published", "suspended"]);
    expect(event).toMatchObject({ eventType: "listing.suspended", actorId: support.id, payload: { reason: REASON, action: "suspend", moderation: true, role: "support" } });
  });
  it("reinstates only when the listing passes the publish checks today", async () => {
    state.staff = support;
    state.rec = { listing: listing("suspended") };
    state.gate = { allowed: false, reasons: ["The listing fee or plan has not been paid."] };
    const blocked = await post(listingAction, { action: "reinstate", reason: REASON });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).reasons).toEqual(["The listing fee or plan has not been paid."]);
    expect(state.writes).toEqual([]);
    state.gate = { allowed: true, reasons: [] };
    expect((await post(listingAction, { action: "reinstate", reason: REASON })).status).toBe(200);
    expect((state.writes[0] as unknown[])[3]).toBe("published");
  });
  it("reports a lost race and an unknown listing", async () => {
    state.staff = support;
    state.writeOk = false;
    expect((await post(listingAction, { action: "suspend", reason: REASON })).status).toBe(409);
    expect((await post(listingAction, { action: "suspend", reason: REASON }, "not-a-uuid")).status).toBe(404);
    state.rec = null;
    expect((await post(listingAction, { action: "suspend", reason: REASON })).status).toBe(404);
  });
  it("suspends an account with a reason", async () => {
    state.staff = comp;
    expect((await post(userAction, { action: "suspend", reason: REASON }, U(60))).status).toBe(200);
    expect(state.writes[0]).toEqual([expect.anything(), comp, U(60), "active", "suspended", REASON]);
    state.target = { id: U(61), userType: "admin", status: "active" };
    expect((await post(userAction, { action: "suspend", reason: REASON }, U(61))).status).toBe(409);
  });
});
