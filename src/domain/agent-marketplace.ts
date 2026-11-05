import type { Result } from "./listing-service";

// Agent marketplace rules: public profile fields, weekly availability, bookable slots, reviews and browse filters. Pure functions; SQL lives in
// src/server/agent-marketplace-db.ts. Nothing here reads a user's private data.

export const CONSULT_MODES = ["video", "phone"] as const;
export type ConsultMode = (typeof CONSULT_MODES)[number];
export const CONSULT_MINUTES = [15, 30, 45, 60] as const;
export const SPECIALTIES = ["first home buyers", "investors", "luxury", "downsizers", "new builds", "rural", "apartments", "commercial", "rentals", "auctions", "negotiation", "development sites"] as const;
export const TIMEZONES = ["Australia/Brisbane", "Australia/Sydney", "Australia/Melbourne", "Australia/Hobart", "Australia/Adelaide", "Australia/Darwin", "Australia/Perth"] as const;
export const SLOT_DAYS = 14;
export const MIN_LEAD_HOURS = 2;
export const MAX_PORTFOLIO_ITEMS = 30;
export const PAGE_SIZE = 12;

export interface Window { weekday: number; startMin: number; endMin: number }
export interface MarketplaceProfile {
  listed: boolean; headline: string; photoUrl: string | null; specialties: string[]; languages: string[]; yearsExperience: number | null;
  consultModes: ConsultMode[]; consultMinutes: number; videoUrl: string | null; timezone: string; availability: Window[];
}
export interface Slot { startsAt: string; endsAt: string }

const bad = (message: string): Result<never> => ({ ok: false, code: "invalid", message });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
const strList = (v: unknown, max: number, itemMax: number): string[] | null => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  const out = [...new Set(v.map(x => clean(x, itemMax).toLowerCase()).filter(Boolean))];
  return out;
};
/** Photo and video links must be https; anything else (javascript:, data:, http:) is refused. */
export function httpsUrl(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 500) return undefined;
  try { const u = new URL(v.trim()); return u.protocol === "https:" && !u.username && !u.password ? u.toString() : undefined; } catch { return undefined; }
}

export function parseMarketplaceProfile(input: unknown): Result<MarketplaceProfile> {
  if (!isObj(input)) return bad("Send the profile as an object.");
  const specialties = strList(input["specialties"], 12, 40), languages = strList(input["languages"], 8, 30);
  if (!specialties || !languages) return bad("Too many specialties or languages.");
  const photoUrl = httpsUrl(input["photoUrl"]), videoUrl = httpsUrl(input["videoUrl"]);
  if (photoUrl === undefined) return bad("The photo link must be an https address.");
  if (videoUrl === undefined) return bad("The video meeting link must be an https address.");
  const modes = Array.isArray(input["consultModes"]) ? input["consultModes"] : [];
  if (!modes.every(m => (CONSULT_MODES as readonly unknown[]).includes(m))) return bad("Consultation types are video or phone.");
  const minutes = input["consultMinutes"] === undefined ? 30 : Number(input["consultMinutes"]);
  if (!(CONSULT_MINUTES as readonly number[]).includes(minutes)) return bad("A consultation is 15, 30, 45 or 60 minutes.");
  const years = input["yearsExperience"];
  if (years !== undefined && years !== null && (!Number.isInteger(years) || (years as number) < 0 || (years as number) > 60)) return bad("Years of experience must be 0 to 60.");
  const timezone = input["timezone"] === undefined ? TIMEZONES[0] : String(input["timezone"]);
  if (!(TIMEZONES as readonly string[]).includes(timezone)) return bad("Choose an Australian timezone.");
  const av = parseAvailability(input["availability"], minutes);
  if (!av.ok) return av;
  const consultModes = [...new Set(modes as ConsultMode[])];
  if (consultModes.includes("video") && !videoUrl) return bad("Add your video meeting link to offer video consultations.");
  return { ok: true, value: {
    listed: input["listed"] === true, headline: clean(input["headline"], 120), photoUrl, specialties, languages,
    yearsExperience: typeof years === "number" ? years : null, consultModes, consultMinutes: minutes, videoUrl, timezone, availability: av.value
  } };
}

