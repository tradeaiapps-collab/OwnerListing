import { createHash } from "node:crypto";
import { hostProblem } from "./net-guard";

/**
 * Listing syndication rules: which portals exist, how a listing becomes a portal payload, the per-listing custom fields,
 * retry timing and the booking rules. Pure; the database and HTTP live in src/server/syndication-db.ts.
 */

export const PORTALS = ["airbnb", "vrbo", "booking_com"] as const;
export type Portal = (typeof PORTALS)[number];
export const isPortal = (v: unknown): v is Portal => typeof v === "string" && (PORTALS as readonly string[]).includes(v);
export const PORTAL_LABELS: Record<Portal, string> = { airbnb: "Airbnb", vrbo: "VRBO", booking_com: "Booking.com" };

/** "api": we push to the portal's partner endpoint. "manual": the owner lists on the portal and pastes the link back. */
export type PortalMode = "api" | "manual";
export const TRANSACTION_TYPES = ["rent", "sale"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const SYNC_STATES = ["pending", "live", "failed", "removed", "manual", "manual_removal"] as const;
export type SyncState = (typeof SYNC_STATES)[number];

/** A listing is re-sent at least this often even when nothing changed (photos can change without the listing row changing). */
export const STALE_AFTER_HOURS = 24;
/** Waits before attempt 2..6. After the sixth failure the sync stays failed until someone presses retry. */
export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 21600] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
export const nextRetryDelaySeconds = (attemptsMade: number): number | null =>
  attemptsMade >= 1 && attemptsMade <= RETRY_DELAYS_SECONDS.length ? RETRY_DELAYS_SECONDS[attemptsMade - 1]! : null;

export const MAX_STAY_NIGHTS = 365;

// ---- Portal setup (staff) ------------------------------------------------------------------------------------------------

export interface PortalConfigInput {
  enabled?: boolean;
  mode?: PortalMode;
  baseUrl?: string | null;
  allowedTransactionTypes?: TransactionType[];
  maxPerMinute?: number;
}
type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** Base URL of a portal's partner API: https, standard port, a real host name (not an IP, localhost or an internal name). */
export function validateBaseUrl(raw: unknown): Checked<string> {
  if (typeof raw !== "string" || raw.length > 300) return { ok: false, error: "Enter the portal API address (https://...)." };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, error: "That is not a valid address." }; }
  if (u.protocol !== "https:") return { ok: false, error: "The address must start with https://." };
  if (u.username || u.password) return { ok: false, error: "Do not put credentials in the address." };
  if (u.port && u.port !== "443") return { ok: false, error: "Use the standard https port." };
  if (u.search || u.hash) return { ok: false, error: "Leave out the query string and fragment." };
  const problem = hostProblem(u.hostname);
  if (problem) return { ok: false, error: problem };
  return { ok: true, value: u.toString().replace(/\/+$/, "") };
}

export function parsePortalConfig(body: Record<string, unknown>): Checked<PortalConfigInput> {
  const out: PortalConfigInput = {};
  if ("enabled" in body) { if (typeof body["enabled"] !== "boolean") return { ok: false, error: "enabled must be true or false." }; out.enabled = body["enabled"]; }
  if ("mode" in body) { if (body["mode"] !== "api" && body["mode"] !== "manual") return { ok: false, error: "mode must be api or manual." }; out.mode = body["mode"]; }
  if ("baseUrl" in body) {
    if (body["baseUrl"] === null || body["baseUrl"] === "") out.baseUrl = null;
    else { const u = validateBaseUrl(body["baseUrl"]); if (!u.ok) return u; out.baseUrl = u.value; }
  }
  if ("allowedTransactionTypes" in body) {
    const a = body["allowedTransactionTypes"];
    if (!Array.isArray(a) || a.length === 0 || !a.every(x => (TRANSACTION_TYPES as readonly unknown[]).includes(x))) return { ok: false, error: "Pick at least one of rent or sale." };
    out.allowedTransactionTypes = [...new Set(a as TransactionType[])];
  }
  if ("maxPerMinute" in body) {
    const n = body["maxPerMinute"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 600) return { ok: false, error: "Rate limit must be a whole number from 1 to 600 per minute." };
    out.maxPerMinute = n;
  }
  return { ok: true, value: out };
}

/** The portal can take pushes only when it is switched on and, in api mode, has an address, a key and a webhook secret. */
export function portalReady(p: { enabled: boolean; mode: PortalMode; baseUrl: string | null; hasKey: boolean; hasWebhookSecret: boolean }): boolean {
  return p.enabled && (p.mode === "manual" || (p.baseUrl !== null && p.hasKey && p.hasWebhookSecret));
}

