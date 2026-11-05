import { randomUUID } from "node:crypto";
import type {
  AcceptOutcome, AgentAppointmentItem, AgentAppointmentRepository, AppointmentInvite, AppointmentRecord, AppointmentScope, InviteStatus
} from "../domain/agent-appointment-service";
import { isAgentPermission, type AgentPermission } from "../domain/access";
import { isJurisdiction } from "../domain/jurisdiction";
import { getDb } from "./context";
import { appendAuditPg, verifiedLicencesPg, type Queryable } from "./db";

// Constant SQL text; user input only travels as bound parameters. Owner and agent ids in WHERE clauses come from the
// session or from stored rows. Each write and its audit_event row run in one transaction. Nothing here deletes a row
// (db/20261025190000 also blocks deletes with triggers).

const text = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const scopeOf = (v: unknown): AppointmentScope => (v === "full" ? "full" : "enquiries_and_offers");
const permsOf = (v: unknown): { permissions?: AgentPermission[] } => (Array.isArray(v) ? { permissions: v.filter(isAgentPermission) } : {});
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));

export const GET_LISTING_SQL = "SELECT owner_user_id, jurisdiction, title FROM property_listing WHERE id = $1::uuid";
export const FIND_BY_ID_SQL = "SELECT id, user_type, status FROM app_user WHERE id = $1::uuid";
export const FIND_BY_EMAIL_SQL = "SELECT id, user_type, status FROM app_user WHERE email = $1::citext";
export const GET_INVITE_SQL =
  "SELECT i.id, i.listing_id, l.owner_user_id, i.agent_user_id, i.scope, i.permissions, i.status, i.created_at " +
  "FROM agent_appointment_invite i JOIN property_listing l ON l.id = i.listing_id WHERE i.id = $1::uuid";
export const GET_APPOINTMENT_SQL =
  "SELECT a.id, a.listing_id, l.owner_user_id, a.agent_user_id, a.scope, a.permissions, a.appointed_at, a.revoked_at " +
  "FROM listing_agent_appointment a JOIN property_listing l ON l.id = a.listing_id WHERE a.id = $1::uuid";
export const ACTIVE_FOR_LISTING_SQL =
  "SELECT a.id, a.listing_id, l.owner_user_id, a.agent_user_id, a.scope, a.permissions, a.appointed_at, a.revoked_at " +
  "FROM listing_agent_appointment a JOIN property_listing l ON l.id = a.listing_id WHERE a.listing_id = $1::uuid AND a.revoked_at IS NULL";
/** Params: 1 id, 2 listing, 3 owner, 4 agent, 5 scope, 6 created at, 7 permissions or null. Inserts only for the listing's owner and an active agent account. */
export const INSERT_INVITE_SQL =
  "INSERT INTO agent_appointment_invite (id, listing_id, agent_user_id, invited_by, scope, status, created_at, permissions) " +
  "SELECT $1::uuid, l.id, u.id, l.owner_user_id, $5::text, 'proposed', $6::timestamptz, $7::text[] FROM property_listing l, app_user u " +
  "WHERE l.id = $2::uuid AND l.owner_user_id = $3::uuid AND u.id = $4::uuid AND u.id <> l.owner_user_id " +
  "AND u.user_type = 'agent' AND u.status NOT IN ('suspended', 'closed') " +
  "ON CONFLICT DO NOTHING RETURNING id";
/** Params: 1 invite, 2 agent, 3 appointment id. Locks the invite row so two accepts cannot both win. */
export const LOCK_INVITE_SQL =
  "SELECT listing_id, scope, permissions, invited_by FROM agent_appointment_invite WHERE id = $1::uuid AND agent_user_id = $2::uuid AND status = 'proposed' FOR UPDATE";
export const INSERT_APPOINTMENT_SQL =
  "INSERT INTO listing_agent_appointment (id, listing_id, agent_user_id, appointed_by, scope, appointed_at, permissions) " +
  "SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::timestamptz, $7::text[] " +
  "WHERE NOT EXISTS (SELECT 1 FROM listing_agent_appointment WHERE listing_id = $2::uuid AND revoked_at IS NULL) " +
  "ON CONFLICT DO NOTHING RETURNING id";
export const MARK_ACCEPTED_SQL =
  "UPDATE agent_appointment_invite SET status = 'accepted', responded_at = $2::timestamptz, appointment_id = $3::uuid WHERE id = $1::uuid";
export const WITHDRAW_OTHERS_SQL =
  "UPDATE agent_appointment_invite SET status = 'withdrawn', responded_at = $3::timestamptz WHERE listing_id = $1::uuid AND id <> $2::uuid AND status = 'proposed'";
