import type { Result } from "./listing-service";
import { medianOf } from "./area-forecast";
import { shiftDays } from "./agent-benchmark";

/**
 * Agent performance for owners (choosing an agent), staff (ranking, outliers, export) and agents (their own month on month).
 *
 * Definitions, kept the same as the benchmarks in src/domain/agent-benchmark.ts:
 * - An accepted offer is a formal offer on a sale listing with status accepted (standing) or fallen_through (it was accepted, then the sale
 *   fell through), dated by submission and credited to the agent appointed to the listing at that time.
 * - Time to sale: days from the listing's first publish (creation when never published through the platform) to the accepted offer, averaged
 *   over standing sales. Time to settlement is not measured yet: the platform records no settlement completion.
 * - Deal velocity: standing sales per month (sales in the period scaled to 30 days).
 * - Price achieved: sale price against the listing's asking price, as a percent variance, averaged.
 * - Fall-through rate: fallen-through offers as a share of all accepted offers (standing and fallen through).
 * - Satisfaction: average of buyer ratings (1-5) given for sales the agent was appointed on. Buyers are never named.
 */

export const PERFORMANCE_PERIODS = [30, 90, 180, 365] as const;
export const DEFAULT_PERFORMANCE_DAYS = 180;
/** Fewer accepted offers than this and a fall-through rate is not judged. */
export const MIN_OFFERS_FOR_FALL_THROUGH = 3;
export const FALL_THROUGH_FLAG_PERCENT = 25;
export const MAX_COMPARE = 3;
export const MIN_RATINGS_SHOWN = 1;

export interface PerfAgent {
  agentId: string; name: string; headline?: string; specialties: string[]; areas: string[]; acceptingNew: boolean; activeListings: number;
}
export interface PerfOffer { agentId: string; date: string; fellThrough: boolean; priceCents: number; listCents?: number; daysToSale?: number }
export interface PerfRating { agentId: string; date: string; rating: number; comment: string }
export interface PerfFacts { agents: PerfAgent[]; offers: PerfOffer[]; ratings: PerfRating[] }

export interface PerfMetrics {
  sold: number;
  acceptedOffers: number;
  fellThrough: number;
  timeToSaleDays?: number;
  dealVelocity: number;
  satisfaction?: number;
  ratingCount: number;
  priceVariancePercent?: number;
  fallThroughRate?: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const avg = (v: readonly number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined);
export interface DateRange { from: string; to: string }
const within = (d: string, r: DateRange) => d >= r.from && d <= r.to;
const daysIn = (r: DateRange) => Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) + 1;

export function periodRange(days: number, today: string): DateRange {
  return { from: shiftDays(today, -(days - 1)), to: today };
}
export function parsePerformanceDays(raw: string | null): number | undefined {
  if (raw === null || raw === "") return DEFAULT_PERFORMANCE_DAYS;
  const n = Number(raw);
  return (PERFORMANCE_PERIODS as readonly number[]).includes(n) ? n : undefined;
}

/** Metrics for one agent (or everyone when agentId is undefined) over a date range. Values with nothing to measure are left out. */
export function computeMetrics(f: Pick<PerfFacts, "offers" | "ratings">, range: DateRange, agentId?: string): PerfMetrics {
  const mine = <T extends { agentId: string; date: string }>(rows: readonly T[]) => rows.filter(r => (agentId === undefined || r.agentId === agentId) && within(r.date, range));
  const offers = mine(f.offers), ratings = mine(f.ratings);
  const sales = offers.filter(o => !o.fellThrough);
  const fell = offers.length - sales.length;
  const tts = avg(sales.flatMap(s => (s.daysToSale !== undefined && s.daysToSale >= 0 ? [s.daysToSale] : [])));
  const variance = avg(sales.flatMap(s => (s.listCents && s.listCents > 0 ? [((s.priceCents - s.listCents) / s.listCents) * 100] : [])));
  const sat = avg(ratings.map(r => r.rating));
  const out: PerfMetrics = {
    sold: sales.length, acceptedOffers: offers.length, fellThrough: fell, ratingCount: ratings.length,
    dealVelocity: round1((sales.length / daysIn(range)) * 30)
  };
  if (tts !== undefined) out.timeToSaleDays = Math.round(tts);
  if (variance !== undefined) out.priceVariancePercent = round1(variance);
  if (sat !== undefined) out.satisfaction = round1(sat);
  if (offers.length >= MIN_OFFERS_FOR_FALL_THROUGH) out.fallThroughRate = round1((fell / offers.length) * 100);
  return out;
}

