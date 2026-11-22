import { formatPrice } from "./listing-details";
import { estimatePrice, roundStep, roundTo, weightedQuantile, type Comparable, type Subject } from "./price-guidance";
import {
  CONDITION_FACTOR, intelAnswer, marketInsights, sizeAdjusted,
  type IntelAnswer, type IntelBundle, type IntelQuery, type MarketInsights, type MarketUnavailable, type TrendUnavailable, type ValueTrend, type Valuation
} from "./property-intelligence";

/**
 * Elena's market intelligence, second layer: valuation breakdown, trend forecast, investment fundamentals, buyer demand outlook and
 * market-shift detection. Pure and deterministic, built on the figures property-intelligence already works out. Advisory only: a forecast
 * is a statistical extrapolation of past sales, not a prediction of what will happen, and nothing here is financial or investment advice.
 */

export const FORECAST_MODEL_VERSION = "forecast-v1";
export const SCORE_MODEL_VERSION = "fundamentals-v1";
export const DEMAND_MODEL_VERSION = "demand-v1";
export const FORECAST_NOTE =
  "A statistical extension of past sales, not a prediction. Markets change for reasons sales history cannot show. It is not financial or investment advice and does not replace a licensed valuer.";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (from: number, to: number) => round1(((to - from) / from) * 100);

type Pt = { x: number; y: number; w: number };
/** Weighted least squares line. Undefined when the points do not spread along x. */
function fitLine(pts: readonly Pt[]): { a: number; b: number; sd: number; r2: number; xbar: number; sxx: number; n: number } | undefined {
  const n = pts.length;
  const sw = pts.reduce((s, p) => s + p.w, 0);
  if (n < 3 || sw <= 0) return undefined;
  const xbar = pts.reduce((s, p) => s + p.w * p.x, 0) / sw, ybar = pts.reduce((s, p) => s + p.w * p.y, 0) / sw;
  const sxx = pts.reduce((s, p) => s + p.w * (p.x - xbar) ** 2, 0);
  if (sxx <= 0) return undefined;
  const b = pts.reduce((s, p) => s + p.w * (p.x - xbar) * (p.y - ybar), 0) / sxx;
  const a = ybar - b * xbar;
  const sse = pts.reduce((s, p) => s + p.w * (p.y - (a + b * p.x)) ** 2, 0);
  const sst = pts.reduce((s, p) => s + p.w * (p.y - ybar) ** 2, 0);
  return { a, b, sd: Math.sqrt(sse / sw * (n / Math.max(1, n - 2))), r2: sst > 0 ? 1 - sse / sst : 0, xbar, sxx: sxx / sw, n };
}

// ---- 1. Valuation breakdown ----------------------------------------------------------------------------------------------------

export interface BreakdownStep { key: "comparables" | "features" | "size" | "condition"; label: string; deltaCents: number; runningCents: number; detail: string }
export interface BreakdownComparable { id: string; suburb: string; date: string; priceCents: number; adjustedCents: number; sharePercent: number; label?: string | undefined }
export interface ValuationBreakdown { startCents: number; endCents: number; steps: BreakdownStep[]; topComparables: BreakdownComparable[] }

/** Where the estimate came from: the plain comparable median, then what each adjustment added or took off. The steps always add up to the estimate. */
export function valuationBreakdown(q: IntelQuery, all: readonly Comparable[], now: string, v: Valuation): ValuationBreakdown | undefined {
  const plain = estimatePrice(q, all, now);
  if (!plain) return undefined;
  const sized = sizeAdjusted(q, all);
  const withSize = sized.used ? estimatePrice(q, sized.comps, now) : plain;
  if (!withSize) return undefined;
  const tx = q.transactionType;
  const start = Math.round(weightedQuantile(plain.comparables.map(c => ({ v: c.priceCents, w: c.weight })), 0.5));
  const features = plain.midCents - start, size = withSize.midCents - plain.midCents, condition = v.midCents - withSize.midCents;
  const steps: BreakdownStep[] = [];
  let run = start;
  const push = (key: BreakdownStep["key"], label: string, delta: number, detail: string) => { run += delta; steps.push({ key, label, deltaCents: delta, runningCents: run, detail }); };
  push("comparables", "Similar results nearby", 0, `Weighted middle of ${plain.comparables.length} recent ${tx === "rent" ? "leases" : "sales"}, as they sold.`);
  push("features", "Bedrooms, bathrooms and parking", features, "Each result moved to this property's bedrooms, bathrooms and parking.");
  push("size", "Land or floor size", size, sized.used ? "Results moved to this property's size with a mild elasticity." : "No size given, so no size adjustment.");
  push("condition", "Condition", condition, v.factors.condition === "good" ? "Typical condition assumed." : `Condition set to ${v.factors.condition} (${Math.round((CONDITION_FACTOR[v.factors.condition] - 1) * 1000) / 10}%).`);
  const totalW = plain.comparables.reduce((s, c) => s + c.weight, 0) || 1;
  const topComparables = plain.comparables.slice(0, 5).map(c => ({
    id: c.id, suburb: c.suburb, date: c.date, priceCents: c.priceCents, adjustedCents: c.adjustedCents, sharePercent: Math.round((c.weight / totalW) * 100), label: c.label
  }));
  return { startCents: start, endCents: v.midCents, steps, topComparables };
}

