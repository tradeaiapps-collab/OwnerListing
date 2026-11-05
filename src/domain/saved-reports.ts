import { ANALYTICS_TIME_ZONE, type Range } from "./admin-analytics";
import { acceptanceRate } from "./admin-dashboard";
import { buildReport, DIMENSIONS, isDimension, type Dimension, type RawReportRow, type ReportRow } from "./admin-report-builder";
import { staffCan, type StaffActor } from "./staff-access";

/**
 * Saved and scheduled reports. A definition says what to report (grouping, measures, period, comparison); it is stored as JSON and
 * re-run on demand or on a schedule. Scheduled definitions use a relative period ("last 30 days") so every run covers fresh dates.
 * Everything is built from the same rows as the report builder, so the permission rules are the same: revenue needs report.financial
 * and agent names follow the personal-data permissions of whoever the report runs as.
 */

export const MEASURES = [
  { key: "listingsCreated", label: "Listings created", kind: "count" },
  { key: "liveNow", label: "Live now", kind: "count" },
  { key: "enquiries", label: "Enquiries (leads)", kind: "count" },
  { key: "offers", label: "Offers", kind: "count" },
  { key: "accepted", label: "Accepted offers", kind: "count" },
  { key: "acceptance", label: "Acceptance %", kind: "percent" },
  { key: "revenueCents", label: "Platform fees paid (incl. GST)", kind: "cents" }
] as const;
export type MeasureKey = (typeof MEASURES)[number]["key"];
export type MeasureKind = (typeof MEASURES)[number]["kind"];
export const isMeasure = (v: unknown): v is MeasureKey => MEASURES.some(m => m.key === v);
/** "Live now" is today's status, so it has no previous period to compare with. */
export const comparable = (k: MeasureKey) => k !== "liveNow";
export const measureOf = (k: MeasureKey) => MEASURES.find(m => m.key === k)!;

export const PERIODS = [
  { key: "last_7_days", label: "Last 7 days" },
  { key: "last_30_days", label: "Last 30 days" },
  { key: "last_90_days", label: "Last 90 days" },
  { key: "this_month", label: "This month so far" },
  { key: "last_month", label: "Last full month" },
  { key: "custom", label: "Custom dates" }
] as const;
export type PeriodKey = (typeof PERIODS)[number]["key"];

export interface ReportDefinition {
  name: string; dimension: Dimension; measures: MeasureKey[]; period: PeriodKey;
  /** Only with period "custom" (not allowed on a scheduled report). */
  from?: string; to?: string; compare: boolean; shared: boolean;
}

export interface ReportTemplate { id: string; label: string; blurb: string; definition: Omit<ReportDefinition, "shared"> }
export const TEMPLATES: readonly ReportTemplate[] = [
  { id: "sales", label: "Sales", blurb: "Listings, offers and fees by property type.",
    definition: { name: "Sales report", dimension: "category", measures: ["listingsCreated", "liveNow", "offers", "accepted", "revenueCents"], period: "last_30_days", compare: true } },
  { id: "pipeline", label: "Pipeline", blurb: "How listings move to offers and acceptance, sale vs rent.",
    definition: { name: "Pipeline report", dimension: "transaction", measures: ["listingsCreated", "liveNow", "enquiries", "offers", "accepted", "acceptance"], period: "last_90_days", compare: true } },
  { id: "performance", label: "Performance", blurb: "Offers and acceptance by agent.",
    definition: { name: "Agent performance", dimension: "agent", measures: ["listingsCreated", "offers", "accepted", "acceptance"], period: "last_30_days", compare: true } },
  { id: "leads", label: "Leads", blurb: "Buyer enquiries and offers by suburb.",
    definition: { name: "Leads by suburb", dimension: "suburb", measures: ["enquiries", "offers", "accepted"], period: "last_30_days", compare: true } }
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const validDate = (d: unknown): d is string => typeof d === "string" && DATE_RE.test(d) && !Number.isNaN(toMs(d)) && fmt(toMs(d)) === d;
const monthStart = (d: string, back = 0) => { const x = new Date(toMs(d)); return fmt(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() - back, 1)); };
const lastDayOfMonth = (first: string) => { const x = new Date(toMs(first)); return fmt(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)); };
const MAX_CUSTOM_DAYS = 366;

export const REPORT_NAME_MAX = 80;
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

