import type { CaseKind, CaseState, TrustCheckState } from "../domain/staff-admin";
import type { IdSubmission, IdStatus } from "../domain/id-verification";
import { resolveRoleAccess } from "../domain/staff-roles";
import type { TrustAccountDecision, TrustAccountEvidence } from "../domain/trust-account";
import { checksToPerform } from "../domain/trust-verification";
import type { Queryable } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const dateOnly = (v: unknown) => iso(v).slice(0, 10);

// ---- Admin cases ----

const CASE_COLS = `c.id, c.kind, c.subject_id, c.reason, c.status, c.assigned_to, c.opened_at, c.resolved_at, c.resolution_reason,
  c.proposed_by, c.proposed_reason, pi.role AS proposed_role,
  (pr.role_key IS NOT NULL) AS proposed_role_exists, pr.permissions AS proposed_permissions, pr.disabled AS proposed_role_disabled`;
const CASE_FROM = `FROM admin_case c
  LEFT JOIN app_user p ON p.id = c.proposed_by AND p.user_type = 'admin' AND p.status = 'active'
  LEFT JOIN staff_invite pi ON pi.email = lower(p.email::text) AND pi.revoked_at IS NULL
  LEFT JOIN staff_role_current pr ON pr.role_key = pi.role`;

export interface CaseRow extends CaseState {
  id: string; subjectId: string; reason: string; openedAt: string; resolvedAt: string | null; resolutionReason: string | null;
}

function toCase(r: Record<string, unknown>): CaseRow {
  // The proposer's access as it stands now (custom roles from their current definition), so a revoked permission stops a pending override.
  const proposer = typeof r["proposed_by"] === "string"
    ? resolveRoleAccess(r["proposed_by"], r["proposed_role"], { exists: r["proposed_role_exists"] === true, permissions: r["proposed_permissions"], disabled: r["proposed_role_disabled"] })
    : null;
  return {
    id: String(r["id"]), kind: r["kind"] as CaseKind, subjectId: String(r["subject_id"]), reason: String(r["reason"]),
    status: r["status"] as CaseRow["status"], assignedTo: (r["assigned_to"] as string | null) ?? null,
    openedAt: iso(r["opened_at"]), resolvedAt: r["resolved_at"] ? iso(r["resolved_at"]) : null,
    resolutionReason: (r["resolution_reason"] as string | null) ?? null,
    proposedBy: (r["proposed_by"] as string | null) ?? null, proposedReason: (r["proposed_reason"] as string | null) ?? null,
    proposedByRole: proposer?.role ?? null,
    ...(proposer?.permissions ? { proposedByPermissions: proposer.permissions } : {})
  };
}

export async function listCases(db: Queryable, status: "open" | "in_progress" | "resolved" | "active"): Promise<CaseRow[]> {
  const where = status === "active" ? `c.status <> 'resolved'` : `c.status = $1`;
  const res = await db.query(`SELECT ${CASE_COLS} ${CASE_FROM} WHERE ${where} ORDER BY c.opened_at LIMIT 100`, status === "active" ? [] : [status]);
  return res.rows.map(toCase);
}

export async function getCase(db: Queryable, id: string): Promise<CaseRow | null> {
  const res = await db.query(`SELECT ${CASE_COLS} ${CASE_FROM} WHERE c.id = $1`, [id]);
  return res.rows[0] ? toCase(res.rows[0]) : null;
}

/** True when this staff member now holds the case. */
export async function claimCase(db: Queryable, id: string, staffId: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE admin_case SET assigned_to = $2, status = 'in_progress'
      WHERE id = $1 AND status <> 'resolved' AND (assigned_to IS NULL OR assigned_to = $2) RETURNING id`,
    [id, staffId]
  );
  return res.rows.length > 0;
}

export async function proposeResolve(db: Queryable, id: string, staffId: string, reason: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE admin_case SET proposed_by = $2, proposed_reason = $3
      WHERE id = $1 AND proposed_by IS NULL AND assigned_to = $2 AND status <> 'resolved' RETURNING id`,
    [id, staffId, reason]
  );
  return res.rows.length > 0;
}

