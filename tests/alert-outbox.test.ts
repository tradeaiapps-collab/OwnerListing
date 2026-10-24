import { beforeEach, describe, expect, it, vi } from "vitest";
import { alertDeliveryFromEnv, createConsoleAlertDelivery, createRecordingAlertDelivery } from "../src/adapters/alert-delivery";
import { ALERT_MAX_ATTEMPTS, ALERT_SEND_RATE, processOutbox, retryDelayMs, type OutboxResult, type OutboxRow } from "../src/domain/alert-outbox";
import { dispatchAlerts, type AlertDeliveryPort, type DeliveryLogEntry, type DispatchDeps } from "../src/domain/alerts";
import type { AlertPreference, PlannedAlert } from "../src/domain/buyer";
import { makeUnsubscribeToken, readUnsubscribeToken, unsubscribeUrlFor } from "../src/server/alert-unsubscribe";
import { claimDueOutbox, enqueueAlertPg, logDeliveryPg, settleOutboxPg, sentInWindowPg, unsubscribeAlertPg } from "../src/server/alert-outbox-db";
import type { Queryable } from "../src/server/db";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/server/context", () => ({ getDb: () => state.db }));
import { GET as unsubGet, POST as unsubPost } from "../app/api/alerts/unsubscribe/route";
import { POST as runPost } from "../app/api/internal/alerts/run/route";

const KEY = "k".repeat(40);
const NOW = "2026-10-24T10:00:00.000Z";
const consent: AlertPreference = { channel: "email", consentGivenAt: "2026-01-01T00:00:00Z" };
const row = (o: Partial<OutboxRow> = {}): OutboxRow => ({ id: "r1", buyerUserId: "b1", channel: "email", listingId: "l1", searchId: "s1", attempts: 1, ...o });

function fakeDb(rows: Record<string, unknown>[][] = []) {
  const calls: { text: string; params: unknown[] | undefined }[] = [];
  const db: Queryable = { async query(text, params) { calls.push({ text, params }); return { rows: rows.shift() ?? [] }; } };
  return { db, calls };
}

async function run(rows: OutboxRow[], port: AlertDeliveryPort, o: { prefs?: Record<string, AlertPreference[]>; sent?: Set<string>; inWindow?: number; unsub?: string } = {}) {
  const log: DeliveryLogEntry[] = [];
  const settled: { id: string; result: OutboxResult; next?: string | undefined }[] = [];
  const counts = await processOutbox({
    port, due: rows, prefsByBuyer: o.prefs ?? { b1: [consent] }, alreadySent: o.sent ?? new Set(),
    sentInWindow: async () => o.inWindow ?? 0, unsubscribeUrlFor: () => o.unsub ?? "https://x.test/u", now: () => NOW,
    log: async e => { log.push(e); }, settle: async (r, result, next) => { settled.push({ id: r.id, result, next }); }
  });
  return { counts, log, settled };
}

describe("retry backoff", () => {
  it("doubles from 5 minutes and is capped at 6 hours", () => {
    expect(retryDelayMs(1)).toBe(5 * 60_000);
    expect(retryDelayMs(2)).toBe(10 * 60_000);
    expect(retryDelayMs(3)).toBe(20 * 60_000);
    expect(retryDelayMs(99)).toBe(6 * 60 * 60_000);
  });
});