/** Params: 1 invite, 2 actor, 3 side, 4 to-status, 5 at. */
export const CLOSE_INVITE_SQL =
  "UPDATE agent_appointment_invite i SET status = $4::text, responded_at = $5::timestamptz FROM property_listing l " +
  "WHERE i.id = $1::uuid AND l.id = i.listing_id AND i.status = 'proposed' " +
  "AND (CASE WHEN $3::text = 'owner' THEN l.owner_user_id ELSE i.agent_user_id END) = $2::uuid RETURNING i.id";
/** Params: 1 appointment, 2 owner, 3 at. Only the listing's current owner can revoke. */
export const REVOKE_SQL =
  "UPDATE listing_agent_appointment a SET revoked_at = $3::timestamptz, revoked_by = $2::uuid FROM property_listing l " +
  "WHERE a.id = $1::uuid AND l.id = a.listing_id AND l.owner_user_id = $2::uuid AND a.revoked_at IS NULL RETURNING a.id";
/** Params: 1 appointment, 2 owner, 3 permissions. Only the listing's current owner, only while active. */
export const SET_PERMISSIONS_SQL =
  "UPDATE listing_agent_appointment a SET permissions = $3::text[] FROM property_listing l " +
  "WHERE a.id = $1::uuid AND l.id = a.listing_id AND l.owner_user_id = $2::uuid AND a.revoked_at IS NULL RETURNING a.id";
export const OWNER_INVITES_SQL =
  "SELECT i.id, i.listing_id, l.owner_user_id, i.agent_user_id, i.scope, i.permissions, i.status, i.created_at, u.display_name " +
  "FROM agent_appointment_invite i JOIN property_listing l ON l.id = i.listing_id JOIN app_user u ON u.id = i.agent_user_id " +
  "WHERE i.listing_id = $1::uuid AND i.status = 'proposed' ORDER BY i.created_at DESC, i.id LIMIT 50";
export const AGENT_NAME_SQL = "SELECT display_name FROM app_user WHERE id = $1::uuid";
export const AGENT_ITEMS_SQL =
  "SELECT 'invite' AS kind, i.id, i.listing_id, l.title, l.jurisdiction, o.display_name AS owner_name, i.scope, i.permissions, i.created_at AS since " +
  "FROM agent_appointment_invite i JOIN property_listing l ON l.id = i.listing_id JOIN app_user o ON o.id = l.owner_user_id " +
  "WHERE i.agent_user_id = $1::uuid AND i.status = 'proposed' " +
  "UNION ALL " +
  "SELECT 'appointment', a.id, a.listing_id, l.title, l.jurisdiction, o.display_name, a.scope, a.permissions, a.appointed_at " +
  "FROM listing_agent_appointment a JOIN property_listing l ON l.id = a.listing_id JOIN app_user o ON o.id = l.owner_user_id " +
  "WHERE a.agent_user_id = $1::uuid AND a.revoked_at IS NULL LIMIT 400";

const toInvite = (r: Record<string, unknown>): AppointmentInvite => ({
  id: text(r["id"]), listingId: text(r["listing_id"]), ownerUserId: text(r["owner_user_id"]), agentUserId: text(r["agent_user_id"]),
  scope: scopeOf(r["scope"]), ...permsOf(r["permissions"]), status: text(r["status"]) as InviteStatus, createdAt: iso(r["created_at"])
});
const toAppointment = (r: Record<string, unknown>): AppointmentRecord => ({
  id: text(r["id"]), listingId: text(r["listing_id"]), ownerUserId: text(r["owner_user_id"]), agentUserId: text(r["agent_user_id"]),
  scope: scopeOf(r["scope"]), ...permsOf(r["permissions"]), appointedAt: iso(r["appointed_at"]),
  ...(r["revoked_at"] !== null && r["revoked_at"] !== undefined ? { revokedAt: iso(r["revoked_at"]) } : {})
});

