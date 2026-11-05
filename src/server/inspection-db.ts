import { randomUUID } from "node:crypto";
import type { AuditEvent } from "../domain/audit";
import type {
  Finding, FollowupStatus, Inspection, InspectionRepository, InspectionRole, InspectionStatus, InspectionSummaryRow, InspectionType, Severity
} from "../domain/inspection";
import type { InspectionPhotoStore } from "../domain/inspection-photo";
import type { PhotoMime } from "../domain/image-meta";
import { getDb } from "./context";
import type { Queryable } from "./db";

// Constant SQL text: user input only travels as bound parameters. Ids of the acting user come from the session.
// Each write is ONE statement that also inserts its audit_event row, so a change and its audit record succeed or fail together.
// Nothing here deletes an inspection, finding, photo or share (the database refuses it too).

const text = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** True when $n is the listing's owner or its appointed agent with full scope (an active appointment). `l` is the listing alias. */
const managerOf = (n: number) =>
  `(l.owner_user_id = $${n}::uuid OR EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = l.id AND a.agent_user_id = $${n}::uuid AND a.revoked_at IS NULL AND a.scope = 'full'))`;

/** Audit insert reading the single row the guarded statement above returned. Params n..n+4: id, at, event type, correlation, payload. */
const auditTail = (n: number, actor: number, aggregate: string) =>
  `INSERT INTO audit_event (id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload) ` +
  `SELECT $${n}::uuid, $${n + 1}::timestamptz, 'user', $${actor}::text, 'inspection', ${aggregate}, $${n + 2}::text, $${n + 3}::text, $${n + 4}::jsonb FROM done RETURNING aggregate_id`;

export const MANAGED_LISTING_SQL = `SELECT l.id, l.title FROM property_listing l WHERE l.id = $1::uuid AND ${managerOf(2)}`;
export const FIND_BY_ID_SQL = "SELECT id, user_type, status FROM app_user WHERE id = $1::uuid";
export const FIND_BY_EMAIL_SQL = "SELECT id, user_type, status FROM app_user WHERE email = $1::citext";
const INSPECTION_COLUMNS =
  "i.id, i.listing_id, i.requested_by, i.inspector_user_id, i.inspection_type, i.scheduled_at, i.notes, i.status, i.completed_at, " +
  "i.summary_text, i.summary_source, i.summary_generated_at, i.summary_approved_at";
export const GET_SQL = `SELECT ${INSPECTION_COLUMNS} FROM inspection i WHERE i.id = $1::uuid`;

/** Params: 1 inspection, 2 user. Manager wins over inspector, inspector over viewer. A viewer needs a live share. */
export const ROLE_SQL =
  "SELECT CASE WHEN " + managerOf(2) + " THEN 'manager' WHEN i.inspector_user_id = $2::uuid THEN 'inspector' " +
  "WHEN EXISTS (SELECT 1 FROM inspection_share s WHERE s.inspection_id = i.id AND s.shared_with_user_id = $2::uuid AND s.revoked_at IS NULL) THEN 'viewer' END AS role " +
  "FROM inspection i JOIN property_listing l ON l.id = i.listing_id WHERE i.id = $1::uuid";

/** Params: 1 id, 2 listing, 3 requester, 4 inspector, 5 type, 6 scheduled at, 7 notes, 8..12 audit. */
export const INSERT_SQL =
  "WITH done AS (INSERT INTO inspection (id, listing_id, requested_by, inspector_user_id, inspection_type, scheduled_at, notes) " +
  "SELECT $1::uuid, l.id, $3::uuid, $4::uuid, $5::text, $6::timestamptz, $7::text FROM property_listing l " +
  `WHERE l.id = $2::uuid AND ${managerOf(3)} AND l.owner_user_id <> $4::uuid ` +
  "AND EXISTS (SELECT 1 FROM app_user u WHERE u.id = $4::uuid AND u.status NOT IN ('suspended', 'closed')) " +
  "AND NOT EXISTS (SELECT 1 FROM inspection x WHERE x.listing_id = l.id AND x.inspector_user_id = $4::uuid AND x.inspection_type = $5::text AND x.status IN ('invited', 'accepted')) " +
  "RETURNING id::text AS aggregate_id) " + auditTail(8, 3, "done.aggregate_id");

