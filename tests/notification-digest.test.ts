import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/listing-service";
import { composeDigest, isUrgent, parseDigestInput, renderDigestEmail } from "../src/domain/digest";
import type { Category, NotificationView } from "../src/domain/notifications";

const state = vi.hoisted(() => ({
  actor: null as Actor | null,
  calls: [] as { text: string; params: unknown[] | undefined }[],
  due: [] as Record<string, unknown>[],
  claim: true,
  items: [] as Record<string, unknown>[],
  prefs: [] as Record<string, unknown>[],
  sent: [] as { to: string; subject: string; text: string; html: string }[],
  sendStatus: "sent" as "sent" | "failed"
}));

const fakeDb = {
  async query(text: string, params?: unknown[]) {
    state.calls.push({ text, params });
    if (text.includes("FROM notification_digest_setting") && text.startsWith("SELECT user_id")) return { rows: state.due };
    if (text.includes("RETURNING user_id")) return { rows: state.claim ? [{ user_id: "u" }] : [] };
    if (text.includes("FROM app_user u LEFT JOIN buyer_verification")) return { rows: [{ email: "a@example.test", phone_e164: null }] };
    if (text.includes("FROM notification_preference")) return { rows: state.prefs };
    if (text.includes("GROUP BY category")) return { rows: [] };
    if (text.startsWith("SELECT id, kind")) return { rows: state.items };
    if (text.startsWith("SELECT enabled")) return { rows: [] };
    return { rows: [] };
  }
};

vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => fakeDb }));
vi.mock("../src/server/messaging", () => ({ getEmailPort: async () => ({ configured: true, send: async (m: { to: string; subject: string; text: string; html: string }) => { state.sent.push(m); return { status: state.sendStatus }; } }) }));

import * as digestRoute from "../app/api/notifications/digest/route";
import * as cron from "../app/api/internal/notifications/digest/route";
import * as unsub from "../app/api/notifications/unsubscribe/route";
import { makeDigestUnsubscribeToken, readDigestUnsubscribeToken, runDigests } from "../src/server/notification-digest";

process.env["APP_URL"] = "http://test";
const NOW = new Date("2026-11-05T22:00:00Z");
const U = "11111111-1111-4111-8111-111111111111";
const KEY = "k".repeat(40);
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const n = (id: string, kind: string, category: Category, hoursAgo: number, over: Partial<NotificationView> = {}): NotificationView =>
  ({ id, kind, category, title: `T-${id}`, body: `B-${id}`, link: `/x/${id}`, createdAt: ago(hoursAgo), readAt: null, archivedAt: null, ...over });
const all = new Set<Category>(["messages", "appointments", "offers", "listings", "account", "marketing"]);

describe("digest settings input", () => {
  it("accepts a valid schedule and refuses anything else", () => {
    expect(parseDigestInput({ enabled: true, sendHour: 7, timezone: "Australia/Perth" })).toEqual({ ok: true, value: { enabled: true, sendHour: 7, timezone: "Australia/Perth" } });
    for (const bad of [null, [], { enabled: "yes", sendHour: 7, timezone: "UTC" }, { enabled: true, sendHour: 24, timezone: "UTC" }, { enabled: true, sendHour: 1.5, timezone: "UTC" },
      { enabled: true, sendHour: 7, timezone: "Mars/Base" }, { enabled: true, sendHour: 7, timezone: "UTC", extra: 1 }])
      expect(parseDigestInput(bad).ok).toBe(false);
  });
});

