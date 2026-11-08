/**
 * Twelve-month price forecast by area (suburb) and property type, from recorded sales (property_event 'sold', not voided, same source
 * rules as comparables). Method: the median sale price of each month, a weighted straight-line trend on the log of those medians (months
 * with more sales count more), extended 12 months, with 80% and 95% prediction intervals that widen with distance from the data.
 * Deliberately simple and explainable; it is an indication, not a valuation, and never feeds an offer or a price guide.
 */

export const FORECAST_MONTHS = 12;
/** History window read from the database. */
export const HISTORY_MONTHS = 36;
/** Below this many sales, or this many months with a sale, no forecast is drawn. */
export const MIN_SALES = 12;
export const MIN_MONTHS = 6;
/** A segment needs this many sales to appear in the area/type picker (also keeps single sales from being singled out). */
export const MIN_SEGMENT_SALES = 5;
/** The trend is capped at this much growth or fall per month (about 27% a year) so a thin, noisy segment cannot run away. */
export const MAX_MONTHLY_LOG_SLOPE = 0.02;

export const PROPERTY_TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"] as const;

export interface SaleFact { month: string; suburb: string; propertyType: string; priceCents: number }
export interface Segment { area: string; propertyType: string }
export interface SegmentOption { area: string; propertyType: string; sales: number }

export interface HistoryPoint { month: string; medianCents: number; sales: number; fittedCents: number }
export interface ForecastPoint { month: string; midCents: number; low80Cents: number; high80Cents: number; low95Cents: number; high95Cents: number }
export type ForecastConfidence = "low" | "fair" | "good";

export type Forecast =
  | {
      state: "ready"; segment: Segment; sales: number; months: number; history: HistoryPoint[]; forecast: ForecastPoint[];
      annualChangePct: number; lowAnnualChangePct: number; highAnnualChangePct: number; confidence: ForecastConfidence; capped: boolean;
    }
  | { state: "unavailable"; segment: Segment; sales: number; months: number; message: string };

export const ALL = "all";
const MONTH_RE = /^\d{4}-\d{2}$/;

/** "2026-11" plus n months. */
export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

export function medianOf(v: readonly number[]): number | undefined {
  if (v.length === 0) return undefined;
  const s = [...v].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const norm = (s: string) => s.trim().toLowerCase();
const inSegment = (f: SaleFact, s: Segment) =>
  (s.area === ALL || norm(f.suburb) === norm(s.area)) && (s.propertyType === ALL || f.propertyType === s.propertyType);

/** Areas and types with enough sales to pick, busiest first: every suburb (all types), every type (all areas), and suburb x type. */
export function segmentOptions(facts: readonly SaleFact[]): { areas: SegmentOption[]; types: SegmentOption[]; pairs: SegmentOption[] } {
  const count = new Map<string, { area: string; propertyType: string; sales: number }>();
  const bump = (area: string, propertyType: string) => {
    const k = `${norm(area)}|${propertyType}`;
    const cur = count.get(k) ?? { area, propertyType, sales: 0 };
    cur.sales += 1;
    count.set(k, cur);
  };
  for (const f of facts) { bump(f.suburb, ALL); bump(ALL, f.propertyType); bump(f.suburb, f.propertyType); }
  const all = [...count.values()].filter(o => o.sales >= MIN_SEGMENT_SALES).sort((a, b) => b.sales - a.sales || a.area.localeCompare(b.area));
  return {
    areas: all.filter(o => o.area !== ALL && o.propertyType === ALL),
    types: all.filter(o => o.area === ALL && o.propertyType !== ALL),
    pairs: all.filter(o => o.area !== ALL && o.propertyType !== ALL)
  };
}

/** Two-sided t quantiles for 80% and 95% intervals by degrees of freedom (normal beyond 30). */
const T80 = [3.078, 1.886, 1.638, 1.533, 1.476, 1.44, 1.415, 1.397, 1.383, 1.372, 1.363, 1.356, 1.35, 1.345, 1.341, 1.337, 1.333, 1.33, 1.328, 1.325];
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086];
export function tQuantile(df: number, level: 80 | 95): number {
  const table = level === 80 ? T80 : T95;
  if (df < 1) return table[0]!;
  if (df <= table.length) return table[df - 1]!;
  return df <= 30 ? (level === 80 ? 1.31 : 2.05) : level === 80 ? 1.2816 : 1.96;
}

/**
 * Forecast for one segment, starting the month after `lastMonth` (the current, part-finished month is the last history month).
 * Facts outside the segment are ignored.
 */