/** Params: 1 id, 2 actor, 3 side, 4 allowed from-statuses, 5 to-status, 6..10 audit. */
export const TRANSITION_SQL =
  "WITH done AS (UPDATE inspection i SET status = $5::text, completed_at = CASE WHEN $5::text = 'completed' THEN now() ELSE i.completed_at END " +
  "FROM property_listing l WHERE i.id = $1::uuid AND l.id = i.listing_id AND i.status = ANY($4::text[]) " +
  `AND (($3::text = 'inspector' AND i.inspector_user_id = $2::uuid) OR ($3::text = 'manager' AND ${managerOf(2)})) RETURNING i.id::text AS aggregate_id) ` +
  auditTail(6, 2, "done.aggregate_id");

/** Params: 1 id, 2 manager, 3 new time, 4..8 audit. A moved booking goes back to invited so the inspector confirms again. */
export const RESCHEDULE_SQL =
  "WITH done AS (UPDATE inspection i SET scheduled_at = $3::timestamptz, status = 'invited' FROM property_listing l " +
  `WHERE i.id = $1::uuid AND l.id = i.listing_id AND i.status IN ('invited', 'accepted') AND ${managerOf(2)} RETURNING i.id::text AS aggregate_id) ` +
  auditTail(4, 2, "done.aggregate_id");

export const FINDINGS_SQL =
  "SELECT id, inspection_id, area, title, detail, severity, followup_status, followup_note, created_at FROM inspection_finding " +
  "WHERE inspection_id = $1::uuid ORDER BY created_at, id";

/** Params: 1 id, 2 inspection, 3 area, 4 title, 5 detail, 6 severity, 7 follow-up status, 8 inspector, 9 created at, 10..14 audit. */
export const ADD_FINDING_SQL =
  "WITH done AS (INSERT INTO inspection_finding (id, inspection_id, area, title, detail, severity, followup_status, created_by, created_at) " +
  "SELECT $1::uuid, i.id, $3::text, $4::text, $5::text, $6::text, $7::text, $8::uuid, $9::timestamptz FROM inspection i " +
  "WHERE i.id = $2::uuid AND i.status = 'accepted' AND i.inspector_user_id = $8::uuid RETURNING id::text AS aggregate_id) " + auditTail(10, 8, "$2::uuid::text");

/** Params: 1 finding, 2 inspection, 3 status, 4 note, 5 by, 6 at, 7..11 audit. Only the follow-up columns can change. */
export const FOLLOWUP_SQL =
  "WITH done AS (UPDATE inspection_finding f SET followup_status = $3::text, followup_note = $4::text, followup_updated_by = $5::uuid, followup_updated_at = $6::timestamptz " +
  "FROM inspection i JOIN property_listing l ON l.id = i.listing_id WHERE f.id = $1::uuid AND f.inspection_id = $2::uuid AND i.id = f.inspection_id " +
  `AND i.status = 'completed' AND f.followup_status <> 'none' AND ${managerOf(5)} RETURNING f.id::text AS aggregate_id) ` + auditTail(7, 5, "$2::uuid::text");

/** Params: 1 user, 2 listing or null. Viewers see completed reports only. */
export const LIST_SQL =
  "SELECT i.id, i.listing_id, l.title, i.inspection_type, i.scheduled_at, i.status, " +
  "CASE WHEN " + managerOf(1) + " THEN 'manager' WHEN i.inspector_user_id = $1::uuid THEN 'inspector' ELSE 'viewer' END AS role, " +
  "CASE WHEN " + managerOf(1) + " THEN iu.display_name WHEN i.inspector_user_id = $1::uuid THEN ou.display_name ELSE iu.display_name END AS counterpart_name, " +
  "(SELECT count(*) FROM inspection_finding f WHERE f.inspection_id = i.id AND f.followup_status IN ('open', 'in_progress')) AS open_follow_ups, " +
  "(SELECT count(*) FROM inspection_finding f WHERE f.inspection_id = i.id AND f.severity = 'critical') AS critical_count " +
  "FROM inspection i JOIN property_listing l ON l.id = i.listing_id JOIN app_user iu ON iu.id = i.inspector_user_id JOIN app_user ou ON ou.id = l.owner_user_id " +
  "WHERE ($2::uuid IS NULL OR i.listing_id = $2::uuid) AND (" + managerOf(1) + " OR i.inspector_user_id = $1::uuid " +
  "OR (i.status = 'completed' AND EXISTS (SELECT 1 FROM inspection_share s WHERE s.inspection_id = i.id AND s.shared_with_user_id = $1::uuid AND s.revoked_at IS NULL))) " +
  "ORDER BY i.scheduled_at DESC, i.id LIMIT 200";

