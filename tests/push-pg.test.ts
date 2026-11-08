import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderNotification } from "../src/domain/notifications";
import { activeTargetsPg, engagementPg, getPushPreferencesPg, listDevicesPg, recordPushEventPg, registerDevicePg, revokeDevicePg, savePushPreferencesPg, userClickRatePg } from "../src/server/push-db";
import { notifyUser } from "../src/server/notifier";
import { pushToUser } from "../src/server/push";
import type { PushPort, PushPorts, PushTarget } from "../src/server/push-senders";
import { summarizeEngagement } from "../src/domain/push";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const web = (n: number) => ({ platform: "web" as const, token: `https://fcm.googleapis.com/fcm/send/${"t".repeat(30)}${n}`, p256dh: "B".repeat(87), authSecret: "a".repeat(22), label: `Laptop ${n}` });
const android = (n: number) => ({ platform: "android" as const, token: `fcm-token-${"x".repeat(30)}${n}`, p256dh: null, authSecret: null, label: null });
const DAY = "2026-11-05T00:00:00Z"; // 11am Sydney
const NIGHT = "2026-11-05T12:00:00Z"; // 11pm Sydney

describe.skipIf(!DATABASE_URL)("push notifications (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  const fake = (script: (t: PushTarget) => "sent" | "failed" | "gone" = () => "sent") => {
    const sent: { target: PushTarget; msg: { id: string; title: string; body: string; link: string | null; tag: string } }[] = [];
    const port: PushPort = { configured: true, async send(target, msg) { sent.push({ target, msg }); return { status: script(target) }; } };
    const ports: PushPorts = { web: port, android: port, ios: { configured: false, send: async () => ({ status: "failed" }) } };
    return { ports, sent };
  };
  const offer = renderNotification("offer_received", { listing: "1 Test St", link: "/listings/mine" });
  const send = (userId: string, ports: PushPorts, now = DAY, n = offer) => pushToUser(db, userId, "offer_received", n, null, {}, { ports, now: () => new Date(now) });

  it("registers a device once per token, moves it to a new user, and keeps at most 10 active", async () => {
    const a = await addUser(db, "owner"), b = await addUser(db, "buyer");
    const id1 = await registerDevicePg(db, a, web(1));
    expect(await registerDevicePg(db, a, web(1))).toBe(id1);
    expect((await listDevicesPg(db, a)).map(d => d.label)).toEqual(["Laptop 1"]);
    expect(await registerDevicePg(db, b, web(1))).toBe(id1); // shared browser: now belongs to b
    expect(await listDevicesPg(db, a)).toEqual([]);
    expect((await listDevicesPg(db, b)).map(d => d.id)).toEqual([id1]);
    for (let i = 10; i < 22; i++) await registerDevicePg(db, a, android(i));
    expect(await listDevicesPg(db, a)).toHaveLength(10);
  });

  it("lets a user remove only their own device", async () => {
    const a = await addUser(db, "owner"), b = await addUser(db, "buyer");
    const id = await registerDevicePg(db, a, android(50));
    expect(await revokeDevicePg(db, b, id)).toBe(false);
    expect(await listDevicesPg(db, a)).toHaveLength(1);
    expect(await revokeDevicePg(db, a, id)).toBe(true);
    expect(await revokeDevicePg(db, a, id)).toBe(false);
    expect(await activeTargetsPg(db, a)).toEqual([]);
  });

  it("refuses a web device with no keys in the database", async () => {
    const a = await addUser(db, "owner");
    await expect(db.query("INSERT INTO push_device (user_id, platform, token) VALUES ($1,'web',$2)", [a, "https://fcm.googleapis.com/fcm/send/" + "z".repeat(30)])).rejects.toThrow();
  });

  it("saves topic preferences, logs each flip as push consent, and the log stays insert-only", async () => {
    const u = await addUser(db, "buyer");
    expect((await getPushPreferencesPg(db, u)).offers).toBe(true);
    const saved = await savePushPreferencesPg(db, u, { offers: false, marketing: true });
    expect([saved.offers, saved.marketing, saved.account]).toEqual([false, true, true]);
    await savePushPreferencesPg(db, u, { offers: false }); // no change, no log row
    const log = await db.query("SELECT category, granted, channel, source FROM notification_consent_log WHERE user_id = $1 ORDER BY id", [u]);
    expect(log.rows).toEqual([{ category: "offers", granted: false, channel: "push", source: "settings" }, { category: "marketing", granted: true, channel: "push", source: "settings" }]);
    await expect(db.query("DELETE FROM notification_consent_log WHERE user_id = $1", [u])).rejects.toThrow();
  });

  it("pushes to every registered device with Elena's wording and logs each attempt", async () => {
    const u = await addUser(db, "owner");
    await db.query("UPDATE app_user SET display_name = 'Sam Citizen' WHERE id = $1", [u]);
    await registerDevicePg(db, u, web(60)); await registerDevicePg(db, u, android(61));
    const f = fake();
    const r = await send(u, f.ports);
    expect(r).toMatchObject({ status: "sent", sent: 2, failed: 0 });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0]!.msg).toMatchObject({ title: "New offer received", link: "/listings/mine", tag: "offers" });
    expect(f.sent[0]!.msg.body.startsWith("Sam, a new offer was made on 1 Test St")).toBe(true);
    const rows = (await db.query("SELECT status, personalized, kind, category FROM push_delivery WHERE user_id = $1", [u])).rows;
    expect(rows).toEqual([{ status: "sent", personalized: true, kind: "offer_received", category: "offers" }, { status: "sent", personalized: true, kind: "offer_received", category: "offers" }]);
  });

  it("skips when the topic is off, in quiet hours, with no devices, or with nothing configured; account notices ignore quiet hours", async () => {
    const u = await addUser(db, "owner");
    const f = fake();
    expect(await send(u, f.ports)).toMatchObject({ status: "skipped", reason: "no_devices" });
    await registerDevicePg(db, u, android(70));
    expect(await send(u, f.ports, NIGHT)).toMatchObject({ status: "skipped", reason: "quiet_hours" });
    const notice = renderNotification("security_notice", { title: "New sign-in" });
    expect(await pushToUser(db, u, "security_notice", notice, null, {}, { ports: f.ports, now: () => new Date(NIGHT) })).toMatchObject({ status: "sent", sent: 1 });
    await savePushPreferencesPg(db, u, { offers: false });
    expect(await send(u, f.ports)).toMatchObject({ status: "skipped", reason: "topic_off" });
    expect(await pushToUser(db, u, "offer_received", offer, null, {}, { now: () => new Date(DAY) })).toMatchObject({ status: "skipped", reason: "not_configured" });
    expect(f.sent).toHaveLength(1);
  });

  it("retires a device the push service says is gone, and counts failures without retiring", async () => {
    const u = await addUser(db, "owner");
    await registerDevicePg(db, u, web(80)); await registerDevicePg(db, u, android(81));
    const r = await send(u, fake(t => (t.platform === "web" ? "gone" : "failed")).ports);
    expect(r).toMatchObject({ status: "failed", sent: 0, failed: 2 });
    expect((await listDevicesPg(db, u)).map(d => d.platform)).toEqual(["android"]);
    const st = (await db.query("SELECT status FROM push_delivery WHERE user_id = $1 ORDER BY status", [u])).rows.map(x => x.status);
    expect(st).toEqual(["failed", "gone"]);
  });

  it("records an open or dismissal once, only for a sent push, and feeds the engagement figures", async () => {
    const u = await addUser(db, "owner");
    await registerDevicePg(db, u, android(90));
    const f = fake();
    await send(u, f.ports); await send(u, f.ports);
    const [d1, d2] = f.sent.map(s => s.msg.id) as [string, string];
    expect(await recordPushEventPg(db, d1, "clicked")).toBe(true);
    expect(await recordPushEventPg(db, d1, "clicked")).toBe(false);
    expect(await recordPushEventPg(db, d2, "dismissed")).toBe(true);
    expect(await recordPushEventPg(db, "00000000-0000-4000-8000-000000000000", "clicked")).toBe(false);
    const rows = (await engagementPg(db, "2020-01-01T00:00:00Z", "2100-01-01T00:00:00Z")).filter(r => r.platform === "android" && r.category === "offers");
    const e = summarizeEngagement(rows);
    expect(e.total.clicked).toBeGreaterThanOrEqual(1);
    expect(e.total.dismissed).toBeGreaterThanOrEqual(1);
    expect(await userClickRatePg(db, u)).toBeNull(); // too few pushes to judge
  });

  it("keeps the engagement log when the user deletes notification history", async () => {
    const u = await addUser(db, "owner");
    await registerDevicePg(db, u, android(95));
    const nid = String((await db.query("INSERT INTO notification (user_id, kind, category, title, body, archived_at) VALUES ($1,'offer_received','offers','T','b', now()) RETURNING id", [u])).rows[0]!.id);
    const f = fake();
    await pushToUser(db, u, "offer_received", offer, nid, {}, { ports: f.ports, now: () => new Date(DAY) });
    await db.query("DELETE FROM notification WHERE id = $1", [nid]);
    expect((await db.query("SELECT notification_id FROM push_delivery WHERE user_id = $1", [u])).rows).toEqual([{ notification_id: null }]);
  });

  it("notifyUser reports push as skipped when no push provider is configured, and still writes the in-app record", async () => {
    const u = await addUser(db, "owner");
    await registerDevicePg(db, u, android(99));
    const r = await notifyUser(db, u, "offer_received", { listing: "1 Test St", link: "/listings/mine" }, {});
    expect(r).toMatchObject({ inApp: true, push: "skipped" });
  });
});