describe("processOutbox", () => {
  it("sends a due retry and marks it sent", async () => {
    const port = createRecordingAlertDelivery();
    const r = await run([row()], port);
    expect(port.sent).toHaveLength(1);
    expect(r.settled).toEqual([{ id: "r1", result: "sent", next: undefined }]);
    expect(r.log.map(e => e.outcome)).toEqual(["sent"]);
  });
  it("retries a failed send with backoff, then marks it dead on the last attempt", async () => {
    const failing: AlertDeliveryPort = { async send() { return "failed"; } };
    const first = await run([row({ attempts: 1 })], failing);
    expect(first.settled[0]).toEqual({ id: "r1", result: "retry", next: new Date(Date.parse(NOW) + retryDelayMs(2)).toISOString() });
    const last = await run([row({ attempts: ALERT_MAX_ATTEMPTS - 1 })], failing);
    expect(last.settled[0]?.result).toBe("dead");
  });
  it("treats a throwing port as a failed send", async () => {
    const r = await run([row()], { async send() { throw new Error("boom"); } });
    expect(r.settled[0]?.result).toBe("retry");
    expect(r.log[0]?.outcome).toBe("failed");
  });
  it("waits without using up an attempt while no provider is configured", async () => {
    const r = await run([row({ attempts: 2 })], { async send() { return "not_configured"; } });
    expect(r.settled[0]?.result).toBe("not_configured");
    expect(r.settled[0]?.next).toBeDefined();
  });
  it("never contacts a buyer who unsubscribed or has no consent since the failure", async () => {
    const port = createRecordingAlertDelivery();
    const unsub = await run([row()], port, { prefs: { b1: [{ ...consent, unsubscribedAt: "2026-10-24T09:00:00Z" }] } });
    const none = await run([row()], port, { prefs: {} });
    expect(port.sent).toHaveLength(0);
    expect(unsub.settled[0]?.result).toBe("dropped_no_consent");
    expect(none.settled[0]?.result).toBe("dropped_no_consent");
  });
  it("drops duplicates and refuses to send without an unsubscribe link", async () => {
    const port = createRecordingAlertDelivery();
    const dup = await run([row()], port, { sent: new Set(["b1:email:l1"]) });
    const noLink = await run([row()], port, { unsub: " " });
    expect(port.sent).toHaveLength(0);
    expect(dup.settled[0]?.result).toBe("dropped_duplicate");
    expect(noLink.settled[0]?.result).toBe("dropped_no_unsubscribe");
  });
  it("defers when the buyer is at the hourly limit, counting this run's own sends", async () => {
    const port = createRecordingAlertDelivery();
    const atLimit = await run([row()], port, { inWindow: ALERT_SEND_RATE.perBuyer });
    expect(atLimit.settled[0]).toEqual({ id: "r1", result: "deferred_rate", next: new Date(Date.parse(NOW) + ALERT_SEND_RATE.windowMs).toISOString() });
    expect(atLimit.log).toEqual([]);
    const rows = Array.from({ length: 3 }, (_, i) => row({ id: `r${i}`, listingId: `l${i}` }));
    const r = await run(rows, port, { inWindow: ALERT_SEND_RATE.perBuyer - 2 });
    expect(r.settled.map(s => s.result)).toEqual(["sent", "sent", "deferred_rate"]);
  });
});

describe("dispatchAlerts with the outbox hooks", () => {
  const plan: PlannedAlert = { buyerUserId: "b1", searchId: "s1", channel: "email", listingId: "l1" };
  const deps = (port: AlertDeliveryPort, extra: Partial<DispatchDeps> = {}) => {
    const log: DeliveryLogEntry[] = [];
    const d: DispatchDeps = { port, prefsByBuyer: { b1: [consent] }, alreadySent: new Set<string>(), unsubscribeUrlFor: () => "https://x.test/u", now: () => NOW, log: async e => { log.push(e); }, ...extra };
    return { log, d };
  };
  it("queues a failed send for retry, but not a not_configured one", async () => {
    const queued: DeliveryLogEntry[] = [];
    const a = deps({ async send() { return "failed"; } }, { enqueueRetry: async e => { queued.push(e); } });
    await dispatchAlerts([plan], a.d);
    const b = deps({ async send() { return "not_configured"; } }, { enqueueRetry: async e => { queued.push(e); } });
    await dispatchAlerts([plan], b.d);
    expect(queued.map(q => q.outcome)).toEqual(["failed"]);
  });
  it("defers an over-rate buyer without sending or logging an attempt", async () => {
    const port = createRecordingAlertDelivery();
    const deferred: PlannedAlert[] = [];
    const a = deps(port, { overRate: async () => true, defer: async p => { deferred.push(p); } });
    const out = await dispatchAlerts([plan], a.d);
    expect(port.sent).toHaveLength(0);
    expect(out).toEqual([]);
    expect(a.log).toEqual([]);
    expect(deferred).toEqual([plan]);
  });
  it("still checks consent before the rate limit", async () => {
    const a = deps(createRecordingAlertDelivery(), { prefsByBuyer: {}, overRate: async () => true, defer: async () => { throw new Error("should not defer"); } });
    expect((await dispatchAlerts([plan], a.d))[0]?.outcome).toBe("skipped_no_consent");
  });
});

