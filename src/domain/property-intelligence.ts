import { formatPrice } from "./listing-details";
import {
  adjust, estimatePrice, groupOf, MIN_COMPARABLES, monthsBetween, roundStep, roundTo, weightedQuantile, weightOf,
  type Comparable, type PriceEstimate, type Subject
} from "./price-guidance";

/**
 * Property intelligence: valuation (AVM), market insights, comparable properties, value trends and a written market report.
 * Everything here is pure and deterministic, worked out from a list of comparable results (the platform's own sales, a file
 * export or a licensed provider; see src/server/property-intelligence.ts). The assistant explains these numbers and never changes them.
 * Advisory only: not a valuation or appraisal for lending or legal use.
 */

export const AVM_MODEL_VERSION = "avm-v1";
export const INTEL_NOTE =
  "A rough guide worked out from recent comparable results. It is not a valuation, appraisal or advice, it may be wrong, and it does not replace a licensed valuer.";
export const INTEL_RATE = { windowMs: 60 * 60 * 1000, perUser: 240 } as const;

/** Share of comparable results the low to high range is meant to cover (the 20th to 80th percentile). */
export const INTERVAL_PERCENT = 60;
/** Fewer area sales than this in the last 12 months and market figures are not shown. */
export const MIN_MARKET_SALES = 5;

export const CONDITIONS = ["poor", "fair", "good", "excellent"] as const;
export type Condition = (typeof CONDITIONS)[number];
/** Steps against a typical ("good") property. Product and the AI/ML lead can tune these. */
export const CONDITION_FACTOR: Record<Condition, number> = { poor: 0.92, fair: 0.97, good: 1, excellent: 1.05 };

export interface IntelQuery extends Subject {
  areaSqm?: number;
  condition?: Condition;
}

const PROPERTY_TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"];
const isInt = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

/** Reads a query from URL parameters or a JSON body. Nothing is guessed: bad values are refused with a message. */
export function parseIntelQuery(get: (key: string) => string | number | null | undefined): { ok: true; query: IntelQuery } | { ok: false; error: string } {
  const str = (k: string) => { const v = get(k); return v === null || v === undefined ? undefined : String(v).trim(); };
  const tx = str("transactionType") ?? "sale";
  if (tx !== "sale" && tx !== "rent") return { ok: false, error: "Choose sale or rent." };
  const propertyType = str("propertyType") ?? "house";
  if (!PROPERTY_TYPES.includes(propertyType)) return { ok: false, error: "Unknown property type." };
  const suburb = str("suburb"), postcode = str("postcode");
  if (!suburb && !postcode) return { ok: false, error: "Enter a suburb or a postcode." };
  if (suburb !== undefined && (suburb.length < 1 || suburb.length > 80)) return { ok: false, error: "The suburb is too long." };
  if (postcode !== undefined && postcode !== "" && !/^\d{4}$/.test(postcode)) return { ok: false, error: "A postcode has four digits." };
  const q: IntelQuery = { transactionType: tx, propertyType };
  if (suburb) q.suburb = suburb;
  if (postcode) q.postcode = postcode;
  for (const [k, max] of [["bedrooms", 20], ["bathrooms", 20], ["parking", 20]] as const) {
    const raw = str(k);
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!isInt(n, 0, max)) return { ok: false, error: `Check the number of ${k}.` };
    q[k] = n;
  }
  const area = str("areaSqm");
  if (area !== undefined && area !== "") {
    const n = Number(area);
    if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return { ok: false, error: "Check the size in square metres." };
    q.areaSqm = Math.round(n);
  }
  const condition = str("condition");
  if (condition !== undefined && condition !== "") {
    if (!(CONDITIONS as readonly string[]).includes(condition)) return { ok: false, error: "Condition is poor, fair, good or excellent." };
    q.condition = condition as Condition;
  }
  return { ok: true, query: q };
}

const sameArea = (s: Subject, c: Comparable): boolean => {
  if (s.suburb !== undefined && c.suburb.trim().toLowerCase() === s.suburb.trim().toLowerCase()) return true;
  return s.postcode !== undefined && c.postcode !== undefined && c.postcode === s.postcode;
};
const comparableToQuery = (s: Subject, c: Comparable, now: string): boolean =>
  c.transactionType === s.transactionType && groupOf(c.propertyType) === groupOf(s.propertyType) && c.priceCents > 0 &&
  Number.isFinite(Date.parse(c.date)) && Date.parse(c.date) <= Date.parse(now);