export const NAMES_SQL =
  "SELECT l.title, iu.display_name AS inspector_name, ru.display_name AS requester_name FROM inspection i JOIN property_listing l ON l.id = i.listing_id " +
  "JOIN app_user iu ON iu.id = i.inspector_user_id JOIN app_user ru ON ru.id = i.requested_by WHERE i.id = $1::uuid";
export const SHARES_SQL =
  "SELECT s.id, u.display_name, s.shared_at FROM inspection_share s JOIN app_user u ON u.id = s.shared_with_user_id " +
  "WHERE s.inspection_id = $1::uuid AND s.revoked_at IS NULL ORDER BY s.shared_at";

/** Params: 1 inspection, 2 shared with, 3 manager, 4..8 audit. */
export const ADD_SHARE_SQL =
  "WITH done AS (INSERT INTO inspection_share (inspection_id, shared_with_user_id, shared_by) SELECT i.id, $2::uuid, $3::uuid FROM inspection i " +
  `JOIN property_listing l ON l.id = i.listing_id WHERE i.id = $1::uuid AND i.status = 'completed' AND ${managerOf(3)} ` +
  "ON CONFLICT (inspection_id, shared_with_user_id) WHERE revoked_at IS NULL DO NOTHING RETURNING inspection_id::text AS aggregate_id) " + auditTail(4, 3, "done.aggregate_id");

/** Params: 1 share, 2 inspection, 3 manager, 4..8 audit. */
export const REVOKE_SHARE_SQL =
  "WITH done AS (UPDATE inspection_share s SET revoked_at = now() FROM inspection i JOIN property_listing l ON l.id = i.listing_id " +
  `WHERE s.id = $1::uuid AND s.inspection_id = $2::uuid AND i.id = s.inspection_id AND s.revoked_at IS NULL AND ${managerOf(3)} RETURNING s.inspection_id::text AS aggregate_id) ` + auditTail(4, 3, "done.aggregate_id");

export const PHOTO_COUNTS_SQL = "SELECT finding_id, count(*) AS n FROM inspection_photo WHERE inspection_id = $1::uuid GROUP BY finding_id";
export const PHOTOS_SQL = "SELECT id, finding_id FROM inspection_photo WHERE inspection_id = $1::uuid ORDER BY uploaded_at, id";

/** Params: 1 inspection, 2 user, 3 text, 4 source, 5 prompt version, 6 at, 7..11 audit. A new draft clears any earlier approval. */
export const SAVE_SUMMARY_SQL =
  "WITH done AS (UPDATE inspection i SET summary_text = $3::text, summary_source = $4::text, summary_prompt_version = $5::text, summary_generated_by = $2::uuid, " +
  "summary_generated_at = $6::timestamptz, summary_approved_by = NULL, summary_approved_at = NULL FROM property_listing l " +
  "WHERE i.id = $1::uuid AND l.id = i.listing_id AND i.status IN ('accepted', 'completed') " +
  `AND (i.inspector_user_id = $2::uuid OR ${managerOf(2)}) RETURNING i.id::text AS aggregate_id) ` + auditTail(7, 2, "done.aggregate_id");

/** Params: 1 inspection, 2 user, 3 at, 4..8 audit. */
export const APPROVE_SUMMARY_SQL =
  "WITH done AS (UPDATE inspection i SET summary_approved_by = $2::uuid, summary_approved_at = $3::timestamptz FROM property_listing l " +
  "WHERE i.id = $1::uuid AND l.id = i.listing_id AND i.summary_text IS NOT NULL " +
  `AND (i.inspector_user_id = $2::uuid OR ${managerOf(2)}) RETURNING i.id::text AS aggregate_id) ` + auditTail(4, 2, "done.aggregate_id");

