import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/listing-service";

const state = vi.hoisted(() => ({
  actor: null as Actor | null,
  staff: null as unknown,
  calls: [] as { text: string; params: unknown[] | undefined }[],
  prefRows: [] as Record<string, unknown>[],
  revoked: true
}));

const fakeDb = {
  async query(text: string, params?: unknown[]) {
    state.calls.push({ text, params });
    if (text.includes("INSERT INTO push_device")) return { rows: [{ id: "33333333-3333-4333-8333-333333333333" }] };
    if (text.includes("FROM push_device")) return { rows: [{ id: "33333333-3333-4333-8333-333333333333", platform: "web", label: "Laptop", created_at: new Date("2026-11-01T00:00:00Z"), last_seen_at: new Date("2026-11-02T00:00:00Z") }] };
    if (text.startsWith("UPDATE push_device SET revoked_at = now() WHERE id")) return { rows: state.revoked ? [{ id: "x" }] : [] };
    if (text.includes("FROM push_preference")) return { rows: state.prefRows };
    if (text.startsWith("UPDATE push_delivery")) return { rows: [{ id: "x" }] };
    if (text.includes("FROM push_delivery")) return { rows: [{ platform: "web", category: "offers", personalized: true, sent: 10, failed: 1, gone: 0, clicked: 4, dismissed: 2 }] };
    return { rows: [] };
  }
};

vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => fakeDb, getStaff: () => state.staff }));

import * as devices from "../app/api/push/devices/route";
import * as prefs from "../app/api/push/preferences/route";
import * as event from "../app/api/push/event/route";
import * as staffPush from "../app/api/staff/push/route";
process.env["APP_URL"] = "http://test";

const U = "11111111-1111-4111-8111-111111111111";
const DEV = "33333333-3333-4333-8333-333333333333";
const owner: Actor = { userId: U, userType: "owner" };
const send = (method: string, b?: unknown, headers: Record<string, string> = {}, url = "http://test/api/x") =>
  new Request(url, { method, headers: { "content-type": "application/json", origin: "http://test", ...headers }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
const sub = { platform: "web", subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } } };

beforeEach(() => { state.actor = null; state.staff = null; state.calls = []; state.prefRows = []; state.revoked = true; });

describe("push routes", () => {
  it("require sign-in", async () => {
    expect((await devices.GET(send("GET"))).status).toBe(401);
    expect((await devices.POST(send("POST", sub))).status).toBe(401);
    expect((await devices.DELETE(send("DELETE", { id: DEV }))).status).toBe(401);
    expect((await prefs.GET(send("GET"))).status).toBe(401);
    expect((await prefs.PUT(send("PUT", { topics: {} }))).status).toBe(401);
  });

  it("refuse cross-origin writes", async () => {
    state.actor = owner;
    expect((await devices.POST(send("POST", sub, { origin: "http://evil.test" }))).status).toBe(403);
    expect((await prefs.PUT(send("PUT", { topics: { offers: false } }, { origin: "http://evil.test" }))).status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("lists devices with the platforms the server can push to", async () => {
    state.actor = owner;
    const body = await (await devices.GET(send("GET"))).json();
    expect(body.devices).toEqual([{ id: DEV, platform: "web", label: "Laptop", createdAt: "2026-11-01T00:00:00.000Z", lastSeenAt: "2026-11-02T00:00:00.000Z" }]);
    expect(body.platforms).toEqual({ web: false, android: false, ios: false });
    expect(body.webPublicKey).toBeNull();
    expect(JSON.stringify(body)).not.toContain("fcm.googleapis");
  });

  it("registers a device for the signed-in user only, and refuses a bad subscription", async () => {
    state.actor = owner;
    const r = await devices.POST(send("POST", sub));
    expect([r.status, (await r.json()).id]).toEqual([201, DEV]);
    expect(state.calls[0]!.params![0]).toBe(U);
    expect((await devices.POST(send("POST", { ...sub, subscription: { ...sub.subscription, endpoint: "https://169.254.169.254/x" } }))).status).toBe(400);
    expect((await devices.POST(send("POST", { platform: "android", token: "short" }))).status).toBe(400);
    expect((await devices.POST(send("POST", { userId: "someone-else", ...sub }))).status).toBe(201);
    expect(state.calls.every(c => c.params?.[0] === U || !c.text.includes("INSERT"))).toBe(true);
  });

  it("removes a device by id, 404 when it is not the user's", async () => {
    state.actor = owner;
    expect((await devices.DELETE(send("DELETE", { id: DEV }))).status).toBe(200);
    expect(state.calls[0]!.params).toEqual([DEV, U]);
    state.revoked = false;
    expect((await devices.DELETE(send("DELETE", { id: DEV }))).status).toBe(404);
    expect((await devices.DELETE(send("DELETE", { id: "nope" }))).status).toBe(400);
  });

  it("reads and saves push topics, refusing to turn off account notices", async () => {
    state.actor = owner;
    const g = await (await prefs.GET(send("GET"))).json();
    expect(g.topics.offers).toBe(true);
    expect(g.catalogue.find((c: { category: string }) => c.category === "account").locked).toBe(true);
    expect((await prefs.PUT(send("PUT", { topics: { offers: false } }))).status).toBe(200);
    expect((await prefs.PUT(send("PUT", { topics: { account: false } }))).status).toBe(400);
    expect((await prefs.PUT(send("PUT", { topics: { nope: true } }))).status).toBe(400);
  });

  it("accepts an open or dismiss report without sign-in, and refuses anything else", async () => {
    expect((await event.POST(send("POST", { id: DEV, event: "clicked" }, { origin: "" }))).status).toBe(200);
    expect((await event.POST(send("POST", { id: DEV, event: "dismissed" }))).status).toBe(200);
    expect((await event.POST(send("POST", { id: DEV, event: "deleted" }))).status).toBe(400);
    expect((await event.POST(send("POST", { id: "x'; DROP TABLE push_delivery;--", event: "clicked" }))).status).toBe(400);
    expect(state.calls.filter(c => c.text.startsWith("UPDATE push_delivery"))).toHaveLength(2);
  });

  it("staff engagement needs staff sign-in and the sales report permission", async () => {
    expect((await staffPush.GET(send("GET"))).status).toBe(401);
    state.staff = { id: "s1", role: "support" };
    expect((await staffPush.GET(send("GET"))).status).toBe(403);
    state.staff = { id: "s1", role: "accountant" };
    const body = await (await staffPush.GET(send("GET", undefined, {}, "http://test/api/staff/push?from=2026-10-01&to=2026-10-31"))).json();
    expect(body.engagement.total).toMatchObject({ sent: 10, clicked: 4, clickRate: 0.4 });
    expect(body.engagement.personalization.personalized.sent).toBe(10);
    expect((await staffPush.GET(send("GET", undefined, {}, "http://test/api/staff/push?from=bad"))).status).toBe(400);
    expect((await staffPush.GET(send("GET", undefined, {}, "http://test/api/staff/push?from=2026-10-31&to=2026-10-01"))).status).toBe(400);
  });
});