const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
const pct = (from: number, to: number) => Math.round(((to - from) / from) * 1000) / 10;

// ---- 1. Valuation (AVM) ----

export type ConfidenceLabel = "low" | "fair" | "good";
export const confidenceLabel = (c: number): ConfidenceLabel => (c >= 0.7 ? "good" : c >= 0.5 ? "fair" : "low");

export interface Valuation {
  lowCents: number; midCents: number; highCents: number;
  /** 0 to 1. */
  confidence: number; confidenceLabel: ConfidenceLabel; intervalPercent: number;
  comparablesUsed: number; modelVersion: string;
  factors: { condition: Condition; conditionFactor: number; sizeAdjusted: boolean };
  /** Plain steps, in order, of how the number was worked out. */
  methodology: string[];
  basis: string[];
  estimate: PriceEstimate;
}

/** Brings each comparable to the subject's size (a mild elasticity, so a bigger block moves the price less than proportionally). */
export function sizeAdjusted(q: IntelQuery, all: readonly Comparable[]): { comps: Comparable[]; used: boolean } {
  if (q.areaSqm === undefined) return { comps: [...all], used: false };
  let used = false;
  const comps = all.map(c => {
    if (c.areaSqm === undefined) return c;
    used = true;
    const f = Math.min(1.25, Math.max(0.8, Math.pow(q.areaSqm! / c.areaSqm, 0.4)));
    return { ...c, priceCents: Math.round(c.priceCents * f) };
  });
  return { comps, used };
}

/** The estimated value with its range, or undefined when there is too little comparable data (never a guess). */
export function valueProperty(q: IntelQuery, all: readonly Comparable[], now: string): Valuation | undefined {
  const { comps, used } = sizeAdjusted(q, all);
  const e = estimatePrice(q, comps, now);
  if (!e) return undefined;
  const condition: Condition = q.condition ?? "good";
  const factor = CONDITION_FACTOR[condition];
  const step = roundStep(q.transactionType, e.midCents);
  const scale = (v: number) => (factor === 1 ? v : roundTo(v * factor, step));
  const low = scale(e.lowCents), mid = scale(e.midCents), high = scale(e.highCents);
  const methodology = [
    "1. Find recent sales or leases of similar properties in the same suburb or postcode.",
    "2. Adjust each result for differences in bedrooms, bathrooms and parking" + (used ? ", and for land or floor size." : "."),
    "3. Weight results: newer, closer and more similar properties count more.",
    `4. Take the weighted middle as the estimate and the 20th to 80th percentile as the range, so about ${INTERVAL_PERCENT}% of similar results fall inside it.`,
    condition === "good"
      ? "5. Condition is assumed typical, so no condition adjustment was made."
      : `5. Condition was set to ${condition}, which moves the figures by ${Math.round((factor - 1) * 1000) / 10}%.`,
    "6. Confidence combines how many comparable results there are, how tightly they agree and how recent they are."
  ];
  return {
    lowCents: low, midCents: mid, highCents: high, confidence: e.confidence, confidenceLabel: confidenceLabel(e.confidence),
    intervalPercent: INTERVAL_PERCENT, comparablesUsed: e.comparables.length, modelVersion: AVM_MODEL_VERSION,
    factors: { condition, conditionFactor: factor, sizeAdjusted: used }, methodology, basis: e.basis, estimate: e
  };
}

// ---- 2. Market insights ----

export type Velocity = "heating" | "steady" | "cooling";

export interface MarketInsights {
  state: "ready";
  suburb?: string | undefined; postcode?: string | undefined;
  /** Results in the area over the last 12 months. */
  sampleSize: number;
  medianCents: number; p25Cents: number; p75Cents: number;
  /** Change in the median: last 6 months against the 6 months before. Undefined when the earlier half is too thin. */
  change6mPercent?: number | undefined;
  /** Change in the median: last 12 months against the 12 months before. */
  change12mPercent?: number | undefined;
  salesPerMonth: number; salesLast3m: number; salesPrev3m: number;
  /** Sales pace in the last 3 months against the 3 before. */
  velocity?: Velocity | undefined;
  velocityChangePercent?: number | undefined;
  medianDaysOnMarket?: number | undefined; daysOnMarketSample: number;
}
export type MarketUnavailable = { state: "unavailable"; sampleSize: number; message: string };
export const MARKET_UNAVAILABLE = "There are not enough recent sales or leases in this area to show market figures.";

