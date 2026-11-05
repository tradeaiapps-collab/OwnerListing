import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/listing-service";

const state = vi.hoisted(() => ({
  actor: null as Actor | null,
  calls: [] as { text: string; params: unknown[] | undefined }[],
  phone: null as string | null,
  prefRows: [] as Record<string, unknown>[]
}));

const fakeDb = {
  async query(text: string, params?: unknown[]) {
    state.calls.push({ text, params });
    if (text.includes("FROM app_user u LEFT JOIN buyer_verification")) return { rows: [{ email: "a@example.test", phone_e164: state.phone }] };
    if (text.includes("FROM notification_preference")) return { rows: state.prefRows };
    if (text.includes("FROM notification\n") || text.includes("FROM notification ")) {
      if (text.includes("GROUP BY category")) return { rows: [{ category: "offers", total: 10, read: 9 }] };
      if (text.includes("count(*)")) return { rows: [{ n: 3 }] };
      if (text.startsWith("SELECT id, kind")) return { rows: [{ id: "a1", kind: "offer_received", category: "offers", title: "New offer received", body: "b", link: "/listings/mine", created_at: new Date("2026-11-01T00:00:00Z"), read_at: null, archived_at: null }] };
    }
    if (text.startsWith("UPDATE notification")) return { rows: [{ id: "x" }] };
    if (text.startsWith("DELETE FROM notification")) return { rows: [{ id: "x" }, { id: "y" }] };
    return { rows: [] };
  }
};

vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => fakeDb }));

import * as list from "../app/api/notifications/route";
import * as read from "../app/api/notifications/read/route";
import * as archive from "../app/api/notifications/archive/route";
import * as prefs from "../app/api/notifications/preferences/route";
import * as elena from "../app/api/notifications/assistant/route";
import * as unsub from "../app/api/notifications/unsubscribe/route";
import { makeNotificationUnsubscribeToken } from "../src/server/notifications-db";
process.env["APP_URL"] = "http://test";

const U = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const owner: Actor = { userId: U, userType: "owner" };
const send = (method: string, b?: unknown, headers: Record<string, string> = {}, url = "http://test/api/x") =>
  new Request(url, { method, headers: { "content-type": "application/json", origin: "http://test", ...headers }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });

beforeEach(() => { state.actor = null; state.calls = []; state.phone = null; state.prefRows = []; });

