import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ actor: null as { userId: string; userType: string } | null, mfa: true, calls: [] as [string, ...unknown[]][], out: { ok: true, value: {} } as unknown }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getActor: async () => state.actor, getStaff: async () => null }));
vi.mock("../src/server/mfa-context", async () => {
  const { NextResponse } = await import("next/server");
  return { requireRecentMfa: async () => (state.mfa ? null : NextResponse.json({ error: "Confirm it's you", code: "mfa_required" }, { status: 403 })) };
});
vi.mock("../src/server/sale-fall-through-db", () => {
  const rec = (name: string) => async (...a: unknown[]) => { state.calls.push([name, ...a.slice(1)]); return state.out; };
  return { fallThroughView: rec("view"), previewFallThrough: rec("preview"), raiseFallThrough: rec("raise"), respondFallThrough: rec("respond"), withdrawFallThrough: rec("withdraw") };
});

import * as buyer from "../app/api/offers/[offerId]/fall-through/route";
import * as owner from "../app/api/listings/[id]/offers/[offerId]/fall-through/route";
process.env["APP_URL"] = "http://test";

const OFFER = "00000000-0000-4000-8000-000000000001";
const H = { "content-type": "application/json", origin: "http://test" };
const post = (route: typeof buyer | typeof owner, body: unknown, headers: Record<string, string> = H) =>
  (route.POST as (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(
    new Request("http://test/api/x", { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id: OFFER, offerId: OFFER }) });
const get = (route: typeof buyer | typeof owner, offerId = OFFER) =>
  (route.GET as (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(new Request("http://test/api/x"), { params: Promise.resolve({ id: offerId, offerId }) });

describe("sale fell through routes", () => {
  beforeEach(() => { state.actor = null; state.mfa = true; state.calls = []; state.out = { ok: true, value: {} }; });

  it("needs a session, a same-origin request and a real offer id", async () => {
    expect((await get(buyer)).status).toBe(401);
    expect((await post(buyer, { action: "withdraw" })).status).toBe(401);
    state.actor = { userId: "u1", userType: "buyer" };
    expect((await post(buyer, { action: "withdraw" }, { ...H, origin: "http://evil" })).status).toBe(403);
    expect((await get(buyer, "not-a-uuid")).status).toBe(404);
    expect(state.calls).toEqual([]);
  });

  it("passes the signed-in user and the side the route is for; the side is never taken from the body", async () => {
    state.actor = { userId: "u1", userType: "buyer" };
    await get(buyer);
    await post(owner, { action: "raise", reason: "buyer_default", note: "Never paid", party: "buyer", userId: "someone-else" });
    expect(state.calls).toEqual([["view", "u1", "buyer", OFFER], ["raise", "u1", "owner", OFFER, "buyer_default", "Never paid"]]);
  });

  it("validates before touching the database", async () => {
    state.actor = { userId: "u1", userType: "buyer" };
    expect((await post(buyer, { action: "raise", reason: "because" })).status).toBe(400);
    expect((await post(buyer, { action: "respond", decision: "dispute", note: "no" })).status).toBe(400);
    expect((await post(buyer, { action: "nope" })).status).toBe(400);
    expect((await post(buyer, [])).status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it("agreeing needs a recent second-factor check; disputing, previewing and withdrawing do not", async () => {
    state.actor = { userId: "u1", userType: "owner" };
    state.mfa = false;
    const r = await post(owner, { action: "respond", decision: "agree" });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: "mfa_required" });
    expect(state.calls).toEqual([]);
    expect((await post(owner, { action: "respond", decision: "dispute", note: "The condition was waived" })).status).toBe(200);
    expect((await post(owner, { action: "preview", reason: "mutual_termination" })).status).toBe(200);
    expect((await post(owner, { action: "withdraw" })).status).toBe(200);
    state.mfa = true;
    expect((await post(owner, { action: "respond", decision: "agree" })).status).toBe(200);
    expect(state.calls.map(c => c[0])).toEqual(["respond", "preview", "withdraw", "respond"]);
  });

  it("turns a refusal into its status and message", async () => {
    state.actor = { userId: "u1", userType: "buyer" };
    state.out = { ok: false, status: 409, error: "A request is already open." };
    const r = await post(buyer, { action: "raise", reason: "mutual_termination" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "A request is already open." });
    state.out = { ok: true, value: { id: "c1" } };
    expect((await post(buyer, { action: "raise", reason: "mutual_termination" })).status).toBe(201);
  });
});