// ---- 2. Trend forecast ---------------------------------------------------------------------------------------------------------

export interface ForecastPoint { months: number; lowCents: number; midCents: number; highCents: number; changePercent: number }
export type ForecastDirection = "rising" | "steady" | "falling";
export interface Forecast {
  state: "ready"; modelVersion: string; horizons: ForecastPoint[]; annualisedPercent: number; direction: ForecastDirection;
  confidence: "low" | "fair" | "good"; intervalPercent: number; basedOnMonths: number; note: string;
}
export type ForecastUnavailable = { state: "unavailable"; message: string };
export const FORECAST_UNAVAILABLE = "There is not enough sales history in this area to look ahead.";
export const MIN_FORECAST_POINTS = 6;
const DAMPING = 0.92;
const Z80 = 1.2816;
const monthNo = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;

/** Damped log-linear extension of the rolling monthly median, with an 80% range that widens with the horizon. */
export function forecastTrend(trend: ValueTrend | TrendUnavailable, tx: "sale" | "rent", horizons: readonly number[] = [3, 6, 12]): Forecast | ForecastUnavailable {
  if (trend.state !== "ready" || trend.points.length < MIN_FORECAST_POINTS) return { state: "unavailable", message: FORECAST_UNAVAILABLE };
  const pts = trend.points.map(p => ({ x: monthNo(p.month), y: Math.log(p.medianCents), w: Math.min(p.count, 10) }));
  const fit = fitLine(pts);
  if (!fit) return { state: "unavailable", message: FORECAST_UNAVAILABLE };
  const last = pts[pts.length - 1]!;
  const level = fit.a + fit.b * last.x;
  const lastFitted = Math.exp(level);
  const out: ForecastPoint[] = horizons.filter(h => Number.isInteger(h) && h >= 1 && h <= 24).map(h => {
    let drift = 0;
    for (let k = 1; k <= h; k++) drift += fit.b * DAMPING ** k;
    const se = fit.sd * Math.sqrt(1 + 1 / fit.n + (last.x + h - fit.xbar) ** 2 / (fit.sxx * fit.n));
    const step = roundStep(tx, lastFitted);
    const at = (z: number) => roundTo(Math.exp(level + drift + z * se), step);
    const mid = at(0);
    return { months: h, lowCents: at(-Z80), midCents: mid, highCents: at(Z80), changePercent: pct(trend.points[trend.points.length - 1]!.medianCents, mid) };
  });
  let year = 0;
  for (let k = 1; k <= 12; k++) year += fit.b * DAMPING ** k;
  const annualisedPercent = round1((Math.exp(year) - 1) * 100);
  const direction: ForecastDirection = annualisedPercent >= 2 ? "rising" : annualisedPercent <= -2 ? "falling" : "steady";
  const confidence = fit.n >= 12 && fit.r2 >= 0.6 ? "good" : fit.n >= 8 && fit.r2 >= 0.3 ? "fair" : "low";
  return { state: "ready", modelVersion: FORECAST_MODEL_VERSION, horizons: out, annualisedPercent, direction, confidence, intervalPercent: 80, basedOnMonths: fit.n, note: FORECAST_NOTE };
}

// ---- 3. Investment fundamentals score ------------------------------------------------------------------------------------------