describe("composeDigest", () => {
  it("is null when nothing is unread in the last 24 hours", () => {
    expect(composeDigest([], [], all, NOW)).toBeNull();
    expect(composeDigest([n("a", "offer_received", "offers", 30), n("b", "offer_received", "offers", 1, { readAt: ago(0) }), n("c", "offer_received", "offers", 1, { archivedAt: ago(0) })], [], all, NOW)).toBeNull();
  });
  it("puts urgent items first, once, and counts everything", () => {
    const d = composeDigest([n("a", "offer_received", "offers", 2), n("b", "saved_search_match", "listings", 3), n("c", "message_received", "messages", 13), n("d", "message_received", "messages", 1)], [], all, NOW)!;
    expect(d.total).toBe(4);
    expect(d.urgent.map(i => i.id)).toEqual(["a", "c"]);
    expect(d.sections.flatMap(s => s.items.map(i => i.id)).sort()).toEqual(["b", "d"]);
    expect(d.intro).toContain("2 items need your attention");
    expect(d.pose).toBe("tablet");
  });
  it("says nothing is urgent when nothing is", () => {
    const d = composeDigest([n("b", "saved_search_match", "listings", 3)], [], all, NOW)!;
    expect(d.urgentCount).toBe(0);
    expect(d.intro).toContain("Nothing here is urgent");
  });
  it("respects email choices and never includes marketing", () => {
    const d = composeDigest([n("a", "saved_search_match", "listings", 3), n("m", "marketing_news", "marketing", 1), n("o", "offer_received", "offers", 1)], [], new Set<Category>(["offers", "marketing"]), NOW)!;
    expect([...d.urgent, ...d.sections.flatMap(s => s.items)].map(i => i.id)).toEqual(["o"]);
  });
  it("orders sections by how often the user opens each category", () => {
    const items = [n("a", "saved_search_match", "listings", 3), n("b", "appointment_accepted", "appointments", 3)];
    const stats = [{ category: "listings" as const, total: 10, read: 9 }, { category: "appointments" as const, total: 10, read: 1 }];
    expect(composeDigest(items, stats, all, NOW)!.sections.map(s => s.category)).toEqual(["listings", "appointments"]);
    expect(composeDigest(items, [], all, NOW)!.sections.map(s => s.category)).toEqual(["appointments", "listings"]);
  });
  it("caps a section and reports the rest", () => {
    const items = Array.from({ length: 8 }, (_, i) => n(`s${i}`, "appointment_accepted", "appointments", 2 + i / 10));
    const s = composeDigest(items, [], all, NOW)!.sections[0]!;
    expect(s.items).toHaveLength(5);
    expect(s.more).toBe(3);
  });
  it("treats a security notice and an old unread message as urgent", () => {
    expect(isUrgent(n("a", "security_notice", "account", 1), NOW.getTime())).toBe(true);
    expect(isUrgent(n("a", "message_received", "messages", 11), NOW.getTime())).toBe(false);
  });
});

describe("renderDigestEmail", () => {
  it("links each item, escapes values and carries both footer links", () => {
    const d = composeDigest([n("a", "offer_received", "offers", 1, { title: "<b>Offer</b>" }), n("b", "saved_search_match", "listings", 2)], [], all, NOW)!;
    const m = renderDigestEmail({ brand: "OwnerListing", digest: d, baseUrl: "https://site.test/", settingsUrl: "https://site.test/notifications?tab=preferences", unsubscribeUrl: "https://site.test/u?t=1" });
    expect(m.subject).toBe("OwnerListing: 1 item needs your attention");
    expect(m.html).not.toContain("<b>Offer</b>");
    expect(m.html).toContain("&lt;b&gt;Offer&lt;/b&gt;");
    expect(m.html).toContain('href="https://site.test/x/a"');
    expect(m.html).toContain('href="https://site.test/x/b"');
    expect(m.html).toContain("Stop the daily digest");
    expect(m.text).toContain("https://site.test/x/a");
    expect(m.text).toContain("Stop the daily digest: https://site.test/u?t=1");
  });
  it("drops links when no base address is configured", () => {
    const d = composeDigest([n("b", "saved_search_match", "listings", 2)], [], all, NOW)!;
    expect(renderDigestEmail({ brand: "B", digest: d }).html).not.toContain("href=");
  });
});

describe("digest tokens", () => {
  it("round trip and reject tampering, other kinds and a missing key", () => {
    const t = makeDigestUnsubscribeToken(U, KEY)!;
    expect(readDigestUnsubscribeToken(t, KEY)).toEqual({ userId: U });
    expect(readDigestUnsubscribeToken(t, "z".repeat(40))).toBeUndefined();
    expect(readDigestUnsubscribeToken(t.replace("d1.", "n1."), KEY)).toBeUndefined();
    expect(readDigestUnsubscribeToken(`${t}x`, KEY)).toBeUndefined();
    expect(makeDigestUnsubscribeToken(U, undefined)).toBeUndefined();
  });
});

const row = (id: string, kind: string, category: string, hoursAgo: number) => ({ id, kind, category, title: `T-${id}`, body: "b", link: `/x/${id}`, created_at: new Date(ago(hoursAgo)), read_at: null, archived_at: null });
const env = { APP_URL: "http://test", ALERT_UNSUBSCRIBE_KEY: KEY };

