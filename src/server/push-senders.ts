import { createPrivateKey, createSign, sign as cryptoSign } from "node:crypto";
import http2 from "node:http2";
import webpush from "web-push";
import type { Platform, PushMessage } from "../domain/push";

type Env = Readonly<Record<string, string | undefined>>;
export type SendStatus = "sent" | "failed" | "gone";
export interface SendOutcome { status: SendStatus; error?: string }
export interface PushTarget { id: string; platform: Platform; token: string; p256dh: string | null; authSecret: string | null }
export interface PushPort { configured: boolean; send(target: PushTarget, msg: PushMessage): Promise<SendOutcome> }
export interface PushPorts { web: PushPort; android: PushPort; ios: PushPort }

/** Replaceable I/O so tests never touch the network. */
export interface PushTransports {
  webPush?: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, opts: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number; urgency: "high" | "normal" }) => Promise<unknown>;
  fetch?: typeof fetch;
  apns?: (req: { origin: string; path: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; body: string }>;
  now?: () => number;
}

const wire = (m: PushMessage) => JSON.stringify({ id: m.id, title: m.title, body: m.body, link: m.link, tag: m.tag });
const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");
const pem = (v: string) => v.replace(/\\n/g, "\n").trim();
const err = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/[\u0000-\u001f]+/g, " ").slice(0, 200);
const off: PushPort = { configured: false, send: async () => ({ status: "failed", error: "not_configured" }) };

// ---- Browsers (Web Push with VAPID) -------------------------------------------------------------------------------------------
export const VAPID_PUBLIC = /^[A-Za-z0-9_-]{87}$/;
export const VAPID_PRIVATE = /^[A-Za-z0-9_-]{43}$/;

export function webPublicKey(env: Env): string | null {
  const k = env["VAPID_PUBLIC_KEY"], p = env["VAPID_PRIVATE_KEY"], s = env["VAPID_SUBJECT"];
  return k && p && s && VAPID_PUBLIC.test(k) && VAPID_PRIVATE.test(p) && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(s) ? k : null;
}

function webPort(env: Env, t: PushTransports): PushPort {
  const publicKey = webPublicKey(env);
  if (!publicKey) return off;
  const vapidDetails = { subject: env["VAPID_SUBJECT"]!, publicKey, privateKey: env["VAPID_PRIVATE_KEY"]! };
  const send = t.webPush ?? ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts));
  return {
    configured: true,
    async send(target, msg) {
      if (!target.p256dh || !target.authSecret) return { status: "gone", error: "missing_keys" };
      try {
        await send({ endpoint: target.token, keys: { p256dh: target.p256dh, auth: target.authSecret } }, wire(msg), { vapidDetails, TTL: 86_400, urgency: msg.tag === "messages" || msg.tag === "offers" ? "high" : "normal" });
        return { status: "sent" };
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        return code === 404 || code === 410 ? { status: "gone", error: String(code) } : { status: "failed", error: code ? String(code) : err(e) };
      }
    }
  };
}

// ---- Android (Firebase Cloud Messaging, HTTP v1) ------------------------------------------------------------------------------
function fcmPort(env: Env, t: PushTransports): PushPort {
  const project = env["FCM_PROJECT_ID"], email = env["FCM_CLIENT_EMAIL"], key = env["FCM_PRIVATE_KEY"];
  if (!project || !email || !key || !/^[a-z][a-z0-9-]{4,29}$/.test(project) || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(email) || !pem(key).startsWith("-----BEGIN")) return off;
  const doFetch = t.fetch ?? fetch;
  const now = t.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;

  const accessToken = async (): Promise<string> => {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
    const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(pem(key)).toString("base64url");
    const r = await doFetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` })
    });
    const d = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!r.ok || !d.access_token) throw new Error(`fcm_auth_${r.status}`);
    cached = { token: d.access_token, expiresAt: now() + (d.expires_in ?? 3600) * 1000 };
    return d.access_token;
  };

  return {
    configured: true,
    async send(target, msg) {
      try {
        const r = await doFetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await accessToken()}` },
          body: JSON.stringify({ message: { token: target.token, notification: { title: msg.title, body: msg.body }, data: { id: msg.id, link: msg.link ?? "", tag: msg.tag }, android: { priority: msg.tag === "messages" || msg.tag === "offers" ? "HIGH" : "NORMAL", notification: { tag: msg.tag } } } })
        });
        if (r.ok) return { status: "sent" };
        const text = await r.text().catch(() => "");
        if (r.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(text)) return { status: "gone", error: String(r.status) };
        if (r.status === 401) cached = null;
        return { status: "failed", error: String(r.status) };
      } catch (e) {
        return { status: "failed", error: err(e) };
      }
    }
  };
}