/** Closes the case; for an override, the override_log row is written by the same statement. */
export async function resolveCase(
  db: Queryable, c: CaseRow, resolvedBy: string, reason: string,
  override: { actorId: string; approverId: string; reason: string; target: string } | null
): Promise<boolean> {
  const closed = `UPDATE admin_case SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution_reason = $3
                   WHERE id = $1 AND status <> 'resolved'`;
  if (!override) return (await db.query(`${closed} RETURNING id`, [c.id, resolvedBy, reason])).rows.length > 0;
  const res = await db.query(
    `WITH done AS (${closed} RETURNING id)
     INSERT INTO override_log (actor_id, approver_id, target_type, target_id, reason, before_state, after_state)
     SELECT $4::uuid, $5::uuid, $6, $1::text, $7, $8::jsonb, '{"status":"resolved"}'::jsonb FROM done RETURNING id`,
    [c.id, resolvedBy, reason, override.actorId, override.approverId, override.target, override.reason, JSON.stringify({ status: c.status, kind: c.kind })]
  );
  return res.rows.length > 0;
}

// ---- Trust account approvals ----

export interface TrustQueueRow {
  checkId: string; listingId: string; checkedAt: string; evidence: unknown; reasons: unknown;
  /** awaiting_human_approval can be approved or rejected; needs_more_evidence and flagged_for_admin are to-do lists only. */
  decision: string; checksToPerform: string[];
  firmName: string; tier: string; jurisdiction: string; accountName: string; bsb: string;
  newOrChanged: boolean; approvals: { staffId: string; outcome: "approve" | "reject" }[];
}

const NOT_SUPERSEDED = `NOT EXISTS (
  SELECT 1 FROM trust_account_check n WHERE n.trust_account_id = c.trust_account_id AND n.listing_id = c.listing_id
    AND (n.checked_at, n.id) > (c.checked_at, c.id))`;

/** The account number is never selected: it is encrypted and staff do not need it to approve. */
export async function listTrustQueue(db: Queryable): Promise<TrustQueueRow[]> {
  const res = await db.query(
    `SELECT c.id, c.listing_id, c.checked_at, c.evidence, c.reasons, f.name AS firm_name, f.tier, f.jurisdiction,
            a.account_name, a.bsb, a.details_fingerprint, a.last_human_approved_fingerprint
       FROM trust_account_check c JOIN trust_account a ON a.id = c.trust_account_id JOIN law_firm f ON f.id = a.firm_id
      WHERE c.decision IN ('awaiting_human_approval','needs_more_evidence','flagged_for_admin') AND ${NOT_SUPERSEDED} ORDER BY c.checked_at LIMIT 100`
  );
  const ids = res.rows.map(r => String(r["id"]));
  const ap = ids.length ? await db.query(`SELECT check_id, staff_user_id, outcome FROM trust_account_approval WHERE check_id = ANY($1::uuid[])`, [ids]) : { rows: [] };
  return res.rows.map(r => ({
    checkId: String(r["id"]), listingId: String(r["listing_id"]), checkedAt: iso(r["checked_at"]), evidence: r["evidence"], reasons: r["reasons"],
    decision: String(r["decision"]),
    checksToPerform: checksToPerform(r["decision"] as TrustAccountDecision["kind"], (r["evidence"] ?? {}) as Partial<TrustAccountEvidence>),
    firmName: String(r["firm_name"]), tier: String(r["tier"]), jurisdiction: String(r["jurisdiction"]),
    accountName: String(r["account_name"]), bsb: String(r["bsb"]),
    newOrChanged: r["last_human_approved_fingerprint"] == null || r["last_human_approved_fingerprint"] !== r["details_fingerprint"],
    approvals: ap.rows.filter(x => x["check_id"] === r["id"]).map(x => ({ staffId: String(x["staff_user_id"]), outcome: x["outcome"] as "approve" | "reject" }))
  }));
}

