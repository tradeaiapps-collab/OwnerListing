import { blockMessage, scanContent } from "./content-filter";
import type { Failure, Result } from "./listing-service";
import { isValidTimeZone } from "./timezone";

/**
 * Emergency contractors. Tradies opt in to urgent call-outs, say which hours they accept them (in their own time zone) and what contact
 * details to show. Owners and tenants search them, or send one urgent request that Elena passes to the matching contractors who are
 * available now. Pure functions, no I/O. Payment is always direct to the contractor: nothing here takes or holds money.
 */
export const EMERGENCY_TRADES = ["plumber", "electrician", "locksmith", "glazier", "roofer", "gas_fitter", "air_conditioning", "pest_control", "builder", "tree_removal"] as const;
export type EmergencyTrade = (typeof EMERGENCY_TRADES)[number];
export const TRADE_LABELS: Record<EmergencyTrade, string> = {
  plumber: "Plumber", electrician: "Electrician", locksmith: "Locksmith", glazier: "Glazier", roofer: "Roofer", gas_fitter: "Gas fitter",
  air_conditioning: "Air conditioning", pest_control: "Pest control", builder: "Builder", tree_removal: "Tree removal"
};
export const isTrade = (v: unknown): v is EmergencyTrade => typeof v === "string" && (EMERGENCY_TRADES as readonly string[]).includes(v);

/** Limits that keep a bug or a bad actor from flooding contractors. */
export const EMERGENCY_LIMITS = { requestsPerHour: 2, requestsPerDay: 4, contractorsPerRequest: 5, contractorMessagesPerDay: 6, openWindowHours: 6 } as const;

export interface HoursWindow { days: number[]; start: string; end: string }
export interface EmergencyProfile {
  trade: EmergencyTrade;
  enabled: boolean;
  timeZone: string;
  allHours: boolean;
  windows: HoursWindow[];
  /** Optional call-out price in cents, shown as "from". */
  callOutCents: number | null;
  businessName: string | null;
  contactPhone: string;
  contactEmail: string | null;
  note: string | null;
  serviceSuburbs: string[];
  servicePostcodes: string[];
}
export interface EmergencyCandidate { userId: string; displayName: string; profile: EmergencyProfile; messagesToday: number }

const bad = (message: string): Failure => ({ ok: false, code: "invalid", message });
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const norm = (s: string) => s.trim().toLowerCase();
const POSTCODE = /^\d{4}$/;

/** Australian landline, mobile or 13/1300/1800 number, digits only after cleaning. Undefined if it does not look like one. */
export function cleanPhone(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const d = raw.replace(/[\s().-]/g, "");
  return /^(?:\+?61|0)[2-478]\d{8}$/.test(d) || /^1[38]00\d{6}$/.test(d) || /^13\d{4}$/.test(d) ? d.replace(/^\+?61/, "0") : undefined;
}
/** E.164 for a mobile number, so it can be texted. Undefined for landlines and 13/1300 numbers. */
export const mobileE164 = (phone: string): string | undefined => (/^04\d{8}$/.test(phone) ? `+61${phone.slice(1)}` : undefined);

