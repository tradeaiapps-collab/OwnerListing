import { CATEGORIES, CATEGORY_INFO, isCategory, type Category, type RenderedNotification } from "./notifications";
import type { Failure, Result } from "./listing-service";

/**
 * Push notifications: devices, topic preferences, payloads, Elena's personalisation, quiet hours and engagement figures.
 * Pure functions, no I/O. Push is an extra channel for a notification; the in-app notification stays the record.
 */
export const PLATFORMS = ["web", "android", "ios"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const isPlatform = (v: unknown): v is Platform => typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);

const bad = (message: string): Failure => ({ ok: false, code: "invalid", message });

// ---- Topics (the notification categories) -------------------------------------------------------------------------------------

export type PushPreferences = Record<Category, boolean>;
/** Push is on for the time-critical topics once a device is registered. News and saved-search matches are opt-in. Account notices are required. */
export const PUSH_DEFAULTS: PushPreferences = { messages: true, appointments: true, offers: true, listings: false, account: true, marketing: false };
export const PUSH_LOCKED_ON: readonly Category[] = ["account"];

export const defaultPushPreferences = (): PushPreferences => ({ ...PUSH_DEFAULTS });

export function resolvePushPreferences(rows: readonly { category: string; enabled: boolean }[]): PushPreferences {
  const out = defaultPushPreferences();
  for (const r of rows) if (isCategory(r.category)) out[r.category] = r.enabled;
  for (const c of PUSH_LOCKED_ON) out[c] = true;
  return out;
}

/** Body: { topics: { <category>: boolean } }. Any subset; unknown topics, non-booleans and turning off a required topic are refused. */
export function parsePushPreferencesInput(body: unknown): Result<Partial<PushPreferences>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("Send a JSON object.");
  const root = body as Record<string, unknown>;
  if (Object.keys(root).some(k => k !== "topics")) return bad("Unsupported field.");
  const topics = root["topics"];
  if (typeof topics !== "object" || topics === null || Array.isArray(topics)) return bad("Send topics as an object.");
  const out: Partial<PushPreferences> = {};
  for (const [cat, v] of Object.entries(topics as Record<string, unknown>)) {
    if (!isCategory(cat)) return bad(`Unknown topic: ${cat.slice(0, 30)}.`);
    if (typeof v !== "boolean") return bad("Each topic must be true or false.");
    if (!v && PUSH_LOCKED_ON.includes(cat)) return bad(`${CATEGORY_INFO[cat].label} notices are required and cannot be turned off.`);
    out[cat] = v;
  }
  return { ok: true, value: out };
}

/** Topic flips as consent events, like the other channels. */
export function pushConsentChanges(before: PushPreferences, after: PushPreferences): { category: Category; granted: boolean }[] {
  return CATEGORIES.filter(c => before[c] !== after[c]).map(c => ({ category: c, granted: after[c] }));
}

// ---- Devices ------------------------------------------------------------------------------------------------------------------

export interface DeviceInput { platform: Platform; token: string; p256dh: string | null; authSecret: string | null; label: string | null }

/**
 * The browser's push service hosts. A web subscription endpoint is a URL the server will POST to, so only the real push services are accepted
 * (anything else could point the server at an internal address).
 */
const WEB_PUSH_HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/
];
export function isAllowedWebPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && u.port === "" && u.username === "" && u.password === "" && WEB_PUSH_HOSTS.some(r => r.test(u.hostname));
  } catch { return false; }
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const MOBILE_TOKEN = /^[A-Za-z0-9:_.\-]{20,2048}$/;
const cleanLabel = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[<>]+/g, "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, 80);
  return t === "" ? null : t;
};

/**
 * Web:     { platform: "web", subscription: { endpoint, keys: { p256dh, auth } }, label? }   (PushSubscription.toJSON())
 * Android: { platform: "android", token, label? }   (FCM registration token)
 * iOS:     { platform: "ios", token, label? }       (APNs device token, hex)
 */
export function parseDeviceInput(body: unknown): Result<DeviceInput> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("Send a JSON object.");
  const b = body as Record<string, unknown>;
  if (!isPlatform(b["platform"])) return bad("platform must be web, android or ios.");
  const platform = b["platform"];
  const label = cleanLabel(b["label"]);
  if (platform === "web") {
    const s = b["subscription"] as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null | undefined;
    const endpoint = s?.endpoint, p256dh = s?.keys?.p256dh, auth = s?.keys?.auth;
    if (typeof endpoint !== "string" || endpoint.length > 2048 || !isAllowedWebPushEndpoint(endpoint)) return bad("That is not a browser push subscription.");
    if (typeof p256dh !== "string" || typeof auth !== "string" || !B64URL.test(p256dh) || !B64URL.test(auth) || p256dh.length < 20 || p256dh.length > 200 || auth.length < 10 || auth.length > 100)
      return bad("The subscription keys are missing or malformed.");
    return { ok: true, value: { platform, token: endpoint, p256dh, authSecret: auth, label } };
  }
  const token = b["token"];
  if (typeof token !== "string" || !MOBILE_TOKEN.test(token)) return bad("token is missing or malformed.");
  if (platform === "ios" && !/^[0-9a-fA-F]{64,200}$/.test(token)) return bad("An iOS token is the hex device token.");
  return { ok: true, value: { platform, token, p256dh: null, authSecret: null, label } };
}

