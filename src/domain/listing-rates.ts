import { formatAud } from "./listing-details";

/**
 * Council and water rates a seller states for a sale listing, so buyers see the running cost. The owner types what is on their latest
 * rates notices; it is information from the seller, not a figure the platform checks. Money is whole AUD cents. Each charge is entered
 * for the period printed on the notice (quarter or year) and shown with its yearly equivalent. Water usage is billed separately by most
 * water authorities, so it is a yes/no flag, not an amount.
 */

export const RATE_PERIODS = ["quarter", "year"] as const;
export type RatePeriod = (typeof RATE_PERIODS)[number];
/** $1,000,000 for one period. A larger number is a typo. */
export const MAX_RATE_CENTS = 100_000_000;
const PERIODS_PER_YEAR: Record<RatePeriod, number> = { quarter: 4, year: 1 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Charge { cents: number; period: RatePeriod }
export interface ListingRates {
  council?: Charge;
  water?: Charge;
  /** Water use is charged on top of the water rate (true), or is included / not applicable (false). Absent = not stated. */
  waterUsageBilledSeparately?: boolean;
  /** Date of the notice the figures come from, YYYY-MM-DD. Required when a charge is given. */
  asAt?: string;
}

export const annualCents = (c: Charge): number => c.cents * PERIODS_PER_YEAR[c.period];

const isPeriod = (v: unknown): v is RatePeriod => typeof v === "string" && (RATE_PERIODS as readonly string[]).includes(v);

function parseCharge(v: unknown, name: string): { ok: true; value: Charge | undefined } | { ok: false; message: string } {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false, message: `${name} must be an amount and a period.` };
  const o = v as Record<string, unknown>;
  if (typeof o["cents"] !== "number" || !Number.isInteger(o["cents"]) || o["cents"] < 1 || o["cents"] > MAX_RATE_CENTS) {
    return { ok: false, message: `${name} must be between $0.01 and $1,000,000.` };
  }
  if (!isPeriod(o["period"])) return { ok: false, message: `${name} period must be "quarter" or "year".` };
  return { ok: true, value: { cents: o["cents"], period: o["period"] } };
}

const validDate = (s: string): boolean => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Validates a full replacement. `today` is YYYY-MM-DD. The notice date cannot be in the future or more than 3 years old. */
export function parseRates(body: unknown, today: string): { ok: true; value: ListingRates } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "Send the rates as an object." };
  const b = body as Record<string, unknown>;
  const council = parseCharge(b["council"], "Council rates");
  if (!council.ok) return council;
  const water = parseCharge(b["water"], "Water rates");
  if (!water.ok) return water;
  const usage = b["waterUsageBilledSeparately"];
  if (usage !== undefined && usage !== null && typeof usage !== "boolean") return { ok: false, message: "Water usage must be yes or no." };
  const asAt = b["asAt"];
  if (asAt !== undefined && asAt !== null && (typeof asAt !== "string" || !validDate(asAt))) return { ok: false, message: "The notice date must be a real date like 2026-07-01." };
  const hasCharge = council.value !== undefined || water.value !== undefined;
  if (hasCharge && (asAt === undefined || asAt === null)) return { ok: false, message: "Say the date of the rates notice the figures come from." };
  if (typeof asAt === "string") {
    if (asAt > today) return { ok: false, message: "The notice date cannot be in the future." };
    const limit = new Date(`${today}T00:00:00Z`); limit.setUTCFullYear(limit.getUTCFullYear() - 3);
    if (asAt < limit.toISOString().slice(0, 10)) return { ok: false, message: "The notice is more than 3 years old. Use your latest notice." };
  }
  const out: ListingRates = {};
  if (council.value) out.council = council.value;
  if (water.value) out.water = water.value;
  if (typeof usage === "boolean") out.waterUsageBilledSeparately = usage;
  if (typeof asAt === "string") out.asAt = asAt;
  return { ok: true, value: out };
}

export interface RatesLine { label: string; amount: string; yearly: string }
export interface RatesView { lines: RatesLine[]; totalYearly: string | null; waterUsageNote: string | null; asAt: string | null }

const PERIOD_WORD: Record<RatePeriod, string> = { quarter: "per quarter", year: "per year" };

/** What buyers see. Null when the seller has stated nothing. */
export function toRatesView(r: ListingRates): RatesView | null {
  const lines: RatesLine[] = [];
  const add = (label: string, c: Charge | undefined) => {
    if (c) lines.push({ label, amount: `${formatAud(c.cents)} ${PERIOD_WORD[c.period]}`, yearly: `${formatAud(annualCents(c))} per year` });
  };
  add("Council rates", r.council);
  add("Water rates", r.water);
  if (lines.length === 0 && r.waterUsageBilledSeparately === undefined) return null;
  const both = r.council && r.water;
  return {
    lines,
    totalYearly: both ? `${formatAud(annualCents(r.council!) + annualCents(r.water!))} per year` : null,
    waterUsageNote: r.waterUsageBilledSeparately === undefined ? null : r.waterUsageBilledSeparately ? "Water use is billed separately on top of the water rate." : "Water use is included or does not apply.",
    asAt: r.asAt ?? null
  };
}
