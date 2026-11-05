import { generateKeyPairSync } from "node:crypto";
import webpush from "web-push";
import { describe, expect, it } from "vitest";
import { renderNotification } from "../src/domain/notifications";
import {
  buildPushMessage, inQuietHours, isAllowedWebPushEndpoint, parseDeviceInput, parsePushPreferencesInput, personalizePush, pushConsentChanges,
  resolvePushPreferences, summarizeEngagement, defaultPushPreferences
} from "../src/domain/push";
import { checkProviders } from "../src/config/provider-check.mjs";
import { getPushPorts, webPublicKey, type PushTarget } from "../src/server/push-senders";

const P256 = "B".repeat(87), AUTH = "a".repeat(22);
const web = { platform: "web", subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc123", keys: { p256dh: P256, auth: AUTH } }, label: "Laptop" };

describe("push topics", () => {
  it("defaults on for time-critical topics, off for news and saved searches, and account stays on", () => {
    expect(defaultPushPreferences()).toEqual({ messages: true, appointments: true, offers: true, listings: false, account: true, marketing: false });
    expect(resolvePushPreferences([{ category: "account", enabled: false }, { category: "marketing", enabled: true }, { category: "bogus", enabled: true }]))
      .toMatchObject({ account: true, marketing: true });
  });
  it("accepts a subset and refuses unknown topics, non-booleans and switching off a required topic", () => {
    expect(parsePushPreferencesInput({ topics: { offers: false } })).toEqual({ ok: true, value: { offers: false } });
    for (const bad of [null, [], {}, { topics: [] }, { topics: { nope: true } }, { topics: { offers: "yes" } }, { topics: { account: false } }, { topics: { offers: true }, extra: 1 }])
      expect(parsePushPreferencesInput(bad).ok).toBe(false);
  });
  it("reports only the topics that flipped as consent events", () => {
    expect(pushConsentChanges(defaultPushPreferences(), { ...defaultPushPreferences(), offers: false, marketing: true })).toEqual([{ category: "offers", granted: false }, { category: "marketing", granted: true }]);
  });
});

describe("push devices", () => {
  it("accepts a browser subscription, an Android token and an iOS token", () => {
    expect(parseDeviceInput(web)).toMatchObject({ ok: true, value: { platform: "web", token: web.subscription.endpoint, p256dh: P256, authSecret: AUTH, label: "Laptop" } });
    expect(parseDeviceInput({ platform: "android", token: "fcm:APA91b-" + "x".repeat(60) })).toMatchObject({ ok: true, value: { platform: "android", p256dh: null } });
    expect(parseDeviceInput({ platform: "ios", token: "ab".repeat(32) }).ok).toBe(true);
  });
  it("only accepts real browser push services as endpoints (the server posts to them)", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x", "https://wns2-par02p.notify.windows.com/w/?token=x"]) expect(isAllowedWebPushEndpoint(ok)).toBe(true);
    for (const bad of ["http://fcm.googleapis.com/x", "https://localhost/x", "https://169.254.169.254/latest", "https://fcm.googleapis.com.evil.test/x", "https://evil.test/push.services.mozilla.com", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "not a url"])
      expect(isAllowedWebPushEndpoint(bad)).toBe(false);
    expect(parseDeviceInput({ ...web, subscription: { ...web.subscription, endpoint: "https://internal.example/x" } }).ok).toBe(false);
  });
  it("refuses missing or malformed keys, tokens and platforms", () => {
    for (const bad of [null, {}, { platform: "tv", token: "x".repeat(30) }, { ...web, subscription: { endpoint: web.subscription.endpoint, keys: {} } },
      { ...web, subscription: { endpoint: web.subscription.endpoint, keys: { p256dh: "bad key!", auth: AUTH } } },
      { platform: "android", token: "short" }, { platform: "android", token: "has space " + "x".repeat(30) }, { platform: "ios", token: "not-hex-" + "z".repeat(60) }])
      expect(parseDeviceInput(bad).ok).toBe(false);
  });
  it("cleans the label", () => {
    expect(parseDeviceInput({ ...web, label: "  <b>Mum's</b>\n phone " })).toMatchObject({ value: { label: "bMum's/b phone" } });
    expect(parseDeviceInput({ ...web, label: 5 })).toMatchObject({ value: { label: null } });
  });
});