/** Validates a definition from untrusted JSON for this staff member. Measures keep catalogue order; revenue needs report.financial. */
export function parseDefinition(input: unknown, actor: StaffActor, opts: { scheduled?: boolean } = {}): { ok: true; definition: ReportDefinition } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Send the report as an object." };
  const o = input as Record<string, unknown>;
  const name = typeof o["name"] === "string" ? clean(o["name"]) : "";
  if (name.length < 1 || name.length > REPORT_NAME_MAX) return { ok: false, error: `Give the report a name of 1 to ${REPORT_NAME_MAX} characters.` };
  if (!isDimension(o["dimension"])) return { ok: false, error: "Unknown grouping." };
  if (!Array.isArray(o["measures"]) || o["measures"].length === 0 || !o["measures"].every(isMeasure)) return { ok: false, error: "Choose at least one measure from the list." };
  const chosen = new Set<MeasureKey>(o["measures"] as MeasureKey[]);
  if (chosen.has("revenueCents") && !staffCan(actor, "report.financial")) return { ok: false, error: "Platform fees need the financial report permission." };
  const period = o["period"];
  if (!PERIODS.some(p => p.key === period)) return { ok: false, error: "Unknown period." };
  const def: ReportDefinition = {
    name, dimension: o["dimension"], measures: MEASURES.map(m => m.key).filter(k => chosen.has(k)), period: period as PeriodKey,
    compare: o["compare"] === true, shared: o["shared"] === true
  };
  if (def.period === "custom") {
    if (opts.scheduled) return { ok: false, error: "A scheduled report needs a relative period, not fixed dates." };
    if (!validDate(o["from"]) || !validDate(o["to"])) return { ok: false, error: "Dates must be real dates in the form YYYY-MM-DD." };
    if (o["from"] > o["to"]) return { ok: false, error: "The start date must be on or before the end date." };
    if ((toMs(o["to"]) - toMs(o["from"])) / DAY_MS >= MAX_CUSTOM_DAYS) return { ok: false, error: "Choose a period of a year or less." };
    def.from = o["from"]; def.to = o["to"];
  }
  return { ok: true, definition: def };
}

/** Resolves the definition's period to dates (inclusive, in the reporting zone). A custom end date in the future is cut back to today. */
export function resolvePeriod(def: Pick<ReportDefinition, "period" | "from" | "to">, today: string): Range {
  const bucket = "month" as const;
  const days = (n: number) => ({ from: fmt(toMs(today) - (n - 1) * DAY_MS), to: today, bucket });
  switch (def.period) {
    case "last_7_days": return days(7);
    case "last_30_days": return days(30);
    case "last_90_days": return days(90);
    case "this_month": return { from: monthStart(today), to: today, bucket };
    case "last_month": { const f = monthStart(today, 1); return { from: f, to: lastDayOfMonth(f), bucket }; }
    default: {
      const to = def.to && def.to < today ? def.to : today;
      const from = def.from && def.from <= to ? def.from : to;
      return { from, to, bucket };
    }
  }
}

/** The period to compare with: calendar months compare with the month before (same number of days for a month so far); others with the equal-length run just before. */
export function previousPeriod(def: Pick<ReportDefinition, "period">, r: Range): Range {
  const bucket = "month" as const;
  if (def.period === "last_month") { const f = monthStart(r.from, 1); return { from: f, to: lastDayOfMonth(f), bucket }; }
  if (def.period === "this_month") {
    const f = monthStart(r.from, 1), last = lastDayOfMonth(f);
    const want = fmt(toMs(f) + (toMs(r.to) - toMs(r.from)));
    return { from: f, to: want < last ? want : last, bucket };
  }
  const len = (toMs(r.to) - toMs(r.from)) / DAY_MS + 1;
  return { from: fmt(toMs(r.from) - len * DAY_MS), to: fmt(toMs(r.from) - DAY_MS), bucket };
}

export type Values = Partial<Record<MeasureKey, number>>;
export interface ResultRow { key: string; label: string; values: Values; previous?: Values }
export interface ReportResult {
  name: string; dimension: Dimension; dimensionLabel: string; measures: MeasureKey[];
  range: Range; previousRange?: Range; rows: ResultRow[]; totals: Values; previousTotals?: Values; revenueIncluded: boolean; generatedAt: string;
}

function valuesOf(r: Omit<ReportRow, "key" | "label">, measures: readonly MeasureKey[]): Values {
  const v: Values = {};
  const src = r as unknown as Record<string, number | undefined>;
  for (const m of measures) v[m] = src[m] ?? 0;
  // Acceptance is a ratio: totals need the underlying counts even when they are not shown.
  if (measures.includes("acceptance")) { v.offers ??= src["offers"] ?? 0; v.accepted ??= src["accepted"] ?? 0; }
  return v;
}