describe("delivery adapters", () => {
  it("the console adapter logs ids only and sends nothing", async () => {
    const lines: string[] = [];
    const msg = { buyerUserId: "b1", channel: "email" as const, listingId: "l1", searchId: "s1", unsubscribeUrl: "https://x.test/secret-token" };
    expect(await createConsoleAlertDelivery(l => lines.push(l)).send(msg)).toBe("sent");
    expect(lines).toEqual(["[alert:dev] channel=email listing=l1 search=s1"]);
    expect(lines.join()).not.toContain("secret-token");
    expect(lines.join()).not.toContain("b1");
  });
  it("is unconfigured unless ALERT_DELIVERY=console outside production", async () => {
    const msg = { buyerUserId: "b1", channel: "sms" as const, listingId: "l1", searchId: "s1", unsubscribeUrl: "u" };
    for (const env of [{}, { ALERT_DELIVERY: "sendgrid" }, { ALERT_DELIVERY: "console", NODE_ENV: "production" }]) {
      expect(await alertDeliveryFromEnv(env).send(msg)).toBe("not_configured");
    }
    expect(await alertDeliveryFromEnv({ ALERT_DELIVERY: "console", NODE_ENV: "development" }).send(msg)).toBe("sent");
  });
});

describe("unsubscribe tokens", () => {
  it("round-trips and binds buyer and channel", () => {
    const t = makeUnsubscribeToken("b1", "sms", KEY)!;
    expect(readUnsubscribeToken(t, KEY)).toEqual({ buyerUserId: "b1", channel: "sms" });
  });
  it("fails closed without a usable key", () => {
    expect(makeUnsubscribeToken("b1", "sms", undefined)).toBeUndefined();
    expect(makeUnsubscribeToken("b1", "sms", "short")).toBeUndefined();
    expect(readUnsubscribeToken(makeUnsubscribeToken("b1", "sms", KEY), undefined)).toBeUndefined();
  });
  it("rejects tampering, another key, junk and wrong types", () => {
    const t = makeUnsubscribeToken("b1", "sms", KEY)!;
    const [v, , sig] = t.split(".");
    const other = Buffer.from("b2:sms").toString("base64url");
    expect(readUnsubscribeToken(`${v}.${other}.${sig}`, KEY)).toBeUndefined();
    expect(readUnsubscribeToken(t, "z".repeat(40))).toBeUndefined();
    expect(readUnsubscribeToken(t + "x", KEY)).toBeUndefined();
    for (const bad of [undefined, null, 5, "", "v1..", "v2.a.b", "a.b", "x".repeat(400)]) expect(readUnsubscribeToken(bad, KEY)).toBeUndefined();
  });
  it("builds a link only when APP_URL and the key are both set", () => {
    expect(unsubscribeUrlFor({ APP_URL: "https://a.test/", ALERT_UNSUBSCRIBE_KEY: KEY }, "b1", "email")).toMatch(/^https:\/\/a\.test\/api\/alerts\/unsubscribe\?t=v1\./);
    expect(unsubscribeUrlFor({ ALERT_UNSUBSCRIBE_KEY: KEY }, "b1", "email")).toBe("");
    expect(unsubscribeUrlFor({ APP_URL: "https://a.test" }, "b1", "email")).toBe("");
  });
});