describe("quiet hours", () => {
  it("holds pushes from 9pm to 7am Sydney time, except required account notices", () => {
    expect(inQuietHours("offers", "2026-11-05T11:00:00Z")).toBe(true); // 10pm AEDT
  });
  it("is open during the day", () => {
    expect(inQuietHours("offers", "2026-11-05T00:00:00Z")).toBe(false); // 11am AEDT
    expect(inQuietHours("offers", "2026-11-05T20:30:00Z")).toBe(false); // 7:30am AEDT
    expect(inQuietHours("offers", "2026-11-05T09:59:00Z")).toBe(false); // 8:59pm AEDT
    expect(inQuietHours("offers", "2026-11-05T10:00:00Z")).toBe(true); // 9pm AEDT
    expect(inQuietHours("offers", "2026-11-05T19:59:00Z")).toBe(true); // 6:59am AEDT
    expect(inQuietHours("account", "2026-11-05T14:00:00Z")).toBe(false);
  });
});

describe("Elena personalises the push", () => {
  const offer = renderNotification("offer_received", { listing: "1 Test St", link: "/listings/mine" });
  it("uses the first name and says how many are waiting", () => {
    const p = personalizePush(offer, { firstName: "Sam Citizen", unreadInTopic: 3, clickRate: 0.6 });
    expect(p.personalized).toBe(true);
    expect(p.body).toBe("Sam, a new offer was made on 1 Test St. Review it in your offers. You have 3 unread in offers.");
    expect(p.title).toBe(offer.title);
  });
  it("keeps it short for people who rarely open pushes", () => {
    expect(personalizePush(offer, { firstName: "Sam", unreadInTopic: 4, clickRate: 0.05 }).body).not.toContain("unread");
  });
  it("leaves the text alone when there is nothing to add, and never touches account or marketing notices", () => {
    expect(personalizePush(offer, { firstName: null, unreadInTopic: 1, clickRate: null })).toEqual({ title: offer.title, body: offer.body, personalized: false });
    for (const k of ["security_notice", "marketing_news"] as const) {
      const n = renderNotification(k, { title: "T", text: "Body" });
      expect(personalizePush(n, { firstName: "Sam", unreadInTopic: 5, clickRate: 0.9 })).toEqual({ title: "T", body: "Body", personalized: false });
    }
  });
  it("leaves a body that opens with a name as written", () => {
    const msg = renderNotification("message_received", { name: "Pat", listing: "1 Test St" });
    expect(personalizePush(msg, { firstName: "Sam", unreadInTopic: 1, clickRate: null }).body).toBe(`Sam, ${msg.body}`);
  });
  it("strips odd characters from the name, and never adds amounts", () => {
    expect(personalizePush(offer, { firstName: "<script>", unreadInTopic: 1, clickRate: null }).body).toBe(`script, ${offer.body.replace(/^A/, "a")}`);
    const long = personalizePush(offer, { firstName: "Sam", unreadInTopic: 99, clickRate: 1 });
    expect(long.body.length).toBeLessThanOrEqual(180);
    expect(long.body).not.toMatch(/\$/);
  });
  it("builds a short message for the device", () => {
    const m = buildPushMessage("id-1", "T".repeat(200), "B".repeat(400), "/offers", "offers");
    expect([m.title.length, m.body.length, m.tag, m.link, m.id]).toEqual([80, 180, "offers", "/offers", "id-1"]);
  });
});

