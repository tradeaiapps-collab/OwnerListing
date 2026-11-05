/**
 * Channex channel manager (channex.io): one certified connection that reaches Airbnb, Booking.com and Vrbo.
 * We keep one Channex property per listing (one room type, one rate plan) and pushes content, availability and nightly price to it.
 * The owner connects their own Airbnb, Booking.com or Vrbo account in Channex's channel screen (an embedded iframe); bookings come back through
 * the booking revisions feed (polled) and the booking webhook (faster), and each revision is acknowledged once stored.
 *
 * API reference: https://docs.channex.io (v1). Auth header `user-api-key`; bodies wrapped in the entity name; responses `{ data: { id, attributes } }`.
 * Base URL is chosen by CHANNEX_ENV only (staging unless "production"), never taken from input, so no request can be pointed elsewhere.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Portal } from "../../domain/syndication";

export const CHANNEX_STAGING = "https://staging.channex.io";
export const CHANNEX_PRODUCTION = "https://app.channex.io";
/** How far ahead availability and price are sent. Channex keeps 500 days by default; a year is what the portals show. */
export const ARI_DAYS = 365;
const TIMEOUT_MS = 10_000;

/** Iframe channel codes (docs: channel-iframe). */
export const CHANNEL_CODE: Record<Portal, string> = { airbnb: "ABB", booking_com: "BDC", vrbo: "VRB" };
/** Names the channel list (`channel` field) and booking revisions (`ota_name`) use for each portal. Matched case-insensitively. */
const CHANNEL_ALIASES: Record<Portal, readonly string[]> = {
  airbnb: ["abb", "airbnb"], booking_com: ["bdc", "bookingcom", "booking.com", "booking"], vrbo: ["vrb", "vrbo", "homeaway", "expedia"]
};
const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
export function portalForChannel(name: unknown): Portal | null {
  if (typeof name !== "string") return null;
  const n = norm(name);
  for (const p of Object.keys(CHANNEL_ALIASES) as Portal[]) if (CHANNEL_ALIASES[p].some(a => n === a || n.startsWith(a))) return p;
  return null;
}

type Env = Readonly<Record<string, string | undefined>>;
export interface ChannexConfig { host: string; apiKey: string; webhookSecret: string | null }

/** Null (feature off) until CHANNEX_API_KEY is set. CHANNEX_WEBHOOK_SECRET (32+ characters) switches the webhook on; without it bookings arrive by polling only. */
export function channexConfig(env: Env): ChannexConfig | null {
  const apiKey = env["CHANNEX_API_KEY"]?.trim();
  if (!apiKey || apiKey.length < 16 || /\s/.test(apiKey)) return null;
  const secret = env["CHANNEX_WEBHOOK_SECRET"]?.trim();
  return { host: env["CHANNEX_ENV"] === "production" ? CHANNEX_PRODUCTION : CHANNEX_STAGING, apiKey, webhookSecret: secret && secret.length >= 32 ? secret : null };
}

// ---- What we send ---------------------------------------------------------------------------------------------------------------

export interface ChannexContent {
  title: string; description: string; address: string; city: string | null; state: string; timezone: string; propertyType: "apartment" | "villa";
  photos: string[]; houseRules: string | null; maxGuests: number; nightlyRateCents: number | null; minNights: number;
}

const TZ: Record<string, string> = {
  QLD: "Australia/Brisbane", NSW: "Australia/Sydney", ACT: "Australia/Sydney", VIC: "Australia/Melbourne", TAS: "Australia/Hobart",
  SA: "Australia/Adelaide", WA: "Australia/Perth", NT: "Australia/Darwin"
};

/**
 * Content for the Channex property. Rent here is weekly, portals sell nights: the owner's nightly price wins, otherwise a seventh of the weekly rent.
 * Without any price nothing can be sold (the push fails with a message asking for one).
 */
