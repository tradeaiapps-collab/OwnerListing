import { zonedToUtc } from "./agent-marketplace";
import type { Result } from "./listing-service";

// Open inspection scheduling rules: weekly and one-off windows an agent publishes, the bookable slots they produce, buyer booking input and
// agent actions. Pure functions; SQL lives in src/server/open-inspection-db.ts. Wall-clock times are in the listing state's time zone.

export const SLOT_MINUTES = [15, 20, 30, 45, 60] as const;
export const MAX_CAPACITY = 10;
export const SLOT_DAYS = 28;
export const MIN_LEAD_MINUTES = 60;
export const MAX_RULES = 40;
export const MAX_LIVE_BOOKINGS_PER_BUYER = 10;
export const AGENT_ACTIONS = ["cancel", "complete", "no_show", "remind"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];
export const BOOKING_STATUSES = ["booked", "rescheduled", "cancelled", "completed", "no_show"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export interface RuleInput {
  recurrence: "once" | "weekly"; dayOfWeek: number | null; onDate: string | null; startMin: number; endMin: number;
  slotMinutes: number; capacity: number; endDate: string | null;
}
export interface Rule extends RuleInput { id: string }
export interface Block { startsAt: string; endsAt: string }
export interface Slot { startsAt: string; endsAt: string; spotsLeft: number }
export interface BookingInput { startsAt: string; name: string; phone: string; email: string; notes: string }

const bad = (message: string): Result<never> => ({ ok: false, code: "invalid", message });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: unknown): v is string => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
/** "HH:MM" or a whole number of minutes since midnight. */
function minutesOf(v: unknown): number | null {
  if (Number.isInteger(v)) return v as number;
  const m = typeof v === "string" ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export const clock = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** One availability rule: `{ recurrence: "weekly", dayOfWeek: 6, start: "10:00", end: "14:00", slotMinutes: 30 }` or `{ recurrence: "once", date: "2026-12-10", ... }`. */
export function parseRule(input: unknown, todayIso: string): Result<RuleInput> {
  if (!isObj(input)) return bad("Send the open time as an object.");
  const recurrence = input["recurrence"];
  if (recurrence !== "once" && recurrence !== "weekly") return bad("Choose a specific date or a weekly time.");
  const startMin = minutesOf(input["start"] ?? input["startMin"]), endMin = minutesOf(input["end"] ?? input["endMin"]);
  if (startMin === null || endMin === null || startMin < 0 || endMin > 1440 || endMin <= startMin) return bad("The end time must be after the start time, on the same day.");
  const slotMinutes = Number(input["slotMinutes"] ?? 30);
  if (!(SLOT_MINUTES as readonly number[]).includes(slotMinutes)) return bad(`Slots can be ${SLOT_MINUTES.join(", ")} minutes long.`);
  if (endMin - startMin < slotMinutes) return bad("The window must fit at least one slot.");
  const capacity = input["capacity"] === undefined ? 1 : Number(input["capacity"]);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) return bad(`Each slot takes between 1 and ${MAX_CAPACITY} bookings.`);
  const today = todayIso.slice(0, 10);
  if (recurrence === "once") {
    const date = input["date"] ?? input["onDate"];
    if (!validDate(date)) return bad("Choose a date.");
    if (date < today) return bad("That date has already passed.");
    return { ok: true, value: { recurrence, dayOfWeek: null, onDate: date, startMin, endMin, slotMinutes, capacity, endDate: null } };
  }
  const dow = input["dayOfWeek"];
  if (!Number.isInteger(dow) || (dow as number) < 0 || (dow as number) > 6) return bad("Choose a day of the week.");
  const endDate = input["endDate"] === undefined || input["endDate"] === null || input["endDate"] === "" ? null : input["endDate"];
  if (endDate !== null && (!validDate(endDate) || endDate < today)) return bad("The end date must be today or later.");
  return { ok: true, value: { recurrence, dayOfWeek: dow as number, onDate: null, startMin, endMin, slotMinutes, capacity, endDate: endDate as string | null } };
}

/** Two rules for the same day that overlap would double the slots, so they are refused. */
export function overlaps(a: RuleInput, b: RuleInput): boolean {
  const sameDay = a.recurrence === b.recurrence && (a.recurrence === "weekly" ? a.dayOfWeek === b.dayOfWeek : a.onDate === b.onDate);
  return sameDay && a.startMin < b.endMin && b.startMin < a.endMin;
}

