import { formatPrice } from "./listing-details";
import { groupOf, monthsBetween, near, roundStep, roundTo, weightedQuantile, type Comparable, type Subject } from "./price-guidance";

/**
 * Seller market insights: recent comparable sales, monthly price trend with a simple season check, days on the market, a price-to-days
 * guide and rules-based pricing advice. Pure and deterministic, worked out from a list of comparable sales (the platform's own recorded
 * sales plus any licensed feed; see createPlatformComparablesSource). Sales only. It never invents a figure: too little data gives
 * "unavailable". Advisory only; not a valuation, and the seller decides the price.
 */

export const SELLER_NOTE =
  "Guide only, worked out from recent sales we can see. It is not a valuation or a promise of a price or time to sell. You decide your price; a licensed agent or valuer can advise on your property.";
export const COMP_DAYS = 90;
export const MIN_COMPS = 3;
/** A comparable's land or floor size must be within this share of the subject's when both are known. */
export const SIZE_TOLERANCE = 0.4;
/** Days-on-market bands: fast 0-14, standard 15-30, slow 31 and over. */
export const FAST_DAYS = 14;
export const STANDARD_DAYS = 30;
/** Rules for the goal-based advice (product can change these). */
export const FAST_SALE_DISCOUNT = 0.1;
export const SELLER_GOALS = ["fast_sale", "max_price", "balanced"] as const;
export type SellerGoal = (typeof SELLER_GOALS)[number];
export const isSellerGoal = (v: unknown): v is SellerGoal => typeof v === "string" && (SELLER_GOALS as readonly string[]).includes(v);

export interface SellerSubject extends Subject { areaSqm?: number }
export type Unavailable = { state: "unavailable"; message: string };

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
const pct = (from: number, to: number) => Math.round(((to - from) / from) * 1000) / 10;
const money = (c: number) => formatPrice(c, "sale");
const place = (s: Subject) => [s.suburb, s.postcode].filter(Boolean).join(" ") || "this area";
const step = (c: number) => roundStep("sale", c);
const round = (c: number) => roundTo(c, step(c));

/** Sales in the subject's area and property group, no older than `maxMonths`, and of similar size when both sizes are known. */
export function pool(s: SellerSubject, all: readonly Comparable[], now: string, maxMonths: number, sized: boolean): Comparable[] {
  return all.filter(c =>
    c.transactionType === "sale" && c.priceCents > 0 && groupOf(c.propertyType) === groupOf(s.propertyType) && near(s, c) &&
    monthsBetween(c.date, now) >= 0 && monthsBetween(c.date, now) <= maxMonths &&
    (!sized || s.areaSqm === undefined || c.areaSqm === undefined || Math.abs(c.areaSqm - s.areaSqm) / s.areaSqm <= SIZE_TOLERANCE));
}
const inDays = (c: Comparable, now: string, from: number, to: number) => {
  const d = (Date.parse(now) - Date.parse(c.date)) / 86_400_000;
  return d >= from && d < to;
};

// ---- 1. Comparable sales, last 90 days ----

export interface SoldRow {
  id: string; date: string; suburb: string; propertyType: string; priceCents: number;
  bedrooms?: number | undefined; areaSqm?: number | undefined; pricePerSqmCents?: number | undefined; daysOnMarket?: number | undefined; label?: string | undefined;
}
export interface ComparableSales {
  state: "ready"; count: number; rows: SoldRow[];
  medianCents: number; p25Cents: number; p75Cents: number; medianPricePerSqmCents?: number | undefined; medianDaysOnMarket?: number | undefined;
  /** Median now against the 90 days before that; undefined when the earlier quarter has fewer than three sales. */
  changeVsLastQuarterPercent?: number | undefined; direction?: "up" | "down" | "flat" | undefined;
  insight: string;
}

