import { randomUUID } from "node:crypto";
import type { DashboardRow } from "../domain/agency-insights";
import type { AgencyTeamRepository, Commission, CommissionStatus, Team, TeamKind, TeamMember, TeamRole, TeamSummary, TeamTask, TaskStatus } from "../domain/agency-team";
import { getDb } from "./context";
import { appendAuditPg, type Queryable } from "./db";

// Constant SQL text; user input only travels as bound parameters. Team ids in WHERE clauses are checked against the
// caller's membership by the domain before any of these run. Nothing here deletes a task, member row or commission.
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isoOrNull = (v: unknown) => (v === null || v === undefined ? null : iso(v));
const s = (v: unknown) => String(v);

export const INSERT_TEAM_SQL = "INSERT INTO agency_team (id, name, kind, default_member_bps, created_by) VALUES ($1::uuid, $2, $3, $4, $5::uuid)";
export const INSERT_FIRST_MANAGER_SQL = "INSERT INTO agency_team_member (team_id, user_id, role, added_by) VALUES ($1::uuid, $2::uuid, 'manager', $2::uuid)";
export const LIST_MINE_SQL =
  "SELECT t.id, t.name, t.kind, t.default_member_bps, m.role, " +
  "(SELECT count(*) FROM agency_team_member x WHERE x.team_id = t.id AND x.removed_at IS NULL) AS members " +
  "FROM agency_team_member m JOIN agency_team t ON t.id = m.team_id WHERE m.user_id = $1::uuid AND m.removed_at IS NULL ORDER BY t.name, t.id";
export const GET_TEAM_SQL = "SELECT id, name, kind, default_member_bps FROM agency_team WHERE id = $1::uuid";
export const GET_MEMBERSHIP_SQL = "SELECT role, member_bps FROM agency_team_member WHERE team_id = $1::uuid AND user_id = $2::uuid AND removed_at IS NULL";
export const LIST_MEMBERS_SQL =
  "SELECT m.user_id, u.display_name, u.email::text AS email, m.role, m.member_bps FROM agency_team_member m JOIN app_user u ON u.id = m.user_id " +
  "WHERE m.team_id = $1::uuid AND m.removed_at IS NULL ORDER BY CASE m.role WHEN 'manager' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END, u.display_name, m.user_id LIMIT 500";
/** Params: 1 team, 2 name or null, 3 kind or null, 4 default bps or null. */
export const UPDATE_TEAM_SQL =
  "UPDATE agency_team SET name = COALESCE($2, name), kind = COALESCE($3, kind), default_member_bps = COALESCE($4::int, default_member_bps) WHERE id = $1::uuid RETURNING id";
export const FIND_USER_SQL = "SELECT id, user_type, status FROM app_user WHERE email = $1::citext";
/** Re-adding a removed member resets their split; an active member is left alone (no row returned). */
export const ADD_MEMBER_SQL =
  "INSERT INTO agency_team_member (team_id, user_id, role, added_by) VALUES ($1::uuid, $2::uuid, $3, $4::uuid) " +
  "ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role, member_bps = NULL, added_by = EXCLUDED.added_by, added_at = now(), removed_at = NULL " +
  "WHERE agency_team_member.removed_at IS NOT NULL RETURNING user_id";
const OTHER_MANAGER = "EXISTS (SELECT 1 FROM agency_team_member o WHERE o.team_id = m.team_id AND o.role = 'manager' AND o.removed_at IS NULL AND o.user_id <> m.user_id)";
/** Params: 1 team, 2 user, 3 role or null, 4 set split?, 5 split. Keeps a manager on the team and manager/agent roles on agent accounts. */
export const UPDATE_MEMBER_SQL =
  "UPDATE agency_team_member m SET role = COALESCE($3::text, m.role), member_bps = CASE WHEN $4::boolean THEN $5::int ELSE m.member_bps END " +
  "FROM app_user u WHERE m.team_id = $1::uuid AND m.user_id = $2::uuid AND m.removed_at IS NULL AND u.id = m.user_id " +
  "AND (COALESCE($3::text, m.role) = 'staff' OR u.user_type = 'agent') " +
  `AND (m.role <> 'manager' OR COALESCE($3::text, m.role) = 'manager' OR ${OTHER_MANAGER}) RETURNING m.user_id`;
export const REMOVE_MEMBER_SQL =
  "UPDATE agency_team_member m SET removed_at = now() WHERE m.team_id = $1::uuid AND m.user_id = $2::uuid AND m.removed_at IS NULL " +
  `AND (m.role <> 'manager' OR ${OTHER_MANAGER}) ` +
  "AND NOT EXISTS (SELECT 1 FROM agency_task t WHERE t.team_id = m.team_id AND t.assignee_user_id = m.user_id AND t.status <> 'done') RETURNING m.user_id";
