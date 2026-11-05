import { groupOf } from "./price-guidance";

/**
 * Listing performance for sellers: views, inquiries and offers over 7/30/90 days, a comparison with similar listings, a day-and-time
 * heatmap and rules-based advice ("Elena"). Pure and deterministic; the database layer is src/server/listing-performance-db.ts.
 * Views count signed-in buyers (one per buyer per hour, owner's own visits excluded). Advisory only; it never invents a figure and
 * shows "unavailable" when there is too little data. The seller decides the price.
 */

export const PERFORMANCE_NOTE =
  "Guide only. Views count signed-in buyers (one per buyer per hour, your own visits excluded), so real interest is higher. Comparisons use similar listings on this platform and are not a valuation or a promise of an offer.";
export const WINDOWS = [7, 30, 90] as const;
export type Window = (typeof WINDOWS)[number];
export const isWindow = (n: number): n is Window => (WINDOWS as readonly number[]).includes(n);
export const MIN_COMPARABLES = 3;
export const MAX_COMPARABLES = 5;
/** A comparable's asking price must be within this share of the seller's. */
export const PRICE_BAND = 0.2;
/** Trend and gap thresholds. */
export const FLAT_BAND = 10;
export const UNDERPERFORM_GAP = -40;
export const MIN_VIEWS_FOR_RATES = 20;
export const MIN_VIEWS_FOR_TREND = 5;
export const STALE_AGE_DAYS = 14;
export const MAX_REPRICE_VIEWS_GAIN = 40;

export interface DayPoint { date: string; views: number; inquiries: number; offers: number }
export interface Totals { views: number; inquiries: number; offers: number; viewsPerDay: number; inquiryRatePct: number | null; offersPer100Views: number | null }
export interface Trend { changePct: number | null; direction: "up" | "down" | "flat" | "unknown" }
export interface WindowStats extends Totals { days: Window; trend: Trend }