// ---- Payload ------------------------------------------------------------------------------------------------------------------

export interface PushMessage { id: string; title: string; body: string; link: string | null; tag: string }

/** What the device shows. `id` is the delivery id: opening or dismissing reports back with it. No amounts, addresses of other people or message text. */
export function buildPushMessage(deliveryId: string, title: string, body: string, link: string | null, category: Category): PushMessage {
  return { id: deliveryId, title: title.slice(0, 80), body: body.slice(0, 180), link, tag: category };
}

// ---- Quiet hours --------------------------------------------------------------------------------------------------------------

export const PUSH_TIME_ZONE = "Australia/Sydney";
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 7;

export function localHour(nowIso: string, timeZone: string = PUSH_TIME_ZONE): number {
  const h = new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(nowIso)).find(p => p.type === "hour")?.value;
  return Number(h ?? 0) % 24;
}
/** Between 9pm and 7am local time pushes are held back (the in-app notification is still there in the morning). Required account notices still go out. */
export function inQuietHours(category: Category, nowIso: string, timeZone: string = PUSH_TIME_ZONE): boolean {
  if (PUSH_LOCKED_ON.includes(category)) return false;
  const h = localHour(nowIso, timeZone);
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

// ---- Elena personalisation ----------------------------------------------------------------------------------------------------

export interface PushContext {
  /** The person's first name, if known. */
  firstName: string | null;
  /** Unread notifications in the same topic, counting this one. */
  unreadInTopic: number;
  /** Share of recent pushes they opened (0..1), or null when there are too few to judge. */
  clickRate: number | null;
}
export interface PersonalizedPush { title: string; body: string; personalized: boolean }

const first = (n: string | null): string | null => {
  const t = (n ?? "").trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{M}'-]/gu, "") ?? "";
  return t.length >= 1 && t.length <= 30 ? t : null;
};
/** Lower-cases a generic opening word so "Sam, a new offer..." reads naturally; a body that opens with a name (or anything else) is left as written. */
const lowerFirst = (s: string) => (/^(A|An|The|Your|There) /.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/**
 * Elena writes the push in the user's own context (rule based and self-hosted, nothing leaves the platform):
 *  - addresses them by first name, for people-and-property topics only (never marketing, never account or security notices);
 *  - mentions how many are waiting when more than one is unread in the topic;
 *  - keeps it to the short form for people who rarely open pushes, so she does not add noise.
 * She never adds amounts, advice or urgency the notification itself does not carry.
 */
export function personalizePush(n: RenderedNotification, ctx: PushContext): PersonalizedPush {
  const plain: PersonalizedPush = { title: n.title, body: n.body, personalized: false };
  if (n.category === "marketing" || n.category === "account") return plain;
  const name = first(ctx.firstName);
  const brief = ctx.clickRate !== null && ctx.clickRate < 0.2;
  let body = n.body;
  if (name) body = `${name}, ${lowerFirst(body)}`;
  if (!brief && ctx.unreadInTopic > 1) body += ` You have ${ctx.unreadInTopic} unread in ${CATEGORY_INFO[n.category].label.toLowerCase()}.`;
  if (body === n.body) return plain;
  return { title: n.title, body: body.slice(0, 180), personalized: true };
}

// ---- Engagement ---------------------------------------------------------------------------------------------------------------

export interface EngagementRow { platform: Platform; category: Category; personalized: boolean; sent: number; failed: number; gone: number; clicked: number; dismissed: number }
export interface EngagementTotals { sent: number; failed: number; gone: number; clicked: number; dismissed: number; clickRate: number | null }
export interface Engagement {
  total: EngagementTotals;
  byPlatform: Record<string, EngagementTotals>;
  byTopic: Record<string, EngagementTotals>;
  personalization: { personalized: EngagementTotals; plain: EngagementTotals };
}

const empty = (): EngagementTotals => ({ sent: 0, failed: 0, gone: 0, clicked: 0, dismissed: 0, clickRate: null });
const add = (t: EngagementTotals, r: EngagementRow) => { t.sent += r.sent; t.failed += r.failed; t.gone += r.gone; t.clicked += r.clicked; t.dismissed += r.dismissed; };
const finish = (t: EngagementTotals): EngagementTotals => ({ ...t, clickRate: t.sent > 0 ? Math.round((t.clicked / t.sent) * 1000) / 1000 : null });

/** Click rate = opened / delivered to the push service ("sent"). Failed and gone are counted separately and are not in the rate's denominator. */
export function summarizeEngagement(rows: readonly EngagementRow[]): Engagement {
  const total = empty(), p = empty(), plain = empty();
  const byPlatform: Record<string, EngagementTotals> = {}, byTopic: Record<string, EngagementTotals> = {};
  for (const r of rows) {
    add(total, r); add(r.personalized ? p : plain, r);
    add((byPlatform[r.platform] ??= empty()), r);
    add((byTopic[r.category] ??= empty()), r);
  }
  const fin = (m: Record<string, EngagementTotals>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, finish(v)]));
  return { total: finish(total), byPlatform: fin(byPlatform), byTopic: fin(byTopic), personalization: { personalized: finish(p), plain: finish(plain) } };
}

export const isPushEvent = (v: unknown): v is "clicked" | "dismissed" => v === "clicked" || v === "dismissed";