export function marketInsights(s: Subject, all: readonly Comparable[], now: string): MarketInsights | MarketUnavailable {
  const area = all.filter(c => comparableToQuery(s, c, now) && sameArea(s, c));
  const within = (c: Comparable, from: number, to: number) => { const m = monthsBetween(c.date, now); return m >= from && m < to; };
  const last12 = area.filter(c => within(c, 0, 12));
  if (last12.length < MIN_MARKET_SALES) return { state: "unavailable", sampleSize: last12.length, message: MARKET_UNAVAILABLE };
  const prices = last12.map(c => c.priceCents);
  const out: MarketInsights = {
    state: "ready", suburb: s.suburb, postcode: s.postcode, sampleSize: last12.length,
    medianCents: median(prices), p25Cents: weightedQuantile(prices.map(v => ({ v, w: 1 })), 0.25), p75Cents: weightedQuantile(prices.map(v => ({ v, w: 1 })), 0.75),
    salesPerMonth: Math.round((last12.length / 12) * 10) / 10,
    salesLast3m: area.filter(c => within(c, 0, 3)).length, salesPrev3m: area.filter(c => within(c, 3, 6)).length,
    daysOnMarketSample: 0
  };
  const half = (from: number, to: number) => area.filter(c => within(c, from, to)).map(c => c.priceCents);
  const recent6 = half(0, 6), prior6 = half(6, 12);
  if (recent6.length >= 3 && prior6.length >= 3) out.change6mPercent = pct(median(prior6), median(recent6));
  const prior12 = half(12, 24);
  if (prior12.length >= MIN_MARKET_SALES) out.change12mPercent = pct(median(prior12), median(prices));
  if (out.salesPrev3m >= 2) {
    const change = pct(out.salesPrev3m, out.salesLast3m);
    out.velocityChangePercent = change;
    out.velocity = change >= 20 ? "heating" : change <= -20 ? "cooling" : "steady";
  }
  const dom = last12.flatMap(c => (c.daysOnMarket !== undefined ? [c.daysOnMarket] : []));
  out.daysOnMarketSample = dom.length;
  if (dom.length >= 3) out.medianDaysOnMarket = median(dom);
  return out;
}

// ---- 3. Comparable properties ----

export interface ComparableRow {
  id: string; suburb: string; propertyType: string; date: string; priceCents: number; adjustedCents: number;
  bedrooms?: number | undefined; bathrooms?: number | undefined; parking?: number | undefined; areaSqm?: number | undefined;
  daysOnMarket?: number | undefined; distanceKm?: number | undefined; label?: string | undefined;
  /** 0 to 100: how alike and how recent. */
  similarity: number;
}

/** The most similar recent results in the area, best first. Looks back 12 months. */
export function findComparableProperties(s: Subject, all: readonly Comparable[], now: string, limit = 10): ComparableRow[] {
  const pool = all.filter(c => comparableToQuery(s, c, now) && sameArea(s, c) && monthsBetween(c.date, now) <= 12);
  const rows = pool.map(c => ({ c, w: weightOf(s, c, now) })).filter(x => x.w > 0).sort((a, b) => b.w - a.w || a.c.id.localeCompare(b.c.id)).slice(0, Math.max(1, Math.min(limit, 25)));
  const top = rows[0]?.w ?? 1;
  return rows.map(({ c, w }) => ({
    id: c.id, suburb: c.suburb, propertyType: c.propertyType, date: c.date, priceCents: c.priceCents, adjustedCents: adjust(s, c),
    ...(c.bedrooms !== undefined ? { bedrooms: c.bedrooms } : {}), ...(c.bathrooms !== undefined ? { bathrooms: c.bathrooms } : {}),
    ...(c.parking !== undefined ? { parking: c.parking } : {}), ...(c.areaSqm !== undefined ? { areaSqm: c.areaSqm } : {}),
    ...(c.daysOnMarket !== undefined ? { daysOnMarket: c.daysOnMarket } : {}), ...(c.distanceKm !== undefined ? { distanceKm: c.distanceKm } : {}),
    ...(c.label ? { label: c.label } : {}), similarity: Math.round((w / top) * 100)
  }));
}

// ---- 4. Value trends ----