export function buildChannexContent(l: {
  title: string; description: string | null; address: string; suburb: string | null; state: string; propertyType: string; bedrooms: number | null; priceCents: number | null; photoUrls: string[];
}, custom: { houseRules?: string; minNights?: number; maxGuests?: number; nightlyRateCents?: number }): ChannexContent {
  const nightly = custom.nightlyRateCents ?? (l.priceCents !== null && l.priceCents > 0 ? Math.round(l.priceCents / 7) : null);
  return {
    title: l.title.slice(0, 120), description: (l.description ?? "").slice(0, 5000), address: l.address.slice(0, 255), city: l.suburb, state: l.state,
    timezone: TZ[l.state.toUpperCase()] ?? "Australia/Sydney", propertyType: /apartment|unit|flat|studio/i.test(l.propertyType) ? "apartment" : "villa",
    photos: l.photoUrls.filter(u => u.startsWith("https://")).slice(0, 40), houseRules: custom.houseRules ?? null,
    maxGuests: custom.maxGuests ?? Math.min(16, Math.max(2, (l.bedrooms ?? 1) * 2)), nightlyRateCents: nightly !== null && nightly > 0 ? nightly : null,
    minNights: custom.minNights ?? 1
  };
}

const photos = (c: ChannexContent) => c.photos.map((url, i) => ({ url, kind: "photo", position: i }));
export const propertyBody = (c: ChannexContent) => ({
  property: {
    title: c.title, currency: "AUD", country: "AU", state: c.state, city: c.city ?? c.state, address: c.address, timezone: c.timezone, property_type: c.propertyType,
    content: { description: c.description, important_information: c.houseRules ?? "", photos: photos(c) }
  }
});
export const roomTypeBody = (propertyId: string, c: ChannexContent) => ({
  room_type: {
    property_id: propertyId, title: c.title.slice(0, 80), count_of_rooms: 1, occ_adults: c.maxGuests, occ_children: 0, occ_infants: 0,
    default_occupancy: c.maxGuests, content: { description: c.description, photos: photos(c) }
  }
});
export const ratePlanBody = (propertyId: string, roomTypeId: string, c: ChannexContent) => ({
  rate_plan: {
    property_id: propertyId, room_type_id: roomTypeId, title: "Standard", currency: "AUD", sell_mode: "per_room", rate_mode: "manual",
    options: [{ occupancy: c.maxGuests, is_primary: true }]
  }
});

export interface AriValue { [k: string]: string | number | boolean }
export interface Ari { availability: AriValue[]; restrictions: AriValue[] }
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Availability (1 free, 0 booked) and price for the next ARI_DAYS nights from `today`, as date ranges. Stays are [checkIn, checkOut), so the
 * check-out day stays free. `closed` sends 0 for every night (the listing is off every portal). Ranges are inclusive (date_from..date_to).
 */
export function buildAri(ids: { propertyId: string; roomTypeId: string; ratePlanId: string }, today: string, c: Pick<ChannexContent, "nightlyRateCents" | "minNights"> | null,
  booked: readonly { checkIn: string; checkOut: string }[], closed = false): Ari {
  const last = addDays(today, ARI_DAYS - 1);
  const busy = new Set<string>();
  if (!closed) for (const b of booked) for (let d = b.checkIn < today ? today : b.checkIn; d < b.checkOut && d <= last; d = addDays(d, 1)) busy.add(d);
  const availability: AriValue[] = [];
  let start = today;
  let cur = closed || busy.has(today) ? 0 : 1;
  for (let d = addDays(today, 1); ; d = addDays(d, 1)) {
    const v = d > last ? -1 : closed || busy.has(d) ? 0 : 1;
    if (v !== cur) {
      availability.push({ property_id: ids.propertyId, room_type_id: ids.roomTypeId, date_from: start, date_to: addDays(d, -1), availability: cur });
      if (v === -1) break;
      start = d; cur = v;
    }
  }
  const restrictions: AriValue[] = c?.nightlyRateCents && !closed
    ? [{ property_id: ids.propertyId, rate_plan_id: ids.ratePlanId, date_from: today, date_to: last, rate: c.nightlyRateCents, min_stay_arrival: c.minNights, stop_sell: false }]
    : [];
  return { availability, restrictions };
}

