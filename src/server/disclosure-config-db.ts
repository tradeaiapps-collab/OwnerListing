import type { Jurisdiction } from "../domain/jurisdiction";
import type { PropertyListing, UseClass } from "../domain/listing";
import {
  approvalBlocker, parseItems, requiredKeys,
  type ConfigStatus, type DisclosureConfigVersion, type DisclosureItem, type DisclosureRecord, type NewVersionInput, type SubmissionInput, type TransactionType
} from "../domain/disclosure-config";
import type { Queryable } from "./db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

const VERSION_COLS = "id, jurisdiction, transaction_type, use_class, version, items, status, note, created_by, created_at, approved_by, approved_at";

function toVersion(r: Record<string, unknown>): DisclosureConfigVersion {
  // Items were validated when the version was written; re-validate on read so a bad row fails closed (no items = treated as broken).
  const items = parseItems(r["items"]);
  if (!items.ok) throw new Error(`disclosure_config_version ${String(r["id"])} has invalid items: ${items.message}`);
  return {
    id: String(r["id"]), jurisdiction: String(r["jurisdiction"]).trim() as Jurisdiction,
    transactionType: r["transaction_type"] as TransactionType, useClass: r["use_class"] as UseClass,
    version: Number(r["version"]), items: items.value, status: r["status"] as ConfigStatus, note: String(r["note"]),
    createdBy: (r["created_by"] as string | null) ?? null, createdAt: iso(r["created_at"])!,
    approvedBy: (r["approved_by"] as string | null) ?? null, approvedAt: iso(r["approved_at"])
  };
}

/** The approved version for a combination, or null (publishing is then blocked). */
export async function approvedVersionPg(db: Queryable, j: Jurisdiction, tx: TransactionType, use: UseClass): Promise<DisclosureConfigVersion | null> {
  const r = await db.query(
    `SELECT ${VERSION_COLS} FROM disclosure_config_version WHERE jurisdiction = $1 AND transaction_type = $2 AND use_class = $3 AND status = 'approved'`,
    [j, tx, use]
  );
  return r.rows[0] ? toVersion(r.rows[0]) : null;
}

/** The publish gate's requirement set for a listing: the approved version's id and the keys for its property type. Null = blocked. */
export async function disclosureRequirementsPg(db: Queryable, l: PropertyListing): Promise<{ versionId: string; keys: readonly string[] } | null> {
  const v = await approvedVersionPg(db, l.jurisdiction, l.transactionType, l.useClass);
  return v ? { versionId: v.id, keys: requiredKeys(v.items, l.propertyType) } : null;
}

export async function markListingDisclosureVersionPg(db: Queryable, listingId: string, versionId: string): Promise<void> {
  await db.query("UPDATE property_listing SET disclosure_config_version_id = $2 WHERE id = $1", [listingId, versionId]);
}

/** Every version, newest first within each combination (staff screen). */
export async function listVersionsPg(db: Queryable): Promise<DisclosureConfigVersion[]> {
  const r = await db.query(`SELECT ${VERSION_COLS} FROM disclosure_config_version ORDER BY jurisdiction, transaction_type, use_class, version DESC`);
  return r.rows.map(toVersion);
}

export async function getVersionPg(db: Queryable, id: string): Promise<DisclosureConfigVersion | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await db.query(`SELECT ${VERSION_COLS} FROM disclosure_config_version WHERE id = $1`, [id]);
  return r.rows[0] ? toVersion(r.rows[0]) : null;
}

/** Adds a draft as the next version number of its combination. A concurrent draft for the same combination loses with "conflict". */
export async function createDraftVersionPg(db: Queryable, input: NewVersionInput, staffId: string): Promise<{ ok: true; id: string; version: number } | { ok: false; code: "conflict" }> {
  try {
    const r = await db.query(
      `INSERT INTO disclosure_config_version (jurisdiction, transaction_type, use_class, version, items, note, created_by)
       SELECT $1, $2, $3, coalesce(max(version), 0) + 1, $4::jsonb, $5, $6 FROM disclosure_config_version
       WHERE jurisdiction = $1 AND transaction_type = $2 AND use_class = $3
       RETURNING id, version`,
      [input.jurisdiction, input.transactionType, input.useClass, JSON.stringify(input.items), input.note, staffId]
    );
    return { ok: true, id: String(r.rows[0]!["id"]), version: Number(r.rows[0]!["version"]) };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return { ok: false, code: "conflict" };
    throw e;
  }
}

export type ApproveOutcome = { ok: true; retiredId: string | null } | { ok: false; status: 404 | 409 | 403; error: string };