export interface TrendPoint { month: string; medianCents: number; count: number }
export interface ValueTrend { state: "ready"; points: TrendPoint[]; changePercent?: number | undefined; fromMonth: string; toMonth: string }
export type TrendUnavailable = { state: "unavailable"; message: string };
export const TREND_UNAVAILABLE = "There is not enough sales history in this area to draw a trend.";
const monthKey = (iso: string) => iso.slice(0, 7);

/** Rolling three-month median per month, so one odd sale cannot swing the line. Months with fewer than three results are left out. */
export function valueTrend(s: Subject, all: readonly Comparable[], now: string, months = 24): ValueTrend | TrendUnavailable {
  const span = Math.max(6, Math.min(60, months));
  const area = all.filter(c => comparableToQuery(s, c, now) && sameArea(s, c) && monthsBetween(c.date, now) < span + 2);
  const end = new Date(now);
  const points: TrendPoint[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    const key = m.toISOString().slice(0, 7);
    const keys = new Set([0, 1, 2].map(k => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() - k, 1)).toISOString().slice(0, 7)));
    const inWindow = area.filter(c => keys.has(monthKey(c.date)));
    if (inWindow.length >= MIN_COMPARABLES) points.push({ month: key, medianCents: median(inWindow.map(c => c.priceCents)), count: inWindow.length });
  }
  if (points.length < 3) return { state: "unavailable", message: TREND_UNAVAILABLE };
  const first = points[0]!, last = points[points.length - 1]!;
  return { state: "ready", points, changePercent: pct(first.medianCents, last.medianCents), fromMonth: first.month, toMonth: last.month };
}

// ---- Market report and the assistant's words ----

export interface IntelBundle {
  query: IntelQuery;
  valuation?: Valuation | undefined;
  market: MarketInsights | MarketUnavailable;
  trend: ValueTrend | TrendUnavailable;
  comparables: ComparableRow[];
}

const place = (q: Subject) => [q.suburb, q.postcode].filter(Boolean).join(" ") || "this area";
const signed = (n: number) => `${n > 0 ? "up" : n < 0 ? "down" : "flat"} ${Math.abs(n)}%`;
const money = (c: number, tx: "sale" | "rent") => formatPrice(c, tx);
const label = (tx: "sale" | "rent") => (tx === "rent" ? "lease" : "sale");

export interface MarketReport { title: string; sections: { heading: string; body: string }[]; considerations: string[]; note: string }

/**
 * A plain-English report from the numbers. "Things to consider" are observations from the data, not advice on what to do.
 */
export function marketReport(b: IntelBundle): MarketReport {
  const q = b.query, tx = q.transactionType;
  const sections: MarketReport["sections"] = [];
  const considerations: string[] = [];
  if (b.valuation) {
    const v = b.valuation;
    sections.push({
      heading: "Estimated value",
      body: `The guide for a ${q.bedrooms !== undefined ? `${q.bedrooms}-bedroom ` : ""}${q.propertyType} in ${place(q)} is ${money(v.lowCents, tx)} to ${money(v.highCents, tx)}, with a middle of ${money(v.midCents, tx)}. ` +
        `Confidence is ${v.confidenceLabel} (${Math.round(v.confidence * 100)}%), from ${v.comparablesUsed} comparable results.`
    });
    if (v.confidence < 0.5) considerations.push("Confidence is low, so treat the range as a rough guide and ask a licensed valuer if the figure matters.");
    if ((v.highCents - v.lowCents) / v.midCents > 0.25) considerations.push("Comparable results vary a lot, so the range is wide.");
  } else {
    sections.push({ heading: "Estimated value", body: "There are not enough recent comparable results to estimate a value for this property." });
  }
  if (b.market.state === "ready") {
    const m = b.market;
    const parts = [`The median ${label(tx)} price in ${place(q)} over the last 12 months is ${money(m.medianCents, tx)}, from ${m.sampleSize} results (middle half between ${money(m.p25Cents, tx)} and ${money(m.p75Cents, tx)}).`];
    if (m.change12mPercent !== undefined) parts.push(`The median is ${signed(m.change12mPercent)} on the 12 months before.`);
    else if (m.change6mPercent !== undefined) parts.push(`The median is ${signed(m.change6mPercent)} on the previous 6 months.`);
    if (m.velocity) parts.push(`Activity is ${m.velocity}: ${m.salesLast3m} results in the last 3 months against ${m.salesPrev3m} in the 3 before.`);
    if (m.medianDaysOnMarket !== undefined) parts.push(`The median time on the market is ${m.medianDaysOnMarket} days (${m.daysOnMarketSample} results with dates).`);
    sections.push({ heading: "Market", body: parts.join(" ") });
    if (m.velocity === "cooling") considerations.push("Fewer results are coming through than a few months ago, which can mean slower demand or just fewer listings.");
    if (m.velocity === "heating") considerations.push("More results are coming through than a few months ago, which can mean stronger demand.");
    if (m.medianDaysOnMarket !== undefined && m.medianDaysOnMarket > 60) considerations.push("Properties here have been taking a while to sell.");
    if (m.sampleSize < 10) considerations.push("There are only a handful of results, so one unusual sale can move these figures.");
  } else sections.push({ heading: "Market", body: b.market.message });
  if (b.trend.state === "ready") {
    const t = b.trend;
    sections.push({ heading: "Value trend", body: `Between ${t.fromMonth} and ${t.toMonth} the rolling median moved from ${money(t.points[0]!.medianCents, tx)} to ${money(t.points[t.points.length - 1]!.medianCents, tx)}, ${signed(t.changePercent ?? 0)}.` });
  } else sections.push({ heading: "Value trend", body: b.trend.message });
  if (b.comparables.length) {
    const c = b.comparables[0]!;
    sections.push({ heading: "Comparable properties", body: `${b.comparables.length} similar recent results found. The closest match was a ${c.bedrooms !== undefined ? `${c.bedrooms}-bedroom ` : ""}${c.propertyType} in ${c.suburb} at ${money(c.priceCents, tx)} on ${c.date.slice(0, 10)}.` });
  }
  return { title: `Market report: ${place(q)}`, sections, considerations, note: INTEL_NOTE };
}