export async function getTrustCheckState(db: Queryable, checkId: string): Promise<TrustCheckState | null> {
  const res = await db.query(
    `SELECT c.decision, a.details_fingerprint, a.last_human_approved_fingerprint, ${NOT_SUPERSEDED} AS latest
       FROM trust_account_check c JOIN trust_account a ON a.id = c.trust_account_id WHERE c.id = $1`,
    [checkId]
  );
  const r = res.rows[0];
  if (!r) return null;
  const ap = await db.query(`SELECT staff_user_id, outcome FROM trust_account_approval WHERE check_id = $1`, [checkId]);
  return {
    decision: String(r["decision"]), latest: r["latest"] === true, fingerprint: String(r["details_fingerprint"]),
    lastApprovedFingerprint: (r["last_human_approved_fingerprint"] as string | null) ?? null,
    priors: ap.rows.map(x => ({ staffId: String(x["staff_user_id"]), outcome: x["outcome"] as "approve" | "reject" }))
  };
}

const ADD_APPROVAL = `INSERT INTO trust_account_approval (check_id, staff_user_id, outcome, reason) VALUES ($1, $2, $4, $3) RETURNING check_id`;
const CLOSE_CASE = `UPDATE admin_case SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution_reason = $3
                     WHERE kind = 'trust_account_verification' AND subject_id = $1 AND status <> 'resolved'`;
const NEW_CHECK = (decision: string, reasonsParam: string) => `INSERT INTO trust_account_check (listing_id, trust_account_id, decision, evidence, reasons)
  SELECT listing_id, trust_account_id, '${decision}', evidence, ${reasonsParam}::jsonb FROM chk WHERE EXISTS (SELECT 1 FROM ins)`;

/** Records one person's approval; it does not publish anything. A repeat by the same person violates the unique key. */
export async function recordTrustApproval(db: Queryable, checkId: string, staffId: string, reason: string): Promise<void> {
  await db.query(ADD_APPROVAL, [checkId, staffId, reason, "approve"]);
}

/** Final approval in one statement: the approval row, the account's human-approved fingerprint, an 'approved' check row and closing the case. */
export async function finaliseTrustApproval(db: Queryable, checkId: string, staffId: string, reason: string): Promise<void> {
  await db.query(
    `WITH ins AS (${ADD_APPROVAL}),
          chk AS (SELECT listing_id, trust_account_id, evidence FROM trust_account_check WHERE id = $1),
          acct AS (UPDATE trust_account SET approved_by = $2, approved_at = now(), last_human_approved_fingerprint = details_fingerprint
                    WHERE id = (SELECT trust_account_id FROM chk) AND EXISTS (SELECT 1 FROM ins) RETURNING id),
          newchk AS (${NEW_CHECK("approved", `'["Approved by a person after full verification."]'`)} RETURNING id)
     ${CLOSE_CASE}`,
    [checkId, staffId, reason, "approve"]
  );
}

export async function rejectTrustCheck(db: Queryable, checkId: string, staffId: string, reason: string): Promise<void> {
  await db.query(
    `WITH ins AS (${ADD_APPROVAL}),
          chk AS (SELECT listing_id, trust_account_id, evidence FROM trust_account_check WHERE id = $1),
          newchk AS (${NEW_CHECK("rejected", "$5")} RETURNING id)
     ${CLOSE_CASE}`,
    [checkId, staffId, reason, "reject", JSON.stringify([`Rejected by staff: ${reason}`])]
  );
}

// ---- Identity review ----

export interface IdQueueRow {
  id: string; userId: string; accountName: string; documentKind: string; documentCountry: string;
  expiryDate: string; submittedAt: string; approvals: number; selfieCapturedInApp: boolean;
  assignedTo: string | null; assignedAt: string | null; hasImages: boolean; hasBack: boolean;
}

