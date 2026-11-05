import { ANALYTICS_TIME_ZONE, bucketKeys, bucketLabel, bucketStart } from "./admin-analytics";
import { buildInsights as buildTeamInsights, type DashboardRow } from "./agency-insights";
import type { Team } from "./agency-team";
import { buildReport, METRICS, PERIOD_DAYS, resolvePeriod, type MetricKey, type Period, type ReportFacts } from "./agent-reports";
import type { Actor, Result } from "./listing-service";
import { localDateInZone } from "./timezone";
import { managedTeam, mergeFacts, MAX_REPORT_MEMBERS, NO_OFFER_ENQUIRIES, WAITING_BUYERS, type ReportMember, type TeamReportDeps } from "./team-reports";

/**
 * Team analytics for a manager: what the team listed and sold, what each agent did, how sales moved month by month, the commission recorded
 * and where Elena sees trouble. "Sold" means an offer the owner accepted, dated by when it was submitted (the same rule as platform analytics);
 * the platform records no settlement date. Pure rules over facts the server loads.
 */

/** An agent whose accepted share of decided offers sits this far under the team's is flagged, once they have enough decided offers. */
export const RATE_GAP_POINTS = 20;
export const MIN_DECIDED = 5;
export const ANALYTICS_PERIOD_DAYS = PERIOD_DAYS;

export interface CommissionAgg { memberUserId: string; grossCents: number; memberCents: number; officeCents: number; entries: number }
export interface Change { current: number; previous: number; changePct?: number }
export interface AgentStat {
  userId: string; displayName: string; role: string;
  activeListings: number; enquiries: number; offers: number; sold: number; soldCents: number; acceptanceRate?: number;
  commissionGrossCents: number; commissionAgentCents: number; openTasks: number; overdueTasks: number;
}
export type AlertKind = "overdue_tasks" | "stalled_tasks" | "stale_payout" | "listing_imbalance" | "spare_capacity" | "single_manager" | "no_agents"
  | "no_offers" | "waiting_buyers" | "low_acceptance" | "sales_fell";
export interface TeamAlert { id: string; kind: AlertKind; severity: "high" | "medium" | "low"; memberUserId?: string; title: string; detail: string; suggestion: string }
export interface TeamAnalytics {
  team: { id: string; name: string };
  period: { from: string; to: string }; previousPeriod: { from: string; to: string };
  overview: {
    listedNow: number; enquiries: Change; offers: Change; sold: Change; soldCents: Change;
    commissionGrossCents: number; commissionAgentCents: number; commissionOfficeCents: number; commissionOwedCents: number; overdueTasks: number;
  };
  agents: AgentStat[];
  trends: { buckets: string[]; labels: string[]; sold: number[]; soldCents: number[]; perAgent: { userId: string; displayName: string; total: number; values: number[] }[] };
  alerts: TeamAlert[];
  summary: string;
  basis: string;
}

export const change = (current: number, previous: number): Change => ({ current, previous, ...(previous > 0 ? { changePct: Math.round(((current - previous) / previous) * 100) } : {}) });
const plural = (n: number, w: string) => `${n} ${n === 1 ? w : w.endsWith("y") ? `${w.slice(0, -1)}ies` : `${w}s`}`;
const aud = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
const dayOf = (iso: string) => localDateInZone(iso, ANALYTICS_TIME_ZONE);
const inRange = (day: string, from: string, to: string) => day >= from && day <= to;
const ALL = METRICS.map(m => m.key) as MetricKey[];

export interface AnalyticsInput {
  team: Pick<Team, "id" | "name">;
  members: readonly (ReportMember & { role: string })[];
  facts: ReadonlyMap<string, ReportFacts>;
  dashboard: readonly DashboardRow[];
  commissions: readonly CommissionAgg[];
  listedNow: number;
  period: Period;
  today: string;
  now: Date;
}