export const LISTING_EXISTS_SQL = "SELECT 1 FROM property_listing WHERE id = $1::uuid";

const TASK_COLS = "id, team_id, title, notes, assignee_user_id, listing_id, to_char(due_date, 'YYYY-MM-DD') AS due_date, status, created_by, created_at, completed_at";
export const INSERT_TASK_SQL =
  "INSERT INTO agency_task (id, team_id, title, notes, assignee_user_id, listing_id, due_date, status, created_by, created_at) " +
  "VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7::date, 'open', $8::uuid, $9::timestamptz)";
/** Params: 1 team, 2 assignee or null for everyone. */
export const LIST_TASKS_SQL =
  `SELECT ${TASK_COLS} FROM agency_task WHERE team_id = $1::uuid AND ($2::uuid IS NULL OR assignee_user_id = $2::uuid) ` +
  "ORDER BY (status = 'done'), due_date NULLS LAST, created_at DESC LIMIT 500";
export const GET_TASK_SQL = `SELECT ${TASK_COLS} FROM agency_task WHERE team_id = $1::uuid AND id = $2::uuid`;
/** Params: 1 team, 2 id, 3 status, 4 assignee, 5 set due?, 6 due, 7 title, 8 notes, 9 now. */
export const UPDATE_TASK_SQL =
  "UPDATE agency_task SET status = COALESCE($3::text, status), assignee_user_id = COALESCE($4::uuid, assignee_user_id), " +
  "due_date = CASE WHEN $5::boolean THEN $6::date ELSE due_date END, title = COALESCE($7::text, title), notes = COALESCE($8::text, notes), " +
  "completed_at = CASE WHEN COALESCE($3::text, status) = 'done' THEN COALESCE(completed_at, $9::timestamptz) ELSE NULL END " +
  "WHERE team_id = $1::uuid AND id = $2::uuid RETURNING id";

const COMMISSION_COLS = "id, team_id, member_user_id, listing_id, description, gross_cents, member_bps, member_cents, office_cents, status, payout_reference, created_at, approved_at, paid_at";
export const INSERT_COMMISSION_SQL =
  "INSERT INTO agency_commission (id, team_id, member_user_id, listing_id, description, gross_cents, member_bps, member_cents, office_cents, recorded_by, created_at) " +
  "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::bigint, $7::int, $8::bigint, $9::bigint, $10::uuid, $11::timestamptz)";
export const LIST_COMMISSIONS_SQL =
  `SELECT ${COMMISSION_COLS} FROM agency_commission WHERE team_id = $1::uuid AND ($2::uuid IS NULL OR member_user_id = $2::uuid) ORDER BY created_at DESC, id LIMIT 500`;
export const GET_COMMISSION_SQL = `SELECT ${COMMISSION_COLS} FROM agency_commission WHERE team_id = $1::uuid AND id = $2::uuid`;
/** Params: 1 team, 2 id, 3 target status, 4 payout reference, 5 now. Only recorded->approved and approved->paid match. */
export const ADVANCE_COMMISSION_SQL =
  "UPDATE agency_commission SET status = $3::text, approved_at = CASE WHEN $3::text = 'approved' THEN $5::timestamptz ELSE approved_at END, " +
  "paid_at = CASE WHEN $3::text = 'paid' THEN $5::timestamptz ELSE paid_at END, payout_reference = $4 " +
  "WHERE team_id = $1::uuid AND id = $2::uuid AND status = CASE WHEN $3::text = 'approved' THEN 'recorded' ELSE 'approved' END RETURNING id";