// ---- Per-listing settings (owner / agent) ----------------------------------------------------------------------------------

export const CANCELLATION_POLICIES = ["flexible", "moderate", "strict"] as const;
export type CancellationPolicy = (typeof CANCELLATION_POLICIES)[number];

export interface PortalCustomFields { houseRules?: string; cancellationPolicy?: CancellationPolicy; minNights?: number; maxGuests?: number }
export interface ListingPortalInput { enabled: boolean; custom: PortalCustomFields; manualUrl?: string | null }

const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();

export function parseListingPortalInput(raw: unknown): Checked<ListingPortalInput> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "Send an object." };
  const b = raw as Record<string, unknown>;
  if (typeof b["enabled"] !== "boolean") return { ok: false, error: "enabled must be true or false." };
  const custom: PortalCustomFields = {};
  const c = b["custom"];
  if (c !== undefined && c !== null) {
    if (typeof c !== "object" || Array.isArray(c)) return { ok: false, error: "custom must be an object." };
    const f = c as Record<string, unknown>;
    for (const k of Object.keys(f)) if (!["houseRules", "cancellationPolicy", "minNights", "maxGuests"].includes(k)) return { ok: false, error: `Unknown field: ${k.slice(0, 30)}.` };
    if (f["houseRules"] !== undefined && f["houseRules"] !== "") {
      if (typeof f["houseRules"] !== "string" || f["houseRules"].length > 2000) return { ok: false, error: "House rules must be text of at most 2000 characters." };
      custom.houseRules = clean(f["houseRules"]);
    }
    if (f["cancellationPolicy"] !== undefined && f["cancellationPolicy"] !== "") {
      if (!(CANCELLATION_POLICIES as readonly unknown[]).includes(f["cancellationPolicy"])) return { ok: false, error: "Cancellation policy must be flexible, moderate or strict." };
      custom.cancellationPolicy = f["cancellationPolicy"] as CancellationPolicy;
    }
    if (f["minNights"] !== undefined && f["minNights"] !== null && f["minNights"] !== "") {
      const n = f["minNights"];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 365) return { ok: false, error: "Minimum nights must be a whole number from 1 to 365." };
      custom.minNights = n;
    }
    if (f["maxGuests"] !== undefined && f["maxGuests"] !== null && f["maxGuests"] !== "") {
      const n = f["maxGuests"];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 50) return { ok: false, error: "Maximum guests must be a whole number from 1 to 50." };
      custom.maxGuests = n;
    }
  }
  let manualUrl: string | null | undefined;
  if (b["manualUrl"] !== undefined) {
    if (b["manualUrl"] === null || b["manualUrl"] === "") manualUrl = null;
    else {
      if (typeof b["manualUrl"] !== "string" || b["manualUrl"].length > 500) return { ok: false, error: "Enter the link to your listing on the portal." };
      let u: URL;
      try { u = new URL(b["manualUrl"].trim()); } catch { return { ok: false, error: "That link is not valid." }; }
      if (u.protocol !== "https:" || u.username || u.password) return { ok: false, error: "The link must be a plain https:// address." };
      u.hash = "";
      manualUrl = u.toString();
    }
  }
  return { ok: true, value: { enabled: b["enabled"], custom, ...(manualUrl !== undefined ? { manualUrl } : {}) } };
}

// ---- The payload sent to a portal ---------------------------------------------------------------------------------------------

export interface SyndicationListing {
  id: string; title: string; description: string | null; propertyType: string; transactionType: string;
  address: string; suburb: string | null; state: string; bedrooms: number | null; priceCents: number | null;
  updatedAt: string; photoUrls: string[]; listingUrl: string | null;
}
export interface PortalPayload {
  externalRef: string; title: string; description: string; propertyType: string; address: string; suburb: string | null; state: string;
  bedrooms: number | null; priceCents: number | null; photos: string[]; sourceUrl: string | null;
  houseRules: string | null; cancellationPolicy: CancellationPolicy | null; minNights: number | null; maxGuests: number | null;
}
const MAX_PHOTOS = 40;