/** Builds the result from raw rows for the period (and optionally the previous one). Applies the same permission rules as buildReport. */
export function buildResult(actor: StaffActor, def: ReportDefinition, range: Range, raw: readonly RawReportRow[], prev?: { range: Range; raw: readonly RawReportRow[] }, generatedAt = new Date().toISOString()): ReportResult {
  const q = { range, dimension: def.dimension };
  const cur = buildReport(actor, q, raw);
  const old = prev ? buildReport(actor, { range: prev.range, dimension: def.dimension }, prev.raw) : null;
  const oldByKey = new Map((old?.rows ?? []).map(r => [r.key, r]));
  const rows: ResultRow[] = cur.rows.map(r => ({
    key: r.key, label: r.label, values: valuesOf(r, def.measures),
    ...(old ? { previous: valuesOf(oldByKey.get(r.key) ?? ZERO_ROW, def.measures) } : {})
  }));
  if (old) {
    const seen = new Set(cur.rows.map(r => r.key));
    for (const r of old.rows) if (!seen.has(r.key)) rows.push({ key: r.key, label: r.label, values: valuesOf(ZERO_ROW, def.measures), previous: valuesOf(r, def.measures) });
  }
  const primary = def.measures.find(m => measureOf(m).kind !== "percent") ?? def.measures[0]!;
  rows.sort((a, b) => (b.values[primary] ?? 0) - (a.values[primary] ?? 0) || a.label.localeCompare(b.label));
  const totalsOf = (rs: readonly ResultRow[], which: "values" | "previous"): Values => {
    const t: Values = {};
    for (const m of def.measures) t[m] = rs.reduce((s, r) => s + ((which === "values" ? r.values : r.previous)?.[m] ?? 0), 0);
    if (def.measures.includes("acceptance")) {
      const sum = (k: "offers" | "accepted") => rs.reduce((s, r) => s + ((which === "values" ? r.values : r.previous)?.[k] ?? 0), 0);
      t.acceptance = acceptanceRate(sum("accepted"), sum("offers"));
    }
    return t;
  };
  return {
    name: def.name, dimension: def.dimension, dimensionLabel: DIMENSIONS.find(d => d.key === def.dimension)!.label, measures: def.measures, range,
    ...(prev ? { previousRange: prev.range } : {}), rows, totals: totalsOf(rows, "values"), ...(old ? { previousTotals: totalsOf(rows, "previous") } : {}),
    revenueIncluded: cur.revenueIncluded && def.measures.includes("revenueCents"), generatedAt
  };
}
const ZERO_ROW = { listingsCreated: 0, liveNow: 0, enquiries: 0, offers: 0, accepted: 0, acceptance: 0, revenueCents: 0 };

/** Change against the previous period; pct is null when the previous value was zero (no meaningful percentage). */
export function change(now: number, before: number): { abs: number; pct: number | null } {
  return { abs: now - before, pct: before === 0 ? null : Math.round(((now - before) / before) * 1000) / 10 };
}

// ---- Schedules ----

export const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export interface ReportSchedule { frequency: Frequency; /** 1 = Monday ... 7 = Sunday (weekly). */ weekday: number; /** 1-28 (monthly). */ dayOfMonth: number; /** Hour of day, 0-23, Brisbane time. */ hour: number }

export function parseSchedule(input: unknown): { ok: true; schedule: ReportSchedule } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Send the schedule as an object." };
  const o = input as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number, dflt: number) => (v === undefined ? dflt : typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : NaN);
  const frequency = o["frequency"];
  if (!FREQUENCIES.includes(frequency as Frequency)) return { ok: false, error: "Choose daily, weekly or monthly." };
  const weekday = int(o["weekday"], 1, 7, 1), dayOfMonth = int(o["dayOfMonth"], 1, 28, 1), hour = int(o["hour"], 0, 23, 7);
  if (Number.isNaN(weekday)) return { ok: false, error: "Weekday must be 1 (Monday) to 7 (Sunday)." };
  if (Number.isNaN(dayOfMonth)) return { ok: false, error: "Day of month must be 1 to 28." };
  if (Number.isNaN(hour)) return { ok: false, error: "Hour must be 0 to 23." };
  return { ok: true, schedule: { frequency: frequency as Frequency, weekday, dayOfMonth, hour } };
}

/** Brisbane is UTC+10 all year (no daylight saving), so local time is a fixed offset from UTC. */
export const REPORT_ZONE = ANALYTICS_TIME_ZONE;
const ZONE_OFFSET_MS = 10 * 3_600_000;

/** The first run time strictly after `nowIso`, as a UTC instant. */
export function nextRunAfter(s: ReportSchedule, nowIso: string): string {
  const now = Date.parse(nowIso);
  const localDay = Math.floor((now + ZONE_OFFSET_MS) / DAY_MS) * DAY_MS;
  for (let i = 0; i < 400; i++) {
    const day = localDay + i * DAY_MS;
    const d = new Date(day);
    const ok = s.frequency === "daily" || (s.frequency === "weekly" && ((d.getUTCDay() + 6) % 7) + 1 === s.weekday) || (s.frequency === "monthly" && d.getUTCDate() === s.dayOfMonth);
    if (!ok) continue;
    const at = day + s.hour * 3_600_000 - ZONE_OFFSET_MS;
    if (at > now) return new Date(at).toISOString();
  }
  throw new Error("No next run found.");
}

export function describeSchedule(s: ReportSchedule): string {
  const hh = `${String(s.hour).padStart(2, "0")}:00`;
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  if (s.frequency === "daily") return `Every day at ${hh} Brisbane time`;
  if (s.frequency === "weekly") return `Every ${days[s.weekday - 1]} at ${hh} Brisbane time`;
  return `On day ${s.dayOfMonth} of each month at ${hh} Brisbane time`;
}
