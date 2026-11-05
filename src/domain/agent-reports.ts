import { ANALYTICS_TIME_ZONE } from "./admin-analytics";
import { median, rankLeads, type LeadFact, type WorkspaceDeps } from "./agent-workspace";
import { gate } from "./agent-workspace";
import type { Actor, Failure, Result } from "./listing-service";
import { localDateInZone } from "./timezone";

/**
 * Agent reports: a report is a definition (metrics, grouping, period) run over the agent's own listings, enquiries and offers.
 * Pure rules. Reports hold counts, money and listing titles only; never buyer names or messages, so they are safe to email.
 */

export const METRICS = [
  { key: "enquiries", label: "Enquiries", kind: "count" },
  { key: "hot_leads", label: "Hot leads", kind: "count" },
  { key: "awaiting_reply", label: "Awaiting first reply", kind: "count" },
  { key: "median_reply_minutes", label: "Median first reply (min)", kind: "minutes" },
  { key: "offers", label: "Offers", kind: "count" },
  { key: "open_offers", label: "Open offers", kind: "count" },
  { key: "accepted", label: "Accepted offers", kind: "count" },
  { key: "rejected", label: "Rejected offers", kind: "count" },
  { key: "acceptance_rate", label: "Acceptance (%)", kind: "percent" },
  { key: "pipeline_cents", label: "Open pipeline (AUD)", kind: "money" },
  { key: "accepted_cents", label: "Accepted value (AUD)", kind: "money" }
] as const;
export type MetricKey = (typeof METRICS)[number]["key"];
export type MetricKind = (typeof METRICS)[number]["kind"];
const METRIC_KEYS = METRICS.map(m => m.key) as readonly string[];

export const GROUPS = [{ key: "none", label: "Total only" }, { key: "listing", label: "Listing" }, { key: "month", label: "Month" }] as const;
export type GroupKey = (typeof GROUPS)[number]["key"];

export const TEMPLATES = {
  sales: { label: "Sales", blurb: "Offers made, accepted and rejected, with the value won, by listing.", metrics: ["offers", "accepted", "rejected", "acceptance_rate", "accepted_cents"], groupBy: "listing", days: 90 },
  pipeline: { label: "Pipeline", blurb: "Open offers and live leads by listing.", metrics: ["enquiries", "hot_leads", "open_offers", "pipeline_cents"], groupBy: "listing", days: 30 },
  performance: { label: "Performance", blurb: "Month by month: enquiries, offers, acceptance and reply speed.", metrics: ["enquiries", "offers", "accepted", "acceptance_rate", "median_reply_minutes"], groupBy: "month", days: 365 },
  leads: { label: "Leads", blurb: "Enquiry volume, hot leads and unanswered buyers by listing.", metrics: ["enquiries", "hot_leads", "awaiting_reply", "median_reply_minutes"], groupBy: "listing", days: 30 }
} as const satisfies Record<string, { label: string; blurb: string; metrics: readonly MetricKey[]; groupBy: GroupKey; days: number }>;
export type TemplateKey = keyof typeof TEMPLATES;

export const PERIOD_DAYS = [7, 30, 90, 365] as const;
export const MAX_REPORTS = 20;
export const MAX_ROWS = 200;

export type Period = { days: number } | { from: string; to: string };
export interface ReportDefinition { template: TemplateKey | "custom"; metrics: MetricKey[]; groupBy: GroupKey; period: Period }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const validDate = (d: unknown): d is string => typeof d === "string" && DATE_RE.test(d) && !Number.isNaN(toMs(d)) && isoDate(toMs(d)) === d;
const bad = (message: string): Failure => ({ ok: false, code: "invalid", message });

export function templateDefinition(t: TemplateKey): ReportDefinition {
  const x = TEMPLATES[t];
  return { template: t, metrics: [...x.metrics], groupBy: x.groupBy, period: { days: x.days } };
}