describe("runDigests", () => {
  beforeEach(() => { state.calls = []; state.due = [{ user_id: U, last_sent_at: null }]; state.claim = true; state.items = []; state.prefs = []; state.sent = []; state.sendStatus = "sent"; });

  it("sends one email with the unsubscribe link and claims before sending", async () => {
    state.items = [row("a", "offer_received", "offers", 1)];
    expect(await runDigests(fakeDb, env, NOW.toISOString())).toEqual({ due: 1, sent: 1, empty: 0, failed: 0 });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.to).toBe("a@example.test");
    expect(state.sent[0]!.html).toContain("http://test/x/a");
    expect(state.sent[0]!.html).toContain("/api/notifications/unsubscribe?t=d1.");
    const claimAt = state.calls.findIndex(c => c.text.includes("RETURNING user_id"));
    const itemsAt = state.calls.findIndex(c => c.text.startsWith("SELECT id, kind"));
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(itemsAt);
  });
  it("sends nothing when there is nothing unread, and keeps the claim", async () => {
    expect(await runDigests(fakeDb, env, NOW.toISOString())).toEqual({ due: 1, sent: 0, empty: 1, failed: 0 });
    expect(state.sent).toHaveLength(0);
    expect(state.calls.some(c => c.text.includes("SET last_sent_at = $2::timestamptz WHERE user_id"))).toBe(false);
  });
  it("skips a user another tick already claimed", async () => {
    state.claim = false;
    state.items = [row("a", "offer_received", "offers", 1)];
    expect(await runDigests(fakeDb, env, NOW.toISOString())).toEqual({ due: 0, sent: 0, empty: 0, failed: 0 });
    expect(state.sent).toHaveLength(0);
  });
  it("puts the old last_sent_at back when the send fails", async () => {
    state.items = [row("a", "offer_received", "offers", 1)];
    state.sendStatus = "failed";
    state.due = [{ user_id: U, last_sent_at: new Date("2026-11-03T22:00:00Z") }];
    expect(await runDigests(fakeDb, env, NOW.toISOString())).toEqual({ due: 1, sent: 0, empty: 0, failed: 1 });
    const restore = state.calls[state.calls.length - 1]!;
    expect(restore.text).toContain("SET last_sent_at = $2::timestamptz WHERE user_id");
    expect(restore.params).toEqual([U, new Date("2026-11-03T22:00:00Z")]);
  });
  it("leaves out categories whose email the user turned off", async () => {
    state.items = [row("a", "saved_search_match", "listings", 1), row("o", "offer_received", "offers", 1)];
    state.prefs = [{ category: "offers", in_app: true, email: false, sms: false }];
    await runDigests(fakeDb, env, NOW.toISOString());
    expect(state.sent).toHaveLength(0);
  });
});

const send = (method: string, b?: unknown, headers: Record<string, string> = {}, url = "http://test/api/x") =>
  new Request(url, { method, headers: { "content-type": "application/json", origin: "http://test", ...headers }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });

describe("digest routes", () => {
  beforeEach(() => { state.actor = null; state.calls = []; delete process.env["ALERT_CRON_SECRET"]; process.env["ALERT_UNSUBSCRIBE_KEY"] = KEY; });

  it("settings need sign-in, validate, and save for the signed-in user only", async () => {
    expect((await digestRoute.GET(send("GET"))).status).toBe(401);
    expect((await digestRoute.PUT(send("PUT", {}))).status).toBe(401);
    state.actor = { userId: U, userType: "owner" };
    expect((await digestRoute.GET(send("GET"))).status).toBe(200);
    expect((await digestRoute.PUT(send("PUT", { enabled: true, sendHour: 99, timezone: "UTC" }))).status).toBe(400);
    expect((await digestRoute.PUT(send("PUT", { enabled: true, sendHour: 7, timezone: "UTC" }, { origin: "http://evil.test" }))).status).toBe(403);
    expect((await digestRoute.PUT(send("PUT", { enabled: true, sendHour: 7, timezone: "UTC" }))).status).toBe(200);
    const w = state.calls.find(c => c.text.startsWith("INSERT INTO notification_digest_setting"))!;
    expect(w.params).toEqual([U, true, 7, "UTC"]);
  });
  it("the worker fails closed and checks the secret", async () => {
    expect((await cron.POST(send("POST"))).status).toBe(503);
    process.env["ALERT_CRON_SECRET"] = "s".repeat(40);
    expect((await cron.POST(send("POST", undefined, { "x-cron-secret": "wrong" }))).status).toBe(401);
    expect((await cron.POST(send("POST", undefined, { "x-cron-secret": "s".repeat(40) }))).status).toBe(200);
  });
  it("the digest link asks first on GET, and turns the digest off on POST", async () => {
    const t = makeDigestUnsubscribeToken(U, KEY)!;
    const url = `http://test/api/notifications/unsubscribe?t=${encodeURIComponent(t)}`;
    expect((await unsub.GET(send("GET", undefined, {}, url))).status).toBe(200);
    expect(state.calls).toHaveLength(0);
    expect((await unsub.POST(send("POST", undefined, {}, url))).status).toBe(200);
    expect(state.calls[0]!.text).toContain("UPDATE notification_digest_setting SET enabled = false");
    expect(state.calls[0]!.params).toEqual([U]);
    expect((await unsub.POST(send("POST", undefined, {}, `${url}x`))).status).toBe(400);
  });
});