/** Params: 1 team, 2 now. Due dates are compared as UTC dates. */
export const DASHBOARD_SQL =
  "SELECT m.user_id, u.display_name, m.role, " +
  "(SELECT count(*) FROM listing_agent_appointment a WHERE a.agent_user_id = m.user_id AND a.revoked_at IS NULL) AS active_listings, " +
  "(SELECT count(*) FROM agency_task t WHERE t.team_id = m.team_id AND t.assignee_user_id = m.user_id AND t.status <> 'done') AS open_tasks, " +
  "(SELECT count(*) FROM agency_task t WHERE t.team_id = m.team_id AND t.assignee_user_id = m.user_id AND t.status <> 'done' AND t.due_date < ($2::timestamptz AT TIME ZONE 'UTC')::date) AS overdue_tasks, " +
  "(SELECT count(*) FROM agency_task t WHERE t.team_id = m.team_id AND t.assignee_user_id = m.user_id AND t.status = 'done' AND t.completed_at >= $2::timestamptz - interval '30 days') AS done_30, " +
  "(SELECT COALESCE(sum(c.member_cents), 0) FROM agency_commission c WHERE c.team_id = m.team_id AND c.member_user_id = m.user_id AND c.status IN ('recorded','approved')) AS owed, " +
  "(SELECT COALESCE(sum(c.member_cents), 0) FROM agency_commission c WHERE c.team_id = m.team_id AND c.member_user_id = m.user_id AND c.status = 'paid' AND c.paid_at >= $2::timestamptz - interval '90 days') AS paid_90, " +
  "(SELECT COALESCE(sum(c.member_cents), 0) FROM agency_commission c WHERE c.team_id = m.team_id AND c.member_user_id = m.user_id AND c.created_at >= $2::timestamptz - interval '90 days') AS recorded_90, " +
  "(SELECT min(c.created_at) FROM agency_commission c WHERE c.team_id = m.team_id AND c.member_user_id = m.user_id AND c.status IN ('recorded','approved')) AS oldest_unpaid " +
  "FROM agency_team_member m JOIN app_user u ON u.id = m.user_id WHERE m.team_id = $1::uuid AND m.removed_at IS NULL " +
  "ORDER BY CASE m.role WHEN 'manager' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END, u.display_name, m.user_id LIMIT 500";

const toTeam = (r: Record<string, unknown>): Team => ({ id: s(r["id"]), name: s(r["name"]), kind: s(r["kind"]) as TeamKind, defaultMemberBps: Number(r["default_member_bps"]) });
const toTask = (r: Record<string, unknown>): TeamTask => ({
  id: s(r["id"]), teamId: s(r["team_id"]), title: s(r["title"]), notes: s(r["notes"]), assigneeUserId: s(r["assignee_user_id"]),
  listingId: r["listing_id"] ? s(r["listing_id"]) : null, dueDate: r["due_date"] ? s(r["due_date"]) : null, status: s(r["status"]) as TaskStatus,
  createdBy: s(r["created_by"]), createdAt: iso(r["created_at"]), completedAt: isoOrNull(r["completed_at"])
});
const toCommission = (r: Record<string, unknown>): Commission => ({
  id: s(r["id"]), teamId: s(r["team_id"]), memberUserId: s(r["member_user_id"]), listingId: r["listing_id"] ? s(r["listing_id"]) : null,
  description: s(r["description"]), grossCents: Number(r["gross_cents"]), memberBps: Number(r["member_bps"]), memberCents: Number(r["member_cents"]),
  officeCents: Number(r["office_cents"]), status: s(r["status"]) as CommissionStatus, payoutReference: s(r["payout_reference"]),
  createdAt: iso(r["created_at"]), approvedAt: isoOrNull(r["approved_at"]), paidAt: isoOrNull(r["paid_at"])
});