export function buildPortalPayload(l: SyndicationListing, custom: PortalCustomFields): PortalPayload {
  return {
    externalRef: l.id, title: l.title.slice(0, 120), description: (l.description ?? "").slice(0, 5000), propertyType: l.propertyType,
    address: l.address, suburb: l.suburb, state: l.state, bedrooms: l.bedrooms, priceCents: l.priceCents,
    photos: l.photoUrls.slice(0, MAX_PHOTOS), sourceUrl: l.listingUrl,
    houseRules: custom.houseRules ?? null, cancellationPolicy: custom.cancellationPolicy ?? null,
    minNights: custom.minNights ?? null, maxGuests: custom.maxGuests ?? null
  };
}

/** Same payload gives the same hash; used to skip a push when nothing a portal would see has changed. */
export const payloadHash = (p: PortalPayload): string => createHash("sha256").update(JSON.stringify(p)).digest("hex");

/** Why a listing may not go to a portal, or null when it may. Only published listings in an allowed category are ever sent. */
export function ineligibleReason(l: { status: string; transactionType: string }, allowed: readonly string[]): string | null {
  if (l.status !== "published") return "Only published listings are shared.";
  if (!allowed.includes(l.transactionType)) return `This portal does not take ${l.transactionType} listings.`;
  return null;
}

/** Backoff after a failed attempt: next time to try, or null when attempts are used up. */
export function nextAttemptAt(nowIso: string, attemptsMade: number): string | null {
  const d = nextRetryDelaySeconds(attemptsMade);
  return d === null ? null : new Date(Date.parse(nowIso) + d * 1000).toISOString();
}

/** Errors stored for staff to read: one short line, no secrets (a bearer value is masked even if a portal echoes it back). */
export function safeError(e: unknown, secrets: readonly string[] = []): string {
  let m = e instanceof Error ? e.message : String(e);
  for (const s of secrets) if (s.length >= 6) m = m.split(s).join("***");
  return m.replace(/\s+/g, " ").replace(/Bearer\s+\S+/gi, "Bearer ***").slice(0, 300) || "Unknown error";
}

// ---- Bookings from a portal ----------------------------------------------------------------------------------------------------

export interface IncomingBooking {
  event: "booking.created" | "booking.cancelled";
  externalListingId: string; externalBookingId: string;
  guestName: string; guests: number | null; checkIn: string; checkOut: string; totalCents: number | null;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string): boolean => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const nights = (checkIn: string, checkOut: string): number => Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);

export function parseIncomingBooking(raw: unknown): Checked<IncomingBooking> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "Send a JSON object." };
  const b = raw as Record<string, unknown>;
  const event = b["event"];
  if (event !== "booking.created" && event !== "booking.cancelled") return { ok: false, error: "Unknown event." };
  const str = (k: string, max: number): string | null => (typeof b[k] === "string" && b[k].trim() !== "" && (b[k] as string).length <= max ? (b[k] as string).trim() : null);
  const externalListingId = str("externalListingId", 200);
  const externalBookingId = str("externalBookingId", 200);
  if (!externalListingId || !externalBookingId) return { ok: false, error: "externalListingId and externalBookingId are required." };
  const checkIn = str("checkIn", 10);
  const checkOut = str("checkOut", 10);
  if (!checkIn || !checkOut || !validDate(checkIn) || !validDate(checkOut)) return { ok: false, error: "checkIn and checkOut must be dates (YYYY-MM-DD)." };
  const n = nights(checkIn, checkOut);
  if (n < 1 || n > MAX_STAY_NIGHTS) return { ok: false, error: `A stay is 1 to ${MAX_STAY_NIGHTS} nights.` };
  const guestName = clean(str("guestName", 120) ?? "") || "Guest";
  const guests = b["guests"] === undefined || b["guests"] === null ? null : b["guests"];
  if (guests !== null && (typeof guests !== "number" || !Number.isInteger(guests) || guests < 1 || guests > 100)) return { ok: false, error: "guests must be a whole number from 1 to 100." };
  const total = b["totalCents"] === undefined || b["totalCents"] === null ? null : b["totalCents"];
  if (total !== null && (typeof total !== "number" || !Number.isInteger(total) || total < 0)) return { ok: false, error: "totalCents must be a whole number of cents." };
  return { ok: true, value: { event, externalListingId, externalBookingId, guestName, guests, checkIn, checkOut, totalCents: total } };
}

/** Stays are [checkIn, checkOut): a guest leaving on the day another arrives is not a clash. */
export const overlaps = (a: { checkIn: string; checkOut: string }, b: { checkIn: string; checkOut: string }): boolean => a.checkIn < b.checkOut && b.checkIn < a.checkOut;