/** Image keys are never selected: images are fetched one at a time through the audited image route by the claiming reviewer. */
export async function listIdQueue(db: Queryable): Promise<IdQueueRow[]> {
  const res = await db.query(
    `SELECT s.id, s.user_id, u.display_name, s.document_kind, s.document_country, s.expiry_date, s.submitted_at, s.approvals, s.selfie_captured_in_app,
            s.assigned_reviewer, s.assigned_at, (s.front_image_key IS NOT NULL AND s.selfie_key IS NOT NULL) AS has_images, s.back_image_key IS NOT NULL AS has_back
       FROM id_submission s JOIN app_user u ON u.id = s.user_id WHERE s.status = 'pending' ORDER BY s.submitted_at LIMIT 100`
  );
  return res.rows.map(r => ({
    id: String(r["id"]), userId: String(r["user_id"]), accountName: String(r["display_name"]), documentKind: String(r["document_kind"]),
    documentCountry: String(r["document_country"]).trim(), expiryDate: dateOnly(r["expiry_date"]), submittedAt: iso(r["submitted_at"]),
    approvals: Array.isArray(r["approvals"]) ? r["approvals"].length : 0, selfieCapturedInApp: r["selfie_captured_in_app"] === true,
    assignedTo: (r["assigned_reviewer"] as string | null) ?? null, assignedAt: r["assigned_at"] ? iso(r["assigned_at"]) : null,
    hasImages: r["has_images"] === true, hasBack: r["has_back"] === true
  }));
}

export async function getIdSubmission(db: Queryable, id: string): Promise<IdSubmission | null> {
  const res = await db.query(
    `SELECT id, user_id, document_kind, document_country, expiry_date, selfie_captured_in_app, submitted_at, status, approvals, decided_at
       FROM id_submission WHERE id = $1`,
    [id]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r["id"]), userId: String(r["user_id"]), documentKind: r["document_kind"] as IdSubmission["documentKind"],
    documentCountry: String(r["document_country"]).trim(), expiryDate: dateOnly(r["expiry_date"]),
    selfieCapturedInApp: r["selfie_captured_in_app"] === true, submittedAt: iso(r["submitted_at"]), status: r["status"] as IdStatus,
    approvals: Array.isArray(r["approvals"]) ? (r["approvals"] as string[]) : [],
    ...(r["decided_at"] ? { decidedAt: iso(r["decided_at"]) } : {})
  };
}

/**
 * Saves a reviewed submission only if nobody else changed it meanwhile. Approval also marks the buyer as manually verified.
 * Every decision ends the current claim, so a first approval leaves the check free for a different second reviewer.
 * Checked again in the same statement: an approval needs the reviewer's claim to be live at write time (not only when
 * approvalBlocker ran), and no decision may land on a check another reviewer holds now.
 */
export async function saveIdReview(db: Queryable, before: IdSubmission, after: IdSubmission, reviewer: { staffId: string; claimTtlMs: number }): Promise<boolean> {
  const approving = after.approvals.length > before.approvals.length;
  const res = await db.query(
    `WITH upd AS (UPDATE id_submission SET status = $3, approvals = $4::jsonb, decided_at = $5, assigned_reviewer = NULL, assigned_at = NULL
                   WHERE id = $1 AND status = 'pending' AND approvals = $2::jsonb
                     AND CASE WHEN $8::boolean
                              THEN assigned_reviewer = $6::uuid AND assigned_at > now() - $7::int * interval '1 millisecond'
                              ELSE assigned_reviewer IS NULL OR assigned_reviewer = $6::uuid OR assigned_at <= now() - $7::int * interval '1 millisecond' END
                   RETURNING user_id, status),
          ver AS (INSERT INTO buyer_verification (user_id, id_verified_at, id_method)
                  SELECT user_id, now(), 'manual_review' FROM upd WHERE status = 'approved'
                  ON CONFLICT (user_id) DO UPDATE SET id_verified_at = now(), id_method = 'manual_review' RETURNING user_id)
     SELECT user_id FROM upd`,
    [before.id, JSON.stringify(before.approvals), after.status, JSON.stringify(after.approvals), after.decidedAt ?? null,
      reviewer.staffId, reviewer.claimTtlMs, approving]
  );
  return res.rows.length > 0;
}