export type ScoreLabel = "strong" | "moderate" | "weak";
export interface ScoreComponent { key: "growth" | "yield" | "liquidity" | "momentum" | "stability"; label: string; score: number; weight: number; reason: string }
export interface InvestmentScore {
  state: "ready"; modelVersion: string; score: number; label: ScoreLabel; components: ScoreComponent[];
  grossYieldPercent?: number | undefined; confidence: "low" | "fair" | "good"; note: string;
}
export type ScoreUnavailable = { state: "unavailable"; message: string };
export const SCORE_UNAVAILABLE = "There is not enough sales activity in this area to score its fundamentals.";
export const SCORE_NOTE =
  "A summary of area fundamentals worked out from recent results. It is not a rating of any one property, not a prediction and not financial or investment advice.";
const scale = (v: number, zero: number, full: number) => Math.round(clamp(((v - zero) / (full - zero)) * 100, 0, 100));

export interface ScoreInputs {
  market: MarketInsights | MarketUnavailable;
  forecast?: Forecast | ForecastUnavailable | undefined;
  /** Rental market for the same area and property type; gives the yield. */
  rentMarket?: MarketInsights | MarketUnavailable | undefined;
}

/** Five area-level components, each 0 to 100, weighted. A component with no data is left out and the others are re-weighted. */
export function investmentScore(i: ScoreInputs): InvestmentScore | ScoreUnavailable {
  if (i.market.state !== "ready") return { state: "unavailable", message: SCORE_UNAVAILABLE };
  const m = i.market;
  const parts: ScoreComponent[] = [];
  const growthPct = i.forecast?.state === "ready" ? i.forecast.annualisedPercent : m.change12mPercent ?? m.change6mPercent;
  if (growthPct !== undefined) {
    parts.push({ key: "growth", label: "Price growth", weight: 30, score: scale(growthPct, -10, 10),
      reason: `${i.forecast?.state === "ready" ? "Projected" : "Recent"} median movement of ${growthPct > 0 ? "+" : ""}${growthPct}% a year.` });
  }
  let grossYieldPercent: number | undefined;
  if (i.rentMarket?.state === "ready") {
    grossYieldPercent = round1((i.rentMarket.medianCents * 52 * 100) / m.medianCents);
    parts.push({ key: "yield", label: "Rental yield", weight: 25, score: scale(grossYieldPercent, 2, 6),
      reason: `Gross yield of about ${grossYieldPercent}% from median rent against median price, before costs.` });
  }
  parts.push(m.medianDaysOnMarket !== undefined
    ? { key: "liquidity", label: "Time to sell", weight: 20, score: scale(90 - m.medianDaysOnMarket, 0, 60), reason: `Median ${m.medianDaysOnMarket} days on the market.` }
    : { key: "liquidity", label: "Sales pace", weight: 20, score: scale(m.salesPerMonth, 1, 8), reason: `About ${m.salesPerMonth} results a month.` });
  if (m.velocity) {
    parts.push({ key: "momentum", label: "Momentum", weight: 15, score: m.velocity === "heating" ? 80 : m.velocity === "steady" ? 55 : 25,
      reason: `Activity is ${m.velocity}: ${m.salesLast3m} results in 3 months against ${m.salesPrev3m} before.` });
  }
  const spread = (m.p75Cents - m.p25Cents) / m.medianCents;
  parts.push({ key: "stability", label: "Price consistency", weight: 10, score: scale(0.6 - spread, 0, 0.4), reason: `The middle half of results spans ${Math.round(spread * 100)}% of the median.` });
  if (parts.length < 3) return { state: "unavailable", message: SCORE_UNAVAILABLE };
  const totalW = parts.reduce((s, p) => s + p.weight, 0);
  const score = Math.round(parts.reduce((s, p) => s + p.score * p.weight, 0) / totalW);
  const confidence = m.sampleSize >= 20 && parts.length >= 4 ? "good" : m.sampleSize >= 10 ? "fair" : "low";
  return { state: "ready", modelVersion: SCORE_MODEL_VERSION, score, label: score >= 70 ? "strong" : score >= 50 ? "moderate" : "weak", components: parts, grossYieldPercent, confidence, note: SCORE_NOTE };
}

// ---- 4. Buyer demand outlook ---------------------------------------------------------------------------------------------------