export function buildTeamAnalytics(i: AnalyticsInput): TeamAnalytics {
  const per = resolvePeriod(i.period, i.today);
  const def = { template: "custom" as const, metrics: ALL, groupBy: "none" as const, period: i.period };
  const empty: ReportFacts = { leads: [], offers: [] };
  const merged = mergeFacts(i.members.map(m => i.facts.get(m.userId) ?? empty));
  const team = buildReport(def, merged, i.today, i.now);
  const t = team.totals, p = team.previousTotals;
  const money = (list: readonly CommissionAgg[], f: (c: CommissionAgg) => number) => list.reduce((s, c) => s + f(c), 0);
  const dash = new Map(i.dashboard.map(r => [r.userId, r]));
  const comm = new Map(i.commissions.map(c => [c.memberUserId, c]));

  const agents: AgentStat[] = i.members.map(m => {
    const r = buildReport(def, i.facts.get(m.userId) ?? empty, i.today, i.now).totals;
    const d = dash.get(m.userId), c = comm.get(m.userId);
    return {
      userId: m.userId, displayName: m.displayName, role: m.role, activeListings: d?.activeListings ?? 0,
      enquiries: r.enquiries ?? 0, offers: r.offers ?? 0, sold: r.accepted ?? 0, soldCents: r.accepted_cents ?? 0,
      ...(r.acceptance_rate !== undefined ? { acceptanceRate: r.acceptance_rate } : {}),
      commissionGrossCents: c?.grossCents ?? 0, commissionAgentCents: c?.memberCents ?? 0, openTasks: d?.openTasks ?? 0, overdueTasks: d?.overdueTasks ?? 0
    };
  }).sort((a, b) => b.soldCents - a.soldCents || b.sold - a.sold || b.offers - a.offers || a.displayName.localeCompare(b.displayName));

  // Sales by month, for the team (each accepted offer once) and for each agent (a listing shared by two agents shows against both).
  const buckets = bucketKeys({ from: per.from, to: per.to, bucket: "month" });
  const at = new Map(buckets.map((b, n) => [b, n]));
  const spread = (f: ReportFacts, value: (price: number) => number) => {
    const out = buckets.map(() => 0);
    for (const o of f.offers) {
      if (o.status !== "accepted") continue;
      const day = dayOf(o.submittedAt);
      const n = inRange(day, per.from, per.to) ? at.get(bucketStart(day, "month")) : undefined;
      if (n !== undefined) out[n]! += value(o.priceCents);
    }
    return out;
  };
  const trends = {
    buckets, labels: buckets.map(b => bucketLabel(b, "month")), sold: spread(merged, () => 1), soldCents: spread(merged, c => c),
    perAgent: agents.map(a => ({ userId: a.userId, displayName: a.displayName, values: spread(i.facts.get(a.userId) ?? empty, c => c) }))
      .map(a => ({ ...a, total: a.values.reduce((s, v) => s + v, 0) })).filter(a => a.total > 0)
  };

  const alerts = buildAlerts(i, agents, t, p);
  const sold = change(t.accepted ?? 0, p.accepted ?? 0);
  const high = alerts.filter(a => a.severity === "high").length;
  const dir = sold.changePct === undefined ? "" : sold.changePct === 0 ? ", unchanged on the period before" : `, ${sold.changePct > 0 ? "up" : "down"} ${Math.abs(sold.changePct)}% on the period before`;
  const summary = `${i.team.name} had ${plural(sold.current, "accepted offer")} worth ${aud(t.accepted_cents ?? 0)} from ${per.from} to ${per.to}${dir}. ` +
    (alerts.length === 0 ? "No alerts: tasks, replies and offers look on track." : `${plural(alerts.length, "alert")}${high > 0 ? `, ${high} high` : ""}; the most urgent: ${alerts[0]!.title}.`);

  return {
    team: { id: i.team.id, name: i.team.name }, period: { from: per.from, to: per.to }, previousPeriod: { from: per.prevFrom, to: per.prevTo },
    overview: {
      listedNow: i.listedNow, enquiries: change(t.enquiries ?? 0, p.enquiries ?? 0), offers: change(t.offers ?? 0, p.offers ?? 0), sold,
      soldCents: change(t.accepted_cents ?? 0, p.accepted_cents ?? 0),
      commissionGrossCents: money(i.commissions, c => c.grossCents), commissionAgentCents: money(i.commissions, c => c.memberCents),
      commissionOfficeCents: money(i.commissions, c => c.officeCents), commissionOwedCents: i.dashboard.reduce((s, r) => s + (r.owedCents ?? 0), 0),
      overdueTasks: i.dashboard.reduce((s, r) => s + r.overdueTasks, 0)
    },
    agents, trends, alerts, summary,
    basis: "Rule-based and self-hosted, from your team's own numbers. Sold means an offer the owner accepted, dated by when it was submitted. Only listings an agent is appointed to now are counted. A listing held by two agents shows against both of them but once in the team total. Commission is a record of what is owed; the platform never moves money."
  };
}