// ---- iPhone (Apple Push Notification service, token auth over HTTP/2) ---------------------------------------------------------
function http2Post(req: { origin: string; path: string; headers: Record<string, string>; body: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(req.origin);
    const done = (fn: () => void) => { session.close(); fn(); };
    session.on("error", e => done(() => reject(e)));
    const r = session.request({ ":method": "POST", ":path": req.path, ...req.headers });
    r.setTimeout(10_000, () => { r.close(); done(() => reject(new Error("apns_timeout"))); });
    let status = 0, body = "";
    r.on("response", h => { status = Number(h[":status"] ?? 0); });
    r.on("data", c => { body += String(c); });
    r.on("end", () => done(() => resolve({ status, body })));
    r.on("error", e => done(() => reject(e)));
    r.end(req.body);
  });
}

function apnsPort(env: Env, t: PushTransports): PushPort {
  const keyId = env["APNS_KEY_ID"], teamId = env["APNS_TEAM_ID"], bundle = env["APNS_BUNDLE_ID"], key = env["APNS_PRIVATE_KEY"];
  if (!keyId || !teamId || !bundle || !key || !/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Za-z0-9.-]+$/.test(bundle) || !pem(key).startsWith("-----BEGIN")) return off;
  const origin = env["APNS_PRODUCTION"] === "1" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  const post = t.apns ?? http2Post;
  const now = t.now ?? Date.now;
  let jwt: { token: string; at: number } | null = null;
  const bearer = () => {
    if (jwt && now() - jwt.at < 40 * 60_000) return jwt.token; // Apple wants a fresh token at least hourly, and not more than every 20 minutes.
    const iat = Math.floor(now() / 1000);
    const head = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
    const claims = b64url(JSON.stringify({ iss: teamId, iat }));
    const sig = cryptoSign("sha256", Buffer.from(`${head}.${claims}`), { key: createPrivateKey(pem(key)), dsaEncoding: "ieee-p1363" }).toString("base64url");
    jwt = { token: `${head}.${claims}.${sig}`, at: now() };
    return jwt.token;
  };
  return {
    configured: true,
    async send(target, msg) {
      try {
        const r = await post({
          origin, path: `/3/device/${target.token}`,
          headers: { authorization: `bearer ${bearer()}`, "apns-topic": bundle, "apns-push-type": "alert", "apns-priority": msg.tag === "messages" || msg.tag === "offers" ? "10" : "5", "content-type": "application/json" },
          body: JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: "default", "thread-id": msg.tag }, id: msg.id, link: msg.link })
        });
        if (r.status === 200) return { status: "sent" };
        const reason = (() => { try { return String((JSON.parse(r.body) as { reason?: unknown }).reason ?? ""); } catch { return ""; } })();
        if (r.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic") return { status: "gone", error: reason || String(r.status) };
        if (r.status === 403) jwt = null;
        return { status: "failed", error: reason || String(r.status) };
      } catch (e) {
        return { status: "failed", error: err(e) };
      }
    }
  };
}

/** Each platform is on only when all of its keys are present and well formed; otherwise it stays off and nothing is attempted. */
export function getPushPorts(env: Env = process.env, t: PushTransports = {}): PushPorts {
  return { web: webPort(env, t), android: fcmPort(env, t), ios: apnsPort(env, t) };
}