/** Platform activity per week, oldest first, for the listings in the area. Counts only. */
export interface DemandFacts { weeks: { saves: number; enquiries: number; offers: number }[]; activeListings: number }
export type Outlook = "rising" | "steady" | "easing";
export interface DemandOutlook {
  state: "ready"; modelVersion: string; outlook: Outlook; score: number; recentChangePercent: number | undefined; interestPerListing: number;
  next4Weeks: { lowActivity: number; midActivity: number; highActivity: number }; weeks: number; confidence: "low" | "fair" | "good"; note: string;
}
export type DemandUnavailable = { state: "unavailable"; message: string };
export const DEMAND_UNAVAILABLE = "There is not enough buyer activity on the platform in this area yet to read demand.";
export const DEMAND_NOTE = "Based only on activity on this platform (saves, enquiries and offers), which is a sample of the market, not all of it. A rough outlook, not a prediction.";
export const MIN_DEMAND_WEEKS = 6;
export const MIN_DEMAND_ACTIVITY = 12;
/** An offer shows more intent than an enquiry, and an enquiry more than a save. */
const WEIGHT = { saves: 1, enquiries: 3, offers: 8 } as const;

export function demandOutlook(f: DemandFacts): DemandOutlook | DemandUnavailable {
  if (f.weeks.length < MIN_DEMAND_WEEKS) return { state: "unavailable", message: DEMAND_UNAVAILABLE };
  const act = f.weeks.map(w => w.saves * WEIGHT.saves + w.enquiries * WEIGHT.enquiries + w.offers * WEIGHT.offers);
  const total = act.reduce((s, n) => s + n, 0);
  if (total < MIN_DEMAND_ACTIVITY) return { state: "unavailable", message: DEMAND_UNAVAILABLE };
  const half = Math.floor(act.length / 2);
  const prior = act.slice(0, half).reduce((s, n) => s + n, 0), recent = act.slice(act.length - half).reduce((s, n) => s + n, 0);
  const recentChangePercent = prior > 0 ? pct(prior, recent) : undefined;
  const fit = fitLine(act.map((y, x) => ({ x, y, w: 1 })));
  const mean = total / act.length;
  const last = act.length - 1;
  const level = fit ? fit.a + fit.b * last : mean;
  const project = (k: number) => { let d = 0; for (let j = 1; j <= k; j++) d += (fit?.b ?? 0) * DAMPING ** j; return Math.max(0, level + d); };
  const mid = Math.round(project(4) * 4), sd = fit?.sd ?? Math.sqrt(mean);
  const band = Math.round(Z80 * sd * 2);
  const slopeRel = fit ? (fit.b * 4) / Math.max(1, mean) : 0;
  const outlook: Outlook = slopeRel >= 0.15 ? "rising" : slopeRel <= -0.15 ? "easing" : "steady";
  const interestPerListing = round1((f.weeks.reduce((s, w) => s + w.saves + w.enquiries + w.offers, 0) / Math.max(1, f.activeListings)) / f.weeks.length * 4);
  let score = 50 + (recentChangePercent === undefined ? 0 : clamp(recentChangePercent, -60, 60) * 0.5);
  score += interestPerListing >= 5 ? 10 : interestPerListing < 1 ? -10 : 0;
  const confidence = f.weeks.length >= 10 && total >= 60 ? "good" : total >= 30 ? "fair" : "low";
  return {
    state: "ready", modelVersion: DEMAND_MODEL_VERSION, outlook, score: Math.round(clamp(score, 0, 100)), recentChangePercent, interestPerListing,
    next4Weeks: { lowActivity: Math.max(0, mid - band), midActivity: mid, highActivity: mid + band }, weeks: f.weeks.length, confidence, note: DEMAND_NOTE
  };
}

// ---- 5. Market shifts (proactive alerts) ---------------------------------------------------------------------------------------

export type ShiftKind = "prices_up" | "prices_down" | "heating" | "cooling" | "slower_sales" | "faster_sales" | "demand_up" | "demand_down";
export interface MarketShift { kind: ShiftKind; severity: "notable" | "major"; title: string; text: string }
export const SHIFT_THRESHOLDS = { priceNotable: 5, priceMajor: 10, domNotablePercent: 20, domMinDays: 7, demandNotable: 40, demandMajor: 80 } as const;

export interface ShiftInputs {
  area: string;
  now: MarketInsights | MarketUnavailable;
  /** The same figures as they stood about a month ago. */
  before?: MarketInsights | MarketUnavailable | undefined;
  demand?: DemandOutlook | DemandUnavailable | undefined;
}