export type IntelTopic = "methodology" | "confidence" | "trends" | "market" | "comparables" | "report" | "advice" | "unknown";
export interface IntelAnswer { topic: IntelTopic; text: string; suggestions: string[] }

const ADVICE = /\b(should\s+(i|we)|worth\s+(it|buying|selling)|good\s+(time|deal|investment|buy)|buy\s+now|sell\s+now|list\s+(it\s+)?at|what\s+price\s+should|guarantee)\b/;
const INTEL_TOPICS: readonly [IntelTopic, RegExp][] = [
  ["report", /\b(report|summary|summaris\w+|summariz\w+|overview|full\s+picture|write\s+up)\b/],
  ["confidence", /\b(confiden\w+|accura\w+|reliable|how\s+sure|certain|margin|interval|range|error|trust)\b/],
  ["methodology", /\b(method\w*|how\s+(is|was|did|do|does|are|were)\b.{0,40}\b(work(ed|s)?|calculat\w*|estimat\w*|deriv\w*|arriv\w*|valu(e|ed)|come\s+up)|algorithm|model|why\s+(this|that)\s+(number|figure|value|price)|adjust\w*|condition|calculation)\b/],
  ["trends", /\b(trend\w*|history|over\s+time|growth|growing|rising|rose|falling|fell|dropp?ed?|increase\w*|decrease\w*|chart|last\s+(year|12|6)|year\s+on\s+year|appreciat\w+)\b/],
  ["market", /\b(market|demand|days\s+on\s+market|dom|how\s+(fast|quick)|sell(ing)?\s+(fast|quick)|velocity|activity|competition|hot|cool\w*|median|average|typical)\b/],
  ["comparables", /\b(compar\w+|comps?|similar|nearby|recent\s+sales?|sold|neighbou?rs?)\b/]
];

export const INTEL_SUGGESTIONS = ["How was this value worked out?", "How confident is the estimate?", "What are the market trends?", "Show me the comparable sales", "Write me a market report"];