export function parseAvailability(input: unknown, minutes: number): Result<Window[]> {
  if (input === undefined) return { ok: true, value: [] };
  if (!Array.isArray(input) || input.length > 42) return bad("Availability is a list of weekly time windows.");
  const out: Window[] = [];
  for (const w of input) {
    if (!isObj(w)) return bad("Each availability window needs weekday, startMin and endMin.");
    const { weekday, startMin, endMin } = w as Record<string, unknown>;
    if (!Number.isInteger(weekday) || (weekday as number) < 0 || (weekday as number) > 6) return bad("Weekday must be 0 (Sunday) to 6 (Saturday).");
    if (!Number.isInteger(startMin) || !Number.isInteger(endMin) || (startMin as number) < 0 || (endMin as number) > 1440 || (endMin as number) <= (startMin as number)) return bad("Each window must end after it starts, within one day.");
    if ((endMin as number) - (startMin as number) < minutes) return bad("Each window must fit at least one consultation.");
    out.push({ weekday: weekday as number, startMin: startMin as number, endMin: endMin as number });
  }
  const sorted = [...out].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.weekday === sorted[i - 1]!.weekday && sorted[i]!.startMin < sorted[i - 1]!.endMin) return bad("Availability windows on the same day must not overlap.");
  return { ok: true, value: sorted };
}

// ---- Slots ---------------------------------------------------------------------------------------------------------------------

/** Offset (ms) of a timezone from UTC at a given instant. */
function offsetMs(tz: string, at: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(at)).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p["year"]!, p["month"]! - 1, p["day"]!, p["hour"]!, p["minute"]!, p["second"]!) - Math.floor(at / 1000) * 1000;
}
/** The UTC instant for a wall-clock date and minute-of-day in a timezone. */
export function zonedToUtc(tz: string, y: number, m: number, d: number, minuteOfDay: number): number {
  const guess = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  const first = guess - offsetMs(tz, guess);
  return guess - offsetMs(tz, first);
}
const localDate = (tz: string, at: number): { y: number; m: number; d: number } => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(at)).map(x => [x.type, Number(x.value)]));
  return { y: p["year"]!, m: p["month"]!, d: p["day"]! };
};