export function comparableSales(s: SellerSubject, all: readonly Comparable[], now: string, limit = 20): ComparableSales | Unavailable {
  const recent = pool(s, all, now, 6, true).filter(c => inDays(c, now, 0, COMP_DAYS));
  if (recent.length < MIN_COMPS) return { state: "unavailable", message: "There are not enough recent sales of similar properties in this area to show comparable sales." };
  const prices = recent.map(c => c.priceCents);
  const med = median(prices);
  const q = (p: number) => weightedQuantile(prices.map(v => ({ v, w: 1 })), p);
  const prev = pool(s, all, now, 6, true).filter(c => inDays(c, now, COMP_DAYS, COMP_DAYS * 2));
  const change = prev.length >= MIN_COMPS ? pct(median(prev.map(c => c.priceCents)), med) : undefined;
  const persqm = recent.flatMap(c => (c.areaSqm ? [Math.round(c.priceCents / c.areaSqm)] : []));
  const dom = recent.flatMap(c => (c.daysOnMarket !== undefined ? [c.daysOnMarket] : []));
  const p25 = round(q(0.25)), p75 = round(q(0.75));
  const rows = [...recent].sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.id.localeCompare(b.id)).slice(0, Math.max(1, Math.min(limit, 50))).map((c): SoldRow => ({
    id: c.id, date: c.date, suburb: c.suburb, propertyType: c.propertyType, priceCents: c.priceCents,
    ...(c.bedrooms !== undefined ? { bedrooms: c.bedrooms } : {}), ...(c.areaSqm ? { areaSqm: c.areaSqm, pricePerSqmCents: Math.round(c.priceCents / c.areaSqm) } : {}),
    ...(c.daysOnMarket !== undefined ? { daysOnMarket: c.daysOnMarket } : {}), ...(c.label ? { label: c.label } : {})
  }));
  const trendWords = change === undefined ? "" : ` Prices are ${change > 1 ? `up ${change}%` : change < -1 ? `down ${Math.abs(change)}%` : "about flat"} on the previous 90 days.`;
  return {
    state: "ready", count: recent.length, rows, medianCents: med, p25Cents: p25, p75Cents: p75,
    ...(persqm.length >= MIN_COMPS ? { medianPricePerSqmCents: median(persqm) } : {}), ...(dom.length >= MIN_COMPS ? { medianDaysOnMarket: median(dom) } : {}),
    ...(change !== undefined ? { changeVsLastQuarterPercent: change, direction: change > 1 ? "up" as const : change < -1 ? "down" as const : "flat" as const } : {}),
    insight: `Properties like yours are selling for ${money(p25)} to ${money(p75)} in ${place(s)} (${recent.length} sales in the last ${COMP_DAYS} days, middle ${money(med)}).${trendWords}`
  };
}

// ---- 2. Price trend, last 12 months, with a simple season check ----

export interface MonthPoint { month: string; averageCents: number; sales: number }
export interface SeasonCheck { season: string; months: string; seasonAverageCents: number; restAverageCents: number; differencePercent: number; seasonSales: number; restSales: number }
export interface SellerTrend {
  state: "ready"; points: MonthPoint[]; sales: number;
  /** Average of the last 12 months against the months before that (at most 14 are available); undefined when that earlier period has fewer than three sales. */
  yearOnYearPercent?: number | undefined; priorSales: number;
  season?: SeasonCheck | undefined; insight: string;
}

/** Southern-hemisphere seasons, as used in Australian real estate. */
const SEASONS = [
  { name: "Summer", label: "Dec-Feb", months: [12, 1, 2] }, { name: "Autumn", label: "Mar-May", months: [3, 4, 5] },
  { name: "Winter", label: "Jun-Aug", months: [6, 7, 8] }, { name: "Spring", label: "Sep-Nov", months: [9, 10, 11] }
] as const;
const avg = (xs: readonly number[]) => Math.round(xs.reduce((t, v) => t + v, 0) / xs.length);
const monthKey = (iso: string) => iso.slice(0, 7);

export function sellerTrend(s: SellerSubject, all: readonly Comparable[], now: string): SellerTrend | Unavailable {
  const area = pool(s, all, now, 26, false);
  const last12 = area.filter(c => monthsBetween(c.date, now) <= 12);
  if (last12.length < 6) return { state: "unavailable", message: "There are not enough sales in this area over the last 12 months to draw a price trend." };
  const end = new Date(now);
  const points: MonthPoint[] = [];
  for (let i = 11; i >= 0; i--) {
    const key = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
    const inMonth = last12.filter(c => monthKey(c.date) === key);
    if (inMonth.length > 0) points.push({ month: key, averageCents: avg(inMonth.map(c => c.priceCents)), sales: inMonth.length });
  }
  const firstKey = points[0]!.month;
  const prior = area.filter(c => monthKey(c.date) < firstKey);
  const yoy = prior.length >= MIN_COMPS ? pct(avg(prior.map(c => c.priceCents)), avg(last12.map(c => c.priceCents))) : undefined;
  // Season check: the current season (Southern hemisphere) against the rest of the 12 months. Needs three sales on each side.
  const curMonth = end.getUTCMonth() + 1;
  const season = SEASONS.find(x => (x.months as readonly number[]).includes(curMonth))!;
  const inSeason = last12.filter(c => (season.months as readonly number[]).includes(new Date(c.date).getUTCMonth() + 1));
  const rest = last12.filter(c => !inSeason.includes(c));
  let check: SeasonCheck | undefined;
  if (inSeason.length >= MIN_COMPS && rest.length >= MIN_COMPS) {
    const a = avg(inSeason.map(c => c.priceCents)), b = avg(rest.map(c => c.priceCents));
    check = { season: season.name, months: season.label, seasonAverageCents: a, restAverageCents: b, differencePercent: pct(b, a), seasonSales: inSeason.length, restSales: rest.length };
  }
  const bits = [`Average sale price in ${place(s)} over the last 12 months is ${money(avg(last12.map(c => c.priceCents)))} from ${last12.length} sales.`];
  if (yoy !== undefined) bits.push(`That is ${yoy > 0 ? `up ${yoy}%` : yoy < 0 ? `down ${Math.abs(yoy)}%` : "flat"} on the months before.`);
  if (check) bits.push(`${check.season} (${check.months}) sales averaged ${check.differencePercent >= 0 ? `${check.differencePercent}% higher` : `${Math.abs(check.differencePercent)}% lower`} than the rest of the year. One year of sales is a thin guide to seasons.`);
  return { state: "ready", points, sales: last12.length, ...(yoy !== undefined ? { yearOnYearPercent: yoy } : {}), priorSales: prior.length, ...(check ? { season: check } : {}), insight: bits.join(" ") };
}