/**
 * Approves a draft (never by its author) and retires the combination's previous approved version, in one transaction.
 * The row is locked first, so two approvers cannot both win.
 */
export async function approveVersionPg(db: Queryable, id: string, staffId: string, reason: string): Promise<ApproveOutcome> {
  if (!UUID_RE.test(id)) return { ok: false, status: 404, error: "Version not found." };
  if (!db.transaction) throw new Error("approveVersionPg needs a transactional connection.");
  return db.transaction(async tx => {
    const cur = await tx.query("SELECT status, created_by, jurisdiction, transaction_type, use_class FROM disclosure_config_version WHERE id = $1 FOR UPDATE", [id]);
    const row = cur.rows[0];
    if (!row) return { ok: false, status: 404, error: "Version not found." } as const;
    const blocker = approvalBlocker({ status: row["status"] as ConfigStatus, createdBy: (row["created_by"] as string | null) ?? null }, staffId);
    if (blocker) return { ok: false, status: row["status"] !== "draft" ? 409 : 403, error: blocker } as const;
    const retired = await tx.query(
      `UPDATE disclosure_config_version SET status = 'retired', retired_at = now()
       WHERE jurisdiction = $1 AND transaction_type = $2 AND use_class = $3 AND status = 'approved' RETURNING id`,
      [row["jurisdiction"], row["transaction_type"], row["use_class"]]
    );
    await tx.query(
      "UPDATE disclosure_config_version SET status = 'approved', approved_by = $2, approved_at = now(), approval_reason = $3 WHERE id = $1",
      [id, staffId, reason]
    );
    return { ok: true, retiredId: retired.rows[0] ? String(retired.rows[0]["id"]) : null } as const;
  });
}

/** A listing's disclosure rows for its checklist. */
export async function listingDisclosuresPg(db: Queryable, listingId: string): Promise<DisclosureRecord[]> {
  if (!UUID_RE.test(listingId)) return [];
  const r = await db.query(
    `SELECT disclosure_key, jurisdiction, satisfied, evidence_reference, state, not_applicable, evidence_document_id, review_reason
     FROM listing_disclosure WHERE listing_id = $1`, [listingId]
  );
  return r.rows.map(row => ({
    key: String(row["disclosure_key"]), jurisdiction: String(row["jurisdiction"]).trim() as Jurisdiction, satisfied: Boolean(row["satisfied"]),
    ...(row["evidence_reference"] ? { evidenceReference: String(row["evidence_reference"]) } : {}),
    state: row["state"] as DisclosureRecord["state"], notApplicable: Boolean(row["not_applicable"]),
    evidenceDocumentId: (row["evidence_document_id"] as string | null) ?? null, reviewReason: (row["review_reason"] as string | null) ?? null
  }));
}

/** True when the document is an active file on this listing (evidence must come from the listing's own documents). */
export async function activeListingDocumentPg(db: Queryable, listingId: string, documentId: string): Promise<boolean> {
  if (!UUID_RE.test(listingId) || !UUID_RE.test(documentId)) return false;
  const r = await db.query("SELECT 1 FROM property_document WHERE id = $1 AND listing_id = $2 AND status = 'active'", [documentId, listingId]);
  return r.rows.length > 0;
}

/**
 * Records the owner's submission for one item. Any earlier decision on it is cleared, so a changed submission is reviewed again
 * (and an item that was verified stops counting until it is).
 */
export async function submitDisclosurePg(
  db: Queryable, a: { listingId: string; jurisdiction: Jurisdiction; key: string; versionId: string; actorId: string; input: SubmissionInput }
): Promise<void> {
  const na = a.input.kind === "not_applicable";
  const note = a.input.kind === "not_applicable" ? a.input.note : null;
  const documentId = a.input.kind === "evidence" ? a.input.documentId : null;
  await db.query(
    `INSERT INTO listing_disclosure (listing_id, jurisdiction, disclosure_key, satisfied, state, not_applicable, owner_note, evidence_document_id,
       evidence_reference, submitted_by, submitted_at, config_version_id)
     VALUES ($1, $2, $3, false, 'submitted', $4, $5, $6::uuid, $6::text, $7, now(), $8)
     ON CONFLICT (listing_id, disclosure_key) DO UPDATE SET jurisdiction = EXCLUDED.jurisdiction, satisfied = false, state = 'submitted',
       not_applicable = EXCLUDED.not_applicable, owner_note = EXCLUDED.owner_note, evidence_document_id = EXCLUDED.evidence_document_id,
       evidence_reference = EXCLUDED.evidence_reference, submitted_by = EXCLUDED.submitted_by, submitted_at = now(),
       config_version_id = EXCLUDED.config_version_id, verified_by = NULL, verified_at = NULL, review_reason = NULL`,
    [a.listingId, a.jurisdiction, a.key, na, note, documentId, a.actorId, a.versionId]
  );
}