/** Free consultation slots over the next SLOT_DAYS days: inside the weekly windows, after the lead time, not overlapping a live booking. */
export function generateSlots(availability: readonly Window[], timezone: string, minutes: number, busy: readonly Slot[], nowIso: string, days: number = SLOT_DAYS): Slot[] {
  const now = Date.parse(nowIso), earliest = now + MIN_LEAD_HOURS * 3600_000, len = minutes * 60_000;
  const busyRanges = busy.map(b => [Date.parse(b.startsAt), Date.parse(b.endsAt)] as const);
  const today = localDate(timezone, now);
  const out: Slot[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()] as const;
    for (const w of availability.filter(a => a.weekday === day.getUTCDay())) {
      for (let s = w.startMin; s + minutes <= w.endMin; s += minutes) {
        const start = zonedToUtc(timezone, y, m, d, s), end = start + len;
        if (start < earliest || busyRanges.some(([bs, be]) => start < be && end > bs)) continue;
        out.push({ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
      }
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export interface BookingInput { startsAt: string; mode: ConsultMode; phone: string | null; note: string }
export function parseBooking(input: unknown): Result<BookingInput> {
  if (!isObj(input)) return bad("Send the booking as an object.");
  const startsAt = typeof input["startsAt"] === "string" && !Number.isNaN(Date.parse(input["startsAt"])) ? new Date(input["startsAt"]).toISOString() : null;
  if (!startsAt) return bad("Choose a time slot.");
  if (!(CONSULT_MODES as readonly unknown[]).includes(input["mode"])) return bad("Choose video or phone.");
  const phone = clean(input["phone"], 30);
  if (phone && !/^[+\d][\d\s()-]{5,}$/.test(phone)) return bad("Enter a valid phone number.");
  if (input["mode"] === "phone" && !phone) return bad("Add a phone number so the agent can call you.");
  return { ok: true, value: { startsAt, mode: input["mode"] as ConsultMode, phone: phone || null, note: clean(input["note"], 500) } };
}

// ---- Reviews, portfolio and browse ----------------------------------------------------------------------------------------------

export interface ReviewInput { rating: number; title: string; body: string }
export function parseReview(input: unknown): Result<ReviewInput> {
  if (!isObj(input)) return bad("Send the review as an object.");
  const rating = input["rating"];
  if (!Number.isInteger(rating) || (rating as number) < 1 || (rating as number) > 5) return bad("Rate the agent from 1 to 5 stars.");
  const body = clean(input["body"], 1500);
  if ((rating as number) <= 2 && body.length < 10) return bad("Please say briefly what went wrong.");
  return { ok: true, value: { rating: rating as number, title: clean(input["title"], 80), body } };
}

export interface PortfolioInput { suburb: string; propertyType: string; soldOn: string; priceCents: number | null; note: string }
export function parsePortfolioItem(input: unknown, todayIso: string): Result<PortfolioInput> {
  if (!isObj(input)) return bad("Send the sale as an object.");
  const suburb = clean(input["suburb"], 80);
  if (!suburb) return bad("Add the suburb.");
  const soldOn = input["soldOn"];
  if (typeof soldOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(soldOn) || Number.isNaN(Date.parse(soldOn))) return bad("Sold date must be YYYY-MM-DD.");
  if (soldOn > todayIso.slice(0, 10)) return bad("A sale cannot be dated in the future.");
  const price = input["priceCents"];
  if (price !== undefined && price !== null && (!Number.isInteger(price) || (price as number) <= 0)) return bad("Price must be a positive whole number of cents.");
  return { ok: true, value: { suburb, propertyType: clean(input["propertyType"], 30).toLowerCase() || "house", soldOn, priceCents: typeof price === "number" ? price : null, note: clean(input["note"], 200) } };
}

export function ratingSummary(ratings: readonly number[]): { count: number; average: number | null; distribution: Record<1 | 2 | 3 | 4 | 5, number> } {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of ratings) if (r >= 1 && r <= 5) distribution[r as 1 | 2 | 3 | 4 | 5]++;
  const count = ratings.length;
  return { count, average: count ? Math.round((ratings.reduce((a, b) => a + b, 0) / count) * 10) / 10 : null, distribution };
}
/** "Alex Morgan" -> "Alex M."; reviewers are never shown in full. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return parts.length === 0 ? "A buyer" : parts.length === 1 ? parts[0]! : `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

export interface BrowseQuery { q: string; area: string; specialty: string; language: string; mode: ConsultMode | ""; minRating: number; sort: "rating" | "reviews" | "experience" | "name"; page: number }
export function parseBrowse(sp: URLSearchParams): BrowseQuery {
  const sort = sp.get("sort");
  const mode = sp.get("mode");
  const minRating = Number(sp.get("minRating") ?? 0);
  const page = Math.floor(Number(sp.get("page") ?? 1));
  return {
    q: clean(sp.get("q"), 60), area: clean(sp.get("area"), 60), specialty: clean(sp.get("specialty"), 40).toLowerCase(), language: clean(sp.get("language"), 30).toLowerCase(),
    mode: mode === "video" || mode === "phone" ? mode : "", minRating: [3, 4, 4.5].includes(minRating) ? minRating : 0,
    sort: sort === "reviews" || sort === "experience" || sort === "name" ? sort : "rating", page: Number.isFinite(page) && page >= 1 && page <= 500 ? page : 1
  };
}
