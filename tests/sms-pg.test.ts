import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SMS_NOTIFY_RATE, twilioSignature } from "../src/domain/sms";
import { getPreferencesPg, savePreferencesPg } from "../src/server/notifications-db";
import { notifyUser } from "../src/server/notifier";
import { applySmsStatus, smsUsage, smsWithinRate } from "../src/server/sms-log";
import { handleSmsInboundWebhook, handleSmsStatusWebhook, webhookUrl } from "../src/server/sms-webhook";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const TOKEN = "t0ken-secret-value-1234567890abcd";
const env = {
  APP_URL: "https://owner.example", SESSION_SECRET: "s".repeat(40), SMS_PROVIDER: "twilio", SMS_ACCOUNT_SID: "AC" + "a".repeat(32),
  SMS_AUTH_TOKEN: TOKEN, SMS_SENDER: "+61400000001", SMS_COST_PER_SEGMENT_CENTS: "5"
};
let counter = 0;
const nextSid = () => "SM" + (++counter).toString(16).padStart(32, "0");

describe.skipIf(!DATABASE_URL)("SMS delivery tracking (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function smsUser(phone: string) {
    const u = await addUser(db, "buyer");
    await db.query("INSERT INTO buyer_verification (user_id, phone_verified_at, phone_e164) VALUES ($1, now(), $2)", [u, phone]);
    const prefs = await getPreferencesPg(db, u);
    await savePreferencesPg(db, u, { offers: { ...prefs.offers, sms: true }, messages: { ...prefs.messages, sms: true } }, "settings");
    return u;
  }
  const stubTwilio = (sids: string[]) => {
    const calls: URLSearchParams[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      calls.push(new URLSearchParams(init.body));
      return new Response(JSON.stringify({ sid: sids.shift() }), { status: 201 });
    });
    return calls;
  };
  const signed = (path: "status" | "inbound", body: URLSearchParams) => twilioSignature(TOKEN, webhookUrl(env, path)!, body);

  it("sends a notification text with a status callback, logs it with segments and an estimated cost", async () => {
    const u = await smsUser("+61400000101");
    const sid = nextSid();
    const calls = stubTwilio([sid]);
    expect((await notifyUser(db, u, "offer_accepted", { listing: "1 Test St" }, env)).sms).toBe("sent");
    expect(calls[0]!.get("StatusCallback")).toBe("https://owner.example/api/webhooks/twilio/status");
    expect(calls[0]!.get("Body")).toContain("Turn texts off");
    const row = (await db.query("SELECT user_id, status, segments, est_cost_micros, template FROM sms_message WHERE provider_ref = $1", [sid])).rows[0]!;
    expect(row).toMatchObject({ user_id: u, status: "queued", segments: 1, template: "notif_offer_accepted" });
    expect(Number(row["est_cost_micros"])).toBe(50_000);
  });

  it("records a failed send without a provider reference and costs nothing", async () => {
    const u = await smsUser("+61400000102");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ code: 21211 }), { status: 400 }));
    expect((await notifyUser(db, u, "offer_accepted", {}, env)).sms).toBe("failed");
    const row = (await db.query("SELECT status, error_code, est_cost_micros, provider_ref FROM sms_message WHERE user_id = $1", [u])).rows[0]!;
    expect(row).toMatchObject({ status: "failed", error_code: "invalid_recipient", provider_ref: null });
    expect(Number(row["est_cost_micros"])).toBe(0);
  });

  it("limits notification texts per user and still delivers in-app", async () => {
    const u = await smsUser("+61400000103");
    const calls = stubTwilio(Array.from({ length: 10 }, nextSid));
    for (let i = 0; i < SMS_NOTIFY_RATE.perHour; i++) expect((await notifyUser(db, u, "offer_accepted", {}, env)).sms).toBe("sent");
    expect(await smsWithinRate(db, u)).toBe(false);
    const over = await notifyUser(db, u, "offer_accepted", {}, env);
    expect(over).toMatchObject({ sms: "skipped", inApp: true });
    expect(calls).toHaveLength(SMS_NOTIFY_RATE.perHour);
  });

  it("applies status callbacks forward only and keeps every report in the audit trail", async () => {
    const u = await smsUser("+61400000104");
    const sid = nextSid();
    stubTwilio([sid]);
    await notifyUser(db, u, "offer_accepted", {}, env);
    const post = async (status: string, extra: Record<string, string> = {}) => {
      const body = new URLSearchParams({ MessageSid: sid, MessageStatus: status, ...extra });
      return handleSmsStatusWebhook(db, env, body.toString(), signed("status", body));
    };
    expect(JSON.parse((await post("sent")).body).outcome).toBe("updated");
    expect(JSON.parse((await post("delivered", { Price: "-0.0750", PriceUnit: "AUD" })).body).outcome).toBe("updated");
    expect(JSON.parse((await post("sent")).body).outcome).toBe("logged"); // late, out of order
    const row = (await db.query("SELECT status, price_micros, price_unit, delivered_at FROM sms_message WHERE provider_ref = $1", [sid])).rows[0]!;
    expect(row).toMatchObject({ status: "delivered", price_unit: "AUD" });
    expect(Number(row["price_micros"])).toBe(75_000);
    expect(row["delivered_at"]).not.toBeNull();
    expect((await db.query("SELECT status FROM sms_status_event WHERE provider_ref = $1 ORDER BY id", [sid])).rows.map(r => r["status"])).toEqual(["sent", "delivered", "sent"]);
    await expect(db.query("UPDATE sms_status_event SET status = 'failed'")).rejects.toThrow(/insert-only/);
    await expect(db.query("DELETE FROM sms_status_event")).rejects.toThrow(/insert-only/);
    // A reference we never sent (for example a verification code) is not recorded.
    expect(await applySmsStatus(db, { ref: nextSid(), status: "delivered", errorCode: null })).toBe("unknown");
  });

  it("records an undelivered report with its error code", async () => {
    const u = await smsUser("+61400000105");
    const sid = nextSid();
    stubTwilio([sid]);
    await notifyUser(db, u, "offer_accepted", {}, env);
    const body = new URLSearchParams({ MessageSid: sid, MessageStatus: "undelivered", ErrorCode: "30003" });
    await handleSmsStatusWebhook(db, env, body.toString(), signed("status", body));
    expect((await db.query("SELECT status, error_code FROM sms_message WHERE provider_ref = $1", [sid])).rows[0]).toMatchObject({ status: "undelivered", error_code: "e30003" });
  });

  it("STOP switches the sender's texts off in every category and logs the withdrawal", async () => {
    const u = await smsUser("+61400000106");
    const other = await smsUser("+61400000107");
    const body = new URLSearchParams({ From: "+61400000106", Body: " stop " });
    const r = await handleSmsInboundWebhook(db, env, body.toString(), signed("inbound", body));
    expect(r.status).toBe(200);
    const prefs = await getPreferencesPg(db, u);
    expect(prefs.offers.sms).toBe(false);
    expect(prefs.messages.sms).toBe(false);
    expect((await getPreferencesPg(db, other)).offers.sms).toBe(true);
    const log = (await db.query("SELECT category, granted FROM notification_consent_log WHERE user_id = $1 AND source = 'sms_stop' ORDER BY category", [u])).rows;
    expect(log.map(x => x["category"])).toEqual(["messages", "offers"]);
    expect(log.every(x => x["granted"] === false)).toBe(true);
    // No more texts for this user.
    const calls = stubTwilio([nextSid()]);
    expect((await notifyUser(db, u, "offer_accepted", {}, env)).sms).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("totals texts, segments and cost per month and template", async () => {
    const u = await smsUser("+61400000108");
    await db.query("DELETE FROM sms_message");
    await db.query(
      `INSERT INTO sms_message (user_id, template, provider_ref, status, segments, est_cost_micros, price_micros) VALUES
        ($1,'notif_offer_received',$2,'delivered',1,50000,60000), ($1,'notif_offer_received',$3,'failed',2,0,NULL), ($1,'notif_message_received',$4,'sent',2,100000,NULL)`,
      [u, nextSid(), nextSid(), nextSid()]);
    const rows = await smsUsage(db, 3);
    expect(rows).toEqual([
      expect.objectContaining({ template: "notif_message_received", messages: 1, segments: 2, estMicros: 100_000, priceMicros: 0 }),
      expect.objectContaining({ template: "notif_offer_received", messages: 2, segments: 3, delivered: 1, failed: 1, estMicros: 50_000, priceMicros: 60_000 })
    ]);
    expect(rows[0]!.month).toMatch(/^\d{4}-\d{2}$/);
  });
});