describe("engagement figures", () => {
  const row = (o: Partial<Parameters<typeof summarizeEngagement>[0][number]>) => ({ platform: "web" as const, category: "offers" as const, personalized: false, sent: 0, failed: 0, gone: 0, clicked: 0, dismissed: 0, ...o });
  it("totals, rates and splits by platform, topic and personalisation", () => {
    const e = summarizeEngagement([row({ sent: 10, clicked: 5, dismissed: 2 }), row({ personalized: true, sent: 10, clicked: 8, failed: 1 }), row({ platform: "ios", category: "messages", sent: 4, clicked: 1, gone: 2 })]);
    expect(e.total).toEqual({ sent: 24, failed: 1, gone: 2, clicked: 14, dismissed: 2, clickRate: 0.583 });
    expect(e.byPlatform["ios"]!.clickRate).toBe(0.25);
    expect(e.byTopic["offers"]!.sent).toBe(20);
    expect([e.personalization.personalized.clickRate, e.personalization.plain.clickRate]).toEqual([0.8, 0.429]);
  });
  it("has no rate when nothing was sent", () => {
    expect(summarizeEngagement([]).total.clickRate).toBeNull();
  });
});

describe("senders", () => {
  const msg = buildPushMessage("d1", "Title", "Body", "/offers", "offers");
  const target = (o: Partial<PushTarget>): PushTarget => ({ id: "t1", platform: "web", token: "https://fcm.googleapis.com/fcm/send/x", p256dh: P256, authSecret: AUTH, ...o });
  const vapid = webpush.generateVAPIDKeys();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const env = {
    VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:a@example.com.au",
    FCM_PROJECT_ID: "ownerlisting-prod", FCM_CLIENT_EMAIL: "p@ownerlisting-prod.iam.gserviceaccount.com", FCM_PRIVATE_KEY: rsa.replace(/\n/g, "\\n"),
    APNS_KEY_ID: "ABC123DEFG", APNS_TEAM_ID: "TEAM123456", APNS_BUNDLE_ID: "au.example.app", APNS_PRIVATE_KEY: ec
  };

  it("is off, and attempts nothing, when keys are missing or malformed", () => {
    const p = getPushPorts({});
    expect([p.web.configured, p.android.configured, p.ios.configured]).toEqual([false, false, false]);
    expect(getPushPorts({ ...env, VAPID_PUBLIC_KEY: "short" }).web.configured).toBe(false);
    expect(getPushPorts({ ...env, FCM_PRIVATE_KEY: "nope" }).android.configured).toBe(false);
    expect(getPushPorts({ ...env, APNS_TEAM_ID: "x" }).ios.configured).toBe(false);
    expect(webPublicKey({})).toBeNull();
  });
  it("agrees with the provider check", () => {
    const r = Object.fromEntries(checkProviders(env, { production: false }).map(x => [x.id, x.status]));
    expect([r["webpush"], r["fcm"], r["apns"]]).toEqual(["ready", "ready", "ready"]);
    const ports = getPushPorts(env);
    expect([ports.web.configured, ports.android.configured, ports.ios.configured]).toEqual([true, true, true]);
  });

  it("web: sends the JSON payload with VAPID details, and maps 404/410 to gone", async () => {
    const calls: { sub: unknown; payload: string; opts: { vapidDetails: { subject: string }; urgency: string } }[] = [];
    let code = 0;
    const ports = getPushPorts(env, { webPush: async (sub, payload, opts) => { calls.push({ sub, payload, opts }); if (code) throw Object.assign(new Error("x"), { statusCode: code }); return {}; } });
    expect(await ports.web.send(target({}), msg)).toEqual({ status: "sent" });
    expect(JSON.parse(calls[0]!.payload)).toEqual({ id: "d1", title: "Title", body: "Body", link: "/offers", tag: "offers" });
    expect(calls[0]!.opts.vapidDetails.subject).toBe("mailto:a@example.com.au");
    expect(calls[0]!.opts.urgency).toBe("high");
    code = 410; expect((await ports.web.send(target({}), msg)).status).toBe("gone");
    code = 404; expect((await ports.web.send(target({}), msg)).status).toBe("gone");
    code = 500; expect(await ports.web.send(target({}), msg)).toEqual({ status: "failed", error: "500" });
    expect((await ports.web.send(target({ p256dh: null }), msg)).status).toBe("gone");
  });
  it("web: the real library encrypts for a real subscription key without touching the network", async () => {
    const ecdh = (await import("node:crypto")).createECDH("prime256v1"); ecdh.generateKeys();
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } };
    const d = webpush.generateRequestDetails(sub, "hello", { vapidDetails: { subject: "mailto:a@example.com.au", publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 60 });
    expect(d.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(String(d.headers["Authorization"])).toMatch(/^vapid t=/);
  });

  it("android: gets a token once, then sends the HTTP v1 message; UNREGISTERED means gone", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let sendStatus = 200, sendBody = "{}";
    const fetchStub = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      return new Response(sendBody, { status: sendStatus });
    }) as unknown as typeof fetch;
    const ports = getPushPorts(env, { fetch: fetchStub, now: () => 1_000_000 });
    expect(await ports.android.send(target({ platform: "android", token: "fcm-token-" + "x".repeat(30) }), msg)).toEqual({ status: "sent" });
    const send = calls.find(c => c.url.includes("messages:send"))!;
    expect(send.url).toBe("https://fcm.googleapis.com/v1/projects/ownerlisting-prod/messages:send");
    expect((send.init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
    const m = JSON.parse(String(send.init.body)).message;
    expect(m.notification).toEqual({ title: "Title", body: "Body" });
    expect(m.data).toEqual({ id: "d1", link: "/offers", tag: "offers" });
    expect(String((calls[0]!.init.body as URLSearchParams).get("assertion")).split(".")).toHaveLength(3);
    await ports.android.send(target({ platform: "android" }), msg);
    expect(calls.filter(c => c.url.includes("oauth2"))).toHaveLength(1); // token reused
    sendStatus = 404; sendBody = '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}';
    expect((await ports.android.send(target({ platform: "android" }), msg)).status).toBe("gone");
    sendStatus = 500; sendBody = "oops";
    expect(await ports.android.send(target({ platform: "android" }), msg)).toEqual({ status: "failed", error: "500" });
  });

  it("iOS: posts to APNs with a signed ES256 token; 410 and BadDeviceToken mean gone", async () => {
    const calls: { origin: string; path: string; headers: Record<string, string>; body: string }[] = [];
    let reply = { status: 200, body: "" };
    const ports = getPushPorts(env, { apns: async r => { calls.push(r); return reply; } });
    const t = target({ platform: "ios", token: "ab".repeat(32), p256dh: null, authSecret: null });
    expect(await ports.ios.send(t, msg)).toEqual({ status: "sent" });
    expect(calls[0]!.origin).toBe("https://api.sandbox.push.apple.com");
    expect(calls[0]!.path).toBe(`/3/device/${"ab".repeat(32)}`);
    expect(calls[0]!.headers["apns-topic"]).toBe("au.example.app");
    const [h, c, sig] = calls[0]!.headers["authorization"]!.replace("bearer ", "").split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString()).iss).toBe("TEAM123456");
    expect(Buffer.from(sig!, "base64url")).toHaveLength(64);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ aps: { alert: { title: "Title", body: "Body" } }, id: "d1", link: "/offers" });
    reply = { status: 410, body: '{"reason":"Unregistered"}' };
    expect((await ports.ios.send(t, msg)).status).toBe("gone");
    reply = { status: 400, body: '{"reason":"BadDeviceToken"}' };
    expect((await ports.ios.send(t, msg)).status).toBe("gone");
    reply = { status: 429, body: '{"reason":"TooManyRequests"}' };
    expect(await ports.ios.send(t, msg)).toEqual({ status: "failed", error: "TooManyRequests" });
    expect(getPushPorts({ ...env, APNS_PRODUCTION: "1" }, { apns: async r => { calls.push(r); return { status: 200, body: "" }; } }).ios.configured).toBe(true);
  });
});