function buildAlerts(i: AnalyticsInput, agents: readonly AgentStat[], t: Partial<Record<MetricKey, number>>, p: Partial<Record<MetricKey, number>>): TeamAlert[] {
  // Task, payout and workload alerts come from the same rules as the team dashboard, so the two pages never disagree.
  const out: TeamAlert[] = buildTeamInsights(i.dashboard, i.now.toISOString()).map((x, n) => ({
    id: `${x.kind}-${x.memberUserId ?? n}`, kind: x.kind, severity: x.severity, ...(x.memberUserId ? { memberUserId: x.memberUserId } : {}), title: x.title, detail: x.detail, suggestion: x.suggestion
  }));
  const waiting = new Map<string, number>();
  for (const m of i.members) waiting.set(m.userId, buildReport({ template: "custom", metrics: ["awaiting_reply"], groupBy: "none", period: i.period }, i.facts.get(m.userId) ?? { leads: [], offers: [] }, i.today, i.now).totals.awaiting_reply ?? 0);
  const decided = (t.accepted ?? 0) + buildRejected(i);
  const teamRate = decided >= MIN_DECIDED ? Math.round(((t.accepted ?? 0) / decided) * 100) : undefined;

  for (const a of agents) {
    if (a.enquiries >= NO_OFFER_ENQUIRIES && a.offers === 0) {
      out.push({ id: `no_offers-${a.userId}`, kind: "no_offers", severity: "medium", memberUserId: a.userId, title: `${a.displayName} has had no offers this period`,
        detail: `${plural(a.enquiries, "enquiry")} came in for ${a.displayName}'s listings and none became an offer.`,
        suggestion: "Review price guides, photos and descriptions on their listings, and check buyers are getting quick replies." });
    }
    const w = waiting.get(a.userId) ?? 0;
    if (w >= WAITING_BUYERS) {
      out.push({ id: `waiting_buyers-${a.userId}`, kind: "waiting_buyers", severity: "high", memberUserId: a.userId, title: `${a.displayName} has ${w} buyers waiting for a reply`,
        detail: `${plural(w, "buyer")} wrote to ${a.displayName} and have had no first reply.`, suggestion: "Ask them to reply today, or move the enquiries to a teammate with room." });
    }
    const dec = agentDecided(i, a.userId);
    if (teamRate !== undefined && dec >= MIN_DECIDED && a.acceptanceRate !== undefined && a.acceptanceRate <= teamRate - RATE_GAP_POINTS) {
      out.push({ id: `low_acceptance-${a.userId}`, kind: "low_acceptance", severity: "medium", memberUserId: a.userId, title: `${a.displayName}'s offers are accepted less often`,
        detail: `${a.acceptanceRate}% of ${a.displayName}'s decided offers were accepted against ${teamRate}% for the team (${plural(dec, "decided offer")}).`,
        suggestion: "Look at the offers owners rejected; the pattern is often pricing guidance rather than effort." });
    }
  }
  const prev = p.accepted ?? 0, cur = t.accepted ?? 0;
  if (prev >= 3 && cur * 10 <= prev * 5) {
    out.push({ id: "sales_fell", kind: "sales_fell", severity: "medium", title: "Accepted offers fell by half or more",
      detail: `${plural(cur, "offer")} accepted against ${prev} in the period before.`, suggestion: "Check whether listings went off the market or enquiries dried up, then talk to the agents involved." });
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id));
}

function periodOffers(i: AnalyticsInput, facts: ReportFacts) {
  const per = resolvePeriod(i.period, i.today);
  return facts.offers.filter(o => inRange(dayOf(o.submittedAt), per.from, per.to));
}
function agentDecided(i: AnalyticsInput, userId: string): number {
  return periodOffers(i, i.facts.get(userId) ?? { leads: [], offers: [] }).filter(o => o.status === "accepted" || o.status === "rejected").length;
}
function buildRejected(i: AnalyticsInput): number {
  const merged = mergeFacts(i.members.map(m => i.facts.get(m.userId) ?? { leads: [], offers: [] }));
  return periodOffers(i, merged).filter(o => o.status === "rejected").length;
}

/** Analytics period from a query string: ?days=7|30|90|365 or ?from=&to= (two years at most). Same rules as agent reports. */
export function analyticsPeriod(p: URLSearchParams): Result<Period> {
  if (p.get("from") || p.get("to")) {
    const from = p.get("from") ?? "", to = p.get("to") ?? "";
    const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
    if (!ok(from) || !ok(to)) return { ok: false, code: "invalid", message: "Dates must be real dates in the form YYYY-MM-DD." };
    if (from > to) return { ok: false, code: "invalid", message: "The start date must be on or before the end date." };
    if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 > 730) return { ok: false, code: "invalid", message: "Choose a period of two years or less." };
    return { ok: true, value: { from, to } };
  }
  const days = Number(p.get("days") ?? 90);
  if (!(PERIOD_DAYS as readonly number[]).includes(days)) return { ok: false, code: "invalid", message: "Choose a period of 7, 30, 90 or 365 days." };
  return { ok: true, value: { days } };
}

/* ---------- service ---------- */

export interface TeamAnalyticsDeps extends TeamReportDeps {
  dashboardRows(teamId: string, now: string): Promise<DashboardRow[]>;
  commissions(teamId: string, from: string, to: string): Promise<CommissionAgg[]>;
  listedNow(userIds: string[]): Promise<number>;
}

export async function teamAnalytics(d: TeamAnalyticsDeps, actor: Actor, teamId: string, period: Period): Promise<Result<TeamAnalytics>> {
  const m = await managedTeam(d.repo, actor, teamId);
  if (!m.ok) return m;
  const members = m.value.members.slice(0, MAX_REPORT_MEMBERS);
  const now = d.now();
  const today = localDateInZone(now.toISOString(), ANALYTICS_TIME_ZONE);
  const per = resolvePeriod(period, today);
  const ids = members.map(x => x.userId);
  const [facts, dashboard, commissions, listedNow] = await Promise.all([d.facts(ids), d.dashboardRows(teamId, now.toISOString()), d.commissions(teamId, per.from, per.to), d.listedNow(ids)]);
  return { ok: true, value: buildTeamAnalytics({ team: m.value.team, members, facts, dashboard, commissions, listedNow, period, today, now }) };
}
