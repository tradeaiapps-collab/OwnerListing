import { ANALYTICS_TIME_ZONE } from "./admin-analytics";
import type { AgencyTeamRepository, Team } from "./agency-team";
import {
  buildReport, definitionFromQuery, formatValue, METRICS, reportInsights, type Insights, type MetricKey, type MetricKind, type OfferFact, type ReportDefinition, type ReportFacts,
  type ReportResult, type ReportRow
} from "./agent-reports";
import type { LeadFact } from "./agent-workspace";
import type { Actor, Result } from "./listing-service";
import { localDateInZone } from "./timezone";

/**
 * Team reports: the agent report engine run over every member of a team a manager looks after, with team totals, one row per agent,
 * an agent-against-agent comparison and filters for agents and property type. Pure rules. Managers only: an agent sees their own
 * reports on the agent reports page, never a colleague's. Reports hold counts, money and listing titles; never buyer names or messages.
 */

export const PROPERTY_TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];
/** Reports read two queries per member, so a team report is limited to this many people. */
export const MAX_REPORT_MEMBERS = 50;
/** An agent with at least this many enquiries and no offers in the period is called out. */
export const NO_OFFER_ENQUIRIES = 5;
export const WAITING_BUYERS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = { ok: false, code: "not_found", message: "Not found." } as const;
const invalid = (message: string) => ({ ok: false as const, code: "invalid" as const, message });

export interface ReportMember { userId: string; displayName: string }
export interface TeamReportFilter { agents: string[]; propertyType?: PropertyType }
export interface TeamReportRequest { definition: ReportDefinition; filter: TeamReportFilter }

export interface VersusRow { key: MetricKey; label: string; kind: MetricKind; a?: number; b?: number; leader: "a" | "b" | "tie" | null }
export interface Versus { a: ReportMember; b: ReportMember; rows: VersusRow[] }
export interface TeamReportResult {
  team: { id: string; name: string };
  report: ReportResult;
  /** One row per selected agent, whatever the grouping, so the page can always compare agents. */
  agentRows: ReportRow[];
  insights: Insights;
  members: (ReportMember & { role: string })[];
  filter: TeamReportFilter;
  versus?: Versus;
  truncatedMembers: boolean;
}

/** Metrics where a smaller number is the better one. */
const LOWER_IS_BETTER: readonly MetricKey[] = ["median_reply_minutes", "awaiting_reply"];

/**
 * ?template=&metrics=&groupBy=none|listing|month&days=|from=&to= as for agent reports, with team defaults: the sales template, one row per
 * agent ("none"). Unlike an agent's own report, "none" here means the table has a row for each agent.
 */
export function teamDefinitionFromQuery(p: URLSearchParams): Result<ReportDefinition> {
  const q = new URLSearchParams(p);
  if (!q.get("template") && !q.get("metrics")) q.set("template", "sales");
  if (!q.get("groupBy")) q.set("groupBy", "none");
  return definitionFromQuery(q);
}

/** Validates ?agents=id,id&propertyType=house on top of the usual report definition. Unknown values are refused, never ignored. */
export function parseTeamFilter(agents: string | null, propertyType: string | null, members: readonly ReportMember[]): Result<TeamReportFilter> {
  const ids = agents ? [...new Set(agents.split(",").map(s => s.trim()).filter(Boolean))] : [];
  if (ids.length > MAX_REPORT_MEMBERS) return invalid("Too many agents selected.");
  for (const id of ids) if (!UUID.test(id) || !members.some(m => m.userId === id)) return invalid("Choose agents from this team.");
  if (propertyType && !(PROPERTY_TYPES as readonly string[]).includes(propertyType)) return invalid("Choose a property type from the list.");
  return { ok: true, value: { agents: ids, ...(propertyType ? { propertyType: propertyType as PropertyType } : {}) } };
}

export function filterFacts(f: ReportFacts, propertyType?: PropertyType): ReportFacts {
  if (!propertyType) return f;
  return { leads: f.leads.filter(l => l.propertyType === propertyType), offers: f.offers.filter(o => o.propertyType === propertyType) };
}