/** Fastest average time to sale first, then happier buyers; agents with no measured time to sale come last, by name. */
export function compareByTimeToSale(a: { name: string; metrics: PerfMetrics }, b: { name: string; metrics: PerfMetrics }): number {
  const ta = a.metrics.timeToSaleDays, tb = b.metrics.timeToSaleDays;
  if (ta !== undefined && tb === undefined) return -1;
  if (ta === undefined && tb !== undefined) return 1;
  if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
  return (b.metrics.satisfaction ?? 0) - (a.metrics.satisfaction ?? 0) || a.name.localeCompare(b.name);
}

export interface OwnerAgentRow extends PerfAgent { metrics: PerfMetrics; favorite: boolean }

export interface OwnerFilter { q: string; area: string; specialty: string; availableOnly: boolean }
export function parseOwnerFilter(sp: URLSearchParams): OwnerFilter {
  const t = (k: string) => (sp.get(k) ?? "").trim().slice(0, 80);
  return { q: t("q"), area: t("area"), specialty: t("specialty"), availableOnly: sp.get("available") === "1" };
}
const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

/** Owners search by name, location and specialty, and can limit to agents taking new clients ("availability" is only that flag). */
export function filterAgents(rows: readonly OwnerAgentRow[], f: OwnerFilter): OwnerAgentRow[] {
  return rows.filter(r =>
    (!f.q || has(`${r.name} ${r.headline ?? ""}`, f.q)) &&
    (!f.area || r.areas.some(a => has(a, f.area))) &&
    (!f.specialty || r.specialties.includes(f.specialty)) &&
    (!r.acceptingNew ? !f.availableOnly : true));
}

export function buildOwnerRows(facts: PerfFacts, range: DateRange, favorites: ReadonlySet<string>): OwnerAgentRow[] {
  return facts.agents
    .map(a => ({ ...a, metrics: computeMetrics(facts, range, a.agentId), favorite: favorites.has(a.agentId) }))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || compareByTimeToSale(a, b));
}

/** Up to three distinct ids from "?compare=a,b,c". Returns undefined when more than three or malformed. */
export function parseCompareIds(raw: string | null, isId: (s: string) => boolean): string[] | undefined {
  if (!raw) return [];
  const ids = [...new Set(raw.split(",").map(s => s.trim()).filter(Boolean))];
  return ids.length <= MAX_COMPARE && ids.every(isId) ? ids : undefined;
}

export function parseRating(input: unknown): Result<{ listingId: string; rating: number; comment: string }> {
  const bad = (message: string): Result<never> => ({ ok: false, code: "invalid", message });
  if (typeof input !== "object" || input === null) return bad("Send a rating.");
  const o = input as Record<string, unknown>;
  if (typeof o["listingId"] !== "string" || !o["listingId"]) return bad("Choose which sale you are rating.");
  const rating = o["rating"];
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) return bad("Rate from 1 to 5 stars.");
  const comment = o["comment"] === undefined ? "" : o["comment"];
  if (typeof comment !== "string" || comment.trim().length > 1000) return bad("Keep the comment to 1000 characters.");
  return { ok: true, value: { listingId: o["listingId"], rating, comment: comment.trim() } };
}

export interface RankedAgent { key: string; label: string; metrics: PerfMetrics; flagged: boolean; flagReason?: string }
export interface AdminAnalytics { range: DateRange; days: number; rows: RankedAgent[]; platform: PerfMetrics; notes: string[] }

export const PERFORMANCE_NOTES = [
  "Time to sale runs from first publish to the accepted offer, averaged over standing sales. Settlement completion is not recorded yet.",
  "Deal velocity is standing sales per month. Price achieved is the sale price against the asking price.",
  "Fall-through rate is fallen-through offers as a share of accepted offers, shown from 3 accepted offers.",
  `An agent is flagged when their fall-through rate is ${FALL_THROUGH_FLAG_PERCENT}% or more.`,
  "Satisfaction is the average buyer rating for sales the agent was appointed on."
];

export function flagFor(m: PerfMetrics): string | undefined {
  return m.fallThroughRate !== undefined && m.fallThroughRate >= FALL_THROUGH_FLAG_PERCENT
    ? `${m.fallThroughRate}% of accepted offers fell through (${m.fellThrough} of ${m.acceptedOffers})` : undefined;
}