export function forecastSegment(facts: readonly SaleFact[], segment: Segment, lastMonth: string): Forecast {
  const byMonth = new Map<string, number[]>();
  for (const f of facts) {
    if (!inSegment(f, segment) || !MONTH_RE.test(f.month) || !(f.priceCents > 0) || f.month > lastMonth) continue;
    byMonth.set(f.month, [...(byMonth.get(f.month) ?? []), f.priceCents]);
  }
  const months = [...byMonth.keys()].sort();
  const sales = months.reduce((n, m) => n + byMonth.get(m)!.length, 0);
  if (sales < MIN_SALES || months.length < MIN_MONTHS) {
    return {
      state: "unavailable", segment, sales, months: months.length,
      message: `Not enough sales to forecast: ${sales} sales over ${months.length} months; a forecast needs at least ${MIN_SALES} sales across ${MIN_MONTHS} months.`
    };
  }

  const pts = months.map(m => ({ month: m, t: monthIndex(m), w: byMonth.get(m)!.length, med: medianOf(byMonth.get(m)!)! }));
  const sw = pts.reduce((a, p) => a + p.w, 0);
  const tBar = pts.reduce((a, p) => a + p.w * p.t, 0) / sw;
  const yBar = pts.reduce((a, p) => a + p.w * Math.log(p.med), 0) / sw;
  const sxx = pts.reduce((a, p) => a + p.w * (p.t - tBar) ** 2, 0);
  const sxy = pts.reduce((a, p) => a + p.w * (p.t - tBar) * (Math.log(p.med) - yBar), 0);
  const rawSlope = sxx > 0 ? sxy / sxx : 0;
  const slope = Math.max(-MAX_MONTHLY_LOG_SLOPE, Math.min(MAX_MONTHLY_LOG_SLOPE, rawSlope));
  const capped = slope !== rawSlope;
  const fit = (t: number) => yBar + slope * (t - tBar);

  // Residual variance of one sale (a month's median with w sales has roughly variance sigma^2 / w).
  const df = pts.length - 2;
  const sigma2 = pts.reduce((a, p) => a + p.w * (Math.log(p.med) - fit(p.t)) ** 2, 0) / Math.max(1, df);
  const wFuture = sw / pts.length; // a future month is assumed to have a typical number of sales
  const t80 = tQuantile(df, 80), t95 = tQuantile(df, 95);
  const lastT = monthIndex(lastMonth);

  const forecast: ForecastPoint[] = [];
  for (let h = 1; h <= FORECAST_MONTHS; h++) {
    const t = lastT + h;
    const se = Math.sqrt(sigma2 * (1 / wFuture + 1 / sw + (sxx > 0 ? (t - tBar) ** 2 / sxx : 0)));
    const mid = fit(t);
    forecast.push({
      month: addMonths(lastMonth, h), midCents: cents(mid),
      low80Cents: cents(mid - t80 * se), high80Cents: cents(mid + t80 * se),
      low95Cents: cents(mid - t95 * se), high95Cents: cents(mid + t95 * se)
    });
  }

  const nowFit = Math.exp(fit(lastT));
  const end = forecast[forecast.length - 1]!;
  const pct = (v: number) => Math.round(((v / nowFit) - 1) * 1000) / 10;
  const relWidth = (end.high80Cents - end.low80Cents) / end.midCents;
  const confidence: ForecastConfidence = sales >= 60 && pts.length >= 18 && relWidth < 0.25 ? "good" : sales >= 25 && relWidth < 0.5 ? "fair" : "low";

  return {
    state: "ready", segment, sales, months: pts.length,
    history: pts.map(p => ({ month: p.month, medianCents: Math.round(p.med), sales: p.w, fittedCents: cents(fit(p.t)) })),
    forecast, annualChangePct: pct(end.midCents), lowAnnualChangePct: pct(end.low80Cents), highAnnualChangePct: pct(end.high80Cents), confidence, capped
  };
}

const cents = (logV: number) => Math.round(Math.exp(logV));

/** Reads ?area=&type= (each "all" or a value). An unknown type is refused; an area is matched case-insensitively. */
export function parseSegment(p: URLSearchParams): { ok: true; segment: Segment } | { ok: false; error: string } {
  const area = (p.get("area") ?? ALL).trim() || ALL;
  const propertyType = (p.get("type") ?? ALL).trim() || ALL;
  if (area.length > 80) return { ok: false, error: "Area is too long." };
  if (propertyType !== ALL && !(PROPERTY_TYPES as readonly string[]).includes(propertyType)) return { ok: false, error: "Unknown property type." };
  return { ok: true, segment: { area, propertyType } };
}

export interface ForecastView {
  generatedFor: string; segment: Segment; forecast: Forecast;
  options: { areas: SegmentOption[]; types: SegmentOption[]; pairs: SegmentOption[] };
  method: string;
}

export const FORECAST_METHOD =
  "Median sale price per month over the last three years, a straight-line trend on those medians (busier months count more), extended 12 months. " +
  "The shaded band is the 80% range; the outer band is the 95% range. Sales only (not rentals), from recorded platform and public-record sales. " +
  "An indication for planning, not a valuation.";

export function buildForecastView(facts: readonly SaleFact[], segment: Segment, currentMonth: string): ForecastView {
  return { generatedFor: currentMonth, segment, forecast: forecastSegment(facts, segment, currentMonth), options: segmentOptions(facts), method: FORECAST_METHOD };
}