// ---- 3. Days on the market and the price-to-days guide ----

export interface DomStats {
  state: "ready"; sample: number; averageDays: number; medianDays: number;
  bands: { fast: number; standard: number; slow: number };
  /** Share of sales (0-100) in each band. */
  bandPercent: { fast: number; standard: number; slow: number };
  insight: string;
}
const domPool = (s: SellerSubject, all: readonly Comparable[], now: string) =>
  pool(s, all, now, 12, true).filter(c => c.daysOnMarket !== undefined && c.daysOnMarket >= 0);

export function daysOnMarket(s: SellerSubject, all: readonly Comparable[], now: string): DomStats | Unavailable {
  const rows = domPool(s, all, now);
  if (rows.length < MIN_COMPS) return { state: "unavailable", message: "There are not enough sales with listing dates in this area to show days on the market." };
  const d = rows.map(c => c.daysOnMarket!);
  const bands = { fast: d.filter(x => x <= FAST_DAYS).length, standard: d.filter(x => x > FAST_DAYS && x <= STANDARD_DAYS).length, slow: d.filter(x => x > STANDARD_DAYS).length };
  const p = (n: number) => Math.round((n / d.length) * 100);
  return {
    state: "ready", sample: d.length, averageDays: Math.round(avg(d)), medianDays: median(d), bands, bandPercent: { fast: p(bands.fast), standard: p(bands.standard), slow: p(bands.slow) },
    insight: `Similar properties here took about ${Math.round(avg(d))} days to sell on average (${d.length} sales). ${p(bands.fast)}% sold within ${FAST_DAYS} days, ${p(bands.standard)}% in ${FAST_DAYS + 1}-${STANDARD_DAYS} days and ${p(bands.slow)}% took longer.`
  };
}

export interface PriceDaysModel {
  state: "ready"; medianCents: number; sample: number; interceptDays: number; slopeDaysPerTenPercent: number; r2: number;
  confidence: "low" | "fair" | "good"; minCents: number; maxCents: number;
}
const MIN_MODEL_SAMPLE = 8;

/**
 * A straight line through (price as a share of the area median, days to sell) for similar sales in the last 12 months. It only
 * describes what happened here; with a weak or backwards link it says so instead of drawing a curve. Estimates are held to the range of
 * prices actually seen (with a small margin), so a slider never extrapolates.
 */
export function priceDaysModel(s: SellerSubject, all: readonly Comparable[], now: string): PriceDaysModel | Unavailable {
  const rows = domPool(s, all, now);
  const none = (message: string): Unavailable => ({ state: "unavailable", message });
  if (rows.length < MIN_MODEL_SAMPLE) return none("There are not enough sales with listing dates to estimate days to sell at different prices.");
  const med = median(rows.map(c => c.priceCents));
  const xs = rows.map(c => c.priceCents / med), ys = rows.map(c => c.daysOnMarket!);
  const mx = xs.reduce((t, v) => t + v, 0) / xs.length, my = ys.reduce((t, v) => t + v, 0) / ys.length;
  const sxx = xs.reduce((t, v) => t + (v - mx) ** 2, 0), sxy = xs.reduce((t, v, i) => t + (v - mx) * (ys[i]! - my), 0), syy = ys.reduce((t, v) => t + (v - my) ** 2, 0);
  if (sxx === 0 || syy === 0) return none("Recent sales here are too similar in price to show how price affects days to sell.");
  const slope = sxy / sxx;
  const r2 = (sxy * sxy) / (sxx * syy);
  if (slope <= 0) return none("In recent sales here, higher prices did not take longer to sell, so there is no clear link between price and days to sell.");
  const confidence = rows.length >= 15 && r2 >= 0.3 ? "good" : rows.length >= 10 && r2 >= 0.15 ? "fair" : "low";
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return {
    state: "ready", medianCents: med, sample: rows.length, interceptDays: my - slope * mx, slopeDaysPerTenPercent: Math.round(slope * 0.1 * 10) / 10,
    r2: Math.round(r2 * 100) / 100, confidence, minCents: Math.round(med * (lo - 0.02)), maxCents: Math.round(med * (hi + 0.02))
  };
}

