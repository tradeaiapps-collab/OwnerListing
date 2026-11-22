import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ actor: null as { userId: string; userType: string } | null, staff: null as { id: string; role: string } | null, calls: [] as unknown[][] }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getActor: async () => state.actor, getStaff: async () => state.staff }));
vi.mock("../src/server/transaction-message-db", () => {
  const rec = (name: string) => async (_db: unknown, ...a: unknown[]) => { state.calls.push([name, ...a]); return { ok: true, value: {} }; };
  return { inbox: async (_db: unknown, ...a: unknown[]) => { state.calls.push(["inbox", ...a]); return { threads: [], unread: 0 }; }, threadMessages: rec("thread"), sendMessage: rec("send"), markRead: rec("read"), setMuted: rec("mute"), setArchived: rec("archive") };
});

import * as inboxRoute from "../app/api/messages/route";
import * as one from "../app/api/messages/[id]/route";
process.env["APP_URL"] = "http://test";

const ID = "00000000-0000-4000-8000-000000000001";
const H = { "content-type": "application/json", origin: "http://test" };
type Ctx = { params: Promise<{ id: string }> };
const post = (body: unknown, headers: Record<string, string> = H, id = ID) => (one.POST as (r: Request, c: Ctx) => Promise<Response>)(new Request("http://test/api/x", { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const get = (id = ID) => (one.GET as (r: Request, c: Ctx) => Promise<Response>)(new Request("http://test/api/x"), { params: Promise.resolve({ id }) });

describe("message routes", () => {
  beforeEach(() => { state.actor = null; state.staff = null; state.calls = []; });

  it("needs a session, a same-origin request and a real id", async () => {
    expect((await (inboxRoute.GET as (r: Request) => Promise<Response>)(new Request("http://test/api/messages"))).status).toBe(401);
    expect((await get()).status).toBe(401);
    expect((await post({ body: "hi" })).status).toBe(401);
    state.actor = { userId: "u1", userType: "buyer" };
    expect((await post({ body: "hi" }, { ...H, origin: "http://evil" })).status).toBe(403);
    expect((await get("nope")).status).toBe(404);
    expect((await post({ body: "" })).status).toBe(400);
    expect((await post({ action: "delete" })).status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it("uses only the signed-in user, never one named in the body, and never grants staff powers to people", async () => {
    state.actor = { userId: "u1", userType: "buyer" };
    expect((await post({ body: "hi", userId: "other", staffPermissions: ["case.manage"] })).status).toBe(201);
    expect(state.calls[0]!.slice(0, 3)).toEqual(["send", "u1", ID]);
    expect(state.calls[0]![3]).toMatchObject({ body: "hi" });
    expect(state.calls[0]![5]).toEqual({ staffPermissions: null });
    expect((await post({ action: "read" })).status).toBe(200);
    expect((await post({ action: "mute", muted: true })).status).toBe(200);
    expect((await post({ action: "archive", archived: true })).status).toBe(200);
    expect(state.calls.map(c => c[0])).toEqual(["send", "read", "mute", "archive"]);
  });

  it("gives staff their role's permissions for the team channels", async () => {
    state.staff = { id: "s1", role: "support" };
    expect((await get()).status).toBe(200);
    expect(state.calls[0]![0]).toBe("thread");
    expect((state.calls[0]![3] as { staffPermissions: string[] }).staffPermissions).toContain("case.manage");
  });
});
