import { bucketKeys, bucketLabel, bucketStart, type Range } from "./admin-analytics";
import { metricsFor, shiftDays, type AgentMetricFacts, type MetricValues } from "./agent-benchmark";
import { staffCan, type StaffActor } from "./staff-access";

/**
 * Team trends: the agents' combined sales count, sales volume, average sale price and lead conversion by day, week or month, the same
 * totals for the previous period of equal length, and plain-language signals for drops, growth and the overall direction.
 * Uses the same facts and definitions as agent benchmarking. Volume and average price need the financial report permission.
 */

export const DROP = -0.3;
export const GROWTH = 0.3;
/** A bucket is compared with the average of up to this many buckets before it, and only once at least MIN_BASE_BUCKETS exist. */
export const BASE_BUCKETS = 4;
export const MIN_BASE_BUCKETS = 3;
/** Ignore swings on tiny numbers: the baseline must average at least this many sales, or enquiries for conversion. */
export const MIN_BASE_SALES = 2;
export const MIN_BASE_ENQUIRIES = 5;
export const MAX_SIGNALS = 8;

export type Measure = "sales" | "volume" | "averagePrice" | "conversion";
export interface TrendSeries { key: Measure; label: string; values: number[]; total: number }
export interface Signal { kind: "drop" | "growth"; measure: Measure; bucket: string; label: string; changePct: number; text: string }
export type Direction = "growing" | "declining" | "steady" | "too little data";

export interface TeamTrends {
  range: Range; previous: { from: string; to: string }; buckets: string[]; labels: string[]; partial: { first: boolean; last: boolean };
  series: TrendSeries[]; totals: MetricValues & { volume?: number; averagePrice?: number };
  previousTotals: MetricValues & { volume?: number; averagePrice?: number };
  direction: { direction: Direction; changePct?: number; text: string }; signals: Signal[]; financial: boolean; scope: string;
}

const DAY_MS = 86_400_000;
const days = (r: { from: string; to: string }) => Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / DAY_MS) + 1;
const MEASURE_LABEL: Record<Measure, string> = { sales: "Sales", volume: "Sales volume", averagePrice: "Average sale price", conversion: "Lead conversion (%)" };
const BUCKET_WORD = { day: "day", week: "week", month: "month" } as const;

