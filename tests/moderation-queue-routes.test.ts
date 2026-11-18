import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ staff: null as { id: string; role: string } | null, target: null as { id: string; status: string; subjectOwnerId: string | null } | null, decided: [] as unknown[][], suspended: [] as unknown[][], listingStatus: "published" as string | undefined, conflict: false }));
vi.mock("../src/server/context", () => ({
  getStaff: async () => state.staff, getDb: () => ({}),
  getDeps: () => ({ repo: { get: async () => (state.listingStatus ? { listing: { status: state.listingStatus } } : undefined) } })
}));
vi.mock("../src/server/admin-moderation-db", () => ({ userTarget: async (_db: unknown, id: string) => ({ id, userType: "owner", status: "active" }) }));
vi.mock("../src/server/moderation-queue-db", () => ({
  listQueuePg: async () => [{ id: "i1", history: [] }],
  queueCountsPg: async () => ({ open: 1, escalated: 0 }),
  getQueueTargetPg: async () => state.target,
  decideQueueItemPg: async (...a: unknown[]) => { state.decided.push(a); return state.decided.length === 1; },
  SuspensionConflict: class SuspensionConflict extends Error {},
  rejectAndSuspendPg: async (...a: unknown[]) => {
    if (state.conflict) { const { SuspensionConflict } = await import("../src/server/moderation-queue-db"); throw new SuspensionConflict(); }
    state.suspended.push(a); return { decided: state.suspended.length === 1, listingsSuspended: 2 };
  }
}));

import * as list from "../app/api/staff/review-queue/route";
import * as decide from "../app/api/staff/review-queue/[id]/route";

const ID = "55555555-5555-4555-8555-555555555555";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const H = { "content-type": "application/json", origin: "http://test" };
const post = (body: unknown) => new Request("http://test/x", { method: "POST", headers: H, body: JSON.stringify(body) });
const get = (q = "") => new Request(`http://test/x${q}`, { headers: H });
const OK = { decision: "reject", reason: "Breaks the listing rules." };

beforeEach(() => {
  process.env["APP_URL"] = "http://test";
  state.staff = { id: "a1111111-1111-4111-8111-111111111111", role: "support" };
  state.target = { id: ID, status: "open", subjectOwnerId: null };
  state.decided = []; state.suspended = []; state.listingStatus = "published"; state.conflict = false;
});

describe("staff review queue routes", () => {
  it("needs a signed-in staff member with the permission", async () => {
    state.staff = null;
    expect((await list.GET(get())).status).toBe(401);
    state.staff = { id: "a1111111-1111-4111-8111-111111111111", role: "accountant" };
    expect((await list.GET(get())).status).toBe(403);
    expect((await decide.POST(post(OK), ctx(ID))).status).toBe(403);
  });
  it("lists the queue with counts and what this role may decide", async () => {
    const r = await list.GET(get("?view=open&type=listing"));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.counts).toEqual({ open: 1, escalated: 0 });
    expect(body.decisions).toEqual({ open: ["approve", "reject", "escalate"], escalated: [] });
    expect(body.canSuspend).toEqual({ listing: true, account: false });
    expect((await list.GET(get("?view=nope"))).status).toBe(400);
    expect((await list.GET(get("?type=nope"))).status).toBe(400);
  });
  it("records a decision once, with the reason", async () => {
    expect((await decide.POST(post(OK), ctx(ID))).status).toBe(200);
    expect(state.decided[0]!.slice(2)).toEqual([state.staff, "reject", "open", "Breaks the listing rules."]);
    expect((await decide.POST(post(OK), ctx(ID))).status).toBe(409);
  });
  it("rejects bad input, missing items, own content and escalated items for junior reviewers", async () => {
    expect((await decide.POST(post({ decision: "reject", reason: "no" }), ctx(ID))).status).toBe(400);
    expect((await decide.POST(post(OK), ctx("not-a-uuid"))).status).toBe(404);
    state.target = null;
    expect((await decide.POST(post(OK), ctx(ID))).status).toBe(404);
    state.target = { id: ID, status: "open", subjectOwnerId: state.staff!.id };
    expect((await decide.POST(post(OK), ctx(ID))).status).toBe(403);
    state.target = { id: ID, status: "escalated", subjectOwnerId: null };
    expect((await decide.POST(post(OK), ctx(ID))).status).toBe(403);
    state.staff = { id: state.staff!.id, role: "compliance" };
    expect((await decide.POST(post(OK), ctx(ID))).status).toBe(200);
    expect(state.decided).toHaveLength(1);
  });
  describe("reject and suspend", () => {
    const L = "66666666-6666-4666-8666-666666666666";
    const OWNER = "77777777-7777-4777-8777-777777777777";
    const SUS = { ...OK, suspend: "listing", confirm: true };
    beforeEach(() => { state.target = { id: ID, status: "open", subjectOwnerId: OWNER, subjectType: "listing", subjectId: L } as typeof state.target; });

    it("suspends the listing together with the decision, only after an explicit confirm", async () => {
      expect((await decide.POST(post({ ...OK, suspend: "listing" }), ctx(ID))).status).toBe(400);
      expect(state.suspended).toHaveLength(0);
      const r = await decide.POST(post(SUS), ctx(ID));
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ status: "rejected", suspended: "listing" });
      expect(state.suspended[0]![5]).toMatchObject({ kind: "listing", listingId: L });
      expect(state.decided).toHaveLength(0);
    });
    it("suspends the account, with the listings choice", async () => {
      state.staff = { id: state.staff!.id, role: "compliance" };
      const r = await decide.POST(post({ ...OK, suspend: "account", confirm: true, listings: "keep" }), ctx(ID));
      expect(r.status).toBe(200);
      expect(state.suspended[0]![5]).toMatchObject({ kind: "account", userId: OWNER, withListings: false });
    });
    it("refuses suspension on approve, on a listing that is not live, and without the permission", async () => {
      expect((await decide.POST(post({ decision: "approve", reason: OK.reason, suspend: "listing", confirm: true }), ctx(ID))).status).toBe(400);
      state.listingStatus = "draft";
      expect((await decide.POST(post(SUS), ctx(ID))).status).toBe(409);
      state.listingStatus = "published";
      state.staff = { id: state.staff!.id, role: "support" };
      expect((await decide.POST(post({ ...OK, suspend: "account", confirm: true }), ctx(ID))).status).toBe(403);
      expect(state.suspended).toHaveLength(0);
    });
    it("answers 409 and changes nothing when someone decided first or the listing changed", async () => {
      expect((await decide.POST(post(SUS), ctx(ID))).status).toBe(200);
      expect((await decide.POST(post(SUS), ctx(ID))).status).toBe(409);
      state.conflict = true;
      expect((await decide.POST(post(SUS), ctx(ID))).status).toBe(409);
    });
  });
});
