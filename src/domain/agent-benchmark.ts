import { agentLabel } from "./admin-elena-insights";
import { medianOf } from "./area-forecast";
import { staffCan, type StaffActor } from "./staff-access";

/**
 * Agent benchmarking for staff: each agent against similar agents (same area, price band and experience band, relaxed step by step when
 * too few agents match) on sales, days on market, price-to-list, commission and lead conversion, with percentiles and a change against
 * the previous period of the same length. Shared facts (sales, enquiries, commission) also feed team trends (src/domain/team-trends.ts).
 *
 * Definitions, kept the same as the rest of the analytics:
 * - A sale is an accepted formal offer on a sale listing, dated by submission, credited to the agent appointed to the listing at that time.
 * - Days on market run from the listing's first publish (or creation when never published through the platform) to that offer.
 * - Price-to-list is the sale price as a share of the listing's asking price (when the listing has one).
 * - Lead conversion is the share of enquiries on the agent's listings whose buyer went on to make a formal offer on that listing.
 * - Commission is the agent's commission deals (not cancelled; override when set), dated by deal date. Financial permission only.
 */

export interface AgentFact { agentId: string; name: string; firstAppointedAt?: string; primaryArea?: string; medianListCents?: number }
/** One sale; `date` is the calendar day in the reporting zone. */
export interface AgentSale { agentId: string; date: string; priceCents: number; listCents?: number; daysOnMarket?: number }
export interface AgentEnquiryDay { agentId: string; date: string; enquiries: number; converted: number }
export interface AgentCommission { agentId: string; date: string; cents: number }
export interface AgentMetricFacts { agents: AgentFact[]; sales: AgentSale[]; enquiries: AgentEnquiryDay[]; commissions: AgentCommission[] }