export function createPgAgencyTeamRepository(db: Queryable): AgencyTeamRepository {
  return {
    async createTeam(t, creatorId, audit) {
      await atomic(db, async tx => {
        await tx.query(INSERT_TEAM_SQL, [t.id, t.name, t.kind, t.defaultMemberBps, creatorId]);
        await tx.query(INSERT_FIRST_MANAGER_SQL, [t.id, creatorId]);
        await appendAuditPg(tx, audit);
      });
    },
    async listMine(userId) {
      const { rows } = await db.query(LIST_MINE_SQL, [userId]);
      return rows.map((r): TeamSummary => ({ ...toTeam(r), role: s(r["role"]) as TeamRole, memberCount: Number(r["members"]) }));
    },
    async getTeam(id) {
      const r = (await db.query(GET_TEAM_SQL, [id])).rows[0];
      return r ? toTeam(r) : undefined;
    },
    async getMembership(teamId, userId) {
      const r = (await db.query(GET_MEMBERSHIP_SQL, [teamId, userId])).rows[0];
      return r ? { role: s(r["role"]) as TeamRole, memberBps: r["member_bps"] === null ? null : Number(r["member_bps"]) } : undefined;
    },
    async listMembers(teamId) {
      const { rows } = await db.query(LIST_MEMBERS_SQL, [teamId]);
      return rows.map((r): TeamMember => ({
        userId: s(r["user_id"]), displayName: s(r["display_name"]), role: s(r["role"]) as TeamRole,
        memberBps: r["member_bps"] === null ? null : Number(r["member_bps"]), email: s(r["email"])
      }));
    },
    updateTeam: (teamId, p, audit) => atomic(db, async tx => {
      const ok = (await tx.query(UPDATE_TEAM_SQL, [teamId, p.name ?? null, p.kind ?? null, p.defaultMemberBps ?? null])).rows.length > 0;
      if (ok) await appendAuditPg(tx, audit);
      return ok;
    }),
    async findUserByEmail(email) {
      const r = (await db.query(FIND_USER_SQL, [email])).rows[0];
      return r ? { id: s(r["id"]), userType: s(r["user_type"]), status: s(r["status"]) } : undefined;
    },
    addMember: (teamId, userId, role, addedBy, audit) => atomic(db, async tx => {
      const ok = (await tx.query(ADD_MEMBER_SQL, [teamId, userId, role, addedBy])).rows.length > 0;
      if (ok) await appendAuditPg(tx, audit);
      return ok;
    }),
    updateMember: (teamId, userId, p, audit) => atomic(db, async tx => {
      const ok = (await tx.query(UPDATE_MEMBER_SQL, [teamId, userId, p.role ?? null, p.memberBps !== undefined, p.memberBps ?? null])).rows.length > 0;
      if (ok) await appendAuditPg(tx, audit);
      return ok;
    }),
    removeMember: (teamId, userId, audit) => atomic(db, async tx => {
      const ok = (await tx.query(REMOVE_MEMBER_SQL, [teamId, userId])).rows.length > 0;
      if (ok) await appendAuditPg(tx, audit);
      return ok;
    }),
    async listingExists(id) { return (await db.query(LISTING_EXISTS_SQL, [id])).rows.length > 0; },
    async createTask(t, audit) {
      await atomic(db, async tx => {
        await tx.query(INSERT_TASK_SQL, [t.id, t.teamId, t.title, t.notes, t.assigneeUserId, t.listingId, t.dueDate, t.createdBy, t.createdAt]);
        await appendAuditPg(tx, audit);
      });
    },
    async listTasks(teamId, assignee) { return (await db.query(LIST_TASKS_SQL, [teamId, assignee ?? null])).rows.map(toTask); },
    async getTask(teamId, id) { const r = (await db.query(GET_TASK_SQL, [teamId, id])).rows[0]; return r ? toTask(r) : undefined; },
    updateTask: (teamId, id, p, now, audit) => atomic(db, async tx => {
      const ok = (await tx.query(UPDATE_TASK_SQL, [teamId, id, p.status ?? null, p.assigneeUserId ?? null, p.dueDate !== undefined, p.dueDate ?? null, p.title ?? null, p.notes ?? null, now])).rows.length > 0;
      if (ok) await appendAuditPg(tx, audit);
      return ok;
    }),
    async recordCommission(c, recordedBy, audit) {
      await atomic(db, async tx => {
        await tx.query(INSERT_COMMISSION_SQL, [c.id, c.teamId, c.memberUserId, c.listingId, c.description, c.grossCents, c.memberBps, c.memberCents, c.officeCents, recordedBy, c.createdAt]);
        await appendAuditPg(tx, audit);
      });
    },
    async listCommissions(teamId, member) { return (await db.query(LIST_COMMISSIONS_SQL, [teamId, member ?? null])).rows.map(toCommission); },
    async getCommission(teamId, id) { const r = (await db.query(GET_COMMISSION_SQL, [teamId, id])).rows[0]; return r ? toCommission(r) : undefined; },
    advanceCommission: (teamId, id, to, ref, now, audit) => atomic(db, async tx => {
      const ok = (await tx.query(ADVANCE_COMMISSION_SQL, [teamId, id, to, ref, now])).rows.length > 0;
      if (ok) await appendAuditPg(tx, audit);
      return ok;
    }),
    async dashboardRows(teamId, now) {
      const { rows } = await db.query(DASHBOARD_SQL, [teamId, now]);
      return rows.map((r): DashboardRow => ({
        userId: s(r["user_id"]), displayName: s(r["display_name"]), role: s(r["role"]) as TeamRole,
        activeListings: Number(r["active_listings"]), openTasks: Number(r["open_tasks"]), overdueTasks: Number(r["overdue_tasks"]), doneLast30: Number(r["done_30"]),
        owedCents: Number(r["owed"]), paidCents: Number(r["paid_90"]), recordedCents: Number(r["recorded_90"]), oldestUnpaidAt: isoOrNull(r["oldest_unpaid"])
      }));
    }
  };
}

export const getAgencyTeamRepo = () => createPgAgencyTeamRepository(getDb());
export const agencyIds = { newId: () => randomUUID(), now: () => new Date().toISOString() };