/** Elena's answer from the numbers in `b`. She uses only these figures, gives no advice and cannot change a number. */
export function intelAnswer(b: IntelBundle, question: string): IntelAnswer {
  const t = question.normalize("NFKC").toLowerCase().slice(0, 500);
  const q = b.query, tx = q.transactionType, v = b.valuation;
  const done = (topic: IntelTopic, text: string, suggestions = INTEL_SUGGESTIONS.filter(s => !s.toLowerCase().includes(topic))): IntelAnswer => ({ topic, text, suggestions: suggestions.slice(0, 3) });
  if (ADVICE.test(t)) {
    return done("advice", `That's a decision for you, and I can't tell you what to do. I can show you what the numbers say about ${place(q)}. For advice on your situation, talk to a licensed agent, valuer or your solicitor.`);
  }
  let topic: IntelTopic = "unknown";
  for (const [name, re] of INTEL_TOPICS) if (re.test(t)) { topic = name; break; }
  switch (topic) {
    case "methodology": {
      if (!v) return done(topic, "I couldn't work out a value for this property because there are too few recent comparable results nearby. Try a wider search, such as only the postcode, or a more common property type.");
      return done(topic, `Here is how I worked it out. ${v.methodology.join(" ")} The result is ${money(v.lowCents, tx)} to ${money(v.highCents, tx)}, with ${money(v.midCents, tx)} in the middle. I explain the figures; the maths decides them, and I can't change them.`);
    }
    case "confidence": {
      if (!v) return done(topic, "There isn't an estimate to be confident about yet, because there are too few recent comparable results.");
      const spread = Math.round(((v.highCents - v.lowCents) / v.midCents) * 100);
      return done(topic, `Confidence is ${v.confidenceLabel} (${Math.round(v.confidence * 100)}%). The range of ${money(v.lowCents, tx)} to ${money(v.highCents, tx)} is meant to cover about ${v.intervalPercent}% of similar results, so roughly 1 in 5 similar properties would sell above it and 1 in 5 below. ` +
        `It is ${spread}% wide and rests on ${v.comparablesUsed} comparable results. More recent results that agree with each other would narrow it. It is not a formal valuation.`);
    }
    case "trends": {
      if (b.trend.state !== "ready") return done(topic, b.trend.message);
      const tr = b.trend;
      const m = b.market.state === "ready" ? b.market : undefined;
      const extra = m?.change12mPercent !== undefined ? ` The 12-month median is ${signed(m.change12mPercent)} on the year before.` : "";
      return done(topic, `From ${tr.fromMonth} to ${tr.toMonth} the rolling median ${label(tx)} price in ${place(q)} moved from ${money(tr.points[0]!.medianCents, tx)} to ${money(tr.points[tr.points.length - 1]!.medianCents, tx)}, ${signed(tr.changePercent ?? 0)}.${extra} The chart uses three-month medians so one unusual sale doesn't swing it. Past movement doesn't predict the future.`);
    }
    case "market": {
      if (b.market.state !== "ready") return done(topic, b.market.message);
      const m = b.market;
      const bits = [`In ${place(q)} the median ${label(tx)} price over the last 12 months is ${money(m.medianCents, tx)} from ${m.sampleSize} results, about ${m.salesPerMonth} a month.`];
      if (m.velocity) bits.push(`Activity looks ${m.velocity}: ${m.salesLast3m} results in the last 3 months against ${m.salesPrev3m} before that.`);
      if (m.medianDaysOnMarket !== undefined) bits.push(`The median time to ${tx === "rent" ? "lease" : "sell"} is ${m.medianDaysOnMarket} days.`);
      return done(topic, bits.join(" "));
    }
    case "comparables": {
      if (!b.comparables.length) return done(topic, "I couldn't find similar recent results in this area. Try the postcode on its own or a broader property type.");
      const rows = b.comparables.slice(0, 3).map(c => `${c.bedrooms !== undefined ? `${c.bedrooms}-bed ` : ""}${c.propertyType} in ${c.suburb}, ${money(c.priceCents, tx)} on ${c.date.slice(0, 10)}${c.daysOnMarket !== undefined ? ` after ${c.daysOnMarket} days` : ""}`);
      return done(topic, `I found ${b.comparables.length} similar recent results. The closest: ${rows.join("; ")}. Each one is adjusted for differences in bedrooms, bathrooms and parking, and newer, more alike results count more.`);
    }
    case "report": {
      const r = marketReport(b);
      const text = [r.title, ...r.sections.map(s => `${s.heading}: ${s.body}`), ...(r.considerations.length ? [`Things to consider: ${r.considerations.join(" ")}`] : []), r.note].join("\n\n");
      return done(topic, text);
    }
    default:
      return done("unknown", "I can explain how the value was worked out, how confident it is, the market trends, and the comparable sales for this area, or write you a short market report. What would you like to know?", INTEL_SUGGESTIONS.slice(0, 3));
  }
}