/** What changed in an area since last month, worth telling an agent about. Facts and counts only; never advice on what to do. */
export function detectMarketShifts(i: ShiftInputs): MarketShift[] {
  if (i.now.state !== "ready") return [];
  const n = i.now, b = i.before?.state === "ready" ? i.before : undefined;
  const out: MarketShift[] = [];
  const T = SHIFT_THRESHOLDS;
  const six = n.change6mPercent;
  if (six !== undefined && Math.abs(six) >= T.priceNotable) {
    const up = six > 0;
    out.push({ kind: up ? "prices_up" : "prices_down", severity: Math.abs(six) >= T.priceMajor ? "major" : "notable",
      title: `${i.area}: prices ${up ? "up" : "down"} ${Math.abs(six)}%`,
      text: `The median in ${i.area} is ${up ? "up" : "down"} ${Math.abs(six)}% on the previous 6 months, from ${n.sampleSize} results in the last year.` });
  }
  if (n.velocity && n.velocity !== "steady" && b?.velocity !== n.velocity) {
    const hot = n.velocity === "heating";
    out.push({ kind: hot ? "heating" : "cooling", severity: Math.abs(n.velocityChangePercent ?? 0) >= 50 ? "major" : "notable",
      title: `${i.area}: activity ${hot ? "picking up" : "slowing"}`,
      text: `${n.salesLast3m} results in the last 3 months against ${n.salesPrev3m} in the 3 before (${(n.velocityChangePercent ?? 0) > 0 ? "+" : ""}${n.velocityChangePercent}%).` });
  }
  if (n.medianDaysOnMarket !== undefined && b?.medianDaysOnMarket !== undefined) {
    const d = n.medianDaysOnMarket - b.medianDaysOnMarket;
    if (Math.abs(d) >= T.domMinDays && (Math.abs(d) / b.medianDaysOnMarket) * 100 >= T.domNotablePercent) {
      out.push({ kind: d > 0 ? "slower_sales" : "faster_sales", severity: "notable",
        title: `${i.area}: homes taking ${d > 0 ? "longer" : "less time"} to sell`,
        text: `The median time on the market moved from ${b.medianDaysOnMarket} to ${n.medianDaysOnMarket} days in the last month.` });
    }
  }
  if (i.demand?.state === "ready" && i.demand.recentChangePercent !== undefined && Math.abs(i.demand.recentChangePercent) >= T.demandNotable) {
    const ch = i.demand.recentChangePercent, up = ch > 0;
    out.push({ kind: up ? "demand_up" : "demand_down", severity: Math.abs(ch) >= T.demandMajor ? "major" : "notable",
      title: `${i.area}: buyer interest ${up ? "up" : "down"} ${Math.abs(ch)}%`,
      text: `Saves, enquiries and offers on this platform are ${up ? "up" : "down"} ${Math.abs(ch)}% on the weeks before. Platform activity only.` });
  }
  return out;
}

/** The same area figures as they stood `monthsBack` months earlier, for comparing against today. */
export function marketAt(s: Subject, all: readonly Comparable[], now: string, monthsBack: number): MarketInsights | MarketUnavailable {
  return marketInsights(s, all, new Date(Date.parse(now) - monthsBack * 30.44 * 86_400_000).toISOString());
}

// ---- Bundle and Elena ----------------------------------------------------------------------------------------------------------

export interface ExtendedBundle {
  breakdown?: ValuationBreakdown | undefined;
  forecast: Forecast | ForecastUnavailable;
  score: InvestmentScore | ScoreUnavailable;
  demand?: DemandOutlook | DemandUnavailable | undefined;
}

export function buildExtended(query: IntelQuery, comps: readonly Comparable[], now: string, base: IntelBundle, demand?: DemandFacts): ExtendedBundle {
  const forecast = forecastTrend(base.trend, query.transactionType);
  const rentMarket = query.transactionType === "sale" ? marketInsights({ ...query, transactionType: "rent" }, comps, now) : undefined;
  return {
    breakdown: base.valuation ? valuationBreakdown(query, comps, now, base.valuation) : undefined,
    forecast, score: investmentScore({ market: base.market, forecast, rentMarket }),
    demand: demand ? demandOutlook(demand) : undefined
  };
}