// ---- What comes back ------------------------------------------------------------------------------------------------------------

export interface ChannexRevision {
  revisionId: string; bookingId: string; propertyId: string; portal: Portal | null; status: "new" | "modified" | "cancelled";
  checkIn: string; checkOut: string; guestName: string; guests: number | null; totalCents: number | null;
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const s = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() !== "" && v.length <= max ? v.trim() : null);

/** A booking revision (`{ id, attributes }` or the attributes alone). Money is kept only when it is in AUD. */
export function parseChannexRevision(raw: unknown): { ok: true; value: ChannexRevision } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Not an object." };
  const top = raw as Record<string, unknown>;
  const a = (top["attributes"] && typeof top["attributes"] === "object" ? top["attributes"] : top) as Record<string, unknown>;
  const revisionId = s(top["id"]) ?? s(a["id"]);
  const bookingId = s(a["booking_id"]);
  const propertyId = s(a["property_id"]);
  const status = a["status"];
  if (!revisionId || !bookingId || !propertyId) return { ok: false, error: "Revision is missing its ids." };
  if (status !== "new" && status !== "modified" && status !== "cancelled") return { ok: false, error: "Unknown revision status." };
  const checkIn = s(a["arrival_date"], 10);
  const checkOut = s(a["departure_date"], 10);
  if (!checkIn || !checkOut || !DATE.test(checkIn) || !DATE.test(checkOut) || checkOut <= checkIn) return { ok: false, error: "Revision dates are not valid." };
  const c = (a["customer"] && typeof a["customer"] === "object" ? a["customer"] : {}) as Record<string, unknown>;
  const guestName = [s(c["name"], 60), s(c["surname"], 60)].filter(Boolean).join(" ").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) || "Guest";
  const o = (a["occupancy"] && typeof a["occupancy"] === "object" ? a["occupancy"] : {}) as Record<string, unknown>;
  const people = ["adults", "children"].reduce((n, k) => n + (typeof o[k] === "number" && Number.isInteger(o[k]) && (o[k] as number) >= 0 ? (o[k] as number) : 0), 0);
  const amount = typeof a["amount"] === "string" && /^\d{1,9}(\.\d{1,2})?$/.test(a["amount"]) && a["currency"] === "AUD" ? Math.round(Number(a["amount"]) * 100) : null;
  return {
    ok: true,
    value: { revisionId, bookingId, propertyId, portal: portalForChannel(a["ota_name"]), status, checkIn, checkOut, guestName, guests: people >= 1 && people <= 100 ? people : null, totalCents: amount }
  };
}

/**
 * Webhook check. Channex signs `${timestamp}.${raw body}` with HMAC-SHA256 (headers x-hmac-timestamp, x-hmac-signature-256; two signatures during a key
 * rotation). A webhook set up with a custom header instead sends the secret itself in x-channex-webhook-secret. Either passes; both compare in constant time.
 */
export function verifyChannexWebhook(secret: string, rawBody: string, h: { timestamp: string | null; signature: string | null; sharedSecret: string | null }, nowSeconds: number): boolean {
  const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  if (h.signature && h.timestamp && /^\d{1,12}$/.test(h.timestamp)) {
    if (Math.abs(nowSeconds - Number(h.timestamp)) > 300) return false;
    const want = createHmac("sha256", secret).update(`${h.timestamp}.${rawBody}`).digest("hex");
    return h.signature.split(/[\s,]+/).some(sig => /^[0-9a-f]{64}$/.test(sig) && same(sig, want));
  }
  return h.sharedSecret !== null && same(h.sharedSecret, secret);
}