/** Params: 1 id, 2 inspection, 3 finding or null, 4 uploader, 5 type, 6 width, 7 height, 8 size, 9 sha256, 10 key, 11 max total, 12 max per finding, 13..17 audit. */
export const ADD_PHOTO_SQL =
  "WITH done AS (INSERT INTO inspection_photo (id, inspection_id, finding_id, uploaded_by, content_type, width, height, size_bytes, sha256, storage_key) " +
  "SELECT $1::uuid, i.id, $3::uuid, $4::uuid, $5::text, $6::int, $7::int, $8::int, $9::text, $10::text FROM inspection i " +
  "WHERE i.id = $2::uuid AND i.status = 'accepted' AND i.inspector_user_id = $4::uuid " +
  "AND (SELECT count(*) FROM inspection_photo p WHERE p.inspection_id = i.id) < $11::int " +
  "AND ($3::uuid IS NULL OR ((SELECT count(*) FROM inspection_photo p WHERE p.finding_id = $3::uuid) < $12::int " +
  "AND EXISTS (SELECT 1 FROM inspection_finding f WHERE f.id = $3::uuid AND f.inspection_id = i.id))) RETURNING id::text AS aggregate_id) " + auditTail(13, 4, "$2::uuid::text");
export const STORED_PHOTO_SQL = "SELECT storage_key, content_type FROM inspection_photo WHERE id = $1::uuid AND inspection_id = $2::uuid";
export const FINDING_BELONGS_SQL = "SELECT 1 FROM inspection_finding WHERE id = $1::uuid AND inspection_id = $2::uuid";
export const PHOTO_BYTES_SQL = "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM inspection_photo WHERE uploaded_by = $1::uuid AND uploaded_at >= $2::timestamptz";

export function createPgInspectionPhotoStore(db: Queryable): InspectionPhotoStore & { bytesUploadedSince(userId: string, sinceIso: string): Promise<number | undefined> } {
  return {
    async addPhoto(p, a) {
      const { rows } = await db.query(ADD_PHOTO_SQL, [p.id, p.inspectionId, p.findingId ?? null, p.uploadedBy, p.contentType, p.width, p.height, p.sizeBytes, p.sha256, p.storageKey, p.maxTotal, p.maxPerFinding, ...auditParams(a)]);
      return rows.length === 1;
    },
    async stored(photoId, inspectionId) {
      const r = (await db.query(STORED_PHOTO_SQL, [photoId, inspectionId])).rows[0];
      return r ? { storageKey: text(r["storage_key"]), contentType: r["content_type"] as PhotoMime } : undefined;
    },
    async findingBelongs(findingId, inspectionId) {
      return (await db.query(FINDING_BELONGS_SQL, [findingId, inspectionId])).rows.length === 1;
    },
    async bytesUploadedSince(userId, sinceIso) {
      const total = Number((await db.query(PHOTO_BYTES_SQL, [userId, sinceIso])).rows[0]?.["total"]);
      return Number.isFinite(total) ? total : undefined;
    }
  };
}

const auditParams = (e: AuditEvent) => [e.id, e.occurredAt, e.eventType, e.correlationId, JSON.stringify(e.payload)];

function toInspection(r: Record<string, unknown>): Inspection {
  return {
    id: text(r["id"]), listingId: text(r["listing_id"]), requestedBy: text(r["requested_by"]), inspectorUserId: text(r["inspector_user_id"]),
    type: r["inspection_type"] as InspectionType, scheduledAt: iso(r["scheduled_at"]), notes: text(r["notes"]), status: r["status"] as InspectionStatus,
    ...(r["completed_at"] ? { completedAt: iso(r["completed_at"]) } : {}),
    ...(r["summary_text"]
      ? { summary: { text: text(r["summary_text"]), source: r["summary_source"] === "ai" ? "ai" as const : "rules" as const, generatedAt: iso(r["summary_generated_at"]), approved: r["summary_approved_at"] != null } }
      : {})
  };
}