export const METRIC_KEYS = ["sales", "daysOnMarket", "priceToList", "commission", "conversion"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
export type MetricValues = Partial<Record<MetricKey, number>>;
export const METRIC_INFO: Record<MetricKey, { label: string; higherIsBetter: boolean; unit: "count" | "days" | "percent" | "cents" }> = {
  sales: { label: "Sales", higherIsBetter: true, unit: "count" },
  daysOnMarket: { label: "Median days on market", higherIsBetter: false, unit: "days" },
  priceToList: { label: "Price to list", higherIsBetter: true, unit: "percent" },
  commission: { label: "Commission", higherIsBetter: true, unit: "cents" },
  conversion: { label: "Lead conversion", higherIsBetter: true, unit: "percent" }
};

export const PERIOD_DAYS = [30, 90, 180, 365] as const;
export const DEFAULT_PERIOD_DAYS = 90;
export const TREND_MONTHS = 6;
/** Fewer peers than this and the next criterion is dropped; percentiles need this many peers with a value. */
export const MIN_PEERS = 3;

const DAY_MS = 86_400_000;
const toUtc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const shiftDays = (d: string, n: number) => fmt(toUtc(d) + n * DAY_MS);
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface Period { from: string; to: string; days: number }
/** The period ending `today` and the equal period before it. */
export function periods(days: number, today: string): { current: Period; previous: Period } {
  const from = shiftDays(today, -(days - 1));
  return { current: { from, to: today, days }, previous: { from: shiftDays(from, -days), to: shiftDays(from, -1), days } };
}

export function parsePeriodDays(raw: string | null): number | undefined {
  if (raw === null || raw === "") return DEFAULT_PERIOD_DAYS;
  const n = Number(raw);
  return (PERIOD_DAYS as readonly number[]).includes(n) ? n : undefined;
}

const within = (d: string, p: Period) => d >= p.from && d <= p.to;

/** Metric values for one agent (or a whole set when agentId is undefined) over a period. Missing when there is nothing to measure. */
export function metricsFor(f: AgentMetricFacts, p: Period, agentId?: string): MetricValues {
  const mine = <T extends { agentId: string; date: string }>(rows: readonly T[]) => rows.filter(r => (agentId === undefined || r.agentId === agentId) && within(r.date, p));
  const sales = mine(f.sales), enq = mine(f.enquiries), com = mine(f.commissions);
  const out: MetricValues = { sales: sales.length, commission: com.reduce((a, c) => a + c.cents, 0) };
  const dom = medianOf(sales.flatMap(s => (s.daysOnMarket !== undefined && s.daysOnMarket >= 0 ? [s.daysOnMarket] : [])));
  if (dom !== undefined) out.daysOnMarket = Math.round(dom);
  const ptl = medianOf(sales.flatMap(s => (s.listCents && s.listCents > 0 ? [(s.priceCents / s.listCents) * 100] : [])));
  if (ptl !== undefined) out.priceToList = round1(ptl);
  const enquiries = enq.reduce((a, e) => a + e.enquiries, 0);
  if (enquiries > 0) out.conversion = round1((enq.reduce((a, e) => a + e.converted, 0) / enquiries) * 100);
  return out;
}

/** Share of peers this value beats (ties count half), 0-100; lower-is-better metrics are flipped. */
export function percentile(value: number, peers: readonly number[], higherIsBetter: boolean): number | undefined {
  if (peers.length < MIN_PEERS || peers.every(p => p === value)) return undefined; // everyone level: a rank would mean nothing
  let below = 0, equal = 0;
  for (const p of peers) {
    if (p === value) equal++;
    else if (higherIsBetter ? p < value : p > value) below++;
  }
  return Math.round(((below + equal / 2) / peers.length) * 100);
}

export function priceBand(cents: number | undefined): string {
  if (cents === undefined) return "No asking prices";
  if (cents < 60_000_000) return "Under $600k";
  if (cents < 100_000_000) return "$600k to $1m";
  if (cents < 200_000_000) return "$1m to $2m";
  return "$2m and over";
}
export function experienceBand(firstAppointedAt: string | undefined, asOf: string): string {
  if (!firstAppointedAt) return "New";
  const months = (toUtc(asOf) - Date.parse(firstAppointedAt)) / (30.44 * DAY_MS);
  return months < 12 ? "Under 1 year" : months < 36 ? "1 to 3 years" : "3 years and over";
}

export type Criterion = "area" | "price" | "experience";
interface Profile { id: string; area: string; price: string; experience: string }

/** Similar agents: all three criteria, then without experience, then without price, then everyone. Returns who and on what basis. */
export function peerGroup(me: Profile, all: readonly Profile[]): { ids: string[]; basis: Criterion[] } {
  const others = all.filter(a => a.id !== me.id);
  const steps: Criterion[][] = [["area", "price", "experience"], ["area", "price"], ["area"], []];
  for (const basis of steps) {
    const ids = others.filter(o => basis.every(c => o[c] === me[c])).map(o => o.id);
    if (ids.length >= MIN_PEERS || basis.length === 0) return { ids, basis };
  }
  return { ids: [], basis: [] };
}

export interface BenchmarkRow {
  /** Position-based key; agent ids never leave the server. */
  key: string; label: string; area: string; priceBand: string; experienceBand: string;
  current: MetricValues; previous: MetricValues; percentiles: MetricValues; peerMedian: MetricValues;
  peerCount: number; peerBasis: Criterion[]; monthlySales: number[];
}
export interface Benchmark {
  period: Period; previousPeriod: Period; months: string[]; metrics: MetricKey[]; rows: BenchmarkRow[]; financial: boolean; notes: string[];
}

export const BENCHMARK_NOTES = [
  "A sale is an accepted offer on a sale listing, dated by submission, credited to the agent appointed at the time.",
  "Days on market run from first publish to that offer. Price to list compares the sale price with the listing's asking price.",
  "Lead conversion is the share of enquiries whose buyer went on to make a formal offer.",
  "Peers are agents in the same main suburb, price band and experience band; when fewer than 3 match, experience, then price, then area is dropped.",
  "A percentile is the share of peers the agent does better than (for days on market, fewer is better)."
];

/** Month starts ("YYYY-MM") for the last n months ending with today's month. */
export function lastMonths(today: string, n: number): string[] {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - 1;
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - (n - 1 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export function buildBenchmark(actor: StaffActor, facts: AgentMetricFacts, days: number, today: string): Benchmark {
  const financial = staffCan(actor, "report.financial");
  const { current, previous } = periods(days, today);
  const metrics = METRIC_KEYS.filter(k => financial || k !== "commission");
  const months = lastMonths(today, TREND_MONTHS);
  const profiles: Profile[] = facts.agents.map(a => ({
    id: a.agentId, area: (a.primaryArea ?? "").trim().toLowerCase() || "unknown", price: priceBand(a.medianListCents), experience: experienceBand(a.firstAppointedAt, today)
  }));
  const cur = new Map(facts.agents.map(a => [a.agentId, metricsFor(facts, current, a.agentId)]));
  const sorted = [...facts.agents].sort((a, b) => (cur.get(b.agentId)!.sales ?? 0) - (cur.get(a.agentId)!.sales ?? 0) || a.name.localeCompare(b.name) || a.agentId.localeCompare(b.agentId));

  const rows = sorted.map((a, i): BenchmarkRow => {
    const me = profiles.find(p => p.id === a.agentId)!;
    const group = peerGroup(me, profiles);
    const mine = cur.get(a.agentId)!;
    const pct: MetricValues = {}, peerMed: MetricValues = {};
    for (const k of metrics) {
      const peerVals = group.ids.map(id => cur.get(id)![k]).filter((v): v is number => v !== undefined);
      const med = medianOf(peerVals);
      if (med !== undefined) peerMed[k] = k === "sales" || k === "commission" || k === "daysOnMarket" ? Math.round(med) : round1(med);
      const v = mine[k];
      if (v !== undefined) { const p = percentile(v, peerVals, METRIC_INFO[k].higherIsBetter); if (p !== undefined) pct[k] = p; }
    }
    const strip = (m: MetricValues): MetricValues => { if (financial) return m; const { commission: _drop, ...rest } = m; return rest; };
    const monthly = months.map(mo => facts.sales.filter(s => s.agentId === a.agentId && s.date.startsWith(mo)).length);
    return {
      key: `agent-${i + 1}`, label: agentLabel(actor, a.name, i), area: a.primaryArea?.trim() || "Unknown", priceBand: me.price, experienceBand: me.experience,
      current: strip(mine), previous: strip(metricsFor(facts, previous, a.agentId)), percentiles: pct, peerMedian: peerMed,
      peerCount: group.ids.length, peerBasis: group.basis, monthlySales: monthly
    };
  });
  return { period: current, previousPeriod: previous, months, metrics, rows, financial, notes: BENCHMARK_NOTES };
}
