import { buildPerformance, median, money, rankLeads, type LeadFact, type OfferFacts, type Performance } from "./agent-workspace";
import { hasVerifiedLicence, type AgentLicence } from "./licence";
import type { Actor, Failure, Result } from "./listing-service";

/**
 * Agent teams: members and roles, a performance dashboard, commission splits and task assignment.
 * Pure rules over facts supplied by deps. Joining needs the agent's own acceptance; the assistant only reads numbers and suggests.
 * What a viewer sees depends on their team role: principal sees everything, manager sees performance and tasks, agent sees team totals and their own row.
 */
export const TEAM_ROLES = ["principal", "manager", "agent"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const DEFAULT_RATE_BPS = 200;
export const MAX_RATE_BPS = 1000;

export interface TeamFact { id: string; name: string; commissionRateBps: number }
export interface MemberFact { userId: string; name: string; role: TeamRole; status: "invited" | "active"; agentShareBps: number }
export interface TaskFact { id: string; title: string; listingId?: string; listingTitle?: string; assigneeId: string; createdBy: string; dueOn?: string; status: "open" | "done" }
export interface TeamListingFact { listingId: string; title: string; agentId: string }
export interface Membership { team: TeamFact; role: TeamRole; status: "invited" | "active" }

export interface TeamDeps {
  licences(): Promise<readonly AgentLicence[]>;
  today(): string;
  now(): Date;
  memberships(userId: string): Promise<Membership[]>;
  team(teamId: string): Promise<TeamFact | undefined>;
  members(teamId: string): Promise<MemberFact[]>;
  findAgentByEmail(email: string): Promise<{ userId: string; name: string } | undefined>;
  createTeam(name: string, userId: string): Promise<string>;
  upsertInvite(teamId: string, userId: string, role: TeamRole, invitedBy: string): Promise<void>;
  activate(teamId: string, userId: string): Promise<boolean>;
  endMembership(teamId: string, userId: string): Promise<void>;
  updateMember(teamId: string, userId: string, patch: { role?: TeamRole; agentShareBps?: number }): Promise<void>;
  updateTeam(teamId: string, patch: { name?: string; commissionRateBps?: number }): Promise<void>;
  archiveTeam(teamId: string): Promise<void>;
  leads(agentId: string): Promise<LeadFact[]>;
  offers(agentId: string): Promise<OfferFacts>;
  listings(teamId: string): Promise<TeamListingFact[]>;
  tasks(teamId: string): Promise<TaskFact[]>;
  addTask(teamId: string, t: { title: string; listingId?: string; assigneeId: string; createdBy: string; dueOn?: string }): Promise<void>;
  setTaskStatus(teamId: string, taskId: string, status: "open" | "done", at: string): Promise<void>;
  personaName(): Promise<string>;
}

const deny = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const isManager = (r: TeamRole) => r === "principal" || r === "manager";

async function gate(d: TeamDeps, a: Actor): Promise<Failure | undefined> {
  if (a.userType !== "agent") return deny("forbidden", "Only agents can use teams.");
  const ls = await d.licences(), today = d.today();
  if (!ls.some(l => hasVerifiedLicence(ls, a.userId, l.jurisdiction, today))) return deny("forbidden", "A verified licence is required to use teams.");
  return undefined;
}

/** The viewer's active role in the team, or not_found so that team ids cannot be probed. */
async function access(d: TeamDeps, a: Actor, teamId: string): Promise<Result<{ team: TeamFact; role: TeamRole }>> {
  const f = await gate(d, a); if (f) return f;
  const m = (await d.memberships(a.userId)).find(x => x.team.id === teamId && x.status === "active");
  return m ? { ok: true, value: { team: m.team, role: m.role } } : deny("not_found", "Team not found.");
}

const fromPercent = (v: unknown, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v * 100) : undefined;

export function parseTeamName(v: unknown): Result<string> {
  const n = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  return n.length >= 2 && n.length <= 80 ? { ok: true, value: n } : deny("invalid", "Give the team a name of 2 to 80 characters.");
}

/** Gross commission on accepted offers at the team rate, split between the agent and the team. Integer cents; the team keeps the rounding. */
export function commissionSplit(closedCents: number, rateBps: number, agentShareBps: number) {
  const gross = Math.round((closedCents * rateBps) / 10_000);
  const agent = Math.round((gross * agentShareBps) / 10_000);
  return { grossCents: gross, agentCents: agent, teamCents: gross - agent, agentShareBps };
}

export interface MemberRow {
  userId: string; name: string; role: TeamRole; status: "invited" | "active"; performance?: Performance;
  openTasks: number; overdueTasks: number; listings: number;
  commission?: ReturnType<typeof commissionSplit> & { pipelineGrossCents: number };
}
export interface TeamTotals {
  members: number; listings: number; enquiries: number; hot: number; unanswered: number; overdue: number; openOffers: number; pipelineCents: number;
  closedDeals: number; closedCents: number; acceptanceRate?: number; medianResponseMinutes?: number; openTasks: number; overdueTasks: number;
  commission?: { grossCents: number; agentCents: number; teamCents: number };
}
export interface TeamDashboard { totals: TeamTotals; members: MemberRow[] }

export interface Insight { kind: "replies" | "workload" | "tasks" | "speed" | "data"; text: string }

interface Computed { rows: (MemberRow & { performance: Performance })[]; totals: TeamTotals }

async function compute(d: TeamDeps, team: TeamFact, members: readonly MemberFact[], tasks: readonly TaskFact[]): Promise<Computed> {
  const today = d.today(), now = d.now();
  const active = members.filter(m => m.status === "active");
  const facts = await Promise.all(active.map(async m => {
    const [leads, offers] = await Promise.all([d.leads(m.userId), d.offers(m.userId)]);
    const ranked = rankLeads(leads, now);
    return { m, ranked, offers, performance: buildPerformance(ranked, offers, { agents: 0 }) };
  }));
  const rows = facts.map(({ m, performance, offers }): Computed["rows"][number] => {
    const mine = tasks.filter(t => t.assigneeId === m.userId && t.status === "open");
    const split = commissionSplit(offers.acceptedCents, team.commissionRateBps, m.agentShareBps);
    return {
      userId: m.userId, name: m.name, role: m.role, status: m.status, performance, listings: offers.listings,
      openTasks: mine.length, overdueTasks: mine.filter(t => t.dueOn && t.dueOn < today).length,
      commission: { ...split, pipelineGrossCents: Math.round((offers.openCents * team.commissionRateBps) / 10_000) }
    };
  });
  const sum = (f: (r: Computed["rows"][number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const allLeads = facts.flatMap(f => f.ranked);
  const replies = allLeads.filter(l => l.firstAgentAt).map(l => (Date.parse(l.firstAgentAt!) - Date.parse(l.enquiredAt)) / 60_000).filter(m => m >= 0);
  const accepted = facts.reduce((s, f) => s + f.offers.accepted, 0), rejected = facts.reduce((s, f) => s + f.offers.rejected, 0);
  const mr = median(replies);
  const totals: TeamTotals = {
    members: active.length, listings: sum(r => r.listings), enquiries: sum(r => r.performance.enquiries), hot: sum(r => r.performance.hot),
    unanswered: sum(r => r.performance.unanswered), overdue: sum(r => r.performance.overdue), openOffers: sum(r => r.performance.openOffers),
    pipelineCents: sum(r => r.performance.pipelineCents), closedDeals: sum(r => r.performance.closedDeals), closedCents: sum(r => r.performance.closedCents),
    openTasks: sum(r => r.openTasks), overdueTasks: sum(r => r.overdueTasks),
    ...(accepted + rejected > 0 ? { acceptanceRate: Math.round((accepted / (accepted + rejected)) * 100) } : {}),
    ...(mr !== undefined ? { medianResponseMinutes: mr } : {}),
    commission: { grossCents: sum(r => r.commission!.grossCents), agentCents: sum(r => r.commission!.agentCents), teamCents: sum(r => r.commission!.teamCents) }
  };
  return { rows, totals };
}

/** Narrows the computed dashboard to what the viewer's role may see. Invited members appear in the roster only. */
function visible(c: Computed, viewer: string, role: TeamRole, members: readonly MemberFact[]): TeamDashboard {
  const totals: TeamTotals = { ...c.totals };
  if (role !== "principal") delete totals.commission;
  const rows: MemberRow[] = [];
  for (const m of members) {
    const r = c.rows.find(x => x.userId === m.userId);
    const own = m.userId === viewer;
    if (!r) { if (isManager(role)) rows.push({ userId: m.userId, name: m.name, role: m.role, status: m.status, openTasks: 0, overdueTasks: 0, listings: 0 }); continue; }
    if (!isManager(role) && !own) continue;
    const { commission, ...rest } = r;
    rows.push(role === "principal" || own ? { ...rest, ...(commission ? { commission } : {}) } : rest);
  }
  return { totals, members: rows };
}

/** Suggestions from the numbers only. They name who and why; nothing is done on anyone's behalf. */
export function teamInsights(c: Computed): Insight[] {
  const out: Insight[] = [];
  const { rows, totals } = c;
  if (rows.length < 2 || totals.enquiries + totals.openTasks === 0) return [{ kind: "data", text: "There is not enough activity yet for useful suggestions. Add members, tasks and listings and ask again." }];
  const waiting = [...rows].filter(r => r.performance.unanswered > 0).sort((a, b) => b.performance.unanswered - a.performance.unanswered);
  if (waiting[0]) out.push({ kind: "replies", text: `${waiting[0].name} has ${waiting[0].performance.unanswered} buyer${waiting[0].performance.unanswered === 1 ? "" : "s"} waiting for a first reply. Ask a teammate to help, or create a follow-up task.` });
  const byListings = [...rows].sort((a, b) => b.listings - a.listings), most = byListings[0]!, least = byListings[byListings.length - 1]!;
  if (most.listings >= 4 && most.listings >= least.listings * 2 && most.userId !== least.userId) {
    out.push({ kind: "workload", text: `${most.name} looks after ${most.listings} listings and ${least.name} ${least.listings}. Consider giving ${least.name} the follow-up tasks on ${most.name}'s busiest listings; owners decide who is appointed.` });
  }
  const late = [...rows].filter(r => r.overdueTasks > 0).sort((a, b) => b.overdueTasks - a.overdueTasks)[0];
  if (late) out.push({ kind: "tasks", text: `${late.name} has ${late.overdueTasks} overdue task${late.overdueTasks === 1 ? "" : "s"}. Check whether they need help or a new due date.` });
  const tm = totals.medianResponseMinutes;
  if (tm !== undefined) {
    const slow = rows.find(r => r.performance.medianResponseMinutes !== undefined && r.performance.medianResponseMinutes >= Math.max(tm * 2, 60));
    if (slow) out.push({ kind: "speed", text: `${slow.name}'s median first reply is ${mins(slow.performance.medianResponseMinutes!)} against ${mins(tm)} for the team. Faster first replies tend to keep enquiries warm.` });
  }
  return out.length ? out : [{ kind: "data", text: "Nothing stands out: replies, workload and tasks look balanced." }];
}

const mins = (m: number) => (m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`);

export interface TeamView {
  team: { id: string; name: string; commissionRateBps?: number }; role: TeamRole; viewerId: string; roster: MemberFact[]; dashboard: TeamDashboard; tasks: TaskFact[]; listings: TeamListingFact[];
}

async function load(d: TeamDeps, team: TeamFact, role: TeamRole, viewer: string) {
  const [members, tasks, listings] = await Promise.all([d.members(team.id), d.tasks(team.id), d.listings(team.id)]);
  const c = await compute(d, team, members, tasks);
  return { members, tasks, listings, c, dashboard: visible(c, viewer, role, members) };
}

/** What each role may do with tasks: managers see all; an agent sees their own. */
const taskScope = (tasks: readonly TaskFact[], viewer: string, role: TeamRole) => (isManager(role) ? [...tasks] : tasks.filter(t => t.assigneeId === viewer));

export async function getMyTeams(d: TeamDeps, a: Actor): Promise<Result<{ active?: { id: string; name: string; role: TeamRole }; invitations: { teamId: string; teamName: string; role: TeamRole }[] }>> {
  const f = await gate(d, a); if (f) return f;
  const ms = await d.memberships(a.userId);
  const act = ms.find(m => m.status === "active");
  return { ok: true, value: { ...(act ? { active: { id: act.team.id, name: act.team.name, role: act.role } } : {}), invitations: ms.filter(m => m.status === "invited").map(m => ({ teamId: m.team.id, teamName: m.team.name, role: m.role })) } };
}

export async function createTeam(d: TeamDeps, a: Actor, body: unknown): Promise<Result<{ id: string }>> {
  const f = await gate(d, a); if (f) return f;
  const name = parseTeamName(((body ?? {}) as Record<string, unknown>)["name"]); if (!name.ok) return name;
  if ((await d.memberships(a.userId)).some(m => m.status === "active")) return deny("conflict", "You are already in a team. Leave it before creating another.");
  return { ok: true, value: { id: await d.createTeam(name.value, a.userId) } };
}

export async function getTeam(d: TeamDeps, a: Actor, teamId: string): Promise<Result<TeamView>> {
  const g = await access(d, a, teamId); if (!g.ok) return g;
  const { team, role } = g.value;
  const l = await load(d, team, role, a.userId);
  // Splits are the principal's business: other roles see only their own.
  const members = isManager(role) ? l.members : l.members.filter(m => m.status === "active");
  const roster = members.map(m => (role === "principal" || m.userId === a.userId ? m : { ...m, agentShareBps: 0 }));
  const view: TeamView["team"] = role === "principal" ? team : { id: team.id, name: team.name };
  return { ok: true, value: { team: view, role, viewerId: a.userId, roster, dashboard: l.dashboard, tasks: taskScope(l.tasks, a.userId, role), listings: isManager(role) ? l.listings : l.listings.filter(x => x.agentId === a.userId) } };
}

export async function updateTeam(d: TeamDeps, a: Actor, teamId: string, body: unknown): Promise<Result<true>> {
  const g = await access(d, a, teamId); if (!g.ok) return g;
  if (g.value.role !== "principal") return deny("forbidden", "Only the team principal can change team settings.");
  const o = (body ?? {}) as Record<string, unknown>, patch: { name?: string; commissionRateBps?: number } = {};
  if (o["name"] !== undefined) { const n = parseTeamName(o["name"]); if (!n.ok) return n; patch.name = n.value; }
  if (o["commissionRatePercent"] !== undefined) {
    const bps = fromPercent(o["commissionRatePercent"], MAX_RATE_BPS / 100);
    if (bps === undefined) return deny("invalid", "Commission rate must be between 0 and 10 percent.");
    patch.commissionRateBps = bps;
  }
  if (Object.keys(patch).length === 0) return deny("invalid", "Nothing to change.");
  await d.updateTeam(teamId, patch);
  return { ok: true, value: true };
}

export async function archiveTeam(d: TeamDeps, a: Actor, teamId: string): Promise<Result<true>> {
  const g = await access(d, a, teamId); if (!g.ok) return g;
  if (g.value.role !== "principal") return deny("forbidden", "Only the team principal can close the team.");
  await d.archiveTeam(teamId);
  return { ok: true, value: true };
}

export async function inviteMember(d: TeamDeps, a: Actor, teamId: string, body: unknown): Promise<Result<{ name: string }>> {
  const g = await access(d, a, teamId); if (!g.ok) return g;
  if (!isManager(g.value.role)) return deny("forbidden", "Only the principal or a manager can invite agents.");
  const o = (body ?? {}) as Record<string, unknown>;
  const email = typeof o["email"] === "string" ? o["email"].trim().toLowerCase() : "";
  const role = (o["role"] ?? "agent") as TeamRole;
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 254) return deny("invalid", "Enter the agent's email address.");
  if (role !== "agent" && role !== "manager") return deny("invalid", "Invite as agent or manager.");
  if (role === "manager" && g.value.role !== "principal") return deny("forbidden", "Only the principal can invite a manager.");
  const target = await d.findAgentByEmail(email);
  const ls = await d.licences(), today = d.today();
  if (!target || !ls.some(l => hasVerifiedLicence(ls, target.userId, l.jurisdiction, today))) return deny("not_found", "No licensed agent was found with that email.");
  const ms = await d.memberships(target.userId);
  if (ms.some(m => m.status === "active")) return deny("conflict", "That agent is already in a team.");
  if (ms.some(m => m.team.id === teamId && m.status === "invited")) return deny("conflict", "That agent already has an invitation.");
  await d.upsertInvite(teamId, target.userId, role, a.userId);
  return { ok: true, value: { name: target.name } };
}

/** The invited agent accepts or declines. Nobody joins a team without saying yes. */
export async function respondToInvitation(d: TeamDeps, a: Actor, teamId: string, body: unknown): Promise<Result<{ joined: boolean }>> {
  const f = await gate(d, a); if (f) return f;
  const accept = ((body ?? {}) as Record<string, unknown>)["accept"];
  if (typeof accept !== "boolean") return deny("invalid", "Say whether you accept or decline.");
  const ms = await d.memberships(a.userId);
  if (!ms.some(m => m.team.id === teamId && m.status === "invited")) return deny("not_found", "No invitation found.");
  if (!accept) { await d.endMembership(teamId, a.userId); return { ok: true, value: { joined: false } }; }
  if (ms.some(m => m.status === "active")) return deny("conflict", "You are already in a team. Leave it first.");
  if (!(await d.activate(teamId, a.userId))) return deny("conflict", "You are already in a team. Leave it first.");
  return { ok: true, value: { joined: true } };
}

export async function updateMember(d: TeamDeps, a: Actor, teamId: string, userId: string, body: unknown): Promise<Result<true>> {
  const g = await access(d, a, teamId); if (!g.ok) return g;
  if (g.value.role !== "principal") return deny("forbidden", "Only the team principal can change roles and commission splits.");
  const target = (await d.members(teamId)).find(m => m.userId === userId && m.status === "active");
  if (!target) return deny("not_found", "That member is not in the team.");
  const o = (body ?? {}) as Record<string, unknown>, patch: { role?: TeamRole; agentShareBps?: number } = {};
  if (o["role"] !== undefined) {
    if (target.role === "principal") return deny("forbidden", "The principal's role cannot be changed.");
    if (o["role"] !== "manager" && o["role"] !== "agent") return deny("invalid", "Choose manager or agent.");
    patch.role = o["role"];
  }
  if (o["agentSharePercent"] !== undefined) {
    const bps = fromPercent(o["agentSharePercent"], 100);
    if (bps === undefined) return deny("invalid", "The agent's share must be between 0 and 100 percent.");
    patch.agentShareBps = bps;
  }
  if (Object.keys(patch).length === 0) return deny("invalid", "Nothing to change.");
  await d.updateMember(teamId, userId, patch);
  return { ok: true, value: true };
}

/** Principal or manager removes an agent (a manager cannot remove a manager or the principal); anyone but the principal can leave. */
export async function removeMember(d: TeamDeps, a: Actor, teamId: string, userId: string): Promise<Result<true>> {
  const g = await access(d, a, teamId); if (!g.ok) return g;
  const target = (await d.members(teamId)).find(m => m.userId === userId);
  if (!target) return deny("not_found", "That member is not in the team.");
  if (target.role === "principal") return deny("forbidden", "The principal cannot be removed. Close the team instead.");
  const self = userId === a.userId;
  if (!self && !(g.value.role === "principal" || (g.value.role === "manager" && target.role === "agent"))) return deny("forbidden", "You cannot remove that member.");
  // Open tasks stay with the team; a manager can reassign them.
  await d.endMembership(teamId, userId);
  return { ok: true, value: true };
}

function parseDate(v: unknown): string | undefined | null {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

export async function assignTask(d: TeamDeps, a: Actor, teamId: string, body: unknown): Promise<Result<true>> {
  const g = await access(d, a, teamId); if (!g.ok) return g;
  const o = (body ?? {}) as Record<string, unknown>;
  const title = typeof o["title"] === "string" ? o["title"].trim() : "";
  if (!title || title.length > 200) return deny("invalid", "Give the task a title of up to 200 characters.");
  const due = parseDate(o["dueOn"]); if (due === null) return deny("invalid", "Due date must be YYYY-MM-DD or empty.");
  const assigneeId = typeof o["assigneeId"] === "string" ? o["assigneeId"] : a.userId;
  if (assigneeId !== a.userId && !isManager(g.value.role)) return deny("forbidden", "Agents can only create tasks for themselves.");
  if (!(await d.members(teamId)).some(m => m.userId === assigneeId && m.status === "active")) return deny("invalid", "Assign the task to an active team member.");
  let listingId: string | undefined;
  if (o["listingId"] !== undefined && o["listingId"] !== null && o["listingId"] !== "") {
    listingId = typeof o["listingId"] === "string" ? o["listingId"] : "";
    if (!(await d.listings(teamId)).some(l => l.listingId === listingId)) return deny("invalid", "Choose a listing one of the team's agents is appointed to.");
  }
  await d.addTask(teamId, { title, assigneeId, createdBy: a.userId, ...(listingId ? { listingId } : {}), ...(due ? { dueOn: due } : {}) });
  return { ok: true, value: true };
}

export async function updateTask(d: TeamDeps, a: Actor, teamId: string, taskId: string, body: unknown): Promise<Result<true>> {
  const g = await access(d, a, teamId); if (!g.ok) return g;
  const status = ((body ?? {}) as Record<string, unknown>)["status"];
  if (status !== "open" && status !== "done") return deny("invalid", "Set the status to open or done.");
  const t = (await d.tasks(teamId)).find(x => x.id === taskId);
  if (!t || (!isManager(g.value.role) && t.assigneeId !== a.userId)) return deny("not_found", "Task not found.");
  await d.setTaskStatus(teamId, taskId, status, d.now().toISOString());
  return { ok: true, value: true };
}

export interface TeamAnswer { topic: "performance" | "suggestions" | "commission" | "tasks" | "help"; text: string; suggestions: string[]; insights?: Insight[] }

export async function askTeamAssistant(d: TeamDeps, a: Actor, teamId: string, body: unknown): Promise<Result<TeamAnswer & { name: string }>> {
  const g = await access(d, a, teamId); if (!g.ok) return g;
  const q = (typeof ((body ?? {}) as Record<string, unknown>)["question"] === "string" ? String(((body ?? {}) as Record<string, unknown>)["question"]) : "").trim().toLowerCase();
  if (!q || q.length > 500) return deny("invalid", "Ask a question of up to 500 characters.");
  const { team, role } = g.value;
  const l = await load(d, team, role, a.userId);
  const name = await d.personaName(), t = l.dashboard.totals, mgr = isManager(role);
  const suggestions = mgr ? ["How is the team performing?", "What should we improve?", "Who has overdue tasks?"] : ["How is the team performing?", "What are my tasks?"];
  const ans = (topic: TeamAnswer["topic"], text: string, insights?: Insight[]): Result<TeamAnswer & { name: string }> => ({ ok: true, value: { topic, text, suggestions, name, ...(insights ? { insights } : {}) } });
  const perf = `${t.members} active member${t.members === 1 ? "" : "s"}, ${t.closedDeals} accepted offer${t.closedDeals === 1 ? "" : "s"} worth ${money(t.closedCents)}, ${t.openOffers} open offer${t.openOffers === 1 ? "" : "s"} worth ${money(t.pipelineCents)}${t.acceptanceRate !== undefined ? `, ${t.acceptanceRate}% acceptance` : ""}${t.medianResponseMinutes !== undefined ? `, median first reply ${mins(t.medianResponseMinutes)}` : ""}.`;
  if (/(commission|split|earn|payout|fee)/.test(q)) {
    if (role === "principal") {
      const c = t.commission!;
      return ans("commission", `At the team rate of ${(team.commissionRateBps / 100).toFixed(2)}% on accepted offers, estimated commission is ${money(c.grossCents)}: ${money(c.agentCents)} to agents and ${money(c.teamCents)} kept by the team. This is an estimate from your rate assumption, not a statement of money received.`);
    }
    const me = l.dashboard.members.find(m => m.userId === a.userId)?.commission;
    return ans("commission", me ? `Your estimated commission is ${money(me.agentCents)} on ${money(me.grossCents)} gross (your share ${me.agentShareBps / 100}%). This is an estimate from the team's rate assumption.` : "Commission figures are not available to you.");
  }
  if (/(task|overdue|todo|to do)/.test(q)) {
    const mine = l.tasks.filter(x => x.assigneeId === a.userId && x.status === "open");
    if (!mgr) return ans("tasks", mine.length ? `You have ${mine.length} open task${mine.length === 1 ? "" : "s"}: ${mine.slice(0, 3).map(x => x.title).join("; ")}.` : "You have no open tasks.");
    const late = l.dashboard.members.filter(m => m.overdueTasks > 0);
    return ans("tasks", `${t.openTasks} open task${t.openTasks === 1 ? "" : "s"} across the team, ${t.overdueTasks} overdue.${late.length ? ` Overdue: ${late.map(m => `${m.name} (${m.overdueTasks})`).join(", ")}.` : ""}`);
  }
  if (/(improv|suggest|optimi|better|advice|rebalanc|workload|help me)/.test(q)) {
    if (!mgr) return ans("suggestions", "Team-wide suggestions are for the principal and managers. I can tell you about your own tasks and the team totals.");
    const ins = teamInsights(l.c);
    return ans("suggestions", ins.map(i => i.text).join(" "), ins);
  }
  if (/(perform|team|how|deal|sales|result|insight)/.test(q)) {
    const best = mgr ? [...l.dashboard.members].filter(m => m.performance && m.performance.closedDeals > 0).sort((x, y) => y.performance!.closedCents - x.performance!.closedCents)[0] : undefined;
    return ans("performance", `${name} here. Team: ${perf}${best ? ` Top by accepted value: ${best.name}.` : ""}`);
  }
  return ans("help", `I can summarise team performance, suggest improvements, list overdue tasks${role === "principal" ? " and estimate commission splits" : ""}. I am an AI assistant, not a licensed agent, and I only read your team's data.`);
}