const r1 = (n: number) => Math.round(n * 10) / 10;
const dayMs = 86_400_000;
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const median = (xs: readonly number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Days (UTC dates) in [today - days + 1, today]. `offset` shifts the window back by that many days (previous period). */
function inWindow(p: DayPoint, today: string, days: number, offset = 0): boolean {
  const age = Math.round((Date.parse(today) - Date.parse(p.date)) / dayMs);
  return age >= offset && age < offset + days;
}

export function totalsFor(points: readonly DayPoint[], today: string, days: number, activeDays: number, offset = 0): Totals {
  const sel = points.filter(p => inWindow(p, today, days, offset));
  const views = sel.reduce((a, p) => a + p.views, 0), inquiries = sel.reduce((a, p) => a + p.inquiries, 0), offers = sel.reduce((a, p) => a + p.offers, 0);
  return {
    views, inquiries, offers, viewsPerDay: r1(views / Math.max(1, Math.min(days, activeDays))),
    inquiryRatePct: views >= MIN_VIEWS_FOR_RATES ? r1((inquiries / views) * 100) : null,
    offersPer100Views: views >= MIN_VIEWS_FOR_RATES ? r1((offers / views) * 100) : null
  };
}

export function trendOf(current: number, previous: number): Trend {
  if (previous < MIN_VIEWS_FOR_TREND) return { changePct: null, direction: "unknown" };
  const changePct = r1(((current - previous) / previous) * 100);
  return { changePct, direction: Math.abs(changePct) <= FLAT_BAND ? "flat" : changePct > 0 ? "up" : "down" };
}

/** Days the listing has been live, at least 1. */
export const ageDays = (createdAt: string, now: string) => Math.max(1, Math.floor((Date.parse(now) - Date.parse(createdAt)) / dayMs) + 1);

export function windowStats(points: readonly DayPoint[], now: string, createdAt: string): WindowStats[] {
  const today = now.slice(0, 10), age = ageDays(createdAt, now);
  return WINDOWS.map(days => {
    const cur = totalsFor(points, today, days, age);
    // Only compare with a previous period the listing was live for.
    const prev = age > days ? totalsFor(points, today, days, age - days, days) : undefined;
    return { days, ...cur, trend: prev ? trendOf(cur.views, prev.views) : { changePct: null, direction: "unknown" } };
  });
}

/** One point per day for the last `days` days, filling quiet days with zeros so the chart has no gaps. */
export function fillDays(points: readonly DayPoint[], now: string, days: number): DayPoint[] {
  const by = new Map(points.map(p => [p.date, p]));
  const end = Date.parse(now.slice(0, 10));
  return Array.from({ length: days }, (_, i) => {
    const d = dateOf(end - (days - 1 - i) * dayMs);
    return by.get(d) ?? { date: d, views: 0, inquiries: 0, offers: 0 };
  });
}

// ---- Market comparison ----

export interface Subject {
  id?: string; propertyType: string; suburb?: string | undefined; postcode?: string | undefined; priceCents?: number | undefined; bedrooms?: number | undefined;
}
/** Another published listing's last-30-day figures, as loaded by the database layer. */
export interface CandidateListing {
  id: string; propertyType: string; suburb?: string | undefined; postcode?: string | undefined; priceCents?: number | undefined; bedrooms?: number | undefined;
  ageDays: number; views30: number; inquiries30: number; offers30: number; daysToFirstOffer?: number | undefined;
}
export interface ComparableRow {
  /** Letters A, B, C. Other sellers' listings are not named. */
  label: string; suburb?: string | undefined; bedrooms?: number | undefined; priceCents?: number | undefined; ageDays: number;
  viewsPerDay: number; inquiryRatePct: number | null; offersPer100Views: number | null; daysToFirstOffer?: number | undefined;
}
export interface MarketAverage {
  viewsPerDay: number; inquiryRatePct: number | null; offersPer100Views: number | null; medianAskingCents?: number | undefined; medianDaysToFirstOffer?: number | undefined;
}
export type Unavailable = { state: "unavailable"; message: string };
export interface MarketComparison {
  state: "ready"; count: number; rows: ComparableRow[]; average: MarketAverage;
  /** Seller's 30-day figures against the average, in percent; null when either side is missing. */
  viewsGapPct: number | null; inquiryRateGapPct: number | null; offerRateGapPct: number | null;
}

const active = (c: CandidateListing) => Math.max(1, Math.min(30, c.ageDays));
const rate = (num: number, views: number) => (views >= MIN_VIEWS_FOR_RATES ? r1((num / views) * 100) : null);
const place = (a: { suburb?: string | undefined; postcode?: string | undefined }) => (a.suburb ?? "").trim().toLowerCase() || (a.postcode ?? "");

/**
 * Comparable listings: same property group, same suburb (or postcode when no suburb), and an asking price within 20% of the seller's when
 * both are known. Closest price first, then newest; at most five. Fewer than three gives "unavailable".
 */
export function selectComparables(s: Subject, all: readonly CandidateListing[]): CandidateListing[] {
  const g = groupOf(s.propertyType), here = place(s);
  const ok = all.filter(c =>
    c.id !== s.id && groupOf(c.propertyType) === g && here !== "" && place(c) === here &&
    (s.priceCents === undefined || c.priceCents === undefined || Math.abs(c.priceCents - s.priceCents) / s.priceCents <= PRICE_BAND));
  const dist = (c: CandidateListing) => (s.priceCents !== undefined && c.priceCents !== undefined ? Math.abs(c.priceCents - s.priceCents) : Number.MAX_SAFE_INTEGER);
  return ok.sort((a, b) => dist(a) - dist(b) || a.ageDays - b.ageDays || a.id.localeCompare(b.id)).slice(0, MAX_COMPARABLES);
}

const gap = (mine: number | null, theirs: number | null): number | null => (mine === null || theirs === null || theirs === 0 ? null : r1(((mine - theirs) / theirs) * 100));
const avg = (xs: readonly (number | null)[]): number | null => { const v = xs.filter((x): x is number => x !== null); return v.length === 0 ? null : r1(v.reduce((a, b) => a + b, 0) / v.length); };

export function marketComparison(s: Subject, mine: Totals | undefined, all: readonly CandidateListing[]): MarketComparison | Unavailable {
  const picked = selectComparables(s, all);
  if (picked.length < MIN_COMPARABLES) return { state: "unavailable", message: "There are not enough similar listings in this area to compare yet." };
  const rows = picked.map((c, i): ComparableRow => ({
    label: String.fromCharCode(65 + i), ...(c.suburb ? { suburb: c.suburb } : {}), ...(c.bedrooms !== undefined ? { bedrooms: c.bedrooms } : {}),
    ...(c.priceCents !== undefined ? { priceCents: c.priceCents } : {}), ageDays: c.ageDays, viewsPerDay: r1(c.views30 / active(c)),
    inquiryRatePct: rate(c.inquiries30, c.views30), offersPer100Views: rate(c.offers30, c.views30),
    ...(c.daysToFirstOffer !== undefined ? { daysToFirstOffer: c.daysToFirstOffer } : {})
  }));
  const prices = picked.flatMap(c => (c.priceCents !== undefined ? [c.priceCents] : []));
  const dtf = picked.flatMap(c => (c.daysToFirstOffer !== undefined ? [c.daysToFirstOffer] : []));
  const average: MarketAverage = {
    viewsPerDay: avg(rows.map(r => r.viewsPerDay)) ?? 0, inquiryRatePct: avg(rows.map(r => r.inquiryRatePct)), offersPer100Views: avg(rows.map(r => r.offersPer100Views)),
    ...(prices.length >= MIN_COMPARABLES ? { medianAskingCents: Math.round(median(prices)!) } : {}),
    ...(dtf.length >= MIN_COMPARABLES ? { medianDaysToFirstOffer: Math.round(median(dtf)!) } : {})
  };
  return {
    state: "ready", count: rows.length, rows, average,
    viewsGapPct: mine ? gap(mine.viewsPerDay, average.viewsPerDay) : null,
    inquiryRateGapPct: mine ? gap(mine.inquiryRatePct, average.inquiryRatePct) : null,
    offerRateGapPct: mine ? gap(mine.offersPer100Views, average.offersPer100Views) : null
  };
}

// ---- Heatmap: day of week by 4-hour block (viewer's local Australian time, worked out in the database) ----

export const HEAT_BLOCKS = ["12a-4a", "4a-8a", "8a-12p", "12p-4p", "4p-8p", "8p-12a"] as const;
export const HEAT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export interface Heatmap { state: "ready"; total: number; cells: number[][]; peak: { day: string; block: string } }

/** cells[day][block] with Monday first. Needs 20 views to say anything; otherwise unavailable. */
export function buildHeatmap(rows: readonly { dow: number; block: number; n: number }[]): Heatmap | Unavailable {
  const cells = HEAT_DAYS.map(() => HEAT_BLOCKS.map(() => 0));
  for (const r of rows) {
    const d = (r.dow + 6) % 7; // Postgres: Sunday = 0
    if (d >= 0 && d < 7 && r.block >= 0 && r.block < 6) cells[d]![r.block]! += r.n;
  }
  const total = cells.flat().reduce((a, b) => a + b, 0);
  if (total < MIN_VIEWS_FOR_RATES) return { state: "unavailable", message: "Not enough views yet to show when buyers look." };
  let best = { d: 0, b: 0, n: -1 };
  cells.forEach((row, d) => row.forEach((n, b) => { if (n > best.n) best = { d, b, n }; }));
  return { state: "ready", total, cells, peak: { day: HEAT_DAYS[best.d]!, block: HEAT_BLOCKS[best.b]! } };
}

// ---- Elena: prediction, recommendations, risk ----

export interface Advice {
  prediction: { state: "ready"; days: number; low: number; high: number; message: string } | { state: "has_offer"; message: string } | Unavailable;
  recommendation: { state: "ready"; targetCents: number; viewsGainPct?: number | undefined; message: string } | Unavailable;
  risk: { level: "ok" | "watch" | "at_risk"; message: string; reasons: string[] };
}
export interface AdviceInput {
  subject: Subject; ageDays: number; photoCount: number; stats30: Totals; offersEver: number; market: MarketComparison | Unavailable; candidates: readonly CandidateListing[];
}

const money = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);