/** Validates a contractor's emergency settings. The contractor's own words are scanned like any public profile text. */
export function parseEmergencyProfile(input: unknown): Result<EmergencyProfile> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  if (!isTrade(o["trade"])) return bad("Choose a trade from the list.");
  if (typeof o["enabled"] !== "boolean") return bad("Say whether you take emergency jobs.");
  const timeZone = o["timeZone"];
  if (typeof timeZone !== "string" || !isValidTimeZone(timeZone)) return bad("Choose a valid time zone, for example Australia/Brisbane.");
  const allHours = o["allHours"] === true;
  const rawWindows = o["windows"] ?? [];
  if (!Array.isArray(rawWindows) || rawWindows.length > 14) return bad("Add up to 14 time windows.");
  const windows: HoursWindow[] = [];
  for (const w of rawWindows) {
    const x = (typeof w === "object" && w !== null ? w : {}) as Record<string, unknown>;
    const days = x["days"];
    if (!Array.isArray(days) || days.length === 0 || !days.every(d => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) return bad("Each time window needs at least one day.");
    if (typeof x["start"] !== "string" || typeof x["end"] !== "string" || !TIME.test(x["start"]) || !TIME.test(x["end"])) return bad("Times look like 18:00.");
    if (x["start"] === x["end"]) return bad("A time window cannot start and end at the same time. Choose all hours instead.");
    windows.push({ days: [...new Set(days as number[])].sort((a, b) => a - b), start: x["start"], end: x["end"] });
  }
  const enabled = o["enabled"];
  if (enabled && !allHours && windows.length === 0) return bad("Choose the hours you accept emergency jobs, or all hours.");
  let callOutCents: number | null = null;
  if (o["callOutCents"] !== undefined && o["callOutCents"] !== null && o["callOutCents"] !== "") {
    const c = o["callOutCents"];
    if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c > 1_000_000) return bad("The call-out price must be between $0 and $10,000.");
    callOutCents = c;
  }
  const phone = cleanPhone(o["contactPhone"]);
  if (!phone) return bad("Enter an Australian phone number people can call.");
  const text = (v: unknown, max: number, label: string): string | null | Failure => {
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
    if (typeof v !== "string" || v.trim().length > max) return bad(`${label} must be ${max} characters or fewer.`);
    return v.trim();
  };
  const businessName = text(o["businessName"], 80, "Business name"); if (typeof businessName === "object" && businessName) return businessName;
  const note = text(o["note"], 300, "Note"); if (typeof note === "object" && note) return note;
  const email = text(o["contactEmail"], 254, "Email"); if (typeof email === "object" && email) return email;
  if (typeof email === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad("Enter a valid contact email or leave it empty.");
  for (const [label, v] of [["Business name", businessName], ["Note", note]] as const) {
    if (typeof v !== "string") continue;
    const scan = scanContent(v);
    if (scan.action === "block") return { ok: false, code: "invalid", message: `${label}: ${blockMessage(scan, "profile")}` };
  }
  const list = (v: unknown) => (Array.isArray(v) && v.every(x => typeof x === "string") ? (v as string[]).map(s => s.trim()).filter(Boolean) : undefined);
  const suburbs = list(o["serviceSuburbs"] ?? []), postcodes = list(o["servicePostcodes"] ?? []);
  if (!suburbs || !postcodes || suburbs.length > 200 || postcodes.length > 200) return bad("Areas must be lists of up to 200 postcodes and suburbs.");
  if (!postcodes.every(p => POSTCODE.test(p)) || !suburbs.every(s => s.length <= 80)) return bad("Postcodes are four digits; suburb names are under 80 characters.");
  if (enabled && suburbs.length === 0 && postcodes.length === 0) return bad("Add at least one suburb or postcode you cover.");
  return {
    ok: true,
    value: { trade: o["trade"], enabled, timeZone, allHours, windows, callOutCents, businessName: businessName as string | null, contactPhone: phone, contactEmail: email as string | null, note: note as string | null, serviceSuburbs: [...new Set(suburbs)], servicePostcodes: [...new Set(postcodes)] }
  };
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** Weekday (0 = Sunday) and minutes since midnight at an instant, in a time zone. */
export function localClock(nowIso: string, timeZone: string): { day: number; minutes: number } | undefined {
  const t = Date.parse(nowIso);
  if (Number.isNaN(t) || !isValidTimeZone(timeZone)) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  const day = WEEKDAY[get("weekday")];
  if (day === undefined) return undefined;
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** True when the contractor takes emergency jobs at this instant. Fails closed on a bad time or zone. A window that runs past midnight belongs to the day it starts on. */
export function isAvailableNow(p: Pick<EmergencyProfile, "enabled" | "allHours" | "windows" | "timeZone">, nowIso: string): boolean {
  if (!p.enabled) return false;
  if (p.allHours) return true;
  const c = localClock(nowIso, p.timeZone);
  if (!c) return false;
  const prev = (c.day + 6) % 7;
  return p.windows.some(w => {
    const s = toMinutes(w.start), e = toMinutes(w.end);
    if (s < e) return w.days.includes(c.day) && c.minutes >= s && c.minutes < e;
    return (w.days.includes(c.day) && c.minutes >= s) || (w.days.includes(prev) && c.minutes < e);
  });
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Mon, Tue 18:00 to 06:00" for display. */
export function describeHours(p: Pick<EmergencyProfile, "allHours" | "windows" | "timeZone">): string {
  if (p.allHours) return "All hours, every day";
  if (p.windows.length === 0) return "No hours set";
  return p.windows.map(w => `${w.days.map(d => DAY_NAMES[d]).join(", ")} ${w.start} to ${w.end}`).join("; ");
}

export interface Area { suburb?: string | undefined; postcode?: string | undefined }
/** 3 = suburb and postcode, 2 = suburb, 1 = postcode, 0 = no match. */
export function areaScore(p: Pick<EmergencyProfile, "serviceSuburbs" | "servicePostcodes">, a: Area): number {
  const s = a.suburb ? norm(a.suburb) : "", pc = a.postcode?.trim() ?? "";
  const bySuburb = s !== "" && p.serviceSuburbs.map(norm).includes(s);
  const byPostcode = pc !== "" && p.servicePostcodes.includes(pc);
  return (bySuburb ? 2 : 0) + (byPostcode ? 1 : 0);
}

export interface SearchQuery extends Area { trade?: EmergencyTrade | undefined }
export interface SearchResult { userId: string; displayName: string; profile: EmergencyProfile; availableNow: boolean; areaScore: number }

/** Enabled contractors for a trade and area. Available now first, then the better area match, then the lower call-out price, then id (so the order is repeatable). */
export function searchEmergency(candidates: readonly EmergencyCandidate[], q: SearchQuery, nowIso: string): SearchResult[] {
  const wantsArea = Boolean(q.suburb?.trim() || q.postcode?.trim());
  const out: SearchResult[] = [];
  for (const c of candidates) {
    if (!c.profile.enabled || (q.trade && c.profile.trade !== q.trade)) continue;
    const score = areaScore(c.profile, q);
    if (wantsArea && score === 0) continue;
    out.push({ userId: c.userId, displayName: c.displayName, profile: c.profile, availableNow: isAvailableNow(c.profile, nowIso), areaScore: score });
  }
  return out.sort((a, b) =>
    Number(b.availableNow) - Number(a.availableNow) || b.areaScore - a.areaScore ||
    (a.profile.callOutCents ?? Infinity) - (b.profile.callOutCents ?? Infinity) || a.userId.localeCompare(b.userId));
}

/** Who gets an urgent request: matching, available now, not the requester, and under the daily message cap. Never more than the per-request limit. */
export function pickRecipients(req: { trade: EmergencyTrade } & Area, candidates: readonly EmergencyCandidate[], nowIso: string, requesterId: string): SearchResult[] {
  const eligible = candidates.filter(c => c.userId !== requesterId && c.messagesToday < EMERGENCY_LIMITS.contractorMessagesPerDay);
  return searchEmergency(eligible, { trade: req.trade, suburb: req.suburb, postcode: req.postcode }, nowIso)
    .filter(r => r.availableNow && r.areaScore > 0).slice(0, EMERGENCY_LIMITS.contractorsPerRequest);
}

/** Per-requester limit on urgent requests. `createdAts` are the requester's earlier requests (ISO strings). */
export function requestRateOk(createdAts: readonly string[], nowIso: string): Result<true> {
  const now = Date.parse(nowIso);
  const within = (ms: number) => createdAts.filter(c => now - Date.parse(c) < ms).length;
  if (within(3_600_000) >= EMERGENCY_LIMITS.requestsPerHour || within(86_400_000) >= EMERGENCY_LIMITS.requestsPerDay) {
    return { ok: false, code: "rate_limited", message: "You have sent several urgent requests already. For immediate danger call 000, otherwise use the emergency directory to call a contractor yourself." };
  }
  return { ok: true, value: true };
}

export interface EmergencyRequestInput {
  trade: EmergencyTrade;
  description: string;
  listingId: string | null;
  propertyKind: "sale" | "rental" | "other";
  addressText: string;
  suburb: string | null;
  postcode: string | null;
  callbackPhone: string | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates an urgent request body. The text goes to tradespeople, so contact details, links and abuse are refused: replies come through the platform. */
export function parseEmergencyRequest(input: unknown): Result<EmergencyRequestInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  if (!isTrade(o["trade"])) return bad("Choose the kind of tradesperson you need.");
  const description = typeof o["description"] === "string" ? o["description"].trim() : "";
  if (description.length < 10 || description.length > 1000) return bad("Describe the problem in 10 to 1,000 characters.");
  const scan = scanContent(description);
  if (scan.action === "block") return { ok: false, code: "invalid", message: `${blockMessage(scan, "message")} Put your phone number in the callback field instead.` };
  const listingId = o["listingId"] === undefined || o["listingId"] === null || o["listingId"] === "" ? null : o["listingId"];
  if (listingId !== null && (typeof listingId !== "string" || !UUID.test(listingId))) return bad("That property was not recognised.");
  const kind = o["propertyKind"] ?? "other";
  if (kind !== "sale" && kind !== "rental" && kind !== "other") return bad("Choose sale, rental or other.");
  const addressText = typeof o["addressText"] === "string" ? o["addressText"].trim() : "";
  const suburb = typeof o["suburb"] === "string" && o["suburb"].trim() ? o["suburb"].trim() : null;
  const postcode = typeof o["postcode"] === "string" && o["postcode"].trim() ? o["postcode"].trim() : null;
  if (suburb !== null && suburb.length > 80) return bad("The suburb is too long.");
  if (postcode !== null && !POSTCODE.test(postcode)) return bad("Postcodes are four digits.");
  if (listingId === null) {
    if (addressText.length < 3 || addressText.length > 200) return bad("Enter the street address of the property.");
    if (suburb === null && postcode === null) return bad("Enter the suburb or postcode so we can find contractors nearby.");
  }
  let callbackPhone: string | null = null;
  if (o["callbackPhone"] !== undefined && o["callbackPhone"] !== null && o["callbackPhone"] !== "") {
    const p = cleanPhone(o["callbackPhone"]);
    if (!p) return bad("Enter an Australian phone number, or leave the callback empty.");
    callbackPhone = p;
  }
  return { ok: true, value: { trade: o["trade"], description, listingId: listingId as string | null, propertyKind: kind, addressText, suburb, postcode, callbackPhone } };
}

export const kindLabel = (k: EmergencyRequestInput["propertyKind"]) => (k === "rental" ? "a rental property" : k === "sale" ? "a property for sale" : "a property");

export interface RequestFacts { number: number; trade: EmergencyTrade; description: string; suburb: string | null; postcode: string | null; propertyKind: EmergencyRequestInput["propertyKind"]; requesterFirstName: string; brand: string }
export interface OutboundMessage { subject: string; text: string; sms: string }

/**
 * Elena's first message to a contractor. A fixed template: it states only what the request holds. The street address and the callback number are
 * not in it (they go to the one contractor who accepts), and the owner's own words are quoted and labelled as theirs, never rewritten.
 */
export function composeContractorMessage(f: RequestFacts, link: string): OutboundMessage {
  const place = [f.suburb, f.postcode].filter(Boolean).join(" ") || "the area you cover";
  const subject = `Urgent ${TRADE_LABELS[f.trade].toLowerCase()} request EMG-${f.number} in ${place}`;
  const text = [
    `Hello, this is Elena, the assistant at ${f.brand}, writing for ${f.requesterFirstName}.`,
    `${f.requesterFirstName} needs a ${TRADE_LABELS[f.trade].toLowerCase()} urgently at ${kindLabel(f.propertyKind)} in ${place}. You are listed as available for emergency jobs right now.`,
    `${f.requesterFirstName} wrote: "${f.description.replace(/\s+/g, " ").slice(0, 600)}"`,
    `To take the job or pass on it, open: ${link}`,
    `The street address and a callback number are shown once you accept. Payment is made directly to you by the customer; ${f.brand} does not handle it. If anyone is in danger, call 000.`
  ].join("\n\n");
  const sms = `${f.brand}: urgent ${TRADE_LABELS[f.trade].toLowerCase()} job EMG-${f.number} in ${place}. Reply in the app: ${link}`;
  return { subject, text, sms };
}

export type ReplyKind = "accept" | "decline";
/** A contractor's reply: accept or decline, an optional arrival estimate and a short note, scanned like any message between people. */
export function parseReply(input: unknown): Result<{ kind: ReplyKind; etaMinutes: number | null; note: string | null }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  if (o["kind"] !== "accept" && o["kind"] !== "decline") return bad("Choose accept or decline.");
  let etaMinutes: number | null = null;
  if (o["etaMinutes"] !== undefined && o["etaMinutes"] !== null && o["etaMinutes"] !== "") {
    const e = o["etaMinutes"];
    if (typeof e !== "number" || !Number.isInteger(e) || e < 1 || e > 1440) return bad("The arrival estimate must be 1 to 1,440 minutes.");
    etaMinutes = e;
  }
  const note = typeof o["note"] === "string" && o["note"].trim() ? o["note"].trim() : null;
  if (note !== null) {
    if (note.length > 300) return bad("The note must be 300 characters or fewer.");
    const scan = scanContent(note);
    if (scan.action === "block") return { ok: false, code: "invalid", message: blockMessage(scan, "message") };
  }
  return { ok: true, value: { kind: o["kind"], etaMinutes, note } };
}

export const requestNumber = (n: number) => `EMG-${n}`;