// ---- Calls ----------------------------------------------------------------------------------------------------------------------

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "manual" }) => Promise<{ status: number; text(): Promise<string> }>;
export interface ChannexResult { ok: boolean; status: number | null; data?: unknown; error?: string }

function mask(m: string, key: string): string {
  return m.split(key).join("***").replace(/\s+/g, " ").slice(0, 300);
}

/** One call. Never throws. 2xx is ok; ARI warnings (rejected values in a 200) are surfaced as an error so they are not lost. */
export async function channexCall(cfg: ChannexConfig, fetch: Fetch, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<ChannexResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.host}/api/v1${path}`, {
      method, headers: { "user-api-key": cfg.apiKey, "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: ctl.signal, redirect: "manual"
    });
    const text = await res.text().catch(() => "");
    let json: Record<string, unknown> = {};
    try { const j: unknown = JSON.parse(text); if (j && typeof j === "object") json = j as Record<string, unknown>; } catch { /* empty body */ }
    if (res.status >= 200 && res.status < 300) {
      const warnings = (json["meta"] as Record<string, unknown> | undefined)?.["warnings"];
      if (Array.isArray(warnings) && warnings.length > 0) return { ok: false, status: res.status, error: mask(`Channex rejected some dates: ${JSON.stringify(warnings[0]).slice(0, 160)}`, cfg.apiKey) };
      return { ok: true, status: res.status, data: json["data"] };
    }
    const err = json["errors"] as Record<string, unknown> | undefined;
    const detail = err ? `${String(err["title"] ?? err["code"] ?? "")} ${err["details"] ? JSON.stringify(err["details"]).slice(0, 120) : ""}` : text.slice(0, 120);
    return { ok: false, status: res.status, error: mask(`Channex answered ${res.status}: ${detail.trim()}`, cfg.apiKey) };
  } catch (e) {
    return { ok: false, status: null, error: ctl.signal.aborted ? "Channex did not answer in time." : mask(e instanceof Error ? e.message : String(e), cfg.apiKey) };
  } finally { clearTimeout(timer); }
}

const idOf = (data: unknown): string | null => {
  const d = data as Record<string, unknown> | undefined;
  return typeof d?.["id"] === "string" ? d["id"] : null;
};

export interface ChannexIds { propertyId: string | null; roomTypeId: string | null; ratePlanId: string | null }
export interface ChannelInfo { id: string; portal: Portal | null; active: boolean; properties: string[] }

/** Creates whatever of property, room type and rate plan is still missing. `saveIds` runs after each create so a later failure never orphans one. */
export async function ensureStructure(cfg: ChannexConfig, fetch: Fetch, ids: ChannexIds, c: ChannexContent, saveIds: (ids: ChannexIds) => Promise<void>):
  Promise<{ ok: true; ids: Required<{ [K in keyof ChannexIds]: string }>; created: boolean } | { ok: false; status: number | null; error: string }> {
  const cur = { ...ids };
  let created = false;
  const step = async (key: keyof ChannexIds, path: string, body: unknown) => {
    const r = await channexCall(cfg, fetch, "POST", path, body);
    const id = r.ok ? idOf(r.data) : null;
    if (!id) return { ok: false as const, status: r.status, error: r.error ?? "Channex gave no id back." };
    cur[key] = id; created = true;
    await saveIds(cur);
    return null;
  };
  if (!cur.propertyId) { const f = await step("propertyId", "/properties", propertyBody(c)); if (f) return f; }
  if (!cur.roomTypeId) { const f = await step("roomTypeId", "/room_types", roomTypeBody(cur.propertyId!, c)); if (f) return f; }
  if (!cur.ratePlanId) { const f = await step("ratePlanId", "/rate_plans", ratePlanBody(cur.propertyId!, cur.roomTypeId!, c)); if (f) return f; }
  return { ok: true, ids: { propertyId: cur.propertyId!, roomTypeId: cur.roomTypeId!, ratePlanId: cur.ratePlanId! }, created };
}

export async function updateContent(cfg: ChannexConfig, fetch: Fetch, ids: { propertyId: string; roomTypeId: string }, c: ChannexContent): Promise<ChannexResult> {
  const p = await channexCall(cfg, fetch, "PUT", `/properties/${encodeURIComponent(ids.propertyId)}`, propertyBody(c));
  if (!p.ok) return p;
  const { property_id: _omit, ...room } = roomTypeBody(ids.propertyId, c).room_type;
  return channexCall(cfg, fetch, "PUT", `/room_types/${encodeURIComponent(ids.roomTypeId)}`, { room_type: room });
}

export async function pushAri(cfg: ChannexConfig, fetch: Fetch, ari: Ari): Promise<ChannexResult> {
  const a = await channexCall(cfg, fetch, "POST", "/availability", { values: ari.availability });
  if (!a.ok || ari.restrictions.length === 0) return a;
  return channexCall(cfg, fetch, "POST", "/restrictions", { values: ari.restrictions });
}

export async function listChannels(cfg: ChannexConfig, fetch: Fetch, propertyId: string): Promise<{ ok: true; channels: ChannelInfo[] } | { ok: false; error: string }> {
  const r = await channexCall(cfg, fetch, "GET", `/channels?filter[property_id]=${encodeURIComponent(propertyId)}&pagination[limit]=100`);
  if (!r.ok) return { ok: false, error: r.error ?? "Could not read channels." };
  const rows = Array.isArray(r.data) ? r.data : [];
  return {
    ok: true,
    channels: rows.flatMap(row => {
      const id = idOf(row);
      const at = ((row as Record<string, unknown>)["attributes"] ?? {}) as Record<string, unknown>;
      if (!id) return [];
      return [{ id, portal: portalForChannel(at["channel"]), active: at["is_active"] === true, properties: Array.isArray(at["properties"]) ? at["properties"].filter((x): x is string => typeof x === "string") : [] }];
    })
  };
}

export const setChannelActive = (cfg: ChannexConfig, fetch: Fetch, channelId: string, active: boolean) =>
  channexCall(cfg, fetch, "POST", `/channels/${encodeURIComponent(channelId)}/${active ? "activate" : "deactivate"}`);

export async function getRevision(cfg: ChannexConfig, fetch: Fetch, revisionId: string): Promise<ChannexResult> {
  return channexCall(cfg, fetch, "GET", `/booking_revisions/${encodeURIComponent(revisionId)}`);
}
/** Revisions not yet acknowledged, oldest first. */
export async function revisionFeed(cfg: ChannexConfig, fetch: Fetch): Promise<ChannexResult> {
  return channexCall(cfg, fetch, "GET", "/booking_revisions/feed?order[inserted_at]=asc&pagination[limit]=100");
}
export const ackRevision = (cfg: ChannexConfig, fetch: Fetch, revisionId: string) =>
  channexCall(cfg, fetch, "POST", `/booking_revisions/${encodeURIComponent(revisionId)}/ack`);

/** Address of Channex's channel screen for one property, limited to the portals staff switched on. The token lives 15 minutes and works once. */
export async function channelScreenUrl(cfg: ChannexConfig, fetch: Fetch, propertyId: string, username: string, portals: readonly Portal[]): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const r = await channexCall(cfg, fetch, "POST", "/auth/one_time_token", { one_time_token: { property_id: propertyId, username } });
  const token = r.ok ? (r.data as Record<string, unknown> | undefined)?.["token"] : undefined;
  if (typeof token !== "string" || token === "") return { ok: false, error: r.error ?? "Channex gave no sign-in token back." };
  const q = new URLSearchParams({ oauth_session_key: token, app_mode: "headless", redirect_to: "/channels", property_id: propertyId, channels: portals.map(p => CHANNEL_CODE[p]).join(","), lng: "en" });
  return { ok: true, url: `${cfg.host}/auth/exchange?${q.toString()}` };
}