/**
 * One fact set for the whole team. A listing can have two appointed agents, so the same enquiry or offer may arrive twice: it is counted once.
 * Of two copies of an enquiry the one with the earlier agent reply wins, so the team's reply time is the team's best.
 */
export function mergeFacts(all: readonly ReportFacts[]): ReportFacts {
  const leads = new Map<string, LeadFact>();
  for (const f of all) for (const l of f.leads) {
    const have = leads.get(l.enquiryId);
    if (!have || (l.firstAgentAt && (!have.firstAgentAt || l.firstAgentAt < have.firstAgentAt))) leads.set(l.enquiryId, l);
  }
  const offers = new Map<string, OfferFact>();
  for (const f of all) for (const o of f.offers) offers.set(`${o.listingId}|${o.submittedAt}|${o.priceCents}|${o.status}`, o);
  return { leads: [...leads.values()], offers: [...offers.values()] };
}

export function buildTeamReport(
  team: Pick<Team, "id" | "name">, def: ReportDefinition, members: readonly (ReportMember & { role: string })[], facts: ReadonlyMap<string, ReportFacts>,
  filter: TeamReportFilter, today: string, now: Date
): TeamReportResult {
  const chosen = members.filter(m => filter.agents.length === 0 || filter.agents.includes(m.userId));
  const own = chosen.map(m => ({ m, f: filterFacts(facts.get(m.userId) ?? { leads: [], offers: [] }, filter.propertyType) }));
  const title = `${team.name} ${def.template === "custom" ? "report" : `${def.template} report`}`;
  const none: ReportDefinition = { ...def, groupBy: "none" };

  // Every measure is worked out for every agent, shown or not, so Elena can flag a quiet agent whatever columns the report displays.
  const every: ReportDefinition = { ...none, metrics: METRICS.map(x => x.key) };
  const agentRows: ReportRow[] = own.map(({ m, f }) => ({ key: m.userId, label: m.displayName, values: buildReport(every, f, today, now).totals }));
  agentRows.sort((a, b) => (b.values.accepted_cents ?? b.values.offers ?? b.values.enquiries ?? 0) - (a.values.accepted_cents ?? a.values.offers ?? a.values.enquiries ?? 0) || a.label.localeCompare(b.label));

  const merged = mergeFacts(own.map(o => o.f));
  const team_ = buildReport(def, merged, today, now, title);
  // Grouped by "none" the table is one row per agent; by listing or month it is the team's own breakdown.
  const report: ReportResult = def.groupBy === "none" ? { ...team_, groupLabel: "Agent", rows: agentRows, truncated: false } : team_;

  const result: TeamReportResult = {
    team: { id: team.id, name: team.name }, report, agentRows, insights: teamInsights(report, agentRows, team.name, filter),
    members: members.map(m => ({ ...m })), filter, truncatedMembers: false
  };
  if (chosen.length === 2) result.versus = compareAgents(report, agentRows, chosen[0]!, chosen[1]!);
  return result;
}

/** Two agents side by side on every column of the report. `leader` is null when either has no figure. */
export function compareAgents(report: ReportResult, rows: readonly ReportRow[], a: ReportMember, b: ReportMember): Versus {
  const va = rows.find(r => r.key === a.userId)?.values ?? {}, vb = rows.find(r => r.key === b.userId)?.values ?? {};
  return {
    a, b,
    rows: report.columns.map(c => {
      const x = va[c.key], y = vb[c.key];
      const lower = LOWER_IS_BETTER.includes(c.key);
      const leader: VersusRow["leader"] = x === undefined || y === undefined ? null : x === y ? "tie" : (x < y) === lower ? "a" : "b";
      return { key: c.key, label: c.label, kind: c.kind, ...(x !== undefined ? { a: x } : {}), ...(y !== undefined ? { b: y } : {}), leader };
    })
  };
}