/** iCal (RFC 5545) of booked dates only: no guest names or other personal data, so the feed can be given to a portal. */
export function buildIcal(calendarName: string, bookings: readonly { id: string; checkIn: string; checkOut: string }[], nowIso: string): string {
  const stamp = nowIso.replace(/[-:]/g, "").replace(/\.\d+/, "");
  const day = (d: string) => d.replace(/-/g, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Listing syndication//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${calendarName.replace(/[\r\n,;\\]/g, " ").slice(0, 80)}`];
  for (const b of bookings) {
    lines.push("BEGIN:VEVENT", `UID:${b.id}@syndication.invalid`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(b.checkIn)}`, `DTEND;VALUE=DATE:${day(b.checkOut)}`, "SUMMARY:Booked", "TRANSP:OPAQUE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// ---- Calendar import (iCal from the portal) -----------------------------------------------------------------------------------------

/** Hosts a portal serves its calendar export from. Only these are fetched, so a pasted link can never point at an internal address. */
const CALENDAR_HOSTS: Record<Portal, RegExp> = {
  airbnb: /(^|\.)airbnb\.[a-z]{2,3}(\.[a-z]{2})?$/,
  vrbo: /(^|\.)(vrbo|homeaway|abritel|fewo-direkt)\.[a-z]{2,3}(\.[a-z]{2})?$/,
  booking_com: /(^|\.)booking\.com$/
};
export const IMPORT_EVERY_MINUTES = 60;
export const MAX_ICAL_BYTES = 1_000_000;
const MAX_ICAL_EVENTS = 2000;

export function validateCalendarUrl(portal: Portal, raw: unknown): Checked<string> {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 600) return { ok: false, error: "Paste the calendar link (iCal) from the portal." };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, error: "That is not a valid link." }; }
  if (u.protocol !== "https:") return { ok: false, error: "The link must start with https://." };
  if (u.username || u.password) return { ok: false, error: "That link has a password in it. Copy the calendar link again." };
  if (u.port && u.port !== "443") return { ok: false, error: "Use the standard https port." };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!CALENDAR_HOSTS[portal].test(host)) return { ok: false, error: `That does not look like a ${PORTAL_LABELS[portal]} calendar link.` };
  u.hash = "";
  return { ok: true, value: u.toString() };
}

export interface ImportedBlock { uid: string; checkIn: string; checkOut: string }

const addDay = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** Date part of an iCal value (20261105 or 20261105T140000Z), or null. */
const icalDay = (v: string): string | null => {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?$/.exec(v.trim());
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  return validDate(d) ? d : null;
};

/**
 * Blocked stays out of an iCal text. Cancelled events and events without a usable start are skipped; a missing end is a one night block;
 * a stay longer than a year is cut to a year. Guest names and notes in SUMMARY/DESCRIPTION are never read.
 * Returns null when the text is not a calendar at all (so an error page can never be mistaken for "no bookings").
 */
export function parseIcal(text: string): ImportedBlock[] | null {
  if (!/^BEGIN:VCALENDAR/m.test(text)) return null;
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out: ImportedBlock[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") {
      const ev = cur; cur = null;
      if (!ev || ev["STATUS"]?.toUpperCase() === "CANCELLED" || !ev["DTSTART"]) continue;
      const start = icalDay(ev["DTSTART"]);
      if (!start) continue;
      const endRaw = ev["DTEND"] ? icalDay(ev["DTEND"]) : null;
      let end = endRaw && endRaw > start ? endRaw : addDay(start);
      if (nights(start, end) > MAX_STAY_NIGHTS) end = new Date(Date.parse(`${start}T00:00:00Z`) + MAX_STAY_NIGHTS * 86_400_000).toISOString().slice(0, 10);
      const uid = (ev["UID"] ?? "").trim().slice(0, 150) || `${start}_${end}`;
      out.push({ uid, checkIn: start, checkOut: end });
      if (out.length >= MAX_ICAL_EVENTS) break;
      continue;
    }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 1) continue;
    const name = line.slice(0, i).split(";")[0]!.toUpperCase();
    if (name === "DTSTART" || name === "DTEND" || name === "UID" || name === "STATUS") cur[name] = line.slice(i + 1);
  }
  const seen = new Set<string>();
  return out.filter(b => (seen.has(b.uid) ? false : (seen.add(b.uid), true))).sort((a, b) => (a.checkIn < b.checkIn ? -1 : a.checkIn > b.checkIn ? 1 : 0));
}