describe("notification routes", () => {
  it("require sign-in", async () => {
    expect((await list.GET(send("GET"))).status).toBe(401);
    expect((await list.DELETE(send("DELETE"))).status).toBe(401);
    expect((await read.POST(send("POST", { all: true }))).status).toBe(401);
    expect((await archive.POST(send("POST", { all: true }))).status).toBe(401);
    expect((await prefs.GET(send("GET"))).status).toBe(401);
    expect((await prefs.PUT(send("PUT", { preferences: {} }))).status).toBe(401);
    expect((await elena.POST(send("POST", { action: "summary" }))).status).toBe(401);
  });

  it("refuse writes from another origin", async () => {
    state.actor = owner;
    const evil = { origin: "http://evil.test" };
    expect((await read.POST(send("POST", { all: true }, evil))).status).toBe(403);
    expect((await archive.POST(send("POST", { all: true }, evil))).status).toBe(403);
    expect((await prefs.PUT(send("PUT", { preferences: {} }, evil))).status).toBe(403);
    expect((await list.DELETE(send("DELETE", undefined, evil))).status).toBe(403);
    expect((await elena.POST(send("POST", { action: "summary" }, evil))).status).toBe(403);
  });

  it("lists the signed-in user's notifications, always scoped to the session user", async () => {
    state.actor = owner;
    const r = await list.GET(send("GET", undefined, {}, "http://test/api/notifications?status=history&limit=5"));
    const d = await r.json();
    expect(r.status).toBe(200);
    expect(d.unread).toBe(3);
    expect(d.notifications[0]).toMatchObject({ id: "a1", title: "New offer received", readAt: null });
    expect(state.calls.every(c => c.params?.[0] === U)).toBe(true);
  });

  it("read and archive validate ids and only touch the session user's rows", async () => {
    state.actor = owner;
    for (const bad of [null, {}, { ids: [] }, { ids: ["nope"] }, { ids: Array(51).fill(ID) }, { all: false }])
      expect((await read.POST(send("POST", bad))).status).toBe(400);
    const ok = await read.POST(send("POST", { ids: [ID] }));
    expect(ok.status).toBe(200);
    const upd = state.calls.find(c => c.text.startsWith("UPDATE notification"))!;
    expect(upd.text).toContain("user_id = $1::uuid");
    expect(upd.params).toEqual([U, [ID]]);
    expect((await archive.POST(send("POST", { all: true }))).status).toBe(200);
  });

  it("deletes only the caller's history", async () => {
    state.actor = owner;
    const r = await list.DELETE(send("DELETE"));
    expect(await r.json()).toEqual({ deleted: 2 });
    const del = state.calls.find(c => c.text.startsWith("DELETE FROM notification"))!;
    expect(del.text).toContain("archived_at IS NOT NULL");
    expect(del.params).toEqual([U]);
  });

  it("returns defaults, and refuses bad preference bodies and SMS without a verified phone", async () => {
    state.actor = owner;
    const g = await (await prefs.GET(send("GET"))).json();
    expect(g.phoneVerified).toBe(false);
    expect(g.preferences.marketing).toEqual({ inApp: false, email: false, sms: false });
    expect(g.categories).toHaveLength(6);
    expect((await prefs.PUT(send("PUT", { preferences: { account: { inApp: true, email: false, sms: false } } }))).status).toBe(400);
    expect((await prefs.PUT(send("PUT", { preferences: { offers: { inApp: true, email: true, sms: true } } }))).status).toBe(400);
    expect(state.calls.some(c => c.text.includes("INSERT INTO notification_preference"))).toBe(false);
    state.phone = "+61400000001";
    const ok = await prefs.PUT(send("PUT", { preferences: { offers: { inApp: true, email: true, sms: true } } }));
    expect(ok.status).toBe(200);
    expect(state.calls.some(c => c.text.includes("INSERT INTO notification_consent_log"))).toBe(true);
  });

  it("Elena summarises, answers and suggests, and refuses unknown actions", async () => {
    state.actor = owner;
    state.phone = "+61400000001";
    const s = await (await elena.POST(send("POST", { action: "summary" }))).json();
    expect(s.reply.text).toContain("1 unread notification");
    const a = await (await elena.POST(send("POST", { action: "ask", question: "How do I turn off texts?" }))).json();
    expect(a.reply.text).toMatch(/Text messages/);
    const g = await (await elena.POST(send("POST", { action: "suggest" }))).json();
    expect(g.suggestions).toEqual([expect.objectContaining({ category: "offers", channel: "sms", turnOn: true })]);
    expect(g.note).toMatch(/Not legal/);
    expect((await elena.POST(send("POST", { action: "ask" }))).status).toBe(400);
    expect((await elena.POST(send("POST", { action: "delete everything" }))).status).toBe(400);
  });

  it("unsubscribe: bad token 400, GET changes nothing, POST turns email off and logs consent withdrawn", async () => {
    process.env["ALERT_UNSUBSCRIBE_KEY"] = "k".repeat(40);
    const url = (t: string) => `http://test/api/notifications/unsubscribe?t=${encodeURIComponent(t)}`;
    expect((await unsub.GET(send("GET", undefined, {}, url("bad")))).status).toBe(400);
    expect((await unsub.POST(send("POST", undefined, {}, url("bad")))).status).toBe(400);
    const t = makeNotificationUnsubscribeToken(U, "marketing", process.env["ALERT_UNSUBSCRIBE_KEY"])!;
    state.prefRows = [{ category: "marketing", in_app: false, email: true, sms: false }];
    expect((await unsub.GET(send("GET", undefined, {}, url(t)))).status).toBe(200);
    expect(state.calls.some(c => c.text.includes("INSERT"))).toBe(false);
    expect((await unsub.POST(send("POST", undefined, {}, url(t)))).status).toBe(200);
    const log = state.calls.find(c => c.text.includes("INSERT INTO notification_consent_log"))!;
    expect(log.params).toEqual([U, "email", "marketing", false, "unsubscribe_link"]);
    // An account (locked) token is refused.
    const acct = makeNotificationUnsubscribeToken(U, "account", process.env["ALERT_UNSUBSCRIBE_KEY"])!;
    expect((await unsub.POST(send("POST", undefined, {}, url(acct)))).status).toBe(400);
    delete process.env["ALERT_UNSUBSCRIBE_KEY"];
  });
});
