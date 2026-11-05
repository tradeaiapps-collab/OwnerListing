import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ actor: null as { userId: string; userType: string } | null, staff: null as StaffActor | null, calls: [] as unknown[][], out: { ok: true, value: {} } as unknown, claim: 5000 as number | null }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getActor: async () => state.actor, getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/dispute-db", () => {
  const rec = (name: string) => async (_db: unknown, ...a: unknown[]) => { state.calls.push([name, ...a]); return state.out; };
  return {
    listDisputes: async (_db: unknown, ...a: unknown[]) => { state.calls.push(["list", ...a]); return []; },
    createDispute: rec("create"), submitPosition: rec("position"), respond: rec("respond"), withdraw: rec("withdraw"), staffAct: rec("staff"),
    disputeView: async (_db: unknown, ...a: unknown[]) => { state.calls.push(["view", ...a]); return state.out && (state.out as { ok: boolean }).ok ? { ok: true, value: { claimCents: state.claim } } : state.out; },
    staffQueue: async () => ({ rows: [], metrics: {} }), staffView: async () => ({ ok: true, value: {} })
  };
});

import * as all from "../app/api/disputes/route";
import * as perSettlement from "../app/api/settlements/[id]/disputes/route";
import * as one from "../app/api/settlements/[id]/disputes/[did]/route";
import * as staffList from "../app/api/staff/disputes/route";
import * as staffOne from "../app/api/staff/disputes/[id]/route";
process.env["APP_URL"] = "http://test";

const S = "00000000-0000-4000-8000-000000000001", D = "00000000-0000-4000-8000-000000000002";
const H = { "content-type": "application/json", origin: "http://test" };
type Ctx = { params: Promise<Record<string, string>> };
const ctx = (p: Record<string, string> = { id: S, did: D }): Ctx => ({ params: Promise.resolve(p) });
const get = (route: { GET: unknown }, p?: Record<string, string>, url = "http://test/api/x") => (route.GET as (r: Request, c: Ctx) => Promise<Response>)(new Request(url), ctx(p));
const post = (route: { POST: unknown }, body: unknown, headers: Record<string, string> = H, p?: Record<string, string>) =>
  (route.POST as (r: Request, c: Ctx) => Promise<Response>)(new Request("http://test/api/x", { method: "POST", headers, body: JSON.stringify(body) }), ctx(p));
const create = { type: "repair", title: "Roof", description: "Leaks", position: "Seller pays", claimCents: 5000, sellerSharePct: 100 };

describe("dispute routes", () => {
  beforeEach(() => { state.actor = null; state.staff = null; state.calls = []; state.out = { ok: true, value: {} }; state.claim = 5000; });

  it("needs a session, a same-origin request and real ids", async () => {
    expect((await get(all)).status).toBe(401);
    expect((await get(perSettlement)).status).toBe(401);
    expect((await get(one)).status).toBe(401);
    expect((await post(perSettlement, create)).status).toBe(401);
    expect((await post(one, { action: "withdraw" })).status).toBe(401);
    state.actor = { userId: "u1", userType: "buyer" };
    expect((await post(perSettlement, create, { ...H, origin: "http://evil" })).status).toBe(403);
    expect((await post(one, { action: "withdraw" }, { ...H, origin: "http://evil" })).status).toBe(403);
    expect((await get(one, { id: "nope", did: D })).status).toBe(404);
    expect((await post(one, { action: "withdraw" }, H, { id: S, did: "nope" })).status).toBe(404);
    expect(state.calls).toEqual([]);
  });

  it("passes only the signed-in user, never an id or side from the body", async () => {
    state.actor = { userId: "u1", userType: "buyer" };
    expect((await post(perSettlement, { ...create, userId: "other", side: "seller", initiatedBy: "seller" })).status).toBe(201);
    await post(one, { action: "respond", response: "counter", sellerSharePct: 40, userId: "other", side: "seller" });
    expect(state.calls).toEqual([
      ["create", "u1", S, { type: "repair", title: "Roof", description: "Leaks", position: "Seller pays", claimCents: 5000, sellerSharePct: 100 }],
      ["view", "u1", S, D],
      ["respond", "u1", S, D, { action: "respond", response: "counter", sellerSharePct: 40, note: null }]
    ]);
  });

  it("validates before changing anything and relays refusals", async () => {
    state.actor = { userId: "u1", userType: "buyer" };
    expect((await post(perSettlement, { ...create, type: "x" })).status).toBe(400);
    expect((await post(one, { action: "respond", response: "counter" })).status).toBe(400);
    expect(state.calls.some(c => c[0] === "create" || c[0] === "respond")).toBe(false);
    state.calls = [];
    state.claim = null;
    expect((await post(one, { action: "respond", response: "counter", note: "More time" })).status).toBe(200);
    state.out = { ok: false, status: 403, error: "Only the buyer or the owner can answer a dispute." };
    expect((await post(one, { action: "respond", response: "accept" })).status).toBe(403);
  });

  it("filters the list by side and rejects other values", async () => {
    state.actor = { userId: "u1", userType: "owner" };
    expect((await get(all, undefined, "http://test/api/disputes?side=seller")).status).toBe(200);
    expect((await get(all, undefined, "http://test/api/disputes?side=staff")).status).toBe(400);
    expect(state.calls).toEqual([["list", "u1", { side: "seller" }]]);
  });

  it("staff routes need a staff session with case.manage and a valid action", async () => {
    const list = () => (staffList.GET as (r: Request) => Promise<Response>)(new Request("http://test/api/staff/disputes"));
    expect((await list()).status).toBe(401);
    state.staff = { id: "s1", role: "reporting", permissions: [] } as unknown as StaffActor;
    expect((await list()).status).toBe(403);
    state.staff = { id: "s1", role: "support", permissions: [] } as unknown as StaffActor;
    expect((await list()).status).toBe(200);
    expect((await post(staffOne, { action: "resolve" }, H, { id: D })).status).toBe(400);
    expect((await post(staffOne, { action: "resolve", outcome: "Seller credits $2,000", sellerSharePct: 60 }, H, { id: D })).status).toBe(200);
    expect((await post(staffOne, { action: "claim" }, { ...H, origin: "http://evil" }, { id: D })).status).toBe(403);
    expect((await post(staffOne, { action: "claim" }, H, { id: "nope" })).status).toBe(404);
    expect(state.calls).toEqual([["staff", "s1", D, { action: "resolve", outcome: "Seller credits $2,000", sellerSharePct: 60 }]]);
  });
});