export interface ReviewQueueRow {
  id: string; listingId: string; listingTitle: string; jurisdiction: string; transactionType: string; useClass: string; propertyType: string;
  key: string; item: DisclosureItem | null; notApplicable: boolean; ownerNote: string | null; evidenceDocumentId: string | null;
  evidenceKind: string | null; submittedAt: string;
}

/** Submissions waiting for Compliance, oldest first, with the requirement text from the version the owner answered. */
export async function reviewQueuePg(db: Queryable, limit = 100): Promise<ReviewQueueRow[]> {
  const r = await db.query(
    `SELECT d.id, d.listing_id, l.title, d.jurisdiction, l.transaction_type, l.use_class, l.property_type, d.disclosure_key,
       d.not_applicable, d.owner_note, d.evidence_document_id, pd.kind AS evidence_kind, d.submitted_at, v.items
     FROM listing_disclosure d
     JOIN property_listing l ON l.id = d.listing_id
     LEFT JOIN disclosure_config_version v ON v.id = d.config_version_id
     LEFT JOIN property_document pd ON pd.id = d.evidence_document_id
     WHERE d.state = 'submitted'
     ORDER BY d.submitted_at ASC NULLS FIRST
     LIMIT $1`, [limit]
  );
  return r.rows.map(row => {
    const items = parseItems(row["items"] ?? []);
    const key = String(row["disclosure_key"]);
    return {
      id: String(row["id"]), listingId: String(row["listing_id"]), listingTitle: String(row["title"]), jurisdiction: String(row["jurisdiction"]).trim(),
      transactionType: String(row["transaction_type"]), useClass: String(row["use_class"]), propertyType: String(row["property_type"]),
      key, item: items.ok ? items.value.find(i => i.key === key) ?? null : null,
      notApplicable: Boolean(row["not_applicable"]), ownerNote: (row["owner_note"] as string | null) ?? null,
      evidenceDocumentId: (row["evidence_document_id"] as string | null) ?? null, evidenceKind: (row["evidence_kind"] as string | null) ?? null,
      submittedAt: iso(row["submitted_at"]) ?? ""
    };
  });
}

export type DisclosureReviewOutcome = "reviewed" | "not_found" | "already_reviewed" | "own_listing";

/**
 * Verify or reject a submission. Guarded UPDATE: only a waiting submission changes, and never by the listing's owner or the submitter.
 */
export async function reviewDisclosurePg(
  db: Queryable, id: string, staffId: string, decision: "verify" | "reject", reason: string
): Promise<{ outcome: DisclosureReviewOutcome; listingId?: string; key?: string }> {
  if (!UUID_RE.test(id)) return { outcome: "not_found" };
  const r = await db.query(
    `UPDATE listing_disclosure d SET state = $3, satisfied = ($3 = 'verified'), verified_by = $2, verified_at = now(), review_reason = $4
     FROM property_listing l
     WHERE d.id = $1 AND l.id = d.listing_id AND d.state = 'submitted' AND l.owner_user_id <> $2 AND coalesce(d.submitted_by::text, '') <> $2::text
     RETURNING d.listing_id, d.disclosure_key`,
    [id, staffId, decision === "verify" ? "verified" : "rejected", reason]
  );
  if (r.rows[0]) return { outcome: "reviewed", listingId: String(r.rows[0]["listing_id"]), key: String(r.rows[0]["disclosure_key"]) };
  const cur = await db.query("SELECT d.state FROM listing_disclosure d WHERE d.id = $1", [id]);
  if (!cur.rows[0]) return { outcome: "not_found" };
  return { outcome: cur.rows[0]["state"] !== "submitted" ? "already_reviewed" : "own_listing" };
}

/** The evidence document of a submission (any state), for the reviewer's download. */
export async function submissionEvidencePg(db: Queryable, id: string): Promise<{ documentId: string; listingId: string } | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await db.query("SELECT evidence_document_id, listing_id FROM listing_disclosure WHERE id = $1 AND evidence_document_id IS NOT NULL", [id]);
  return r.rows[0] ? { documentId: String(r.rows[0]["evidence_document_id"]), listingId: String(r.rows[0]["listing_id"]) } : null;
}