/** Estimated days to sell at a price, held to the range of prices seen. Between 1 and 180. */
export function daysAtPrice(m: PriceDaysModel, priceCents: number): number {
  const c = Math.min(m.maxCents, Math.max(m.minCents, priceCents));
  const slope = (m.slopeDaysPerTenPercent / 0.1);
  return Math.min(180, Math.max(1, Math.round(m.interceptDays + slope * (c / m.medianCents))));
}

/** Points for the pricing slider, low to high across the seen price range. */
export function priceCurve(m: PriceDaysModel, points = 9): { priceCents: number; days: number }[] {
  const n = Math.max(2, Math.min(25, points));
  return Array.from({ length: n }, (_, i) => {
    const priceCents = round(m.minCents + ((m.maxCents - m.minCents) * i) / (n - 1));
    return { priceCents, days: daysAtPrice(m, priceCents) };
  });
}

// ---- 4. Rules-based pricing advice ----

export interface Scenario { goal: SellerGoal; priceCents: number; estimatedDays?: number | undefined }
export interface PricingAdvice {
  state: "ready"; goal: SellerGoal; recommendedCents: number; scenarios: Scenario[]; rationale: string; confidence: "low" | "fair" | "good"; basedOnSales: number;
}

/**
 * Fast sale: 10% under the recent median. Maximise price: the upper quartile of recent sales. Balanced: the median. Each price is rounded
 * to a sensible step and paired with the estimated days when the price-to-days link is clear. Never advice on a legal or financial matter.
 */
export function pricingAdvice(goal: SellerGoal, s: SellerSubject, all: readonly Comparable[], now: string): PricingAdvice | Unavailable {
  const comps = comparableSales(s, all, now);
  if (comps.state !== "ready") return { state: "unavailable", message: "There are not enough recent sales of similar properties in this area to suggest a price." };
  const model = priceDaysModel(s, all, now);
  const prices: Record<SellerGoal, number> = {
    fast_sale: round(comps.medianCents * (1 - FAST_SALE_DISCOUNT)), balanced: round(comps.medianCents), max_price: round(Math.max(comps.p75Cents, comps.medianCents))
  };
  const scenarios = SELLER_GOALS.map((g): Scenario => ({ goal: g, priceCents: prices[g], ...(model.state === "ready" ? { estimatedDays: daysAtPrice(model, prices[g]) } : {}) }));
  const pick = scenarios.find(x => x.goal === goal)!;
  const days = pick.estimatedDays !== undefined ? `, which similar sales suggest could take about ${pick.estimatedDays} days` : "";
  const why = {
    fast_sale: `To sell fast, a price around ${money(pick.priceCents)} sits ${Math.round(FAST_SALE_DISCOUNT * 100)}% under the recent middle of ${money(comps.medianCents)}${days}.`,
    max_price: `To aim for the best price, ${money(pick.priceCents)} is at the top quarter of recent sales (middle ${money(comps.medianCents)})${days}. Expect fewer buyers at this level.`,
    balanced: `A balanced price is around ${money(pick.priceCents)}, the middle of recent sales${days}.`
  }[goal];
  const trend = comps.direction === "up" ? " Prices are rising on the last quarter, which supports the higher end." : comps.direction === "down" ? " Prices are falling on the last quarter, so a lower price may sell more reliably." : "";
  const note = model.state === "ready" ? "" : " Days to sell could not be estimated from the data we have.";
  return {
    state: "ready", goal, recommendedCents: pick.priceCents, scenarios, rationale: `${why}${trend}${note}`.slice(0, 1000),
    confidence: comps.count >= 10 && model.state === "ready" ? model.confidence : comps.count >= 6 ? "fair" : "low", basedOnSales: comps.count
  };
}

/** Everything the seller screens show, in one call. */
export function sellerBundle(s: SellerSubject, all: readonly Comparable[], now: string) {
  const model = priceDaysModel(s, all, now);
  return {
    comparables: comparableSales(s, all, now), trend: sellerTrend(s, all, now), daysOnMarket: daysOnMarket(s, all, now),
    pricingGuide: model.state === "ready" ? { ...model, curve: priceCurve(model) } : model, note: SELLER_NOTE
  };
}

/** The price-to-days model out of a bundle's `pricingGuide` (which carries the model's fields plus a curve), or its unavailable answer. */
export const pricingGuideModel = (g: ReturnType<typeof sellerBundle>["pricingGuide"] | undefined): PriceDaysModel | Unavailable | undefined =>
  g === undefined ? undefined : g.state === "ready" ? (g as PriceDaysModel) : g;