/** A time to take off the calendar: `{ startsAt, endsAt, note? }`, or `{ date, start: "HH:MM", end: "HH:MM", note? }` in the property's time zone. */
export function parseBlock(input: unknown, nowIso: string, timeZone = "Australia/Sydney"): Result<{ startsAt: string; endsAt: string; note: string }> {
  if (!isObj(input)) return bad("Send the blocked time as an object.");
  let s = typeof input["startsAt"] === "string" ? Date.parse(input["startsAt"]) : NaN, e = typeof input["endsAt"] === "string" ? Date.parse(input["endsAt"]) : NaN;
  if (input["date"] !== undefined) {
    const a = minutesOf(input["start"]), b = minutesOf(input["end"]);
    if (!validDate(input["date"]) || a === null || b === null || b <= a || b > 1440) return bad("Choose a date, with an end time after the start time.");
    const [y, m, d] = input["date"].split("-").map(Number) as [number, number, number];
    s = zonedToUtc(timeZone, y, m, d, a); e = zonedToUtc(timeZone, y, m, d, b);
  }
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return bad("The blocked time must end after it starts.");
  if (e <= Date.parse(nowIso)) return bad("That time has already passed.");
  if (e - s > 31 * 86_400_000) return bad("Block at most 31 days at a time.");
  return { ok: true, value: { startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), note: clean(input["note"], 200) } };
}

const localDate = (tz: string, at: number): { y: number; m: number; d: number } => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(at)).map(x => [x.type, Number(x.value)]));
  return { y: p["year"]!, m: p["month"]!, d: p["day"]! };
};
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Bookable slots over the next SLOT_DAYS days: inside a rule's window, at least MIN_LEAD_MINUTES away, not inside a block, and with spots left.
 * `taken` is the live booking count per slot start. A slot offered by two rules (should not happen; overlaps are refused) keeps the larger capacity.
 */
export function generateOpenSlots(rules: readonly Rule[], blocks: readonly Block[], taken: ReadonlyMap<string, number>, timezone: string, nowIso: string, days: number = SLOT_DAYS): Slot[] {
  const now = Date.parse(nowIso), earliest = now + MIN_LEAD_MINUTES * 60_000;
  const blockRanges = blocks.map(b => [Date.parse(b.startsAt), Date.parse(b.endsAt)] as const);
  const today = localDate(timezone, now);
  const out = new Map<string, Slot>();
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()] as const;
    const iso = `${y}-${pad(m)}-${pad(d)}`;
    for (const r of rules) {
      const applies = r.recurrence === "once" ? r.onDate === iso : r.dayOfWeek === day.getUTCDay() && (r.endDate === null || iso <= r.endDate);
      if (!applies) continue;
      for (let s = r.startMin; s + r.slotMinutes <= r.endMin; s += r.slotMinutes) {
        const start = zonedToUtc(timezone, y, m, d, s), end = start + r.slotMinutes * 60_000;
        if (start < earliest || blockRanges.some(([bs, be]) => start < be && end > bs)) continue;
        const key = new Date(start).toISOString();
        const left = r.capacity - (taken.get(key) ?? 0);
        if (left <= 0) continue;
        const prior = out.get(key);
        if (!prior || prior.spotsLeft < left) out.set(key, { startsAt: key, endsAt: new Date(end).toISOString(), spotsLeft: left });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** The buyer's booking: a slot start plus contact details (the account's own details are the default on the page). */
export function parseBookingInput(input: unknown): Result<BookingInput> {
  if (!isObj(input)) return bad("Send the booking as an object.");
  const t = typeof input["startsAt"] === "string" ? Date.parse(input["startsAt"]) : NaN;
  if (Number.isNaN(t)) return bad("Choose a time slot.");
  const name = clean(input["name"], 120);
  if (!name) return bad("Enter your name.");
  const phone = clean(input["phone"], 30);
  if (phone && !/^[+\d][\d\s()-]{5,}$/.test(phone)) return bad("Enter a valid phone number.");
  const email = clean(input["email"], 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad("Enter a valid email address.");
  if (!phone && !email) return bad("Add a phone number or an email address so the agent can reach you.");
  return { ok: true, value: { startsAt: new Date(t).toISOString(), name, phone, email, notes: clean(input["notes"], 500) } };
}

/** Agent bulk action: `{ ids: [...up to 50], action }`. */
export function parseAgentAction(input: unknown): Result<{ ids: string[]; action: AgentAction }> {
  if (!isObj(input)) return bad("Send the action as an object.");
  const action = input["action"];
  if (!(AGENT_ACTIONS as readonly unknown[]).includes(action)) return bad("Choose cancel, complete, no_show or remind.");
  const ids = input["ids"];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || !ids.every(x => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x))) return bad("Choose between 1 and 50 bookings.");
  return { ok: true, value: { ids: [...new Set(ids as string[])], action: action as AgentAction } };
}

/** Statuses each agent action may start from. Only a booked slot can be cancelled or reminded; completing or marking a no-show needs the time to have started. */
export const ACTION_FROM: Record<AgentAction, readonly BookingStatus[]> = { cancel: ["booked"], complete: ["booked"], no_show: ["booked"], remind: ["booked"] };
export const ACTION_TO: Partial<Record<AgentAction, BookingStatus>> = { cancel: "cancelled", complete: "completed", no_show: "no_show" };

/** "Saturday 10 Dec, 10:30 am" in the property's time zone. */
export function whenText(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "long", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}
