import type { MemberFact, Membership, TaskFact, TeamDeps, TeamFact, TeamListingFact, TeamRole } from "../domain/agent-team";
import { personaById } from "../domain/assistant-persona";
import { loadLivePersona } from "./assistant-persona-db";
import { getDb } from "./context";
import { verifiedLicencesPg, type Queryable } from "./db";
import { leadsPg, offersPg } from "./agent-workspace-db";

// Constant SQL; ids and text only travel as bound parameters.
const teamOf = (x: Record<string, unknown>): TeamFact => ({ id: String(x["id"]), name: String(x["name"]), commissionRateBps: Number(x["commission_rate_bps"]) });

export function createTeamDeps(db: Queryable, now: () => Date = () => new Date()): TeamDeps {
  return {
    licences: () => verifiedLicencesPg(db), today: () => now().toISOString().slice(0, 10), now,
    async memberships(userId) {
      const r = await db.query(
        `SELECT t.id, t.name, t.commission_rate_bps, m.role, m.status FROM agent_team_member m JOIN agent_team t ON t.id = m.team_id
          WHERE m.user_id = $1::uuid AND m.status IN ('active','invited') AND t.archived_at IS NULL ORDER BY m.status, t.created_at`, [userId]);
      return r.rows.map((x): Membership => ({ team: teamOf(x), role: String(x["role"]) as TeamRole, status: String(x["status"]) as "active" | "invited" }));
    },
    async team(teamId) {
      const r = await db.query("SELECT id, name, commission_rate_bps FROM agent_team WHERE id = $1::uuid AND archived_at IS NULL", [teamId]);
      return r.rows[0] ? teamOf(r.rows[0]) : undefined;
    },
    async members(teamId) {
      const r = await db.query(
        `SELECT m.user_id, u.display_name, m.role, m.status, m.agent_share_bps FROM agent_team_member m JOIN app_user u ON u.id = m.user_id
          WHERE m.team_id = $1::uuid AND m.status IN ('active','invited') ORDER BY (m.role = 'principal') DESC, m.joined_at NULLS LAST, u.display_name, m.user_id`, [teamId]);
      return r.rows.map((x): MemberFact => ({ userId: String(x["user_id"]), name: String(x["display_name"]), role: String(x["role"]) as TeamRole, status: String(x["status"]) as "active" | "invited", agentShareBps: Number(x["agent_share_bps"]) }));
    },
    async findAgentByEmail(email) {
      const r = await db.query("SELECT id, display_name FROM app_user WHERE email = $1 AND user_type = 'agent' AND status = 'active'", [email]);
      return r.rows[0] ? { userId: String(r.rows[0]["id"]), name: String(r.rows[0]["display_name"]) } : undefined;
    },
    async createTeam(name, userId) {
      // One statement, so a failed membership (already in a team) never leaves an empty team behind.
      const r = await db.query(
        `WITH t AS (INSERT INTO agent_team (name, created_by) VALUES ($1,$2::uuid) RETURNING id)
         INSERT INTO agent_team_member (team_id, user_id, role, status, joined_at) SELECT id, $2::uuid, 'principal', 'active', now() FROM t RETURNING team_id`, [name, userId]);
      return String(r.rows[0]!["team_id"]);
    },
    async upsertInvite(teamId, userId, role, invitedBy) {
      await db.query(
        `INSERT INTO agent_team_member (team_id, user_id, role, status, invited_by) VALUES ($1::uuid,$2::uuid,$3,'invited',$4::uuid)
         ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'invited', invited_by = EXCLUDED.invited_by, invited_at = now(), joined_at = NULL, ended_at = NULL, agent_share_bps = 5000`,
        [teamId, userId, role, invitedBy]);
    },
    async activate(teamId, userId) {
      try {
        const r = await db.query("UPDATE agent_team_member SET status = 'active', joined_at = now() WHERE team_id = $1::uuid AND user_id = $2::uuid AND status = 'invited' RETURNING user_id", [teamId, userId]);
        return r.rows.length > 0;
      } catch (e) { if ((e as { code?: string }).code === "23505") return false; throw e; }
    },
    async endMembership(teamId, userId) {
      await db.query("UPDATE agent_team_member SET status = 'removed', ended_at = now() WHERE team_id = $1::uuid AND user_id = $2::uuid AND status <> 'removed'", [teamId, userId]);
    },
    async updateMember(teamId, userId, p) {
      await db.query("UPDATE agent_team_member SET role = COALESCE($3, role), agent_share_bps = COALESCE($4::int, agent_share_bps) WHERE team_id = $1::uuid AND user_id = $2::uuid AND status = 'active'", [teamId, userId, p.role ?? null, p.agentShareBps ?? null]);
    },
    async updateTeam(teamId, p) {
      await db.query("UPDATE agent_team SET name = COALESCE($2, name), commission_rate_bps = COALESCE($3::int, commission_rate_bps) WHERE id = $1::uuid", [teamId, p.name ?? null, p.commissionRateBps ?? null]);
    },
    async archiveTeam(teamId) {
      await db.query(
        `WITH m AS (UPDATE agent_team_member SET status = 'removed', ended_at = now() WHERE team_id = $1::uuid AND status <> 'removed')
         UPDATE agent_team SET archived_at = now() WHERE id = $1::uuid`, [teamId]);
    },
    leads: id => leadsPg(db, id), offers: id => offersPg(db, id),
    async listings(teamId) {
      const r = await db.query(
        `SELECT l.id, l.title, a.agent_user_id FROM agent_team_member m JOIN listing_agent_appointment a ON a.agent_user_id = m.user_id AND a.revoked_at IS NULL
           JOIN property_listing l ON l.id = a.listing_id WHERE m.team_id = $1::uuid AND m.status = 'active' ORDER BY l.title, l.id LIMIT 500`, [teamId]);
      return r.rows.map((x): TeamListingFact => ({ listingId: String(x["id"]), title: String(x["title"]), agentId: String(x["agent_user_id"]) }));
    },
    async tasks(teamId) {
      const r = await db.query(
        `SELECT k.id, k.title, k.listing_id, l.title AS listing_title, k.assignee_user_id, k.created_by, to_char(k.due_on, 'YYYY-MM-DD') AS due_on, k.status
           FROM agent_team_task k LEFT JOIN property_listing l ON l.id = k.listing_id WHERE k.team_id = $1::uuid
          ORDER BY (k.status = 'done'), k.due_on NULLS LAST, k.created_at DESC, k.id LIMIT 500`, [teamId]);
      return r.rows.map((x): TaskFact => ({
        id: String(x["id"]), title: String(x["title"]), assigneeId: String(x["assignee_user_id"]), createdBy: String(x["created_by"]), status: String(x["status"]) as "open" | "done",
        ...(x["listing_id"] ? { listingId: String(x["listing_id"]), listingTitle: String(x["listing_title"]) } : {}), ...(x["due_on"] ? { dueOn: String(x["due_on"]) } : {})
      }));
    },
    async addTask(teamId, t) {
      await db.query("INSERT INTO agent_team_task (team_id, title, listing_id, assignee_user_id, created_by, due_on) VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::date)",
        [teamId, t.title, t.listingId ?? null, t.assigneeId, t.createdBy, t.dueOn ?? null]);
    },
    async setTaskStatus(teamId, taskId, status, at) {
      await db.query("UPDATE agent_team_task SET status = $3, done_at = CASE WHEN $3 = 'done' THEN $4::timestamptz ELSE NULL END WHERE id = $2::uuid AND team_id = $1::uuid", [teamId, taskId, status, at]);
    },
    personaName: async () => personaById(await loadLivePersona(db)).name
  };
}
export const getTeamDeps = (): TeamDeps => createTeamDeps(getDb());