/** Validates a definition from JSON or query text. Unknown metrics, groupings and periods are refused, never ignored. */
export function parseDefinition(input: unknown): Result<ReportDefinition> {
  const o = (input ?? {}) as Record<string, unknown>;
  const t = o["template"] ?? "custom";
  if (t !== "custom" && !(typeof t === "string" && t in TEMPLATES)) return bad("Choose a template: sales, pipeline, performance, leads or custom.");
  const base = t === "custom" ? undefined : templateDefinition(t as TemplateKey);
  const rawMetrics = o["metrics"] ?? base?.metrics;
  if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) return bad("Choose at least one metric.");
  if (rawMetrics.length > METRICS.length) return bad("Too many metrics.");
  for (const m of rawMetrics) if (typeof m !== "string" || !METRIC_KEYS.includes(m)) return bad(`Unknown metric: ${String(m).slice(0, 40)}.`);
  const metrics = METRICS.map(m => m.key).filter(k => (rawMetrics as string[]).includes(k)); // fixed catalogue order, no duplicates
  const groupBy = o["groupBy"] ?? base?.groupBy ?? "listing";
  if (!GROUPS.some(g => g.key === groupBy)) return bad("Group by none, listing or month.");
  const p = (o["period"] ?? base?.period ?? { days: 90 }) as Record<string, unknown>;
  let period: Period;
  if (p["from"] !== undefined || p["to"] !== undefined) {
    if (!validDate(p["from"]) || !validDate(p["to"])) return bad("Dates must be real dates in the form YYYY-MM-DD.");
    if (p["from"] > p["to"]) return bad("The start date must be on or before the end date.");
    if ((toMs(p["to"]) - toMs(p["from"])) / DAY > 730) return bad("Choose a period of two years or less.");
    period = { from: p["from"], to: p["to"] };
  } else {
    if (!(PERIOD_DAYS as readonly unknown[]).includes(p["days"])) return bad("Choose a period of 7, 30, 90 or 365 days.");
    period = { days: p["days"] as number };
  }
  return { ok: true, value: { template: t as ReportDefinition["template"], metrics: metrics as MetricKey[], groupBy: groupBy as GroupKey, period } };
}

/** Definition from a URL's query string: ?template=&metrics=a,b&groupBy=&days=|from=&to= */
export function definitionFromQuery(p: URLSearchParams): Result<ReportDefinition> {
  const o: Record<string, unknown> = {};
  if (p.get("template")) o["template"] = p.get("template");
  if (p.get("metrics")) o["metrics"] = p.get("metrics")!.split(",").map(s => s.trim()).filter(Boolean);
  if (p.get("groupBy")) o["groupBy"] = p.get("groupBy");
  if (p.get("from") || p.get("to")) o["period"] = { from: p.get("from"), to: p.get("to") };
  else if (p.get("days")) o["period"] = { days: Number(p.get("days")) };
  return parseDefinition(o);
}

/** Calendar dates (reporting zone) the definition covers, ending today, and the equal-length period just before. */
export function resolvePeriod(period: Period, today: string): { from: string; to: string; prevFrom: string; prevTo: string } {
  const to = "days" in period ? today : period.to;
  const from = "days" in period ? isoDate(toMs(today) - (period.days - 1) * DAY) : period.from;
  const len = Math.round((toMs(to) - toMs(from)) / DAY) + 1;
  return { from, to, prevTo: isoDate(toMs(from) - DAY), prevFrom: isoDate(toMs(from) - len * DAY) };
}

export interface OfferFact { listingId: string; listingTitle: string; status: string; priceCents: number; submittedAt: string }
export interface ReportFacts { leads: readonly LeadFact[]; offers: readonly OfferFact[] }

const OPEN = ["submitted", "under_review", "countered"];
type Values = Partial<Record<MetricKey, number>>;