export type ExtendedTopic = "forecast" | "score" | "demand" | "breakdown";
const ASK_ADVICE = /\b(should\s+(i|we)|worth\s+(it|buying|selling)|good\s+(investment|buy|deal|time)|buy\s+now|sell\s+now|guarantee\w*|will\s+(it|prices?)\s+(go|rise|fall|drop|crash)|safe\s+bet)\b/;
const EXT_TOPICS: readonly [ExtendedTopic, RegExp][] = [
  ["forecast", /\b(forecast\w*|predict\w*|projection|project(ed)?|next\s+(year|12\s+months|6\s+months|few\s+months)|outlook|where\s+(are\s+)?prices\s+(going|heading)|future)\b/],
  ["score", /\b(invest\w*|yield|rental\s+return|fundamentals?|score|rating)\b/],
  ["demand", /\b(buyer\s+(demand|interest|activity)|demand|interest\s+level|how\s+many\s+buyers|popular)\b/],
  ["breakdown", /\b(break\s*down|breakdown|what\s+(drives|drove|affects|moves|moved)|which\s+factors?|contribut\w+|why\s+(this|that)\s+(number|figure|value|price))\b/]
];
export const EXT_SUGGESTIONS = ["Where are prices heading?", "How strong are the area fundamentals?", "How is buyer demand?", "What drove this value?"];

const place = (q: Subject) => [q.suburb, q.postcode].filter(Boolean).join(" ") || "this area";
const money = (c: number, tx: "sale" | "rent") => formatPrice(c, tx);

/** Elena's answers for the second layer, falling back to the first. She explains the figures, gives no advice and cannot change a number. */
export function extendedAnswer(b: IntelBundle, x: ExtendedBundle, question: string): IntelAnswer {
  const t = question.normalize("NFKC").toLowerCase().slice(0, 500);
  const q = b.query, tx = q.transactionType;
  const done = (text: string): IntelAnswer => ({ topic: "unknown", text, suggestions: EXT_SUGGESTIONS.slice(0, 3) });
  const topic = EXT_TOPICS.find(([, re]) => re.test(t))?.[0];
  if (ASK_ADVICE.test(t)) {
    return done(`Nobody can say what will happen, and I can't either, and what to do is your decision. What I can do is extend the recent trend in ${place(q)} and show how wide the uncertainty is. For advice on your situation, talk to a licensed agent, valuer or your solicitor.`);
  }
  if (!topic) return intelAnswer(b, question);
  switch (topic) {
    case "forecast": {
      const f = x.forecast;
      if (f.state !== "ready") return done(f.message);
      const h = f.horizons.map(p => `${p.months} months: about ${money(p.midCents, tx)} (${money(p.lowCents, tx)} to ${money(p.highCents, tx)})`).join("; ");
      return done(`If the recent trend in ${place(q)} carried on, slowing as it goes, the median ${tx === "rent" ? "rent" : "price"} would be ${h}. That is ${f.direction} at roughly ${f.annualisedPercent}% a year, from ${f.basedOnMonths} months of history, with ${f.confidence} confidence. The range is ${f.intervalPercent}%. ${f.note}`);
    }
    case "score": {
      const s = x.score;
      if (s.state !== "ready") return done(s.message);
      const parts = s.components.map(c => `${c.label} ${c.score}/100 (${c.reason})`).join(" ");
      return done(`Area fundamentals for ${place(q)} score ${s.score}/100, which I call ${s.label}, with ${s.confidence} confidence. ${parts} ${s.note}`);
    }
    case "demand": {
      const d = x.demand;
      if (!d) return done("I don't have buyer activity for this search. Try a suburb or postcode where listings are on this platform.");
      if (d.state !== "ready") return done(d.message);
      const ch = d.recentChangePercent === undefined ? "" : ` Recent weeks are ${d.recentChangePercent >= 0 ? "up" : "down"} ${Math.abs(d.recentChangePercent)}% on the weeks before.`;
      return done(`Buyer interest in ${place(q)} on this platform looks ${d.outlook}, scoring ${d.score}/100 with ${d.confidence} confidence.${ch} That is about ${d.interestPerListing} saves, enquiries and offers per listing over four weeks. ${d.note}`);
    }
    case "breakdown": {
      const br = x.breakdown;
      if (!br) return done("There isn't an estimate to break down yet, because there are too few recent comparable results.");
      const steps = br.steps.map(s => `${s.label}: ${s.deltaCents === 0 ? "" : s.deltaCents > 0 ? "+" : "-"}${money(Math.abs(s.deltaCents), tx)}`).join("; ").replace(": ;", ";");
      return done(`The estimate starts from ${money(br.startCents, tx)}, the weighted middle of nearby results, and ends at ${money(br.endCents, tx)}. Steps: ${steps}. The biggest influence is ${br.topComparables[0] ? `the ${br.topComparables[0].date.slice(0, 10)} result in ${br.topComparables[0].suburb} (${br.topComparables[0].sharePercent}% of the weight)` : "the nearby results"}.`);
    }
  }
}