/** Last day of the bucket starting at `start`. */
function bucketEnd(start: string, bucket: Range["bucket"]): string {
  if (bucket === "day") return start;
  if (bucket === "week") return shiftDays(start, 6);
  const d = new Date(Date.parse(`${start}T00:00:00Z`));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function totalsFor(f: AgentMetricFacts, p: { from: string; to: string }) {
  const m = metricsFor(f, { ...p, days: days(p) });
  const volume = f.sales.filter(s => s.date >= p.from && s.date <= p.to).reduce((a, s) => a + s.priceCents, 0);
  return { ...m, volume, ...(m.sales ? { averagePrice: Math.round(volume / m.sales) } : {}) };
}

/** Least-squares slope of values over their index. */
export function slope(v: readonly number[]): number {
  const n = v.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2, ym = v.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  v.forEach((y, i) => { sxy += (i - xm) * (y - ym); sxx += (i - xm) ** 2; });
  return sxx > 0 ? sxy / sxx : 0;
}

export function buildTeamTrends(actor: StaffActor, f: AgentMetricFacts, range: Range, scope: string): TeamTrends {
  const financial = staffCan(actor, "report.financial");
  const buckets = bucketKeys(range);
  const at = new Map(buckets.map((b, i) => [b, i]));
  const zero = () => buckets.map(() => 0);
  const sales = zero(), volume = zero(), enq = zero(), conv = zero();
  const inRange = (d: string) => d >= range.from && d <= range.to;
  for (const s of f.sales) {
    if (!inRange(s.date)) continue;
    const i = at.get(bucketStart(s.date, range.bucket));
    if (i !== undefined) { sales[i]! += 1; volume[i]! += s.priceCents; }
  }
  for (const e of f.enquiries) {
    if (!inRange(e.date)) continue;
    const i = at.get(bucketStart(e.date, range.bucket));
    if (i !== undefined) { enq[i]! += e.enquiries; conv[i]! += e.converted; }
  }
  const average = sales.map((n, i) => (n > 0 ? Math.round(volume[i]! / n) : 0));
  const conversion = enq.map((n, i) => (n > 0 ? Math.round((conv[i]! / n) * 1000) / 10 : 0));

  const series: TrendSeries[] = [{ key: "sales", label: MEASURE_LABEL.sales, values: sales, total: sum(sales) }];
  if (financial) {
    series.push({ key: "volume", label: MEASURE_LABEL.volume, values: volume, total: sum(volume) });
    series.push({ key: "averagePrice", label: MEASURE_LABEL.averagePrice, values: average, total: sum(sales) ? Math.round(sum(volume) / sum(sales)) : 0 });
  }
  series.push({ key: "conversion", label: MEASURE_LABEL.conversion, values: conversion, total: sum(enq) ? Math.round((sum(conv) / sum(enq)) * 1000) / 10 : 0 });

  // The first and last buckets can be cut short by the range; they are drawn but never used for signals or direction.
  const partial = {
    first: buckets.length > 0 && bucketStart(range.from, range.bucket) < range.from,
    last: buckets.length > 0 && bucketEnd(buckets[buckets.length - 1]!, range.bucket) > range.to
  };
  const lo = partial.first ? 1 : 0, hi = buckets.length - (partial.last ? 1 : 0);
  const labels = buckets.map(b => bucketLabel(b, range.bucket));
  const word = BUCKET_WORD[range.bucket];

  const signals: Signal[] = [];
  const scan = (measure: Measure, values: number[], base: number[], minBase: number) => {
    for (let i = lo + MIN_BASE_BUCKETS; i < hi; i++) {
      const from = Math.max(lo, i - BASE_BUCKETS);
      const baseVals = values.slice(from, i), gate = base.slice(from, i);
      const baseline = avg(baseVals);
      if (avg(gate) < minBase || baseline <= 0) continue;
      const change = (values[i]! - baseline) / baseline;
      if (change > DROP && change < GROWTH) continue;
      const pct = Math.round(change * 100);
      const kind = change <= DROP ? "drop" : "growth";
      signals.push({
        kind, measure, bucket: buckets[i]!, label: labels[i]!, changePct: pct,
        text: `${MEASURE_LABEL[measure].replace(" (%)", "")} ${kind === "drop" ? "fell" : "rose"} ${Math.abs(pct)}% in the ${word} of ${labels[i]} against the previous ${baseVals.length}-${word} average.`
      });
    }
  };
  scan("sales", sales, sales, MIN_BASE_SALES);
  if (financial) scan("volume", volume, sales, MIN_BASE_SALES);
  scan("conversion", conversion, enq, MIN_BASE_ENQUIRIES);
  signals.sort((a, b) => b.bucket.localeCompare(a.bucket) || Math.abs(b.changePct) - Math.abs(a.changePct));

  const complete = sales.slice(lo, hi);
  const mean = avg(complete);
  let direction: TeamTrends["direction"];
  if (complete.length < 4 || mean < 1) direction = { direction: "too little data", text: `Not enough complete ${word}s with sales to call a direction.` };
  else {
    const changePct = Math.round(((slope(complete) * (complete.length - 1)) / mean) * 100);
    const dir: Direction = changePct >= 20 ? "growing" : changePct <= -20 ? "declining" : "steady";
    direction = {
      direction: dir, changePct,
      text: dir === "steady" ? `Sales are steady across the period (trend ${changePct >= 0 ? "+" : ""}${changePct}%).`
        : `Sales are ${dir}: the trend line moves ${changePct >= 0 ? "+" : ""}${changePct}% from the first to the last complete ${word}.`
    };
  }

  const prevTo = shiftDays(range.from, -1), prev = { from: shiftDays(prevTo, -(days(range) - 1)), to: prevTo };
  const strip = <T extends { volume?: number; averagePrice?: number; commission?: number }>(t: T): T => (financial ? { ...t, commission: undefined } : { ...t, volume: undefined, averagePrice: undefined, commission: undefined });
  return {
    range, previous: prev, buckets, labels, partial, series, totals: clean(strip(totalsFor(f, range))), previousTotals: clean(strip(totalsFor(f, prev))),
    direction, signals: signals.slice(0, MAX_SIGNALS), financial, scope
  };
}

const sum = (v: readonly number[]) => v.reduce((a, b) => a + b, 0);
const avg = (v: readonly number[]) => (v.length ? sum(v) / v.length : 0);
const clean = <T extends object>(m: T): T => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as T;
