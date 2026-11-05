import type { AuditEvent } from "./audit";
import type { Actor, Result } from "./listing-service";
import { buildInsights, elenaSummary, type DashboardRow, type Insight, type TeamTotals } from "./agency-insights";

// Agency teams and offices. A team is owned by managers; agents and staff work inside it. The platform holds no money:
// commission entries record what is owed and "paid" is marked by a manager after the agency pays outside the platform.
// Everyone who is not an active member gets 404 so team ids are not probe-able.

export const TEAM_ROLES = ["manager", "agent", "staff"] as const;
export type TeamRole = typeof TEAM_ROLES[number];
export const TEAM_KINDS = ["team", "office"] as const;
export type TeamKind = typeof TEAM_KINDS[number];
export const TASK_STATUSES = ["open", "in_progress", "done"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export type CommissionStatus = "recorded" | "approved" | "paid";
export const DEFAULT_MEMBER_BPS = 7000;
export const MAX_GROSS_CENTS = 100_000_000_000;

export interface Team { id: string; name: string; kind: TeamKind; defaultMemberBps: number }
export interface TeamSummary extends Team { role: TeamRole; memberCount: number }
export interface TeamMember { userId: string; displayName: string; role: TeamRole; memberBps: number | null; email?: string }
export interface Membership { role: TeamRole; memberBps: number | null }
export interface TeamTask {
  id: string; teamId: string; title: string; notes: string; assigneeUserId: string; listingId: string | null;
  dueDate: string | null; status: TaskStatus; createdBy: string; createdAt: string; completedAt: string | null;
}
export interface Commission {
  id: string; teamId: string; memberUserId: string; listingId: string | null; description: string; grossCents: number;
  memberBps: number; memberCents: number; officeCents: number; status: CommissionStatus; payoutReference: string;
  createdAt: string; approvedAt: string | null; paidAt: string | null;
}
export interface UserRef { id: string; userType: string; status: string }

export interface AgencyTeamRepository {
  /** Inserts the team and its first manager in one write. */
  createTeam(team: Team, creatorId: string, audit: AuditEvent): Promise<void>;
  listMine(userId: string): Promise<TeamSummary[]>;
  getTeam(teamId: string): Promise<Team | undefined>;
  getMembership(teamId: string, userId: string): Promise<Membership | undefined>;
  listMembers(teamId: string): Promise<TeamMember[]>;
  updateTeam(teamId: string, patch: { name?: string; kind?: TeamKind; defaultMemberBps?: number }, audit: AuditEvent): Promise<boolean>;
  findUserByEmail(email: string): Promise<UserRef | undefined>;
  /** Adds or re-adds. False if the user is already an active member. */
  addMember(teamId: string, userId: string, role: TeamRole, addedBy: string, audit: AuditEvent): Promise<boolean>;
  /** False if there is no active member, it would leave the team without a manager, or it gives a non-agent account the manager or agent role. */
  updateMember(teamId: string, userId: string, patch: { role?: TeamRole; memberBps?: number | null }, audit: AuditEvent): Promise<boolean>;
  /** False if there is no active member, they are the last manager, or they still hold open tasks. */
  removeMember(teamId: string, userId: string, audit: AuditEvent): Promise<boolean>;
  listingExists(listingId: string): Promise<boolean>;
  createTask(task: TeamTask, audit: AuditEvent): Promise<void>;
  /** Pass assigneeUserId to limit the list to one person's tasks. */
  listTasks(teamId: string, assigneeUserId?: string): Promise<TeamTask[]>;
  getTask(teamId: string, taskId: string): Promise<TeamTask | undefined>;
  updateTask(teamId: string, taskId: string, patch: { status?: TaskStatus; assigneeUserId?: string; dueDate?: string | null; title?: string; notes?: string }, now: string, audit: AuditEvent): Promise<boolean>;
  recordCommission(c: Commission, recordedBy: string, audit: AuditEvent): Promise<void>;
  listCommissions(teamId: string, memberUserId?: string): Promise<Commission[]>;
  getCommission(teamId: string, id: string): Promise<Commission | undefined>;
  /** Moves recorded->approved or approved->paid only. False if the entry was not in the expected status. */
  advanceCommission(teamId: string, id: string, to: "approved" | "paid", payoutReference: string, now: string, audit: AuditEvent): Promise<boolean>;
  dashboardRows(teamId: string, now: string): Promise<DashboardRow[]>;
}

export interface TeamIds { newId: () => string; now: () => string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const notFound = { ok: false, code: "not_found", message: "Not found." } as const;
const invalid = (message: string) => ({ ok: false as const, code: "invalid" as const, message });
const forbidden = (message: string) => ({ ok: false as const, code: "forbidden" as const, message });
const conflict = (message: string) => ({ ok: false as const, code: "conflict" as const, message });
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

const audit = (ids: TeamIds, actor: Actor, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>): AuditEvent => ({
  id: ids.newId(), occurredAt: ids.now(), actorType: "user", actorId: actor.userId, aggregateType, aggregateId, eventType, correlationId: ids.newId(), payload
});

/** Splits a gross commission: the member's share is rounded down, so the agency keeps any odd cent. */
export function splitCommission(grossCents: number, memberBps: number): { memberCents: number; officeCents: number } {
  const memberCents = Math.floor((grossCents * memberBps) / 10000);
  return { memberCents, officeCents: grossCents - memberCents };
}

const bpsOk = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10000;
const isRole = (v: unknown): v is TeamRole => typeof v === "string" && (TEAM_ROLES as readonly string[]).includes(v);
const isKind = (v: unknown): v is TeamKind => typeof v === "string" && (TEAM_KINDS as readonly string[]).includes(v);
const cleanText = (v: unknown, min: number, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length >= min && s.length <= max ? s : undefined;
};
function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

async function member(repo: AgencyTeamRepository, actor: Actor, teamId: string): Promise<Result<{ team: Team; me: Membership }>> {
  if (!UUID.test(teamId)) return notFound;
  const [team, me] = await Promise.all([repo.getTeam(teamId), repo.getMembership(teamId, actor.userId)]);
  return team && me ? { ok: true, value: { team, me } } : notFound;
}
async function manager(repo: AgencyTeamRepository, actor: Actor, teamId: string): Promise<Result<{ team: Team; me: Membership }>> {
  const m = await member(repo, actor, teamId);
  if (!m.ok) return m;
  return m.value.me.role === "manager" ? m : forbidden("Only a team manager can do this.");
}

export async function createTeam(repo: AgencyTeamRepository, actor: Actor, input: unknown, ids: TeamIds): Promise<Result<Team>> {
  if (actor.userType !== "agent") return forbidden("Only agent accounts can create a team.");
  const o = obj(input);
  if (!o) return invalid("Send a JSON object.");
  const name = cleanText(o["name"], 2, 80);
  if (!name) return invalid("Team name must be 2 to 80 characters.");
  const kind = o["kind"] ?? "team";
  if (!isKind(kind)) return invalid("Kind must be team or office.");
  const bps = o["defaultMemberBps"] ?? DEFAULT_MEMBER_BPS;
  if (!bpsOk(bps)) return invalid("Default split must be a whole number of basis points from 0 to 10000.");
  const team: Team = { id: ids.newId(), name, kind, defaultMemberBps: bps };
  await repo.createTeam(team, actor.userId, audit(ids, actor, "agency_team", team.id, "agency_team.created", { name, kind, defaultMemberBps: bps }));
  return { ok: true, value: team };
}

export async function myTeams(repo: AgencyTeamRepository, actor: Actor): Promise<Result<TeamSummary[]>> {
  return { ok: true, value: await repo.listMine(actor.userId) };
}

export async function teamDetail(repo: AgencyTeamRepository, actor: Actor, teamId: string): Promise<Result<{ team: Team; myRole: TeamRole; me: string; members: TeamMember[] }>> {
  const m = await member(repo, actor, teamId);
  if (!m.ok) return m;
  const isManager = m.value.me.role === "manager";
  const members = (await repo.listMembers(teamId)).map(x => {
    const { email, ...rest } = x;
    // Email addresses and individual split rates are for managers (and for the member themself).
    const own = x.userId === actor.userId;
    return { ...rest, memberBps: isManager || own ? x.memberBps : null, ...(isManager && email ? { email } : {}) };
  });
  return { ok: true, value: { team: m.value.team, myRole: m.value.me.role, me: actor.userId, members } };
}

export async function updateTeam(repo: AgencyTeamRepository, actor: Actor, teamId: string, input: unknown, ids: TeamIds): Promise<Result<Team>> {
  const m = await manager(repo, actor, teamId);
  if (!m.ok) return m;
  const o = obj(input);
  if (!o) return invalid("Send a JSON object.");
  const patch: { name?: string; kind?: TeamKind; defaultMemberBps?: number } = {};
  if (o["name"] !== undefined) { const n = cleanText(o["name"], 2, 80); if (!n) return invalid("Team name must be 2 to 80 characters."); patch.name = n; }
  if (o["kind"] !== undefined) { if (!isKind(o["kind"])) return invalid("Kind must be team or office."); patch.kind = o["kind"]; }
  if (o["defaultMemberBps"] !== undefined) { if (!bpsOk(o["defaultMemberBps"])) return invalid("Default split must be 0 to 10000 basis points."); patch.defaultMemberBps = o["defaultMemberBps"]; }
  if (Object.keys(patch).length === 0) return invalid("Nothing to change.");
  await repo.updateTeam(teamId, patch, audit(ids, actor, "agency_team", teamId, "agency_team.updated", patch));
  return { ok: true, value: { ...m.value.team, ...patch } };
}

/** Adds an existing, active account by email. Managers and agents must be agent accounts; staff may be any non-admin account. */
export async function addMember(repo: AgencyTeamRepository, actor: Actor, teamId: string, input: unknown, ids: TeamIds): Promise<Result<{ userId: string; role: TeamRole }>> {
  const m = await manager(repo, actor, teamId);
  if (!m.ok) return m;
  const o = obj(input);
  if (!o) return invalid("Send a JSON object.");
  const email = typeof o["email"] === "string" ? o["email"].trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return invalid("Enter the member's email address.");
  if (!isRole(o["role"])) return invalid("Role must be manager, agent or staff.");
  const role = o["role"];
  const user = await repo.findUserByEmail(email);
  if (!user || user.status !== "active") return { ok: false, code: "not_found", message: "No active account has that email address." };
  if (user.userType === "admin") return invalid("That account cannot join a team.");
  if (role !== "staff" && user.userType !== "agent") return invalid("Managers and agents must have an agent account.");
  const added = await repo.addMember(teamId, user.id, role, actor.userId, audit(ids, actor, "agency_team", teamId, "agency_team.member_added", { userId: user.id, role }));
  return added ? { ok: true, value: { userId: user.id, role } } : conflict("That person is already on this team.");
}

export async function changeMember(repo: AgencyTeamRepository, actor: Actor, teamId: string, userId: string, input: unknown, ids: TeamIds): Promise<Result<{ userId: string }>> {
  const m = await manager(repo, actor, teamId);
  if (!m.ok) return m;
  if (!UUID.test(userId)) return notFound;
  const o = obj(input);
  if (!o) return invalid("Send a JSON object.");
  const patch: { role?: TeamRole; memberBps?: number | null } = {};
  if (o["role"] !== undefined) { if (!isRole(o["role"])) return invalid("Role must be manager, agent or staff."); patch.role = o["role"]; }
  if (o["memberBps"] !== undefined) {
    if (o["memberBps"] !== null && !bpsOk(o["memberBps"])) return invalid("Split must be 0 to 10000 basis points, or null for the team default.");
    patch.memberBps = o["memberBps"] as number | null;
  }
  if (Object.keys(patch).length === 0) return invalid("Nothing to change.");
  const ok = await repo.updateMember(teamId, userId, patch, audit(ids, actor, "agency_team", teamId, "agency_team.member_changed", { userId, ...patch }));
  return ok ? { ok: true, value: { userId } } : conflict("Not possible: the person must be an active member, a team needs at least one manager, and manager or agent roles need an agent account.");
}

export async function removeMember(repo: AgencyTeamRepository, actor: Actor, teamId: string, userId: string, ids: TeamIds): Promise<Result<{ userId: string }>> {
  const isSelf = userId === actor.userId;
  const m = isSelf ? await member(repo, actor, teamId) : await manager(repo, actor, teamId);
  if (!m.ok) return m;
  if (!UUID.test(userId)) return notFound;
  const ok = await repo.removeMember(teamId, userId, audit(ids, actor, "agency_team", teamId, "agency_team.member_removed", { userId }));
  return ok ? { ok: true, value: { userId } } : conflict("Not possible: the last manager cannot leave, and open tasks must be reassigned first.");
}

export async function createTask(repo: AgencyTeamRepository, actor: Actor, teamId: string, input: unknown, ids: TeamIds): Promise<Result<TeamTask>> {
  const m = await member(repo, actor, teamId);
  if (!m.ok) return m;
  const o = obj(input);
  if (!o) return invalid("Send a JSON object.");
  const title = cleanText(o["title"], 2, 200);
  if (!title) return invalid("Task title must be 2 to 200 characters.");
  const notes = o["notes"] === undefined ? "" : cleanText(o["notes"], 0, 2000);
  if (notes === undefined) return invalid("Notes must be at most 2000 characters.");
  const assignee = o["assigneeUserId"] === undefined ? actor.userId : o["assigneeUserId"];
  if (typeof assignee !== "string" || !UUID.test(assignee)) return invalid("Choose who the task is for.");
  if (assignee !== actor.userId && m.value.me.role !== "manager") return forbidden("Only a manager can assign a task to someone else.");
  if (!(await repo.getMembership(teamId, assignee))) return invalid("The assignee must be on this team.");
  const dueDate = o["dueDate"] ?? null;
  if (dueDate !== null && !isDate(dueDate)) return invalid("Due date must be YYYY-MM-DD.");
  const listingId = o["listingId"] ?? null;
  if (listingId !== null && (typeof listingId !== "string" || !UUID.test(listingId) || !(await repo.listingExists(listingId)))) return invalid("That listing was not found.");
  const task: TeamTask = { id: ids.newId(), teamId, title, notes, assigneeUserId: assignee, listingId, dueDate, status: "open", createdBy: actor.userId, createdAt: ids.now(), completedAt: null };
  await repo.createTask(task, audit(ids, actor, "agency_task", task.id, "agency_task.created", { teamId, assigneeUserId: assignee }));
  return { ok: true, value: task };
}

/** Managers see every task; everyone else sees the tasks assigned to them. */
export async function listTasks(repo: AgencyTeamRepository, actor: Actor, teamId: string): Promise<Result<TeamTask[]>> {
  const m = await member(repo, actor, teamId);
  if (!m.ok) return m;
  return { ok: true, value: await repo.listTasks(teamId, m.value.me.role === "manager" ? undefined : actor.userId) };
}

/** Managers may change anything. The person a task is assigned to may only change its status. */
export async function updateTask(repo: AgencyTeamRepository, actor: Actor, teamId: string, taskId: string, input: unknown, ids: TeamIds): Promise<Result<TeamTask>> {
  const m = await member(repo, actor, teamId);
  if (!m.ok) return m;
  if (!UUID.test(taskId)) return notFound;
  const task = await repo.getTask(teamId, taskId);
  const isManager = m.value.me.role === "manager";
  if (!task || (!isManager && task.assigneeUserId !== actor.userId)) return notFound;
  const o = obj(input);
  if (!o) return invalid("Send a JSON object.");
  const patch: { status?: TaskStatus; assigneeUserId?: string; dueDate?: string | null; title?: string; notes?: string } = {};
  if (o["status"] !== undefined) { if (typeof o["status"] !== "string" || !(TASK_STATUSES as readonly string[]).includes(o["status"])) return invalid("Status must be open, in_progress or done."); patch.status = o["status"] as TaskStatus; }
  const managerOnly = ["assigneeUserId", "dueDate", "title", "notes"].some(k => o[k] !== undefined);
  if (managerOnly && !isManager) return forbidden("Only a manager can change who a task is for, its title or its due date.");
  if (o["assigneeUserId"] !== undefined) {
    if (typeof o["assigneeUserId"] !== "string" || !UUID.test(o["assigneeUserId"]) || !(await repo.getMembership(teamId, o["assigneeUserId"]))) return invalid("The assignee must be on this team.");
    patch.assigneeUserId = o["assigneeUserId"];
  }
  if (o["dueDate"] !== undefined) { if (o["dueDate"] !== null && !isDate(o["dueDate"])) return invalid("Due date must be YYYY-MM-DD."); patch.dueDate = o["dueDate"] as string | null; }
  if (o["title"] !== undefined) { const t = cleanText(o["title"], 2, 200); if (!t) return invalid("Task title must be 2 to 200 characters."); patch.title = t; }
  if (o["notes"] !== undefined) { const n = cleanText(o["notes"], 0, 2000); if (n === undefined) return invalid("Notes must be at most 2000 characters."); patch.notes = n; }
  if (Object.keys(patch).length === 0) return invalid("Nothing to change.");
  if (!(await repo.updateTask(teamId, taskId, patch, ids.now(), audit(ids, actor, "agency_task", taskId, "agency_task.updated", { teamId, ...patch })))) return notFound;
  const next = await repo.getTask(teamId, taskId);
  return next ? { ok: true, value: next } : notFound;
}

/** A manager records a commission for an agent or manager; the split in force is fixed on the entry. */
export async function recordCommission(repo: AgencyTeamRepository, actor: Actor, teamId: string, input: unknown, ids: TeamIds): Promise<Result<Commission>> {
  const m = await manager(repo, actor, teamId);
  if (!m.ok) return m;
  const o = obj(input);
  if (!o) return invalid("Send a JSON object.");
  if (typeof o["memberUserId"] !== "string" || !UUID.test(o["memberUserId"])) return invalid("Choose the team member who earned it.");
  const target = await repo.getMembership(teamId, o["memberUserId"]);
  if (!target || target.role === "staff") return invalid("Commission can be recorded for managers and agents on this team.");
  const gross = o["grossCents"];
  if (typeof gross !== "number" || !Number.isInteger(gross) || gross <= 0 || gross > MAX_GROSS_CENTS) return invalid("Gross commission must be a positive whole number of cents.");
  const description = o["description"] === undefined ? "" : cleanText(o["description"], 0, 200);
  if (description === undefined) return invalid("Description must be at most 200 characters.");
  const listingId = o["listingId"] ?? null;
  if (listingId !== null && (typeof listingId !== "string" || !UUID.test(listingId) || !(await repo.listingExists(listingId)))) return invalid("That listing was not found.");
  const memberBps = target.memberBps ?? m.value.team.defaultMemberBps;
  const c: Commission = {
    id: ids.newId(), teamId, memberUserId: o["memberUserId"], listingId, description, grossCents: gross, memberBps,
    ...splitCommission(gross, memberBps), status: "recorded", payoutReference: "", createdAt: ids.now(), approvedAt: null, paidAt: null
  };
  await repo.recordCommission(c, actor.userId, audit(ids, actor, "agency_commission", c.id, "agency_commission.recorded",
    { teamId, memberUserId: c.memberUserId, grossCents: gross, memberBps, memberCents: c.memberCents }));
  return { ok: true, value: c };
}

/** Managers see every entry; agents see their own; staff see none. */
export async function listCommissions(repo: AgencyTeamRepository, actor: Actor, teamId: string): Promise<Result<Commission[]>> {
  const m = await member(repo, actor, teamId);
  if (!m.ok) return m;
  if (m.value.me.role === "staff") return { ok: true, value: [] };
  return { ok: true, value: await repo.listCommissions(teamId, m.value.me.role === "manager" ? undefined : actor.userId) };
}

/** Body: { action: "approve" } or { action: "mark_paid", payoutReference? }. Records only: no money moves on the platform. */
export async function advanceCommission(repo: AgencyTeamRepository, actor: Actor, teamId: string, id: string, input: unknown, ids: TeamIds): Promise<Result<Commission>> {
  const m = await manager(repo, actor, teamId);
  if (!m.ok) return m;
  if (!UUID.test(id)) return notFound;
  const o = obj(input);
  const action = o?.["action"];
  if (action !== "approve" && action !== "mark_paid") return invalid("Action must be approve or mark_paid.");
  const ref = o?.["payoutReference"] === undefined ? "" : cleanText(o["payoutReference"], 0, 200);
  if (ref === undefined) return invalid("Payout reference must be at most 200 characters.");
  const to = action === "approve" ? "approved" : "paid";
  const ok = await repo.advanceCommission(teamId, id, to, to === "paid" ? ref : "", ids.now(), audit(ids, actor, "agency_commission", id, `agency_commission.${to}`, { teamId }));
  if (!ok) return (await repo.getCommission(teamId, id)) ? conflict(to === "approved" ? "Only a recorded entry can be approved." : "Only an approved entry can be marked paid.") : notFound;
  const c = await repo.getCommission(teamId, id);
  return c ? { ok: true, value: c } : notFound;
}

export interface TeamDashboard {
  team: Team; myRole: TeamRole; rows: DashboardRow[]; totals: TeamTotals;
  /** Elena's read of the team. Managers only. */
  insights: Insight[] | null;
  /** The same read as one spoken-length paragraph. Managers only. */
  summary: string | null;
}

/** Managers see everyone with money. Others see the team's work counts and only their own money. */
export async function teamDashboard(repo: AgencyTeamRepository, actor: Actor, teamId: string, ids: TeamIds): Promise<Result<TeamDashboard>> {
  const m = await member(repo, actor, teamId);
  if (!m.ok) return m;
  const now = ids.now();
  const all = await repo.dashboardRows(teamId, now);
  const isManager = m.value.me.role === "manager";
  const rows = all.map(r => (isManager || r.userId === actor.userId ? r : { ...r, owedCents: null, paidCents: null, recordedCents: null, oldestUnpaidAt: null }));
  const totals = summarise(all);
  const insights = isManager ? buildInsights(all, now) : null;
  return { ok: true, value: {
    team: m.value.team, myRole: m.value.me.role, rows, totals: isManager ? totals : { ...totals, owedCents: null, recordedCents: null },
    insights, summary: insights ? elenaSummary(insights, m.value.team.name) : null
  } };
}

function summarise(rows: readonly DashboardRow[]): TeamTotals {
  const sum = (f: (r: DashboardRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  return {
    members: rows.length, activeListings: sum(r => r.activeListings), openTasks: sum(r => r.openTasks), overdueTasks: sum(r => r.overdueTasks),
    doneLast30: sum(r => r.doneLast30), owedCents: sum(r => r.owedCents ?? 0), recordedCents: sum(r => r.recordedCents ?? 0)
  };
}
