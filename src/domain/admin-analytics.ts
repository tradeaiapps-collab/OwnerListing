import { acceptanceRate } from "./admin-dashboard";
import { staffCan, type StaffActor } from "./staff-access";

/**
 * Platform analytics over a chosen period: listings, offers, offer acceptance, platform fees and account growth, bucketed by day, week
 * or month. Counts and sums only; no personal data. Buckets are calendar dates in one reporting zone so a day means the same thing on
 * every chart. Revenue needs the financial report permission.
 */

/** Reporting zone for bucketing. Brisbane has no daylight saving, so every day is 24 hours and weeks never shift. */
export const ANALYTICS_TIME_ZONE = "Australia/Brisbane";

export type Bucket = "day" | "week" | "month";
export interface Range { from: string; to: string; bucket: Bucket }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_BUCKETS: Record<Bucket, number> = { day: 92, week: 106, month: 36 };
export const DEFAULT_RANGE_DAYS = 90;

const toUtc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const validDate = (d: string) => DATE_RE.test(d) && !Number.isNaN(toUtc(d)) && fmt(toUtc(d)) === d;

/** Start of the bucket holding date d: the day itself, the Monday of its week, or the first of its month. */
export function bucketStart(d: string, bucket: Bucket): string {
  if (bucket === "day") return d;
  if (bucket === "month") return `${d.slice(0, 7)}-01`;
  const ms = toUtc(d);
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  return fmt(ms - dow * DAY_MS);
}

/** Every bucket start from the bucket holding `from` to the one holding `to`, in order. */
export function bucketKeys(r: Range): string[] {
  const out: string[] = [];
  let cur = bucketStart(r.from, r.bucket);
  const end = toUtc(r.to);
  while (toUtc(cur) <= end && out.length <= MAX_BUCKETS[r.bucket]) {
    out.push(cur);
    if (r.bucket === "month") {
      const d = new Date(toUtc(cur));
      cur = fmt(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    } else cur = fmt(toUtc(cur) + (r.bucket === "week" ? 7 : 1) * DAY_MS);
  }
  return out;
}

/**
 * Reads from, to (YYYY-MM-DD, inclusive) and bucket. Defaults: the last 90 days by week, ending today in the reporting zone.
 * Refuses a reversed or future range and one that would draw more buckets than a chart can show.
 */
export function parseRange(p: URLSearchParams, today: string): { ok: true; range: Range } | { ok: false; error: string } {
  const bucketRaw = p.get("bucket") ?? "week";
  if (bucketRaw !== "day" && bucketRaw !== "week" && bucketRaw !== "month") return { ok: false, error: "Bucket must be day, week or month." };
  const to = p.get("to") || today;
  const from = p.get("from") || fmt(toUtc(to) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
  if (!validDate(from) || !validDate(to)) return { ok: false, error: "Dates must be real dates in the form YYYY-MM-DD." };
  if (from > to) return { ok: false, error: "The start date must be on or before the end date." };
  if (to > today) return { ok: false, error: "The end date cannot be in the future." };
  const range: Range = { from, to, bucket: bucketRaw };
  if (bucketKeys(range).length > MAX_BUCKETS[bucketRaw]) {
    return { ok: false, error: `That period is too long to show by ${bucketRaw}. Choose a shorter period or a larger bucket.` };
  }
  return { ok: true, range };
}

export const METRICS = [
  "listings_created", "listings_published", "offers_submitted", "offers_accepted", "revenue_cents",
  "signups_owner", "signups_agent", "signups_buyer", "signups_other"
] as const;
export type Metric = (typeof METRICS)[number];
export interface MetricRow { metric: string; bucket: string; value: number }

export interface SeriesOut { key: string; label: string; values: number[]; total: number }
export interface Analytics {
  range: Range; timeZone: string; labels: string[]; buckets: string[];
  listings: SeriesOut[]; offers: SeriesOut[]; acceptance: SeriesOut[]; users: SeriesOut[]; revenue?: SeriesOut[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Short axis label: "3 Oct" for a day or week start, "Oct 26" for a month. */
export function bucketLabel(d: string, bucket: Bucket): string {
  const m = MONTHS[Number(d.slice(5, 7)) - 1];
  return bucket === "month" ? `${m} ${d.slice(2, 4)}` : `${Number(d.slice(8, 10))} ${m}`;
}

/** Spreads rows onto the bucket list (missing buckets are zero; rows outside the list or for other metrics are ignored). */
export function seriesFor(rows: readonly MetricRow[], metric: Metric, buckets: readonly string[]): number[] {
  const at = new Map(buckets.map((b, i) => [b, i]));
  const out = buckets.map(() => 0);
  for (const r of rows) {
    if (r.metric !== metric) continue;
    const i = at.get(r.bucket);
    if (i !== undefined && Number.isFinite(r.value) && r.value > 0) out[i]! += r.value;
  }
  return out;
}

const sum = (v: readonly number[]) => v.reduce((a, b) => a + b, 0);
const s = (key: string, label: string, values: number[]): SeriesOut => ({ key, label, values, total: sum(values) });

export function buildAnalytics(actor: StaffActor, range: Range, rows: readonly MetricRow[]): Analytics {
  const buckets = bucketKeys(range);
  const get = (m: Metric) => seriesFor(rows, m, buckets);
  const submitted = get("offers_submitted"), accepted = get("offers_accepted");
  const out: Analytics = {
    range, timeZone: ANALYTICS_TIME_ZONE, buckets, labels: buckets.map(b => bucketLabel(b, range.bucket)),
    listings: [s("created", "Listings created", get("listings_created")), s("published", "Listings published", get("listings_published"))],
    offers: [s("submitted", "Offers submitted", submitted), s("accepted", "Offers accepted", accepted)],
    acceptance: [{ key: "acceptance", label: "Offer acceptance (%)", values: submitted.map((n, i) => acceptanceRate(accepted[i]!, n)), total: acceptanceRate(sum(accepted), sum(submitted)) }],
    users: [s("owner", "Owners", get("signups_owner")), s("agent", "Agents", get("signups_agent")), s("buyer", "Buyers", get("signups_buyer"))]
  };
  const other = get("signups_other");
  if (sum(other) > 0) out.users.push(s("other", "Other accounts", other));
  if (staffCan(actor, "report.financial")) out.revenue = [s("revenue", "Platform fees paid (AUD cents)", get("revenue_cents"))];
  return out;
}
