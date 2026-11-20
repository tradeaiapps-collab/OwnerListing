import { randomUUID } from "node:crypto";
import type { AssignmentKind, AssignmentRepository, AssignmentSummary } from "../domain/assignment-service";
import type { AuditEvent } from "../domain/audit";
import type { AssignmentStatus, JobAssignment } from "../domain/job-chat";
import { isJurisdiction } from "../domain/jurisdiction";
import { getDb } from "./context";
import { verifiedLicencesPg, type Queryable } from "./db";

// Every statement has constant text; user input only ever travels as a bound parameter. Owner and
// contractor ids in WHERE clauses come from the session or from stored rows, never from a request body.
// Each write is ONE statement that also inserts its audit_event row, so a change and its audit record
// succeed or fail together (there is no transaction helper on Queryable).
// Nothing here deletes a job_assignment or a chat_message.

export const GET_LISTING_SQL = "SELECT owner_user_id, jurisdiction FROM property_listing WHERE id = $1::uuid";
export const FIND_BY_ID_SQL = "SELECT id, user_type, status FROM app_user WHERE id = $1::uuid";
export const FIND_BY_EMAIL_SQL = "SELECT id, user_type, status FROM app_user WHERE email = $1::citext";
export const GET_ASSIGNMENT_SQL =
  "SELECT id, listing_id, owner_user_id, contractor_user_id, kind, status FROM job_assignment WHERE id = $1::uuid";

/** Params: 1 id, 2 listing, 3 owner, 4 contractor, 5 kind, 6..10 audit (id, at, event type, correlation, payload). */
export const INSERT_PROPOSED_SQL =
  "WITH ins AS (" +
  "INSERT INTO job_assignment (id, listing_id, owner_user_id, contractor_user_id, kind, status) " +
  "SELECT $1::uuid, l.id, l.owner_user_id, c.id, $5::text, 'proposed' FROM property_listing l, app_user c " +
  "WHERE l.id = $2::uuid AND l.owner_user_id = $3::uuid AND c.id = $4::uuid AND c.id <> l.owner_user_id " +
  "AND c.status NOT IN ('suspended', 'closed') AND NOT EXISTS (SELECT 1 FROM contractor_standing cs WHERE cs.user_id = c.id AND cs.suspended) " +
  "AND NOT EXISTS (SELECT 1 FROM job_assignment x WHERE x.listing_id = l.id AND x.contractor_user_id = c.id " +
  "AND x.kind = $5::text AND x.status IN ('proposed', 'approved')) RETURNING id) " +
  "INSERT INTO audit_event (id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload) " +
  "SELECT $6::uuid, $7::timestamptz, 'user', $3::text, 'job_assignment', ins.id::text, $8::text, $9::text, $10::jsonb FROM ins RETURNING aggregate_id";

/** Params: 1 id, 2 actor, 3 side, 4 allowed from-statuses, 5 to-status, 6..10 audit (id, at, event type, correlation, payload). */
export const TRANSITION_SQL =
  "WITH moved AS (" +
  "UPDATE job_assignment SET status = $5::text, approved_at = CASE WHEN $5::text = 'approved' THEN now() ELSE approved_at END " +
  "WHERE id = $1::uuid AND status = ANY($4::text[]) " +
  "AND (CASE WHEN $3::text = 'owner' THEN owner_user_id ELSE contractor_user_id END) = $2::uuid " +
  "AND NOT ($3::text = 'contractor' AND $5::text = 'approved' AND EXISTS (SELECT 1 FROM contractor_standing cs WHERE cs.user_id = contractor_user_id AND cs.suspended)) RETURNING id) " +
  "INSERT INTO audit_event (id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload) " +
  "SELECT $6::uuid, $7::timestamptz, 'user', $2::text, 'job_assignment', moved.id::text, $8::text, $9::text, $10::jsonb FROM moved RETURNING aggregate_id";

/** Params: 1 user, 2 listing or null. Rows are limited to assignments the user is a party to. */
export const LIST_FOR_USER_SQL =
  "SELECT a.id, a.listing_id, a.kind, a.status, a.owner_user_id, l.title, " +
  "CASE WHEN a.owner_user_id = $1::uuid THEN cu.display_name ELSE ou.display_name END AS counterpart_name " +
  "FROM job_assignment a JOIN property_listing l ON l.id = a.listing_id " +
  "JOIN app_user ou ON ou.id = a.owner_user_id JOIN app_user cu ON cu.id = a.contractor_user_id " +
  "WHERE (a.owner_user_id = $1::uuid OR a.contractor_user_id = $1::uuid) " +
  "AND ($2::uuid IS NULL OR a.listing_id = $2::uuid) ORDER BY a.status, a.id LIMIT 200";

const text = (v: unknown) => String(v);

export function createPgAssignmentRepository(db: Queryable): AssignmentRepository {
  const auditParams = (e: AuditEvent) => [e.id, e.occurredAt, e.eventType, e.correlationId, JSON.stringify(e.payload)];
  return {
    async getListing(id) {
      const { rows } = await db.query(GET_LISTING_SQL, [id]);
      const r = rows[0];
      const jurisdiction = r ? text(r["jurisdiction"]).trim() : "";
      return r && isJurisdiction(jurisdiction) ? { ownerUserId: text(r["owner_user_id"]), jurisdiction } : undefined;
    },
    async findContractor(ref) {
      const { rows } = ref.by === "id" ? await db.query(FIND_BY_ID_SQL, [ref.userId]) : await db.query(FIND_BY_EMAIL_SQL, [ref.email]);
      const r = rows[0];
      return r ? { id: text(r["id"]), userType: text(r["user_type"]), status: text(r["status"]) } : undefined;
    },
    async getAssignment(id) {
      const { rows } = await db.query(GET_ASSIGNMENT_SQL, [id]);
      const r = rows[0];
      if (!r) return undefined;
      return {
        id: text(r["id"]), listingId: text(r["listing_id"]), ownerUserId: text(r["owner_user_id"]),
        contractorUserId: text(r["contractor_user_id"]), kind: text(r["kind"]) as JobAssignment["kind"],
        status: text(r["status"]) as AssignmentStatus
      };
    },
    async insertProposed(a, audit) {
      const { rows } = await db.query(INSERT_PROPOSED_SQL, [
        a.id, a.listingId, a.ownerUserId, a.contractorUserId, a.kind, ...auditParams(audit)
      ]);
      return rows.length === 1;
    },
    async transition(t, audit) {
      const { rows } = await db.query(TRANSITION_SQL, [t.id, t.actorId, t.side, [...t.from], t.to, ...auditParams(audit)]);
      return rows.length === 1;
    },
    async listForUser(userId, listingId) {
      const { rows } = await db.query(LIST_FOR_USER_SQL, [userId, listingId ?? null]);
      return rows.map((r): AssignmentSummary => ({
        id: text(r["id"]), listingId: text(r["listing_id"]), listingTitle: text(r["title"]),
        kind: text(r["kind"]) as AssignmentKind, status: text(r["status"]) as AssignmentStatus,
        role: text(r["owner_user_id"]) === userId ? "owner" : "contractor",
        counterpartName: text(r["counterpart_name"])
      }));
    },
    verifiedLicences: () => verifiedLicencesPg(db)
  };
}

/** Wired from the shared pool in context.ts, so that file stays untouched. */
export const getAssignmentRepo = () => createPgAssignmentRepository(getDb());
export const assignmentIds = { newId: () => randomUUID(), now: () => new Date().toISOString() };
