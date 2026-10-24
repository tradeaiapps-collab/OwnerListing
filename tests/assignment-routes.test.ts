import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryAssignmentRepository, type AssignmentRepository } from "../src/domain/assignment-service";
import type { Actor } from "../src/domain/listing-service";

const state = vi.hoisted(() => ({ actor: null as Actor | null, repo: null as AssignmentRepository | null }));

vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => ({}) }));
vi.mock("../src/server/assignment-db", () => {
  let n = 0;
  return {
    getAssignmentRepo: () => state.repo,
    assignmentIds: { newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, now: () => "2026-10-24T00:00:00.000Z" }
  };
});

import * as listingRoute from "../app/api/listings/[id]/assignments/route";
import * as mineRoute from "../app/api/assignments/route";
import * as actRoute from "../app/api/assignments/[id]/route";

const LISTING = "55555555-5555-4555-8555-555555555555";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const vendor: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "agent" };
const stranger: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "owner" };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const inviteReq = (body: unknown) => listingRoute.POST(post(`http://test/api/listings/${LISTING}/assignments`, body), ctx(LISTING));
const actReq = (id: string, body: unknown) => actRoute.POST(post(`http://test/api/assignments/${id}`, body), ctx(id));

describe("contractor assignment routes", () => {
  let repo: ReturnType<typeof createInMemoryAssignmentRepository>;
  beforeEach(() => {
    repo = createInMemoryAssignmentRepository({
      listings: [{ id: LISTING, ownerUserId: owner.userId, jurisdiction: "QLD", title: "House" }],
      users: [
        { id: owner.userId, userType: "owner", status: "active", displayName: "Olive" },
        { id: vendor.userId, userType: "vendor", status: "active", email: "pat@example.com", displayName: "Pat" }
      ]
    });
    state.repo = repo;
    state.actor = owner;
  });

  it("returns 401 for every route when signed out", async () => {
    state.actor = null;
    expect((await inviteReq({})).status).toBe(401);
    expect((await listingRoute.GET(new Request("http://test/x"), ctx(LISTING))).status).toBe(401);
    expect((await mineRoute.GET(new Request("http://test/x"))).status).toBe(401);
    expect((await actReq("x", {})).status).toBe(401);
  });

  it("runs invite -> accept -> chat-ready end to end with the right audit trail", async () => {
    const inv = await inviteReq({ kind: "photographer", email: "pat@example.com" });
    expect(inv.status).toBe(201);
    const { assignment } = await inv.json();
    expect(assignment.status).toBe("proposed");

    state.actor = vendor;
    const mine = await mineRoute.GET(new Request("http://test/api/assignments"));
    expect((await mine.json()).assignments).toMatchObject([{ id: assignment.id, role: "contractor" }]);
    const accepted = await actReq(assignment.id, { action: "accept" });
    expect(accepted.status).toBe(200);
    expect(repo.assignments[0]?.status).toBe("approved");
    expect(repo.audits.map(e => e.eventType)).toEqual(["assignment.invited", "assignment.accepted"]);
  });

  it("404s a stranger on invite, list and act, and 403s the wrong party", async () => {
    const { assignment } = await (await inviteReq({ kind: "photographer", contractorUserId: vendor.userId })).json();
    state.actor = stranger;
    expect((await inviteReq({ kind: "photographer", contractorUserId: vendor.userId })).status).toBe(404);
    expect((await listingRoute.GET(new Request("http://test/x"), ctx(LISTING))).status).toBe(404);
    expect((await actReq(assignment.id, { action: "accept" })).status).toBe(404);
    state.actor = owner;
    expect((await actReq(assignment.id, { action: "accept" })).status).toBe(403);
  });

  it("gives 400 for a malformed body and 409 for a duplicate invite", async () => {
    expect((await inviteReq({ kind: "photographer" })).status).toBe(400);
    expect((await inviteReq({ kind: "photographer", email: "pat@example.com" })).status).toBe(201);
    expect((await inviteReq({ kind: "photographer", email: "pat@example.com" })).status).toBe(409);
  });

  it("exposes no DELETE, PUT or PATCH handler on any assignment route", () => {
    for (const mod of [listingRoute, mineRoute, actRoute] as unknown as Record<string, unknown>[]) {
      expect(mod["DELETE"]).toBeUndefined();
      expect(mod["PUT"]).toBeUndefined();
      expect(mod["PATCH"]).toBeUndefined();
    }
  });
});