/** Elena's read of a team report: the usual change points, then who leads and who needs a conversation. Suggestions only. */
export function teamInsights(report: ReportResult, rows: readonly ReportRow[], teamName: string, filter: TeamReportFilter): Insights {
  const base = reportInsights(report);
  const points = [...base.points];
  const has = (k: MetricKey) => report.columns.some(c => c.key === k);
  if (rows.length >= 2) {
    const key: MetricKey | undefined = has("accepted_cents") ? "accepted_cents" : has("accepted") ? "accepted" : has("offers") ? "offers" : has("enquiries") ? "enquiries" : undefined;
    const top = key ? rows[0] : undefined;
    if (key && top && (top.values[key] ?? 0) > 0) {
      const label = METRICS.find(m => m.key === key)!;
      points.push(`${top.label} leads ${teamName} on ${label.label.toLowerCase()} (${formatValue(label.kind, top.values[key])}).`);
    }
  }
  for (const r of rows) if ((r.values.enquiries ?? 0) >= NO_OFFER_ENQUIRIES && (r.values.offers ?? 0) === 0) {
    points.push(`${r.label} had ${r.values.enquiries} enquiries and no offers. A look at price guides and listing quality may help.`);
  }
  for (const r of rows) if ((r.values.awaiting_reply ?? 0) >= WAITING_BUYERS) points.push(`${r.label} has ${r.values.awaiting_reply} buyers waiting for a first reply.`);
  if (filter.propertyType) points.push(`Only ${filter.propertyType} listings are counted.`);
  if (rows.length === 0) points.push("No agents match the filter.");
  return { headline: base.headline, points };
}

/* ---------- service ---------- */

export interface TeamReportDeps {
  repo: Pick<AgencyTeamRepository, "getTeam" | "getMembership" | "listMembers">;
  /** Appointed-listing facts for each person. Only called for people on the team. */
  facts(userIds: string[]): Promise<Map<string, ReportFacts>>;
  now(): Date;
}

/** The team a manager looks after, or the right refusal: 404 for outsiders so team ids cannot be probed, 403 for members who are not managers. */
export async function managedTeam(repo: TeamReportDeps["repo"], actor: Actor, teamId: string): Promise<Result<{ team: Team; members: (ReportMember & { role: string })[] }>> {
  if (!UUID.test(teamId)) return notFound;
  const [team, me] = await Promise.all([repo.getTeam(teamId), repo.getMembership(teamId, actor.userId)]);
  if (!team || !me) return notFound;
  if (me.role !== "manager") return { ok: false, code: "forbidden", message: "Only a team manager can see team reports." };
  const list = await repo.listMembers(teamId);
  // Staff members hold no listings, so they have no row in a performance report.
  return { ok: true, value: { team, members: list.filter(m => m.role !== "staff").map(m => ({ userId: m.userId, displayName: m.displayName, role: m.role })) } };
}

export async function runTeamReport(d: TeamReportDeps, actor: Actor, teamId: string, req: (members: readonly ReportMember[]) => Result<TeamReportRequest>): Promise<Result<TeamReportResult>> {
  const m = await managedTeam(d.repo, actor, teamId);
  if (!m.ok) return m;
  const parsed = req(m.value.members);
  if (!parsed.ok) return parsed;
  const wanted = m.value.members.filter(x => parsed.value.filter.agents.length === 0 || parsed.value.filter.agents.includes(x.userId));
  const used = wanted.slice(0, MAX_REPORT_MEMBERS);
  const today = localDateInZone(d.now().toISOString(), ANALYTICS_TIME_ZONE);
  const facts = await d.facts(used.map(x => x.userId));
  const out = buildTeamReport(m.value.team, parsed.value.definition, used, facts, parsed.value.filter, today, d.now());
  // Keep the full member list for the filter, but flag when the report left people out.
  out.members = m.value.members;
  out.truncatedMembers = wanted.length > used.length;
  return { ok: true, value: out };
}
