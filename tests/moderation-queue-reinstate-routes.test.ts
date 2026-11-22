import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "a1111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333";
const LID = "44444444-4444-4444-8444-444444444444";
const ID = "55555555-5555-4555-8555-555555555555";
const state = vi.hoisted(() => ({
  staff: null as { id: string; role: string } | null,
  target: null as { id: string; status: string; subjectOwnerId: string | null; subjectType: string; subjectId: string } | null,
  susp: { suspension: null, reinstated: false } as { suspension: unknown; reinstated: boolean },
  listingStatus: "suspended" as string | undefined, userStatus: "suspended", gate: { allowed: true, reasons: [] as string[] },
  reinstated: [] as unknown[][], conflict: false, republished: [] as unknown[][]
}));
vi.mock("../src/server/context", () => ({
  getStaff: async () => state.staff, getDb: () => ({}),
  getDeps: () => ({ now: () => new Date("2026-11-18T10:00:00Z"), repo: { get: async () => (state.listingStatus ? { listing: { status: state.listingStatus, ownerUserId: OWNER } } : undefined) } })
}));
vi.mock("../src/domain/listing-service", () => ({ evaluateListingPublish: async () => state.gate }));
vi.mock("../src/domain/listing-transitions", () => ({ transitionListing: () => ({ event: { id: "e", payload: { from: "suspended", to: "published" } } }) }));
vi.mock("../src/server/admin-moderation-db", () => ({
  userTarget: async (_d: unknown, id: string) => ({ id, userType: "owner", status: state.userStatus }),
  listingsSuspendedWithAccount: async () => ["l1", "l2"]
}));
vi.mock("../src/server/listing-reinstate", () => ({
  republishSuspended: async (...a: unknown[]) => { state.republished.push(a); return { restored: 1, notRestored: [{ id: "l2", title: "T", reasons: ["No photos"] }] }; }
}));
vi.mock("../src/server/moderation-queue-db", () => ({
  getQueueTargetPg: async () => state.target,
  getSuspensionPg: async () => state.susp,
  SuspensionConflict: class SuspensionConflict extends Error {},
  reinstateQueueItemPg: async (...a: unknown[]) => {
    if (state.conflict) { const { SuspensionConflict } = await import("../src/server/moderation-queue-db"); throw new SuspensionConflict(); }
    state.reinstated.push(a); return state.reinstated.length === 1;
  }
}));

import * as route from "../app/api/staff/review-queue/[id]/reinstate/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const H = { "content-type": "application/json", origin: "http://test" };
const post = (body: unknown) => new Request("http://test/x", { method: "POST", headers: H, body: JSON.stringify(body) });
const OK = { reason: "The owner fixed the description." };

beforeEach(() => {
  process.env["APP_URL"] = "http://test";
  state.staff = { id: A, role: "compliance" };
  state.target = { id: ID, status: "rejected", subjectOwnerId: OWNER, subjectType: "listing", subjectId: LID };
  state.susp = { suspension: { kind: "listing", listingId: LID }, reinstated: false };
  state.listingStatus = "suspended"; state.userStatus = "suspended"; state.gate = { allowed: true, reasons: [] };
  state.reinstated = []; state.republished = []; state.conflict = false;
});

describe("staff review queue: reinstate", () => {
  it("needs a signed-in staff member with the permission", async () => {
    state.staff = null;
    expect((await route.POST(post(OK), ctx(ID))).status).toBe(401);
    state.staff = { id: A, role: "accountant" };
    expect((await route.POST(post(OK), ctx(ID))).status).toBe(403);
    expect(state.reinstated).toHaveLength(0);
  });
  it("reinstates a suspended listing with the reason, once", async () => {
    const r = await route.POST(post(OK), ctx(ID));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, reinstated: "listing" });
    const [, id, staff, plan, event] = state.reinstated[0]!;
    expect([id, staff, plan]).toEqual([ID, state.staff, { kind: "listing", listingId: LID, reason: OK.reason }]);
    expect(event).toMatchObject({ payload: { action: "reinstate", reason: OK.reason, moderation: true, moderationItem: ID, role: "compliance" } });
    expect((await route.POST(post(OK), ctx(ID))).status).toBe(409);
  });
  it("needs a reason, a rejected item that suspended something, and not own content", async () => {
    expect((await route.POST(post({ reason: "short" }), ctx(ID))).status).toBe(400);
    expect((await route.POST(post(OK), ctx("nope"))).status).toBe(404);
    state.susp = { suspension: null, reinstated: false };
    expect((await route.POST(post(OK), ctx(ID))).status).toBe(409);
    state.susp = { suspension: { kind: "listing", listingId: LID }, reinstated: true };
    expect((await route.POST(post(OK), ctx(ID))).status).toBe(409);
    state.susp = { suspension: { kind: "listing", listingId: LID }, reinstated: false };
    state.staff = { id: OWNER, role: "compliance" };
    expect((await route.POST(post(OK), ctx(ID))).status).toBe(403);
    expect(state.reinstated).toHaveLength(0);
  });
  it("refuses a listing that would not pass the publish checks today", async () => {
    state.gate = { allowed: false, reasons: ["No photos"] };
    const r = await route.POST(post(OK), ctx(ID));
    expect(r.status).toBe(409);
    expect((await r.json()).reasons).toEqual(["No photos"]);
    expect(state.reinstated).toHaveLength(0);
  });
  it("tells staff when the listing changed in the meantime", async () => {
    state.conflict = true;
    expect((await route.POST(post(OK), ctx(ID))).status).toBe(409);
  });
  it("reinstates an account and brings back its listings only through the publish gate, unless asked to keep them", async () => {
    state.susp = { suspension: { kind: "account", userId: OWNER }, reinstated: false };
    state.target = { ...state.target!, subjectOwnerId: "99999999-9999-4999-8999-999999999999" };
    const r = await route.POST(post({ ...OK, listings: "keep" }), ctx(ID));
    expect(await r.json()).toEqual({ ok: true, reinstated: "account", listingsRestored: 0, listingsNotRestored: [] });
    expect(state.republished).toHaveLength(0);
    state.reinstated = [];
    const r2 = await route.POST(post(OK), ctx(ID));
    expect(await r2.json()).toEqual({ ok: true, reinstated: "account", listingsRestored: 1, listingsNotRestored: [{ id: "l2", title: "T", reasons: ["No photos"] }] });
    expect(state.republished[0]![1]).toEqual(["l1", "l2"]);
    state.userStatus = "active";
    expect((await route.POST(post(OK), ctx(ID))).status).toBe(409);
  });
});