describe("outbox SQL", () => {
  it("claims due rows in one statement with SKIP LOCKED and a lease, params only", async () => {
    const { db, calls } = fakeDb([[{ id: "r1", buyer_user_id: "b1", channel: "email", listing_id: "l1", saved_search_id: "s1", attempts: 2 }, { id: "r2", channel: "push" }]]);
    const rows = await claimDueOutbox(db, NOW, 50);
    expect(rows).toEqual([{ id: "r1", buyerUserId: "b1", channel: "email", listingId: "l1", searchId: "s1", attempts: 2 }]);
    expect(calls[0]?.text).toContain("FOR UPDATE SKIP LOCKED");
    expect(calls[0]?.text).not.toContain(NOW);
    expect(calls[0]?.params?.slice(0, 2)).toEqual([NOW, 50]);
  });
  it("queues idempotently", async () => {
    const { db, calls } = fakeDb();
    await enqueueAlertPg(db, { buyerUserId: "b1", channel: "email", listingId: "l1", searchId: "s1" }, 1, NOW);
    expect(calls[0]?.text).toContain("ON CONFLICT (buyer_user_id, channel, listing_id) DO NOTHING");
    expect(calls[0]?.params).toEqual(["b1", "email", "l1", "s1", 1, NOW]);
  });
  it("a rate-limit deferral does not add an attempt; a send does", async () => {
    const { db, calls } = fakeDb();
    await settleOutboxPg(db, row(), "deferred_rate", NOW, NOW);
    await settleOutboxPg(db, row(), "retry", NOW, NOW);
    await settleOutboxPg(db, row(), "dead", NOW);
    expect(calls.map(c => c.params?.slice(1, 4))).toEqual([["pending", 0, NOW], ["pending", 1, NOW], ["dead", 1, null]]);
  });
  it("counts an unreadable rate figure as over the limit", async () => {
    expect(await sentInWindowPg(fakeDb([[{ n: "oops" }]]).db, "b1", NOW)).toBeGreaterThanOrEqual(ALERT_SEND_RATE.perBuyer);
    expect(await sentInWindowPg(fakeDb([[{ n: 3 }]]).db, "b1", NOW)).toBe(3);
  });
  it("audits each delivery with ids and outcome only", async () => {
    const { db, calls } = fakeDb();
    await logDeliveryPg(db, { buyerUserId: "b1", channel: "email", listingId: "l1", searchId: "s1", outcome: "failed", attemptedAt: NOW });
    expect(calls).toHaveLength(2);
    const audit = calls[1]!;
    expect(audit.params?.[6]).toBe("alert.failed");
    expect(String(audit.params?.[8])).not.toMatch(/@|\+61|https?:/);
  });
  it("unsubscribe changes only a still-subscribed row and audits once", async () => {
    const first = fakeDb([[{ buyer_user_id: "b1" }]]);
    expect(await unsubscribeAlertPg(first.db, "b1", "email", NOW)).toBe(true);
    expect(first.calls[0]?.text).toContain("unsubscribed_at IS NULL");
    expect(first.calls).toHaveLength(2);
    const again = fakeDb([[]]);
    expect(await unsubscribeAlertPg(again.db, "b1", "email", NOW)).toBe(false);
    expect(again.calls).toHaveLength(1);
  });
});

describe("unsubscribe route", () => {
  beforeEach(() => { process.env["ALERT_UNSUBSCRIBE_KEY"] = KEY; });
  const url = (t: string | undefined) => `http://test/api/alerts/unsubscribe${t === undefined ? "" : `?t=${encodeURIComponent(t)}`}`;

  it("GET changes nothing, POST unsubscribes", async () => {
    const f = fakeDb([[{ buyer_user_id: "b1" }]]);
    state.db = f.db;
    const t = makeUnsubscribeToken("b1", "email", KEY)!;
    expect((await unsubGet(new Request(url(t)))).status).toBe(200);
    expect(f.calls).toHaveLength(0);
    expect((await unsubPost(new Request(url(t), { method: "POST" }))).status).toBe(200);
    expect(f.calls[0]?.params).toEqual(["b1", "email", expect.any(String)]);
  });
  it("answers a bad, missing or unsigned token with 400 and touches nothing", async () => {
    const f = fakeDb();
    state.db = f.db;
    for (const t of [undefined, "junk", makeUnsubscribeToken("b1", "email", "z".repeat(40))!]) {
      expect((await unsubGet(new Request(url(t)))).status).toBe(400);
      expect((await unsubPost(new Request(url(t), { method: "POST" }))).status).toBe(400);
    }
    expect(f.calls).toHaveLength(0);
  });
  it("is off when the signing key is unset", async () => {
    delete process.env["ALERT_UNSUBSCRIBE_KEY"];
    const t = makeUnsubscribeToken("b1", "email", KEY)!;
    expect((await unsubPost(new Request(url(t), { method: "POST" }))).status).toBe(400);
  });
});

describe("worker route", () => {
  const call = (secret?: string) => runPost(new Request("http://test/api/internal/alerts/run", { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret } }));
  it("answers 503 while ALERT_CRON_SECRET is unset or short", async () => {
    delete process.env["ALERT_CRON_SECRET"];
    expect((await call("anything")).status).toBe(503);
    process.env["ALERT_CRON_SECRET"] = "short";
    expect((await call("short")).status).toBe(503);
  });
  it("answers 401 for a missing or wrong secret and runs nothing", async () => {
    process.env["ALERT_CRON_SECRET"] = "s".repeat(40);
    const f = fakeDb();
    state.db = f.db;
    expect((await call()).status).toBe(401);
    expect((await call("w".repeat(40))).status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });
  it("runs the outbox for the right secret", async () => {
    process.env["ALERT_CRON_SECRET"] = "s".repeat(40);
    const f = fakeDb();
    state.db = f.db;
    const res = await call("s".repeat(40));
    expect(res.status).toBe(200);
    expect((await res.json()).counts.sent).toBe(0);
    expect(f.calls[0]?.text).toContain("UPDATE alert_outbox");
  });
});