/** Everyone with a sale or accepted offer, or active listings, ranked by time to sale. Names are applied by the caller (pii rules). */
export function buildAdminAnalytics(facts: PerfFacts, days: number, today: string, label: (name: string, index: number) => string): AdminAnalytics {
  const range = periodRange(days, today);
  const ranked = facts.agents.map(a => ({ a, name: a.name, metrics: computeMetrics(facts, range, a.agentId) })).sort(compareByTimeToSale);
  const rows = ranked.map((r, i): RankedAgent => {
    const reason = flagFor(r.metrics);
    return { key: `agent-${i + 1}`, label: label(r.name, i), metrics: r.metrics, flagged: reason !== undefined, ...(reason ? { flagReason: reason } : {}) };
  });
  return { range, days, rows, platform: computeMetrics(facts, range), notes: PERFORMANCE_NOTES };
}

export function adminCsv(a: AdminAnalytics): { header: string[]; rows: (string | number)[][] } {
  const header = ["Rank", "Agent", "Sold", "Avg days to sale", "Sales per month", "Avg buyer rating", "Ratings", "Price vs asking %", "Accepted offers", "Fell through", "Fall-through %", "Flagged"];
  const rows = a.rows.map((r, i) => [i + 1, r.label, r.metrics.sold, r.metrics.timeToSaleDays ?? "", r.metrics.dealVelocity, r.metrics.satisfaction ?? "", r.metrics.ratingCount,
    r.metrics.priceVariancePercent ?? "", r.metrics.acceptedOffers, r.metrics.fellThrough, r.metrics.fallThroughRate ?? "", r.flagged ? "yes" : "no"]);
  return { header, rows };
}

export type MetricName = "sold" | "timeToSaleDays" | "satisfaction" | "priceVariancePercent" | "fallThroughRate";
export interface MonthComparison { thisMonth: PerfMetrics; lastMonth: PerfMetrics; thisRange: DateRange; lastRange: DateRange }

/** Calendar months in the reporting zone: this month so far against the whole of last month. */
export function monthRanges(today: string): { thisRange: DateRange; lastRange: DateRange } {
  const first = `${today.slice(0, 8)}01`;
  const lastEnd = shiftDays(first, -1);
  return { thisRange: { from: first, to: today }, lastRange: { from: `${lastEnd.slice(0, 8)}01`, to: lastEnd } };
}

export function monthComparison(f: Pick<PerfFacts, "offers" | "ratings">, agentId: string, today: string): MonthComparison {
  const { thisRange, lastRange } = monthRanges(today);
  return { thisRange, lastRange, thisMonth: computeMetrics(f, thisRange, agentId), lastMonth: computeMetrics(f, lastRange, agentId) };
}

/**
 * Plain, rule-based suggestions for an agent from their own figures against the platform's (over the same period). Not AI, not a ranking.
 */
export function suggestions(mine: PerfMetrics, platform: PerfMetrics): string[] {
  const out: string[] = [];
  if (mine.fallThroughRate !== undefined && mine.fallThroughRate >= FALL_THROUGH_FLAG_PERCENT)
    out.push(`${mine.fallThroughRate}% of your accepted offers fell through. Check finance and building and pest conditions with the buyer before the owner accepts, and keep in touch through the cooling-off period.`);
  if (mine.timeToSaleDays !== undefined && platform.timeToSaleDays !== undefined && mine.timeToSaleDays > platform.timeToSaleDays * 1.2)
    out.push(`Your listings take ${mine.timeToSaleDays} days to sell against ${platform.timeToSaleDays} across the platform. Review asking prices and photos on listings that have been live longest.`);
  if (mine.satisfaction !== undefined && mine.ratingCount >= 3 && mine.satisfaction < 4)
    out.push(`Your buyer rating is ${mine.satisfaction} from ${mine.ratingCount} ratings. Read the recent comments and follow up sooner after enquiries and offers.`);
  if (mine.sold > 0 && mine.ratingCount === 0)
    out.push("None of your buyers have rated you yet. Ask buyers to rate you after a sale; ratings are what owners compare first.");
  if (mine.priceVariancePercent !== undefined && mine.priceVariancePercent < -5)
    out.push(`Sales are closing ${Math.abs(mine.priceVariancePercent)}% under asking. Talk to owners about pricing closer to the market before listing.`);
  if (out.length === 0) out.push("Nothing stands out. Keep response times short and keep buyers informed through to settlement.");
  return out;
}

export function medianTimeToSale(rows: readonly { metrics: PerfMetrics }[]): number | undefined {
  return medianOf(rows.flatMap(r => (r.metrics.timeToSaleDays !== undefined ? [r.metrics.timeToSaleDays] : [])));
}