function compute(leads: readonly LeadFact[], offers: readonly OfferFact[], now: Date): Record<MetricKey, number | undefined> {
  const scored = rankLeads(leads, now);
  const decided = offers.filter(o => o.status === "accepted" || o.status === "rejected").length;
  const accepted = offers.filter(o => o.status === "accepted"), open = offers.filter(o => OPEN.includes(o.status));
  const replies = leads.filter(l => l.firstAgentAt).map(l => (Date.parse(l.firstAgentAt!) - Date.parse(l.enquiredAt)) / 60_000).filter(m => m >= 0);
  return {
    enquiries: leads.length, hot_leads: scored.filter(l => l.band === "hot").length,
    awaiting_reply: leads.filter(l => l.buyerMessages > 0 && l.agentMessages === 0).length, median_reply_minutes: median(replies),
    offers: offers.length, open_offers: open.length, accepted: accepted.length, rejected: offers.filter(o => o.status === "rejected").length,
    acceptance_rate: decided > 0 ? Math.round((accepted.length / decided) * 100) : undefined,
    pipeline_cents: open.reduce((s, o) => s + o.priceCents, 0), accepted_cents: accepted.reduce((s, o) => s + o.priceCents, 0)
  };
}

export interface ReportColumn { key: MetricKey; label: string; kind: MetricKind }
export interface ReportRow { key: string; label: string; values: Values }
export interface Comparison { key: MetricKey; label: string; kind: MetricKind; current?: number; previous?: number; change?: number }
export interface ReportResult {
  title: string; definition: ReportDefinition; groupLabel: string; period: { from: string; to: string }; previousPeriod: { from: string; to: string };
  columns: ReportColumn[]; rows: ReportRow[]; totals: Values; previousTotals: Values; comparison: Comparison[]; truncated: boolean; generatedAt: string;
}