export function createPgInspectionRepository(db: Queryable): InspectionRepository {
  return {
    async managedListing(listingId, userId) {
      const r = (await db.query(MANAGED_LISTING_SQL, [listingId, userId])).rows[0];
      return r ? { id: text(r["id"]), title: text(r["title"]) } : undefined;
    },
    async findAccount(ref) {
      const { rows } = ref.by === "id" ? await db.query(FIND_BY_ID_SQL, [ref.userId]) : await db.query(FIND_BY_EMAIL_SQL, [ref.email]);
      const r = rows[0];
      return r ? { id: text(r["id"]), userType: text(r["user_type"]), status: text(r["status"]) } : undefined;
    },
    async insert(i, a) {
      const { rows } = await db.query(INSERT_SQL, [i.id, i.listingId, i.requestedBy, i.inspectorUserId, i.type, i.scheduledAt, i.notes, ...auditParams(a)]);
      return rows.length === 1;
    },
    async get(id) {
      const r = (await db.query(GET_SQL, [id])).rows[0];
      return r ? toInspection(r) : undefined;
    },
    async roleOf(i, userId) {
      const r = (await db.query(ROLE_SQL, [i.id, userId])).rows[0];
      const role = r?.["role"];
      return role === "manager" || role === "inspector" || role === "viewer" ? (role as InspectionRole) : undefined;
    },
    async transition(t, a) {
      return (await db.query(TRANSITION_SQL, [t.id, t.actorId, t.side, t.from, t.to, ...auditParams(a)])).rows.length === 1;
    },
    async reschedule(id, managerId, at, a) {
      return (await db.query(RESCHEDULE_SQL, [id, managerId, at, ...auditParams(a)])).rows.length === 1;
    },
    async findings(inspectionId) {
      return (await db.query(FINDINGS_SQL, [inspectionId])).rows.map((r): Finding => ({
        id: text(r["id"]), inspectionId: text(r["inspection_id"]), area: text(r["area"]), title: text(r["title"]), detail: text(r["detail"]),
        severity: r["severity"] as Severity, followupStatus: r["followup_status"] as FollowupStatus, followupNote: text(r["followup_note"]), createdAt: iso(r["created_at"])
      }));
    },
    async addFinding(f, createdBy, a) {
      const { rows } = await db.query(ADD_FINDING_SQL, [f.id, f.inspectionId, f.area, f.title, f.detail, f.severity, f.followupStatus, createdBy, f.createdAt, ...auditParams(a)]);
      return rows.length === 1;
    },
    async updateFollowup(id, inspectionId, status, note, by, at, a) {
      return (await db.query(FOLLOWUP_SQL, [id, inspectionId, status, note, by, at, ...auditParams(a)])).rows.length === 1;
    },
    async listFor(userId, listingId) {
      return (await db.query(LIST_SQL, [userId, listingId ?? null])).rows.map((r): InspectionSummaryRow => ({
        id: text(r["id"]), listingId: text(r["listing_id"]), listingTitle: text(r["title"]), type: r["inspection_type"] as InspectionType,
        scheduledAt: iso(r["scheduled_at"]), status: r["status"] as InspectionStatus, role: r["role"] as InspectionRole,
        counterpartName: text(r["counterpart_name"]), openFollowUps: Number(r["open_follow_ups"]), criticalCount: Number(r["critical_count"])
      }));
    },
    async names(i) {
      const r = (await db.query(NAMES_SQL, [i.id])).rows[0];
      return { listingTitle: r ? text(r["title"]) : "", inspectorName: r ? text(r["inspector_name"]) : "", requesterName: r ? text(r["requester_name"]) : "" };
    },
    async shares(inspectionId) {
      return (await db.query(SHARES_SQL, [inspectionId])).rows.map(r => ({ id: text(r["id"]), name: text(r["display_name"]), sharedAt: iso(r["shared_at"]) }));
    },
    async addShare(inspectionId, sharedWith, by, a) {
      return (await db.query(ADD_SHARE_SQL, [inspectionId, sharedWith, by, ...auditParams(a)])).rows.length === 1;
    },
    async revokeShare(shareId, inspectionId, by, a) {
      return (await db.query(REVOKE_SHARE_SQL, [shareId, inspectionId, by, ...auditParams(a)])).rows.length === 1;
    },
    async photoCounts(inspectionId) {
      const byFinding: Record<string, number> = {};
      let total = 0;
      for (const r of (await db.query(PHOTO_COUNTS_SQL, [inspectionId])).rows) {
        const n = Number(r["n"]);
        total += n;
        if (r["finding_id"]) byFinding[text(r["finding_id"])] = n;
      }
      return { total, byFinding };
    },
    async photos(inspectionId) {
      return (await db.query(PHOTOS_SQL, [inspectionId])).rows.map(r => ({ id: text(r["id"]), ...(r["finding_id"] ? { findingId: text(r["finding_id"]) } : {}) }));
    },
    async saveSummary(id, summary, source, promptVersion, by, at, a) {
      return (await db.query(SAVE_SUMMARY_SQL, [id, by, summary, source, promptVersion, at, ...auditParams(a)])).rows.length === 1;
    },
    async approveSummary(id, by, at, a) {
      return (await db.query(APPROVE_SUMMARY_SQL, [id, by, at, ...auditParams(a)])).rows.length === 1;
    }
  };
}

export const getInspectionRepo = () => createPgInspectionRepository(getDb());
export const inspectionIds = { newId: () => randomUUID(), now: () => new Date().toISOString() };