export function createPgAgentAppointmentRepository(db: Queryable): AgentAppointmentRepository {
  const one = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0];
  return {
    async getListing(id) {
      const r = await one(GET_LISTING_SQL, [id]);
      const jurisdiction = r ? text(r["jurisdiction"]).trim() : "";
      return r && isJurisdiction(jurisdiction) ? { ownerUserId: text(r["owner_user_id"]), jurisdiction, title: text(r["title"]) } : undefined;
    },
    async findAgent(ref) {
      const r = ref.by === "id" ? await one(FIND_BY_ID_SQL, [ref.userId]) : await one(FIND_BY_EMAIL_SQL, [ref.email]);
      return r ? { id: text(r["id"]), userType: text(r["user_type"]), status: text(r["status"]) } : undefined;
    },
    async getInvite(id) { const r = await one(GET_INVITE_SQL, [id]); return r ? toInvite(r) : undefined; },
    async getAppointment(id) { const r = await one(GET_APPOINTMENT_SQL, [id]); return r ? toAppointment(r) : undefined; },
    async activeForListing(listingId) { const r = await one(ACTIVE_FOR_LISTING_SQL, [listingId]); return r ? toAppointment(r) : undefined; },
    async insertInvite(i, audit) {
      return atomic(db, async tx => {
        const { rows } = await tx.query(INSERT_INVITE_SQL, [i.id, i.listingId, i.ownerUserId, i.agentUserId, i.scope, i.createdAt, i.permissions ?? null]);
        if (rows.length !== 1) return false;
        await appendAuditPg(tx, audit);
        return true;
      });
    },
    async acceptInvite(inviteId, agentUserId, a, audit): Promise<AcceptOutcome> {
      return atomic(db, async tx => {
        const locked = (await tx.query(LOCK_INVITE_SQL, [inviteId, agentUserId])).rows[0];
        if (!locked) return "stale";
        const ins = await tx.query(INSERT_APPOINTMENT_SQL, [a.id, text(locked["listing_id"]), agentUserId, text(locked["invited_by"]), text(locked["scope"]), a.appointedAt, locked["permissions"] ?? null]);
        if (ins.rows.length !== 1) return "listing_taken";
        await tx.query(MARK_ACCEPTED_SQL, [inviteId, a.appointedAt, a.id]);
        await tx.query(WITHDRAW_OTHERS_SQL, [text(locked["listing_id"]), inviteId, a.appointedAt]);
        await appendAuditPg(tx, audit);
        return "accepted";
      });
    },
    async closeInvite(inviteId, side, actorId, to, audit) {
      return atomic(db, async tx => {
        const { rows } = await tx.query(CLOSE_INVITE_SQL, [inviteId, actorId, side, to, audit.occurredAt]);
        if (rows.length !== 1) return false;
        await appendAuditPg(tx, audit);
        return true;
      });
    },
    async revoke(appointmentId, ownerUserId, at, audit) {
      return atomic(db, async tx => {
        const { rows } = await tx.query(REVOKE_SQL, [appointmentId, ownerUserId, at]);
        if (rows.length !== 1) return false;
        await appendAuditPg(tx, audit);
        return true;
      });
    },
    async ownerView(listingId) {
      const activeRow = await one(ACTIVE_FOR_LISTING_SQL, [listingId]);
      const active = activeRow ? toAppointment(activeRow) : null;
      const name = active ? await one(AGENT_NAME_SQL, [active.agentUserId]) : undefined;
      const { rows } = await db.query(OWNER_INVITES_SQL, [listingId]);
      return {
        active: active ? { ...active, agentName: text(name?.["display_name"] ?? "Agent") } : null,
        invites: rows.map(r => ({ ...toInvite(r), agentName: text(r["display_name"]) }))
      };
    },
    async agentItems(agentUserId) {
      const { rows } = await db.query(AGENT_ITEMS_SQL, [agentUserId]);
      return rows.flatMap((r): Omit<AgentAppointmentItem, "licensed" | "granted">[] => {
        const jurisdiction = text(r["jurisdiction"]).trim();
        if (!isJurisdiction(jurisdiction)) return [];
        return [{
          kind: r["kind"] === "invite" ? "invite" : "appointment", id: text(r["id"]), listingId: text(r["listing_id"]),
          listingTitle: text(r["title"]), jurisdiction, ownerName: text(r["owner_name"]), scope: scopeOf(r["scope"]), ...permsOf(r["permissions"]),
          since: iso(r["since"])
        }];
      });
    },
    async setPermissions(appointmentId, ownerUserId, permissions, audit) {
      return atomic(db, async tx => {
        const { rows } = await tx.query(SET_PERMISSIONS_SQL, [appointmentId, ownerUserId, permissions]);
        if (rows.length !== 1) return false;
        await appendAuditPg(tx, audit);
        return true;
      });
    },
    verifiedLicences: () => verifiedLicencesPg(db)
  };
}

/** Wired from the shared pool in context.ts, so that file stays untouched. */
export const getAgentAppointmentRepo = () => createPgAgentAppointmentRepository(getDb());
export const appointmentIds = { newId: () => randomUUID(), now: () => new Date().toISOString() };