const inRange = (day: string, from: string, to: string) => day >= from && day <= to;
const dayOf = (iso: string) => localDateInZone(iso, ANALYTICS_TIME_ZONE);
const clean = (v: Record<MetricKey, number | undefined>, keys: readonly MetricKey[]): Values => {
  const out: Values = {};
  for (const k of keys) if (v[k] !== undefined) out[k] = v[k]!;
  return out;
};
const monthsBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  while (`${y}-${String(m).padStart(2, "0")}` <= end && out.length < 40) { out.push(`${y}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; y++; } }
  return out;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (k: string) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;

export function buildReport(def: ReportDefinition, facts: ReportFacts, today: string, now: Date, titleOverride?: string): ReportResult {
  const per = resolvePeriod(def.period, today);
  const columns: ReportColumn[] = METRICS.filter(m => def.metrics.includes(m.key)).map(m => ({ key: m.key, label: m.label, kind: m.kind }));
  const keys = columns.map(c => c.key);
  const slice = (from: string, to: string) => ({
    leads: facts.leads.filter(l => inRange(dayOf(l.enquiredAt), from, to)),
    offers: facts.offers.filter(o => inRange(dayOf(o.submittedAt), from, to))
  });
  const cur = slice(per.from, per.to), prev = slice(per.prevFrom, per.prevTo);
  const totals = clean(compute(cur.leads, cur.offers, now), keys), previousTotals = clean(compute(prev.leads, prev.offers, now), keys);

  let rows: ReportRow[] = [];
  if (def.groupBy === "listing") {
    const titles = new Map<string, string>();
    for (const l of cur.leads) titles.set(l.listingId, l.listingTitle);
    for (const o of cur.offers) titles.set(o.listingId, o.listingTitle);
    rows = [...titles].map(([id, title]) => ({ key: id, label: title, values: clean(compute(cur.leads.filter(l => l.listingId === id), cur.offers.filter(o => o.listingId === id), now), keys) }));
    rows.sort((a, b) => (b.values.offers ?? b.values.enquiries ?? 0) - (a.values.offers ?? a.values.enquiries ?? 0) || a.label.localeCompare(b.label));
  } else if (def.groupBy === "month") {
    rows = monthsBetween(per.from, per.to).map(m => ({
      key: m, label: monthLabel(m),
      values: clean(compute(cur.leads.filter(l => dayOf(l.enquiredAt).startsWith(m)), cur.offers.filter(o => dayOf(o.submittedAt).startsWith(m)), now), keys)
    }));
  }
  const truncated = rows.length > MAX_ROWS;
  if (truncated) rows = rows.slice(0, MAX_ROWS);

  const comparison: Comparison[] = columns.map(c => {
    const a = totals[c.key], b = previousTotals[c.key];
    const change = a !== undefined && b !== undefined && b > 0 && c.kind !== "percent" ? Math.round(((a - b) / b) * 100) : undefined;
    return { key: c.key, label: c.label, kind: c.kind, ...(a !== undefined ? { current: a } : {}), ...(b !== undefined ? { previous: b } : {}), ...(change !== undefined ? { change } : {}) };
  });
  const title = titleOverride ?? (def.template === "custom" ? "Custom report" : `${TEMPLATES[def.template].label} report`);
  return {
    title, definition: def, groupLabel: GROUPS.find(g => g.key === def.groupBy)!.label, period: { from: per.from, to: per.to },
    previousPeriod: { from: per.prevFrom, to: per.prevTo }, columns, rows, totals, previousTotals, comparison, truncated, generatedAt: now.toISOString()
  };
}

const aud = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
export function formatValue(kind: MetricKind, v: number | undefined): string {
  if (v === undefined) return "–";
  return kind === "money" ? aud(v) : kind === "percent" ? `${v}%` : String(v);
}

/** Flat table for exports. Money is whole dollars with cents, percent and minutes are plain numbers; a missing value is empty. */
export function reportTable(r: ReportResult): { head: string[]; rows: (string | number)[][] } {
  const head = [r.groupLabel === "Total only" ? "Scope" : r.groupLabel, ...r.columns.map(c => c.label)];
  const cell = (c: ReportColumn, v: number | undefined): string | number => (v === undefined ? "" : c.kind === "money" ? Math.round(v) / 100 : v);
  const line = (label: string, v: Values) => [label, ...r.columns.map(c => cell(c, v[c.key]))];
  return { head, rows: [...r.rows.map(x => line(x.label, x.values)), line(r.rows.length ? "Total" : "All listings", r.totals)] };
}

export interface Insights { headline: string; points: string[] }

/** Elena's summary: plain rules over the report's own numbers. It states what changed and what to look at; it never decides anything. */
export function reportInsights(r: ReportResult): Insights {
  const pts: string[] = [];
  const t = r.totals;
  const lead = r.comparison.find(c => c.change !== undefined && Math.abs(c.change) >= 10 && (c.current ?? 0) + (c.previous ?? 0) >= 5);
  const moves = r.comparison.filter(c => c.change !== undefined && Math.abs(c.change) >= 10 && (c.current ?? 0) + (c.previous ?? 0) >= 5).slice(0, 3);
  for (const m of moves) pts.push(`${m.label} ${m.change! > 0 ? "rose" : "fell"} ${Math.abs(m.change!)}% on the previous period (${formatValue(m.kind, m.previous)} to ${formatValue(m.kind, m.current)}).`);
  if (moves.length === 0 && r.comparison.some(c => c.previous !== undefined)) pts.push("Nothing moved by more than 10% against the previous period, or the numbers are too small to read a trend from.");
  const best = r.definition.groupBy === "listing" ? r.rows[0] : undefined;
  if (best) pts.push(`${best.label} is the busiest listing in this report.`);
  if (r.definition.groupBy === "month") {
    const k = (r.columns.find(c => c.key === "offers") ?? r.columns.find(c => c.key === "enquiries"))?.key;
    const top = k ? [...r.rows].sort((a, b) => (b.values[k] ?? 0) - (a.values[k] ?? 0))[0] : undefined;
    if (top && (top.values[k!] ?? 0) > 0) pts.push(`${top.label} was the strongest month for ${METRICS.find(m => m.key === k)!.label.toLowerCase()}.`);
  }
  if ((t.awaiting_reply ?? 0) > 0) pts.push(`${t.awaiting_reply} buyer${t.awaiting_reply === 1 ? " is" : "s are"} still waiting for a first reply. Answering those is the quickest win.`);
  if (t.acceptance_rate !== undefined && (t.accepted ?? 0) + (t.rejected ?? 0) > 0 && (t.accepted ?? 0) + (t.rejected ?? 0) < 3) pts.push("Acceptance is based on fewer than 3 decided offers, so treat it as a rough guide.");
  if (r.truncated) pts.push(`Only the first ${MAX_ROWS} rows are shown.`);
  const nothing = Object.values(t).every(v => !v);
  const headline = nothing ? `No activity from ${r.period.from} to ${r.period.to}.` : lead ? `${r.title}: ${lead.label.toLowerCase()} ${lead.change! > 0 ? "up" : "down"} ${Math.abs(lead.change!)}% on the previous period.` : `${r.title}, ${r.period.from} to ${r.period.to}.`;
  return { headline, points: pts };
}

/* ---------- schedule ---------- */

export const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const isFrequency = (v: unknown): v is Frequency => (FREQUENCIES as readonly unknown[]).includes(v);

const SEND_HOUR_LOCAL = 8;
const OFFSET_HOURS = 10; // Australia/Brisbane has no daylight saving, so a fixed offset is exact.

/** The next 08:00 Brisbane time strictly after `after`: tomorrow (daily), the next Monday (weekly) or the next 1st (monthly). Returned as a UTC ISO time. */
export function nextRunAt(freq: Frequency, after: Date): string {
  const local = new Date(after.getTime() + OFFSET_HOURS * 3_600_000);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const sendMs = (d: number) => d + SEND_HOUR_LOCAL * 3_600_000;
  const localNow = local.getTime();
  let target = day;
  if (freq === "daily") { if (sendMs(target) <= localNow) target += DAY; }
  else if (freq === "weekly") {
    target += ((8 - new Date(day).getUTCDay()) % 7) * DAY; // days until Monday; 0 when today is Monday
    if (sendMs(target) <= localNow) target += 7 * DAY;
  } else {
    const d = new Date(day);
    target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    if (sendMs(target) <= localNow) target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return new Date(sendMs(target) - OFFSET_HOURS * 3_600_000).toISOString();
}

/** A schedule needs a rolling period; a fixed date range would send the same numbers every time. */
export function checkSchedulable(def: ReportDefinition): Failure | undefined {
  return "days" in def.period ? undefined : bad("A scheduled report needs a rolling period (last 7, 30, 90 or 365 days), not fixed dates.");
}

export function parseName(v: unknown): Result<string> {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!s) return bad("Give the report a name.");
  if (s.length > 80) return bad("Keep the name under 80 characters.");
  return { ok: true, value: s };
}

/* ---------- service ---------- */

export interface SavedReport { id: string; name: string; definition: ReportDefinition; createdAt: string; schedule?: { frequency: Frequency; nextRunAt: string; lastRunAt?: string; lastStatus?: string } }
export interface RunSnapshot { id: string; trigger: "manual" | "scheduled"; periodFrom: string; periodTo: string; totals: Values; createdAt: string }
export interface DueReport { reportId: string; agentId: string; name: string; definition: ReportDefinition; frequency: Frequency; nextRunAt: string; email?: string }

export interface ReportDeps extends Pick<WorkspaceDeps, "licences" | "today" | "now"> {
  facts(agentId: string): Promise<ReportFacts>;
  list(agentId: string): Promise<SavedReport[]>;
  get(agentId: string, id: string): Promise<SavedReport | undefined>;
  create(agentId: string, name: string, def: ReportDefinition): Promise<string>;
  update(agentId: string, id: string, name: string, def: ReportDefinition): Promise<void>;
  remove(agentId: string, id: string): Promise<void>;
  setSchedule(id: string, frequency: Frequency | null, nextRunAt: string): Promise<void>;
  addRun(id: string, trigger: "manual" | "scheduled", from: string, to: string, totals: Values, at: string): Promise<void>;
  runs(id: string): Promise<RunSnapshot[]>;
  due(now: string, limit: number): Promise<DueReport[]>;
  /** Moves the next run on only if it is still due at `now`; false means another tick took it. */
  claim(reportId: string, now: string, next: string): Promise<boolean>;
  finish(reportId: string, status: "sent" | "not_sent" | "skipped", at: string): Promise<void>;
  send(agentId: string, to: string, subject: string, text: string): Promise<boolean>;
}

const deny = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const reportToday = (d: ReportDeps) => localDateInZone(d.now().toISOString(), ANALYTICS_TIME_ZONE);

export async function runReport(d: ReportDeps, a: Actor, def: ReportDefinition, title?: string): Promise<Result<{ report: ReportResult; insights: Insights }>> {
  const f = await gate(d, a); if (f) return f;
  const report = buildReport(def, await d.facts(a.userId), reportToday(d), d.now(), title);
  return { ok: true, value: { report, insights: reportInsights(report) } };
}

export async function listReports(d: ReportDeps, a: Actor): Promise<Result<{ reports: SavedReport[] }>> {
  const f = await gate(d, a); if (f) return f;
  return { ok: true, value: { reports: await d.list(a.userId) } };
}

async function parseSave(body: unknown): Promise<Result<{ name: string; def: ReportDefinition; frequency: Frequency | null | undefined }>> {
  const o = (body ?? {}) as Record<string, unknown>;
  const n = parseName(o["name"]); if (!n.ok) return n;
  const def = parseDefinition(o["definition"]); if (!def.ok) return def;
  const s = o["schedule"];
  if (s === undefined) return { ok: true, value: { name: n.value, def: def.value, frequency: undefined } };
  if (s === null) return { ok: true, value: { name: n.value, def: def.value, frequency: null } };
  const freq = (s as Record<string, unknown>)["frequency"];
  if (!isFrequency(freq)) return bad("Schedule it daily, weekly or monthly.");
  const un = checkSchedulable(def.value); if (un) return un;
  return { ok: true, value: { name: n.value, def: def.value, frequency: freq } };
}

export async function saveReport(d: ReportDeps, a: Actor, body: unknown): Promise<Result<{ id: string }>> {
  const f = await gate(d, a); if (f) return f;
  const p = await parseSave(body); if (!p.ok) return p;
  if ((await d.list(a.userId)).length >= MAX_REPORTS) return bad(`You can keep up to ${MAX_REPORTS} saved reports. Delete one first.`);
  const id = await d.create(a.userId, p.value.name, p.value.def);
  if (p.value.frequency) await d.setSchedule(id, p.value.frequency, nextRunAt(p.value.frequency, d.now()));
  return { ok: true, value: { id } };
}

export async function updateReport(d: ReportDeps, a: Actor, id: string, body: unknown): Promise<Result<true>> {
  const f = await gate(d, a); if (f) return f;
  const cur = await d.get(a.userId, id);
  if (!cur) return deny("not_found", "That report was not found.");
  const p = await parseSave(body); if (!p.ok) return p;
  await d.update(a.userId, id, p.value.name, p.value.def);
  if (p.value.frequency === null) await d.setSchedule(id, null, "");
  else if (p.value.frequency && (cur.schedule?.frequency !== p.value.frequency)) await d.setSchedule(id, p.value.frequency, nextRunAt(p.value.frequency, d.now()));
  return { ok: true, value: true };
}

export async function deleteReport(d: ReportDeps, a: Actor, id: string): Promise<Result<true>> {
  const f = await gate(d, a); if (f) return f;
  if (!(await d.get(a.userId, id))) return deny("not_found", "That report was not found.");
  await d.remove(a.userId, id);
  return { ok: true, value: true };
}

/** A saved report's detail and its run history (newest first). `snapshot` stores this run's totals so later runs can be compared. */
export async function savedReport(d: ReportDeps, a: Actor, id: string, snapshot: boolean): Promise<Result<{ saved: SavedReport; report: ReportResult; insights: Insights; history: RunSnapshot[] }>> {
  const f = await gate(d, a); if (f) return f;
  const saved = await d.get(a.userId, id);
  if (!saved) return deny("not_found", "That report was not found.");
  const report = buildReport(saved.definition, await d.facts(a.userId), reportToday(d), d.now(), saved.name);
  if (snapshot) await d.addRun(id, "manual", report.period.from, report.period.to, report.totals, d.now().toISOString());
  return { ok: true, value: { saved, report, insights: reportInsights(report), history: await d.runs(id) } };
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
export function emailText(r: ReportResult, ins: Insights, link: string): { subject: string; text: string } {
  const t = reportTable(r);
  const widths = t.head.map((h, i) => Math.min(28, Math.max(h.length, ...t.rows.slice(0, 30).map(row => String(row[i]).length))));
  const fmt = (row: readonly (string | number)[]) => row.map((c, i) => pad(String(c), widths[i]!)).join("  ").trimEnd();
  const lines = [
    ins.headline, "", ...ins.points.map(p => `- ${p}`), "",
    `${r.title} for ${r.period.from} to ${r.period.to} (compared with ${r.previousPeriod.from} to ${r.previousPeriod.to}).`, "",
    fmt(t.head), ...t.rows.slice(0, 31).map(fmt), t.rows.length > 31 ? `…and ${t.rows.length - 31} more rows` : "", "",
    `Open the full report, or export it as CSV, Excel or PDF: ${link}`, "",
    "Summary written by Elena, an AI assistant, from your own listings' numbers. Change or stop this email from your reports page."
  ];
  return { subject: `${r.title}: ${r.period.from} to ${r.period.to}`, text: lines.join("\n") };
}

export interface DueSummary { due: number; sent: number; notSent: number; skipped: number }

/**
 * Sends every scheduled report that is due. Each report is claimed first (its next run is moved on in one conditional update), so two
 * overlapping ticks cannot both send it. Agents who no longer hold a verified licence, or have no email, are skipped, and the next run is still booked.
 */
export async function runDueReports(d: ReportDeps, appUrl: string | undefined, limit = 50): Promise<DueSummary> {
  const now = d.now();
  const out: DueSummary = { due: 0, sent: 0, notSent: 0, skipped: 0 };
  for (const j of await d.due(now.toISOString(), limit)) {
    if (!(await d.claim(j.reportId, now.toISOString(), nextRunAt(j.frequency, now)))) continue;
    out.due++;
    const at = now.toISOString();
    try {
      const ok = !(await gate(d, { userId: j.agentId, userType: "agent" })) && j.email;
      if (!ok) { out.skipped++; await d.finish(j.reportId, "skipped", at); continue; }
      const report = buildReport(j.definition, await d.facts(j.agentId), reportToday(d), now, j.name);
      await d.addRun(j.reportId, "scheduled", report.period.from, report.period.to, report.totals, at);
      const m = emailText(report, reportInsights(report), `${(appUrl ?? "").replace(/\/+$/, "")}/agent/reports`);
      const sent = await d.send(j.agentId, j.email!, m.subject, m.text);
      sent ? out.sent++ : out.notSent++;
      await d.finish(j.reportId, sent ? "sent" : "not_sent", at);
    } catch {
      out.notSent++;
      await d.finish(j.reportId, "not_sent", at).catch(() => undefined);
    }
  }
  return out;
}
