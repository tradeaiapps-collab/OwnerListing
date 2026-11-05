import { evidenceHash, requestStatusAfter, type RequestStatus, type SignerStatus } from "../domain/e-sign";
import type { DocumentKind } from "../domain/documents";
import { overlaps, reminderDueAt, type Finding, type InspectionKind, type InspectionRecord, type InspectionStatus, type Severity } from "../domain/inspection";
import type { Stage, TxnFacts, Viewer } from "../domain/transaction-assistant";
import { stageOf } from "../domain/transaction-assistant";
import type { Queryable } from "./db";

const inTx = <T>(db: Queryable, fn: (q: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const opt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

// ---------------------------------------------------------------- who is who on a listing

/** An approved (or finished) inspector assignment on the listing. */
export async function isListingInspector(db: Queryable, listingId: string, userId: string): Promise<boolean> {
  const r = await db.query(
    "SELECT 1 FROM job_assignment WHERE listing_id = $1 AND contractor_user_id = $2 AND kind = 'inspector' AND status IN ('approved','completed') LIMIT 1", [listingId, userId]);
  return r.rows.length > 0;
}

/** A buyer who has enquired on the listing, was named on an inspection, or was asked to sign something on it. */
export async function isListingParty(db: Queryable, listingId: string, userId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM enquiry WHERE listing_id = $1 AND buyer_user_id = $2
     UNION ALL SELECT 1 FROM inspection WHERE listing_id = $1 AND buyer_user_id = $2
     UNION ALL SELECT 1 FROM signature_signer s JOIN signature_request q ON q.id = s.request_id WHERE q.listing_id = $1 AND s.user_id = $2
     LIMIT 1`, [listingId, userId]);
  return r.rows.length > 0;
}

export interface PartyRow { userId: string; name: string; role: "buyer" | "inspector" }

/** People the owner can pick for an inspection or a signature: buyers who enquired and inspectors assigned to the listing. Names only. */
export async function listingParties(db: Queryable, listingId: string): Promise<PartyRow[]> {
  const r = await db.query(
    `SELECT u.id, u.display_name, 'buyer' AS role FROM enquiry e JOIN app_user u ON u.id = e.buyer_user_id WHERE e.listing_id = $1
     UNION
     SELECT u.id, u.display_name, 'inspector' FROM job_assignment a JOIN app_user u ON u.id = a.contractor_user_id
      WHERE a.listing_id = $1 AND a.kind = 'inspector' AND a.status IN ('approved','completed')
     ORDER BY 2, 1`, [listingId]);
  return r.rows.map(x => ({ userId: String(x["id"]), name: String(x["display_name"]), role: x["role"] as PartyRow["role"] }));
}

// ---------------------------------------------------------------- inspections

const toInspection = (r: Record<string, unknown>): InspectionRecord => ({
  id: String(r["id"]), listingId: String(r["listing_id"]), kind: r["kind"] as InspectionKind, requestedBy: String(r["requested_by"]),
  inspectorUserId: opt(r["inspector_user_id"]), buyerUserId: opt(r["buyer_user_id"]),
  scheduledStart: iso(r["scheduled_start"]), durationMinutes: Number(r["duration_minutes"]), status: r["status"] as InspectionStatus,
  accessNotes: opt(r["access_notes"]), cancelReason: opt(r["cancel_reason"]), completedAt: r["completed_at"] ? iso(r["completed_at"]) : undefined
});
const INSPECTION_COLS = "id, listing_id, kind, requested_by, inspector_user_id, buyer_user_id, scheduled_start, duration_minutes, status, access_notes, cancel_reason, completed_at";

export type CreateInspectionResult = { ok: true; inspection: InspectionRecord } | { ok: false; code: "invalid" | "conflict"; message: string };

/**
 * Books an inspection. The inspector must be assigned to this listing, and may not be booked twice at the same time
 * (their bookings are serialised with an advisory lock). Queues the confirmation email for everyone involved and a 24-hour reminder.
 */
export async function createInspection(
  db: Queryable, id: string, listingId: string, requestedBy: string,
  input: { kind: InspectionKind; scheduledStart: string; durationMinutes: number; inspectorUserId?: string | undefined; buyerUserId?: string | undefined; accessNotes?: string | undefined },
  ownerUserId: string, nowIso: string
): Promise<CreateInspectionResult> {
  if (input.kind !== "walkthrough" && input.kind !== "other" && !input.inspectorUserId) return { ok: false, code: "invalid", message: "Choose the inspector for this inspection." };
  if (input.inspectorUserId && !(await isListingInspector(db, listingId, input.inspectorUserId))) {
    return { ok: false, code: "invalid", message: "That inspector is not assigned to this listing. Assign them first." };
  }
  if (input.buyerUserId && !(await isListingParty(db, listingId, input.buyerUserId))) {
    return { ok: false, code: "invalid", message: "That buyer has not enquired about this listing." };
  }
  return inTx(db, async q => {
    if (input.inspectorUserId) {
      await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`inspector:${input.inspectorUserId}`]);
      const busy = await q.query(
        "SELECT scheduled_start, duration_minutes FROM inspection WHERE inspector_user_id = $1 AND status IN ('requested','confirmed') AND scheduled_start < $3::timestamptz AND scheduled_start + make_interval(mins => duration_minutes) > $2::timestamptz",
        [input.inspectorUserId, input.scheduledStart, new Date(Date.parse(input.scheduledStart) + input.durationMinutes * 60_000).toISOString()]);
      if (busy.rows.some(b => overlaps(input.scheduledStart, input.durationMinutes, iso(b["scheduled_start"]), Number(b["duration_minutes"])))) {
        return { ok: false as const, code: "conflict" as const, message: "The inspector is already booked at that time." };
      }
    }
    // A walkthrough without an inspector needs no one else to agree, so it starts confirmed.
    const status: InspectionStatus = input.inspectorUserId ? "requested" : "confirmed";
    const res = await q.query(
      `INSERT INTO inspection (id, listing_id, kind, requested_by, inspector_user_id, buyer_user_id, scheduled_start, duration_minutes, status, access_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${INSPECTION_COLS}`,
      [id, listingId, input.kind, requestedBy, input.inspectorUserId ?? null, input.buyerUserId ?? null, input.scheduledStart, input.durationMinutes, status, input.accessNotes ?? null]);
    const people = new Set([ownerUserId, requestedBy, input.inspectorUserId, input.buyerUserId].filter((x): x is string => !!x));
    const reminder = reminderDueAt(input.scheduledStart, nowIso);
    for (const u of people) {
      await q.query("INSERT INTO inspection_notice (inspection_id, user_id, kind, due_at) VALUES ($1,$2,'confirmation',$3) ON CONFLICT DO NOTHING", [id, u, nowIso]);
      if (reminder) await q.query("INSERT INTO inspection_notice (inspection_id, user_id, kind, due_at) VALUES ($1,$2,'reminder',$3) ON CONFLICT DO NOTHING", [id, u, reminder]);
    }
    return { ok: true as const, inspection: toInspection(res.rows[0]!) };
  });
}

export async function inspectionById(db: Queryable, id: string): Promise<InspectionRecord | undefined> {
  const r = await db.query(`SELECT ${INSPECTION_COLS} FROM inspection WHERE id = $1`, [id]);
  return r.rows[0] ? toInspection(r.rows[0]) : undefined;
}

/** Everything on the listing for the owner and agent; only their own for an inspector or a buyer. */
export async function inspectionsForListing(db: Queryable, listingId: string, who: { all: true } | { userId: string }): Promise<InspectionRecord[]> {
  const r = "all" in who
    ? await db.query(`SELECT ${INSPECTION_COLS} FROM inspection WHERE listing_id = $1 ORDER BY scheduled_start, id`, [listingId])
    : await db.query(`SELECT ${INSPECTION_COLS} FROM inspection WHERE listing_id = $1 AND (inspector_user_id = $2 OR buyer_user_id = $2) ORDER BY scheduled_start, id`, [listingId, who.userId]);
  return r.rows.map(toInspection);
}

export async function findingsForInspections(db: Queryable, ids: readonly string[]): Promise<(Finding & { inspectionId: string })[]> {
  if (ids.length === 0) return [];
  const r = await db.query("SELECT inspection_id, severity, area, summary, recommendation FROM inspection_finding WHERE inspection_id = ANY($1::uuid[]) ORDER BY created_at, id", [ids]);
  return r.rows.map(x => ({ inspectionId: String(x["inspection_id"]), severity: x["severity"] as Severity, area: String(x["area"]), summary: String(x["summary"]), recommendation: opt(x["recommendation"]) }));
}

/** Moves the inspection from one status to another only if it is still in `from` (so two people cannot both act). */
export async function moveInspection(
  db: Queryable, id: string, from: InspectionStatus, to: InspectionStatus, by: string, nowIso: string,
  extra: { reason?: string | undefined; findings?: readonly Finding[] } = {}
): Promise<InspectionRecord | undefined> {
  return inTx(db, async q => {
    const r = await q.query(
      `UPDATE inspection SET status = $3, cancel_reason = COALESCE($4, cancel_reason), completed_at = CASE WHEN $3 = 'completed' THEN $5::timestamptz ELSE completed_at END
       WHERE id = $1 AND status = $2 RETURNING ${INSPECTION_COLS}`, [id, from, to, extra.reason ?? null, nowIso]);
    const row = r.rows[0];
    if (!row) return undefined;
    for (const f of extra.findings ?? []) {
      await q.query("INSERT INTO inspection_finding (inspection_id, severity, area, summary, recommendation, created_by) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, f.severity, f.area, f.summary, f.recommendation ?? null, by]);
    }
    if (to === "cancelled") {
      // The reminder no longer applies; tell everyone it is off.
      await q.query("UPDATE inspection_notice SET sent_at = $2 WHERE inspection_id = $1 AND kind = 'reminder' AND sent_at IS NULL", [id, nowIso]);
      await q.query(
        `INSERT INTO inspection_notice (inspection_id, user_id, kind, due_at)
         SELECT $1, u, 'cancellation', $2 FROM (SELECT requested_by AS u FROM inspection WHERE id = $1 UNION SELECT inspector_user_id FROM inspection WHERE id = $1
           UNION SELECT buyer_user_id FROM inspection WHERE id = $1 UNION SELECT l.owner_user_id FROM inspection i JOIN property_listing l ON l.id = i.listing_id WHERE i.id = $1) p WHERE u IS NOT NULL
         ON CONFLICT DO NOTHING`, [id, nowIso]);
    }
    return toInspection(row);
  });
}

export interface DueNotice { id: string; kind: "confirmation" | "reminder" | "cancellation"; email: string; name: string; inspectionKind: InspectionKind; scheduledStart: string; address: string; status: InspectionStatus }

export async function dueNotices(db: Queryable, nowIso: string, limit = 50): Promise<DueNotice[]> {
  const r = await db.query(
    `SELECT n.id, n.kind, u.email, u.display_name, i.kind AS ikind, i.scheduled_start, i.status, l.address_text AS address
     FROM inspection_notice n JOIN inspection i ON i.id = n.inspection_id JOIN property_listing l ON l.id = i.listing_id JOIN app_user u ON u.id = n.user_id
     WHERE n.sent_at IS NULL AND n.due_at <= $1::timestamptz AND u.email IS NOT NULL AND u.status = 'active' ORDER BY n.due_at LIMIT $2`, [nowIso, limit]);
  return r.rows.map(x => ({ id: String(x["id"]), kind: x["kind"] as DueNotice["kind"], email: String(x["email"]), name: String(x["display_name"]),
    inspectionKind: x["ikind"] as InspectionKind, scheduledStart: iso(x["scheduled_start"]), address: String(x["address"]), status: x["status"] as InspectionStatus }));
}

export async function markNoticeSent(db: Queryable, id: string, nowIso: string): Promise<void> {
  await db.query("UPDATE inspection_notice SET sent_at = $2 WHERE id = $1 AND sent_at IS NULL", [id, nowIso]);
}

// ---------------------------------------------------------------- generated documents

export interface GeneratedDoc {
  id: string; listingId: string; templateId: string; templateVersion: string; version: number; supersedesId?: string | undefined;
  title: string; body: string; fields: Record<string, string>; contentSha256: string; createdBy: string; createdAt: string;
}
const DOC_COLS = "id, listing_id, template_id, template_version, version, supersedes_id, title, body, fields, content_sha256, created_by, created_at";
const toDoc = (r: Record<string, unknown>): GeneratedDoc => ({
  id: String(r["id"]), listingId: String(r["listing_id"]), templateId: String(r["template_id"]), templateVersion: String(r["template_version"]),
  version: Number(r["version"]), supersedesId: opt(r["supersedes_id"]), title: String(r["title"]), body: String(r["body"]),
  fields: (r["fields"] ?? {}) as Record<string, string>, contentSha256: String(r["content_sha256"]), createdBy: String(r["created_by"]), createdAt: iso(r["created_at"])
});

export async function generatedById(db: Queryable, id: string): Promise<GeneratedDoc | undefined> {
  const r = await db.query(`SELECT ${DOC_COLS} FROM generated_document WHERE id = $1`, [id]);
  return r.rows[0] ? toDoc(r.rows[0]) : undefined;
}

export async function generatedForListing(db: Queryable, listingId: string): Promise<GeneratedDoc[]> {
  const r = await db.query(`SELECT ${DOC_COLS} FROM generated_document WHERE listing_id = $1 ORDER BY created_at, id`, [listingId]);
  return r.rows.map(toDoc);
}

/** True when a newer version has replaced this one. */
export async function isSuperseded(db: Queryable, id: string): Promise<boolean> {
  return (await db.query("SELECT 1 FROM generated_document WHERE supersedes_id = $1", [id])).rows.length > 0;
}

export async function addGenerated(
  db: Queryable, d: { id: string; listingId: string; templateId: string; templateVersion: string; supersedes?: GeneratedDoc | undefined; title: string; body: string; fields: Record<string, string>; contentSha256: string; createdBy: string }
): Promise<{ ok: true; doc: GeneratedDoc } | { ok: false; message: string }> {
  return inTx(db, async q => {
    try {
      const r = await q.query(
        `INSERT INTO generated_document (id, listing_id, template_id, template_version, version, supersedes_id, title, body, fields, content_sha256, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) RETURNING ${DOC_COLS}`,
        [d.id, d.listingId, d.templateId, d.templateVersion, (d.supersedes?.version ?? 0) + 1, d.supersedes?.id ?? null, d.title, d.body, JSON.stringify(d.fields), d.contentSha256, d.createdBy]);
      await addEvent(q, { listingId: d.listingId, documentId: d.id, type: d.supersedes ? "version_created" : "created", actor: d.createdBy, detail: { version: (d.supersedes?.version ?? 0) + 1 } });
      return { ok: true as const, doc: toDoc(r.rows[0]!) };
    } catch (e) {
      if (/generated_document_one_successor/.test((e as Error).message)) return { ok: false as const, message: "Someone already made a newer version. Reload to see it." };
      throw e;
    }
  });
}

// ---------------------------------------------------------------- signatures

export interface SignerRow { userId: string; name: string; roleLabel: string; status: SignerStatus; viewedAt?: string | undefined; signedAt?: string | undefined; typedName?: string | undefined; evidenceSha256?: string | undefined; declineReason?: string | undefined }
export interface SignatureRequestRow { id: string; listingId: string; documentId: string; contentSha256: string; title: string; requestedBy: string; status: RequestStatus; expiresAt: string; createdAt: string; closedAt?: string | undefined }

const REQ_COLS = "id, listing_id, generated_document_id, content_sha256, title, requested_by, status, expires_at, created_at, closed_at";
const toRequest = (r: Record<string, unknown>): SignatureRequestRow => ({
  id: String(r["id"]), listingId: String(r["listing_id"]), documentId: String(r["generated_document_id"]), contentSha256: String(r["content_sha256"]), title: String(r["title"]),
  requestedBy: String(r["requested_by"]), status: r["status"] as RequestStatus, expiresAt: iso(r["expires_at"]), createdAt: iso(r["created_at"]), closedAt: r["closed_at"] ? iso(r["closed_at"]) : undefined
});

export async function createSignatureRequest(
  db: Queryable, id: string, doc: GeneratedDoc, requestedBy: string, signers: readonly { userId: string; roleLabel: string }[], expiresAt: string
): Promise<{ ok: true; request: SignatureRequestRow } | { ok: false; code: "invalid" | "conflict"; message: string }> {
  return inTx(db, async q => {
    const newer = await q.query("SELECT 1 FROM generated_document WHERE supersedes_id = $1", [doc.id]);
    if (newer.rows.length > 0) return { ok: false as const, code: "conflict" as const, message: "A newer version of this document exists. Send that one." };
    try {
      const r = await q.query(
        `INSERT INTO signature_request (id, listing_id, generated_document_id, content_sha256, title, requested_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${REQ_COLS}`,
        [id, doc.listingId, doc.id, doc.contentSha256, doc.title, requestedBy, expiresAt]);
      for (const s of signers) {
        await q.query("INSERT INTO signature_signer (request_id, user_id, role_label) VALUES ($1,$2,$3)", [id, s.userId, s.roleLabel]);
      }
      await addEvent(q, { listingId: doc.listingId, documentId: doc.id, requestId: id, type: "sign_requested", actor: requestedBy, detail: { signers: signers.length } });
      return { ok: true as const, request: toRequest(r.rows[0]!) };
    } catch (e) {
      if (/signature_request_open/.test((e as Error).message)) return { ok: false as const, code: "conflict" as const, message: "This document is already out for signing." };
      throw e;
    }
  });
}

/** Marks a request expired once its time has passed (lazily, whenever it is read or acted on). */
export async function expireIfDue(db: Queryable, requestId: string, nowIso: string): Promise<void> {
  await inTx(db, async q => {
    const r = await q.query(
      "UPDATE signature_request SET status = 'expired', closed_at = $2 WHERE id = $1 AND status = 'pending' AND expires_at <= $2::timestamptz RETURNING listing_id, generated_document_id", [requestId, nowIso]);
    if (r.rows[0]) await addEvent(q, { listingId: String(r.rows[0]["listing_id"]), documentId: String(r.rows[0]["generated_document_id"]), requestId, type: "expired", actor: null, detail: {} });
  });
}

export async function requestById(db: Queryable, id: string): Promise<SignatureRequestRow | undefined> {
  const r = await db.query(`SELECT ${REQ_COLS} FROM signature_request WHERE id = $1`, [id]);
  return r.rows[0] ? toRequest(r.rows[0]) : undefined;
}

export async function requestsForDocument(db: Queryable, documentId: string): Promise<SignatureRequestRow[]> {
  const r = await db.query(`SELECT ${REQ_COLS} FROM signature_request WHERE generated_document_id = $1 ORDER BY created_at, id`, [documentId]);
  return r.rows.map(toRequest);
}

export async function requestsForListing(db: Queryable, listingId: string): Promise<SignatureRequestRow[]> {
  const r = await db.query(`SELECT ${REQ_COLS} FROM signature_request WHERE listing_id = $1 ORDER BY created_at, id`, [listingId]);
  return r.rows.map(toRequest);
}

export async function signersFor(db: Queryable, requestId: string): Promise<SignerRow[]> {
  const r = await db.query(
    `SELECT s.user_id, u.display_name, s.role_label, s.status, s.viewed_at, s.signed_at, s.typed_name, s.evidence_sha256, s.decline_reason
     FROM signature_signer s JOIN app_user u ON u.id = s.user_id WHERE s.request_id = $1 ORDER BY s.role_label, s.id`, [requestId]);
  return r.rows.map(x => ({ userId: String(x["user_id"]), name: String(x["display_name"]), roleLabel: String(x["role_label"]), status: x["status"] as SignerStatus,
    viewedAt: x["viewed_at"] ? iso(x["viewed_at"]) : undefined, signedAt: x["signed_at"] ? iso(x["signed_at"]) : undefined,
    typedName: opt(x["typed_name"]), evidenceSha256: opt(x["evidence_sha256"]), declineReason: opt(x["decline_reason"]) }));
}

/** Requests waiting on this user, newest first. */
export async function awaitingSignature(db: Queryable, userId: string, listingId?: string): Promise<SignatureRequestRow[]> {
  const r = await db.query(
    `SELECT ${REQ_COLS.split(", ").map(c => `q.${c}`).join(", ")} FROM signature_request q JOIN signature_signer s ON s.request_id = q.id
     WHERE s.user_id = $1 AND s.status = 'pending' AND q.status = 'pending' AND q.expires_at > now() AND ($2::uuid IS NULL OR q.listing_id = $2::uuid) ORDER BY q.created_at DESC`,
    [userId, listingId ?? null]);
  return r.rows.map(toRequest);
}

export type SignResult = { ok: true; completed: boolean; evidenceSha256: string } | { ok: false; code: "not_found" | "conflict"; message: string };

/** Records one signature. The request must still be open, the signer pending, and the document unchanged and not replaced. */
export async function recordSignature(
  db: Queryable, requestId: string, userId: string, typedName: string, ipHashValue: string, consentVersion: string, nowIso: string
): Promise<SignResult> {
  return inTx(db, async q => {
    const rq = await q.query(`SELECT ${REQ_COLS} FROM signature_request WHERE id = $1 FOR UPDATE`, [requestId]);
    if (!rq.rows[0]) return { ok: false as const, code: "not_found" as const, message: "Document not found." };
    const req = toRequest(rq.rows[0]);
    if (req.status !== "pending" || Date.parse(req.expiresAt) <= Date.parse(nowIso)) return { ok: false as const, code: "conflict" as const, message: "This request is no longer open." };
    const doc = await q.query("SELECT content_sha256 FROM generated_document WHERE id = $1", [req.documentId]);
    if (String(doc.rows[0]?.["content_sha256"]) !== req.contentSha256) return { ok: false as const, code: "conflict" as const, message: "The document has changed. Ask for a new request." };
    if ((await q.query("SELECT 1 FROM generated_document WHERE supersedes_id = $1", [req.documentId])).rows.length > 0) {
      return { ok: false as const, code: "conflict" as const, message: "A newer version of this document exists." };
    }
    const sg = await q.query("SELECT status, viewed_at FROM signature_signer WHERE request_id = $1 AND user_id = $2 FOR UPDATE", [requestId, userId]);
    if (!sg.rows[0]) return { ok: false as const, code: "not_found" as const, message: "Document not found." };
    if (sg.rows[0]["status"] !== "pending") return { ok: false as const, code: "conflict" as const, message: "You have already answered this request." };
    if (!sg.rows[0]["viewed_at"]) return { ok: false as const, code: "conflict" as const, message: "Open and read the document before signing." };
    const evidence = evidenceHash({ contentSha256: req.contentSha256, requestId, userId, typedName, signedAtIso: nowIso, consentVersion });
    await q.query(
      "UPDATE signature_signer SET status = 'signed', typed_name = $3, consent_version = $4, signed_at = $5, evidence_sha256 = $6, ip_hash = $7 WHERE request_id = $1 AND user_id = $2",
      [requestId, userId, typedName, consentVersion, nowIso, evidence, ipHashValue]);
    await addEvent(q, { listingId: req.listingId, documentId: req.documentId, requestId, type: "signed", actor: userId, detail: { evidence } });
    const all = (await q.query("SELECT status FROM signature_signer WHERE request_id = $1", [requestId])).rows.map(x => x["status"] as SignerStatus);
    const after = requestStatusAfter(all);
    if (after === "completed") {
      await q.query("UPDATE signature_request SET status = 'completed', closed_at = $2 WHERE id = $1", [requestId, nowIso]);
      await addEvent(q, { listingId: req.listingId, documentId: req.documentId, requestId, type: "completed", actor: null, detail: {} });
    }
    return { ok: true as const, completed: after === "completed", evidenceSha256: evidence };
  });
}

export async function recordDecline(db: Queryable, requestId: string, userId: string, reason: string | null, nowIso: string): Promise<{ ok: true } | { ok: false; code: "not_found" | "conflict"; message: string }> {
  return inTx(db, async q => {
    const rq = await q.query(`SELECT ${REQ_COLS} FROM signature_request WHERE id = $1 FOR UPDATE`, [requestId]);
    if (!rq.rows[0]) return { ok: false as const, code: "not_found" as const, message: "Document not found." };
    const req = toRequest(rq.rows[0]);
    if (req.status !== "pending") return { ok: false as const, code: "conflict" as const, message: "This request is no longer open." };
    const sg = await q.query("SELECT status FROM signature_signer WHERE request_id = $1 AND user_id = $2 FOR UPDATE", [requestId, userId]);
    if (!sg.rows[0]) return { ok: false as const, code: "not_found" as const, message: "Document not found." };
    if (sg.rows[0]["status"] !== "pending") return { ok: false as const, code: "conflict" as const, message: "You have already answered this request." };
    await q.query("UPDATE signature_signer SET status = 'declined', decline_reason = $3 WHERE request_id = $1 AND user_id = $2", [requestId, userId, reason]);
    await q.query("UPDATE signature_request SET status = 'declined', closed_at = $2 WHERE id = $1", [requestId, nowIso]);
    await addEvent(q, { listingId: req.listingId, documentId: req.documentId, requestId, type: "declined", actor: userId, detail: {} });
    return { ok: true as const };
  });
}

export async function cancelRequest(db: Queryable, requestId: string, by: string, nowIso: string): Promise<boolean> {
  return inTx(db, async q => {
    const r = await q.query("UPDATE signature_request SET status = 'cancelled', closed_at = $2 WHERE id = $1 AND status = 'pending' RETURNING listing_id, generated_document_id", [requestId, nowIso]);
    if (!r.rows[0]) return false;
    await addEvent(q, { listingId: String(r.rows[0]["listing_id"]), documentId: String(r.rows[0]["generated_document_id"]), requestId, type: "cancelled", actor: by, detail: {} });
    return true;
  });
}

/** First time a signer opens the document: stamps viewed_at and writes one history row. */
export async function markViewed(db: Queryable, requestId: string, userId: string, nowIso: string): Promise<void> {
  await inTx(db, async q => {
    const r = await q.query(
      `UPDATE signature_signer SET viewed_at = $3 WHERE request_id = $1 AND user_id = $2 AND viewed_at IS NULL AND status = 'pending'
       RETURNING (SELECT listing_id FROM signature_request WHERE id = $1) AS listing_id, (SELECT generated_document_id FROM signature_request WHERE id = $1) AS doc_id`,
      [requestId, userId, nowIso]);
    if (r.rows[0]) await addEvent(q, { listingId: String(r.rows[0]["listing_id"]), documentId: String(r.rows[0]["doc_id"]), requestId, type: "viewed", actor: userId, detail: {} });
  });
}

// ---------------------------------------------------------------- history

export type EventType = "created" | "version_created" | "viewed" | "sign_requested" | "signed" | "declined" | "cancelled" | "completed" | "expired";
export interface HistoryEntry { at: string; type: EventType | "uploaded" | "superseded" | "downloaded"; actorName?: string | undefined; detail: Record<string, unknown> }

async function addEvent(q: Queryable, e: { listingId: string; documentId: string; requestId?: string; type: EventType; actor: string | null; detail: Record<string, unknown> }): Promise<void> {
  await q.query("INSERT INTO document_event (listing_id, generated_document_id, signature_request_id, event_type, actor_user_id, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [e.listingId, e.documentId, e.requestId ?? null, e.type, e.actor, JSON.stringify(e.detail)]);
}

/** The whole chain of versions the document belongs to, then every event on any of them, oldest first. */
export async function generatedHistory(db: Queryable, documentId: string): Promise<{ versions: { id: string; version: number; createdAt: string; createdByName: string; contentSha256: string }[]; events: (HistoryEntry & { documentId: string; version: number })[] }> {
  const chain = await db.query(
    `WITH RECURSIVE up AS (SELECT * FROM generated_document WHERE id = $1 UNION ALL SELECT g.* FROM generated_document g JOIN up ON g.id = up.supersedes_id),
     down AS (SELECT * FROM generated_document WHERE id = $1 UNION ALL SELECT g.* FROM generated_document g JOIN down ON g.supersedes_id = down.id),
     chain AS (SELECT id FROM up UNION SELECT id FROM down)
     SELECT g.id, g.version, g.created_at, g.content_sha256, u.display_name FROM generated_document g JOIN chain c ON c.id = g.id JOIN app_user u ON u.id = g.created_by ORDER BY g.version`, [documentId]);
  const ids = chain.rows.map(r => String(r["id"]));
  const versionOf = new Map(chain.rows.map(r => [String(r["id"]), Number(r["version"])]));
  const ev = await db.query(
    `SELECT e.generated_document_id, e.event_type, e.detail, e.created_at, u.display_name FROM document_event e LEFT JOIN app_user u ON u.id = e.actor_user_id
     WHERE e.generated_document_id = ANY($1::uuid[]) ORDER BY e.created_at, e.id`, [ids]);
  return {
    versions: chain.rows.map(r => ({ id: String(r["id"]), version: Number(r["version"]), createdAt: iso(r["created_at"]), createdByName: String(r["display_name"]), contentSha256: String(r["content_sha256"]) })),
    events: ev.rows.map(r => ({ documentId: String(r["generated_document_id"]), version: versionOf.get(String(r["generated_document_id"])) ?? 0, at: iso(r["created_at"]),
      type: r["event_type"] as EventType, actorName: opt(r["display_name"]), detail: (r["detail"] ?? {}) as Record<string, unknown> }))
  };
}

/** History of an uploaded file: each version (the supersedes chain) and every recorded download. */
export async function uploadedHistory(db: Queryable, documentId: string): Promise<HistoryEntry[]> {
  const chain = await db.query(
    `WITH RECURSIVE up AS (SELECT id, supersedes_id, uploaded_at, uploaded_by, kind, status FROM property_document WHERE id = $1
       UNION ALL SELECT d.id, d.supersedes_id, d.uploaded_at, d.uploaded_by, d.kind, d.status FROM property_document d JOIN up ON d.id = up.supersedes_id),
     down AS (SELECT id, supersedes_id, uploaded_at, uploaded_by, kind, status FROM property_document WHERE id = $1
       UNION ALL SELECT d.id, d.supersedes_id, d.uploaded_at, d.uploaded_by, d.kind, d.status FROM property_document d JOIN down ON d.supersedes_id = down.id),
     chain AS (SELECT * FROM up UNION SELECT * FROM down)
     SELECT c.id, c.uploaded_at, c.kind, c.status, u.display_name FROM chain c JOIN app_user u ON u.id = c.uploaded_by ORDER BY c.uploaded_at`, [documentId]);
  const ids = chain.rows.map(r => String(r["id"]));
  const dl = await db.query(
    `SELECT a.aggregate_id, a.occurred_at, u.display_name FROM audit_event a LEFT JOIN app_user u ON u.id::text = a.actor_id
     WHERE a.aggregate_type = 'document' AND a.event_type = 'document.downloaded' AND a.aggregate_id = ANY($1::text[]) ORDER BY a.occurred_at`, [ids]);
  const entries: HistoryEntry[] = [
    ...chain.rows.map((r, i): HistoryEntry => ({ at: iso(r["uploaded_at"]), type: i === 0 ? "uploaded" : "version_created", actorName: String(r["display_name"]), detail: { documentId: String(r["id"]), kind: String(r["kind"]), status: String(r["status"]), version: i + 1 } })),
    ...dl.rows.map((r): HistoryEntry => ({ at: iso(r["occurred_at"]), type: "downloaded", actorName: opt(r["display_name"]), detail: { documentId: String(r["aggregate_id"]) } }))
  ];
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

// ---------------------------------------------------------------- facts for the assistant

export async function loadFacts(
  db: Queryable, listing: { id: string; status: string; transactionType: "sale" | "rent"; jurisdiction: string }, viewer: Viewer, userId: string
): Promise<TxnFacts> {
  const handler = viewer === "owner" || viewer === "agent";
  const [kinds, docs, reqs, insp, offer, mine] = await Promise.all([
    handler ? db.query("SELECT DISTINCT kind FROM property_document WHERE listing_id = $1 AND status = 'active'", [listing.id]) : Promise.resolve({ rows: [] }),
    handler ? generatedForListing(db, listing.id) : Promise.resolve([] as GeneratedDoc[]),
    handler ? requestsForListing(db, listing.id) : Promise.resolve([] as SignatureRequestRow[]),
    inspectionsForListing(db, listing.id, handler ? { all: true } : { userId }),
    db.query("SELECT bool_or(status = 'accepted') AS accepted, bool_or(status IN ('submitted','under_review','countered')) AS active FROM formal_offer WHERE listing_id = $1", [listing.id]),
    awaitingSignature(db, userId, listing.id)
  ]);
  const findings = await findingsForInspections(db, insp.filter(i => i.status === "completed").map(i => i.id));
  const state = (d: GeneratedDoc): "draft" | "awaiting_signature" | "signed" => {
    const rs = reqs.filter(r => r.documentId === d.id);
    return rs.some(r => r.status === "completed") ? "signed" : rs.some(r => r.status === "pending") ? "awaiting_signature" : "draft";
  };
  const o = offer.rows[0] ?? {};
  const stage: Stage = stageOf(listing.status, o["accepted"] ? "accepted" : o["active"] ? "active" : "none");
  return {
    viewer, transactionType: listing.transactionType, stage, jurisdiction: listing.jurisdiction,
    uploadedKinds: kinds.rows.map(r => r["kind"] as DocumentKind),
    generated: docs.map(d => ({ templateId: d.templateId, state: state(d) })),
    inspections: insp.map(i => ({ kind: i.kind, status: i.status })),
    findings, awaitingMySignature: mine.length
  };
}