/** Elasticity of views to price across the comparables: slope of ln(views per day + 1) on ln(price). Needs five priced comparables and a negative slope. */
export function priceElasticity(rows: readonly { priceCents: number; viewsPerDay: number }[]): number | undefined {
  if (rows.length < 5) return undefined;
  const xs = rows.map(r => Math.log(r.priceCents)), ys = rows.map(r => Math.log(r.viewsPerDay + 1));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (sxx === 0) return undefined;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0) / sxx;
  return slope < 0 ? slope : undefined;
}

export function elenaAdvice(i: AdviceInput): Advice {
  const m = i.market.state === "ready" ? i.market : undefined;
  const asking = i.subject.priceCents;

  // Risk
  const reasons: string[] = [];
  if (m?.viewsGapPct != null && m.viewsGapPct <= UNDERPERFORM_GAP) reasons.push(`Views are ${Math.abs(Math.round(m.viewsGapPct))}% below similar listings.`);
  if (i.ageDays >= STALE_AGE_DAYS && i.stats30.views >= MIN_VIEWS_FOR_RATES && i.stats30.inquiries === 0) reasons.push("Buyers are looking but nobody has enquired.");
  if (i.ageDays >= STALE_AGE_DAYS && i.stats30.views < MIN_VIEWS_FOR_RATES) reasons.push("Very few buyers have viewed the listing.");
  if (m?.inquiryRateGapPct != null && m.inquiryRateGapPct <= UNDERPERFORM_GAP && i.stats30.views >= MIN_VIEWS_FOR_RATES) reasons.push("Fewer viewers enquire than on similar listings.");
  const level = i.offersEver > 0 ? "ok" : reasons.length >= 2 || (m?.viewsGapPct != null && m.viewsGapPct <= UNDERPERFORM_GAP) ? "at_risk" : reasons.length === 1 ? "watch" : "ok";
  const fixes = [asking !== undefined && m?.average.medianAskingCents !== undefined && asking > m.average.medianAskingCents ? "a price cut" : "", i.photoCount < 8 ? "more photos" : "", "a fresh description"].filter(Boolean);
  const risk: Advice["risk"] = level === "ok"
    ? { level, message: i.offersEver > 0 ? "You have an offer. Keep an eye on the timeline and reply promptly." : "Your listing is performing in line with the market.", reasons }
    : { level, message: `Listing underperforming. Consider ${fixes.slice(0, 2).join(" or ")}.`, reasons };

  // Recommendation: reprice toward the median asking price of similar listings, only when the listing is priced above it.
  let recommendation: Advice["recommendation"] = { state: "unavailable", message: "Not enough similar listings to suggest a price change." };
  if (asking !== undefined && m?.average.medianAskingCents !== undefined) {
    const target = m.average.medianAskingCents;
    if (asking <= target * 1.02) recommendation = { state: "unavailable", message: "Your asking price is at or below the middle of similar listings, so a price change is unlikely to be the issue." };
    else {
      const priced = i.candidates.flatMap(c => (c.priceCents !== undefined ? [{ priceCents: c.priceCents, viewsPerDay: c.views30 / active(c) }] : []));
      const e = priceElasticity(priced);
      const gain = e === undefined ? undefined : Math.min(MAX_REPRICE_VIEWS_GAIN, Math.max(0, Math.round((Math.exp(e * Math.log(target / asking)) - 1) * 100)));
      recommendation = {
        state: "ready", targetCents: target, viewsGainPct: gain,
        message: gain !== undefined && gain > 0
          ? `Repricing to the middle of similar listings (${money(target)}) would increase views by about ${gain}%.`
          : `Similar listings are asking around ${money(target)}. Repricing toward that is the likeliest way to lift interest.`
      };
    }
  }

  // Prediction: the typical days to first offer for similar listings, scaled by how your views compare.
  let prediction: Advice["prediction"] = { state: "unavailable", message: "Not enough data yet to estimate when your first offer might arrive." };
  if (i.offersEver > 0) prediction = { state: "has_offer", message: "You already have an offer." };
  else if (m?.average.medianDaysToFirstOffer !== undefined && i.stats30.views >= MIN_VIEWS_FOR_RATES) {
    const ratio = m.average.viewsPerDay > 0 ? Math.min(2, Math.max(0.5, i.stats30.viewsPerDay / m.average.viewsPerDay)) : 1;
    const days = Math.max(1, Math.round(m.average.medianDaysToFirstOffer / ratio));
    const remaining = Math.max(1, days - i.ageDays);
    prediction = { state: "ready", days: remaining, low: Math.max(1, Math.round(remaining * 0.7)), high: Math.round(remaining * 1.4) + 1, message: `Based on current views, you could expect a first offer in about ${remaining} day${remaining === 1 ? "" : "s"}. This is a guide, not a promise.` };
  }
  return { prediction, recommendation, risk };
}
