import { randomUUID } from "node:crypto";
import { areaOnly, canSeeFullAddress, summariseRatings, USAGE_RIGHTS_VERSION, verificationState, type VerificationInput, type VerificationState } from "../domain/contractor-trust";
import { effectiveDates } from "../domain/contractor-certificates";
import { certDates, currentCertificatesPg } from "./contractor-certificates-db";
import { appendAuditPg, type Queryable } from "./db";

/**
 * Contractor trust and safety storage. Constant SQL; every user-supplied value is a bound parameter. Acting user ids come from the
 * session, never from a request body. Each write and its audit event commit in one transaction. Nothing is deleted.
 */

const inTx = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>) => (db.transaction ? db.transaction(fn) : fn(db));
const text = (v: unknown) => String(v);
const opt = (v: unknown) => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const dateStr = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const audit = (db: Queryable, actorId: string, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown> = {}) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId, aggregateType, aggregateId, eventType, correlationId: randomUUID(), payload });

// ---------- Verification ----------
export interface VerificationRecord extends VerificationInput {
  userId: string; status: "pending" | "verified" | "rejected"; reviewNote: string | null; reviewedAt: string | null; submittedAt: string;
}
const V_COLS = "user_id, business_name, abn, licence_number, licence_authority, licence_expiry, insurer, policy_number, insurance_expiry, status, review_note, reviewed_at, submitted_at";
const toVerification = (r: Record<string, unknown>): VerificationRecord => ({
  userId: text(r["user_id"]), businessName: text(r["business_name"]), abn: text(r["abn"]), licenceNumber: opt(r["licence_number"]), licenceAuthority: opt(r["licence_authority"]),
  licenceExpiry: r["licence_expiry"] ? dateStr(r["licence_expiry"]) : null, insurer: text(r["insurer"]), policyNumber: text(r["policy_number"]), insuranceExpiry: dateStr(r["insurance_expiry"]),
  status: text(r["status"]) as VerificationRecord["status"], reviewNote: opt(r["review_note"]), reviewedAt: r["reviewed_at"] ? iso(r["reviewed_at"]) : null, submittedAt: iso(r["submitted_at"])
});

export async function getVerificationPg(db: Queryable, userId: string): Promise<VerificationRecord | undefined> {
  const r = (await db.query(`SELECT ${V_COLS} FROM contractor_verification WHERE user_id = $1::uuid`, [userId])).rows[0];
  return r ? toVerification(r) : undefined;
}

/** Contractor submits or re-submits their own details. Any re-submission goes back to pending, so the badge is off until staff check the new details. */
export async function submitVerificationPg(db: Queryable, userId: string, v: VerificationInput): Promise<boolean> {
  return inTx(db, async tx => {
    const r = await tx.query(
      `INSERT INTO contractor_verification (user_id, business_name, abn, licence_number, licence_authority, licence_expiry, insurer, policy_number, insurance_expiry)
       SELECT u.id, $2::text, $3::text, $4::text, $5::text, $6::date, $7::text, $8::text, $9::date FROM app_user u
       WHERE u.id = $1::uuid AND u.user_type IN ('vendor', 'agent') AND u.status NOT IN ('suspended', 'closed')
       ON CONFLICT (user_id) DO UPDATE SET business_name = EXCLUDED.business_name, abn = EXCLUDED.abn, licence_number = EXCLUDED.licence_number,
         licence_authority = EXCLUDED.licence_authority, licence_expiry = EXCLUDED.licence_expiry, insurer = EXCLUDED.insurer, policy_number = EXCLUDED.policy_number,
         insurance_expiry = EXCLUDED.insurance_expiry, status = 'pending', review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, submitted_at = now()
       RETURNING user_id`,
      [userId, v.businessName, v.abn, v.licenceNumber, v.licenceAuthority, v.licenceExpiry, v.insurer, v.policyNumber, v.insuranceExpiry]
    );
    if (r.rows.length !== 1) return false;
    await tx.query("INSERT INTO contractor_verification_event (user_id, actor_id, action) VALUES ($1::uuid, $1::uuid, 'submit')", [userId]);
    await audit(tx, userId, "contractor_verification", userId, "contractor_verification.submitted");
    return true;
  });
}

export interface VerificationQueueRow extends VerificationRecord { name: string; state: VerificationState }
export async function listVerificationsPg(db: Queryable, view: "pending" | "all", today: string): Promise<VerificationQueueRow[]> {
  const { rows } = await db.query(
    `SELECT v.user_id, v.business_name, v.abn, v.licence_number, v.licence_authority, v.licence_expiry, v.insurer, v.policy_number, v.insurance_expiry, v.status, v.review_note, v.reviewed_at, v.submitted_at, u.display_name
     FROM contractor_verification v JOIN app_user u ON u.id = v.user_id
     WHERE ($1::text = 'all' OR v.status = 'pending') ORDER BY (v.status = 'pending') DESC, v.insurance_expiry, v.submitted_at LIMIT 200`, [view]);
  const certs = await currentCertificatesPg(db, rows.map(r => text(r["user_id"])));
  return rows.map(r => { const v = toVerification(r); return { ...v, name: text(r["display_name"]), state: verificationState(effectiveDates(v, certDates(certs.get(v.userId))), today) }; });
}

/** Staff decision on pending details only; staff cannot decide on themselves. */
export async function decideVerificationPg(db: Queryable, userId: string, staffId: string, action: "verify" | "reject", note: string | null, expectedSubmittedAt?: string): Promise<boolean> {
  return inTx(db, async tx => {
    // expectedSubmittedAt: the submission the decision was made on. If the contractor re-submitted since, nothing is decided (millisecond match, as JS dates hold).
    const r = await tx.query(
      `UPDATE contractor_verification SET status = $3, review_note = $4, reviewed_by = $2::uuid, reviewed_at = now()
       WHERE user_id = $1::uuid AND status = 'pending' AND user_id <> $2::uuid
         AND ($5::timestamptz IS NULL OR date_trunc('milliseconds', submitted_at) = $5::timestamptz) RETURNING user_id`,
      [userId, staffId, action === "verify" ? "verified" : "rejected", note, expectedSubmittedAt ?? null]);
    if (r.rows.length !== 1) return false;
    await tx.query("INSERT INTO contractor_verification_event (user_id, actor_id, action, note) VALUES ($1::uuid, $2::uuid, $3, $4)", [userId, staffId, action, note]);
    await audit(tx, staffId, "contractor_verification", userId, `contractor_verification.${action}`);
    return true;
  });
}

// ---------- Standing ----------
export interface Standing { suspended: boolean; reason: string | null; changedAt: string | null }
export async function getStandingPg(db: Queryable, userId: string): Promise<Standing> {
  const r = (await db.query("SELECT suspended, reason, changed_at FROM contractor_standing WHERE user_id = $1::uuid", [userId])).rows[0];
  return r ? { suspended: r["suspended"] === true, reason: opt(r["reason"]), changedAt: iso(r["changed_at"]) } : { suspended: false, reason: null, changedAt: null };
}

async function setSuspension(tx: Queryable, staffId: string, contractorId: string, suspend: boolean, note: string, reportId: string | null): Promise<boolean> {
  const r = suspend
    ? await tx.query(
      `INSERT INTO contractor_standing (user_id, suspended, reason, changed_by, changed_at)
       SELECT u.id, true, $3::text, $2::uuid, now() FROM app_user u WHERE u.id = $1::uuid AND u.id <> $2::uuid AND u.user_type IN ('vendor', 'agent')
       ON CONFLICT (user_id) DO UPDATE SET suspended = true, reason = EXCLUDED.reason, changed_by = EXCLUDED.changed_by, changed_at = now()
       WHERE NOT contractor_standing.suspended RETURNING user_id`, [contractorId, staffId, note])
    : await tx.query(
      `UPDATE contractor_standing SET suspended = false, reason = NULL, changed_by = $2::uuid, changed_at = now()
       WHERE user_id = $1::uuid AND suspended AND user_id <> $2::uuid RETURNING user_id`, [contractorId, staffId]);
  if (r.rows.length !== 1) return false;
  // A contractor-type account is also locked out at sign-in (and signed back in when reinstated). Other account types keep their account.
  await tx.query("UPDATE app_user SET status = $2 WHERE id = $1::uuid AND user_type = 'vendor' AND status = $3", [contractorId, suspend ? "suspended" : "active", suspend ? "active" : "suspended"]);
  await tx.query("INSERT INTO contractor_standing_event (contractor_user_id, report_id, actor_id, action, note) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)",
    [contractorId, reportId, staffId, suspend ? "suspend" : "reinstate", note]);
  await audit(tx, staffId, "contractor_standing", contractorId, suspend ? "contractor.suspended" : "contractor.reinstated", { reportId });
  return true;
}
/** False when nothing changed (already in that state, not a contractor account, or staff acting on themselves). */
export async function setSuspensionPg(db: Queryable, staffId: string, contractorId: string, suspend: boolean, note: string): Promise<boolean> {
  return inTx(db, tx => setSuspension(tx, staffId, contractorId, suspend, note, null));
}

// ---------- Complaints (owner reports, filed through contractor operations) ----------
export interface ReportRow {
  id: string; assignmentId: string; kind: string; detail: string; status: "open" | "dismissed" | "upheld"; createdAt: string; decisionNote: string | null; decidedAt: string | null;
  contractorId: string; contractorName: string; reporterName: string; listingTitle: string; contractorSuspended: boolean; reportsAgainst: number;
}
export async function listReportsPg(db: Queryable, view: "open" | "decided"): Promise<ReportRow[]> {
  const { rows } = await db.query(
    `SELECT r.id, r.assignment_id, r.kind, r.details, r.status, r.created_at, r.decision_note, r.decided_at, a.contractor_user_id, cu.display_name AS contractor_name, ru.display_name AS reporter_name, l.title,
       COALESCE(s.suspended, false) AS suspended,
       (SELECT count(*) FROM contractor_complaint x JOIN job_assignment xa ON xa.id = x.assignment_id WHERE xa.contractor_user_id = a.contractor_user_id AND x.status <> 'dismissed') AS against
     FROM contractor_complaint r JOIN job_assignment a ON a.id = r.assignment_id JOIN app_user cu ON cu.id = a.contractor_user_id JOIN app_user ru ON ru.id = r.reported_by
     JOIN property_listing l ON l.id = a.listing_id LEFT JOIN contractor_standing s ON s.user_id = a.contractor_user_id
     WHERE (($1::text = 'open' AND r.status = 'open') OR ($1::text = 'decided' AND r.status <> 'open'))
     ORDER BY r.created_at DESC LIMIT 200`, [view]);
  return rows.map(r => ({
    id: text(r["id"]), assignmentId: text(r["assignment_id"]), kind: text(r["kind"]), detail: text(r["details"]), status: text(r["status"]) as ReportRow["status"],
    createdAt: iso(r["created_at"]), decisionNote: opt(r["decision_note"]), decidedAt: r["decided_at"] ? iso(r["decided_at"]) : null, contractorId: text(r["contractor_user_id"]),
    contractorName: text(r["contractor_name"]), reporterName: text(r["reporter_name"]), listingTitle: text(r["title"]), contractorSuspended: r["suspended"] === true, reportsAgainst: Number(r["against"])
  }));
}

export type DecideReportResult = "ok" | "conflict";
/** Decides an open complaint once. "uphold_and_suspend" also suspends the contractor in the same transaction. Staff on either side of the job cannot decide it. */
export async function decideReportPg(db: Queryable, reportId: string, staffId: string, action: "dismiss" | "uphold" | "uphold_and_suspend", note: string): Promise<DecideReportResult> {
  return inTx(db, async tx => {
    const r = await tx.query(
      `UPDATE contractor_complaint c SET status = $3, decided_by = $2::uuid, decided_at = now(), decision_note = $4 FROM job_assignment a
       WHERE c.id = $1::uuid AND c.status = 'open' AND a.id = c.assignment_id AND c.reported_by <> $2::uuid AND a.contractor_user_id <> $2::uuid RETURNING a.contractor_user_id`,
      [reportId, staffId, action === "dismiss" ? "dismissed" : "upheld", note]);
    const row = r.rows[0];
    if (!row) return "conflict";
    const contractorId = text(row["contractor_user_id"]);
    await tx.query("INSERT INTO contractor_standing_event (contractor_user_id, report_id, actor_id, action, note) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)",
      [contractorId, reportId, staffId, action === "dismiss" ? "dismiss" : "uphold", note]);
    await audit(tx, staffId, "contractor_complaint", reportId, `contractor_complaint.${action}`);
    if (action === "uphold_and_suspend") await setSuspension(tx, staffId, contractorId, true, note, reportId);
    return "ok";
  });
}

// ---------- Assignment access, address privacy and usage rights ----------
export interface AssignmentAccess {
  id: string; listingId: string; kind: string; status: string; role: "owner" | "contractor"; counterpartName: string;
  address: string; addressHidden: boolean; usageRightsConfirmed: boolean;
}
/** Only a party to the assignment gets a row. A contractor gets the street address only once the job is accepted. */
export async function assignmentAccessPg(db: Queryable, assignmentId: string, userId: string): Promise<AssignmentAccess | undefined> {
  const r = (await db.query(
    `SELECT a.id, a.listing_id, a.kind, a.status, a.owner_user_id, a.contractor_user_id, a.usage_rights_confirmed_at, l.address_text, l.suburb, l.postcode, l.jurisdiction,
       CASE WHEN a.owner_user_id = $2::uuid THEN cu.display_name ELSE ou.display_name END AS counterpart,
       EXISTS (SELECT 1 FROM contractor_standing cs WHERE cs.user_id = a.contractor_user_id AND cs.suspended) AS contractor_suspended
     FROM job_assignment a JOIN property_listing l ON l.id = a.listing_id JOIN app_user ou ON ou.id = a.owner_user_id JOIN app_user cu ON cu.id = a.contractor_user_id
     WHERE a.id = $1::uuid AND (a.owner_user_id = $2::uuid OR a.contractor_user_id = $2::uuid)`, [assignmentId, userId])).rows[0];
  if (!r) return undefined;
  const role = text(r["owner_user_id"]) === userId ? "owner" : "contractor";
  // A suspended contractor loses the street address of jobs they accepted earlier.
  const full = canSeeFullAddress(role, text(r["status"])) && !(role === "contractor" && r["contractor_suspended"] === true);
  return {
    id: text(r["id"]), listingId: text(r["listing_id"]), kind: text(r["kind"]), status: text(r["status"]), role, counterpartName: text(r["counterpart"]),
    address: full ? text(r["address_text"]) : areaOnly({ suburb: opt(r["suburb"]), postcode: opt(r["postcode"]), jurisdiction: text(r["jurisdiction"]) }),
    addressHidden: !full, usageRightsConfirmed: r["usage_rights_confirmed_at"] !== null && r["usage_rights_confirmed_at"] !== undefined
  };
}

/** The photographer on an accepted job ticks the usage-rights box. Stored once, with the wording version. */
export async function confirmUsageRightsPg(db: Queryable, contractorId: string, assignmentId: string): Promise<boolean> {
  return inTx(db, async tx => {
    const r = await tx.query(
      `UPDATE job_assignment SET usage_rights_confirmed_at = now(), usage_rights_version = $3
       WHERE id = $1::uuid AND contractor_user_id = $2::uuid AND kind = 'photographer' AND status = 'approved' AND usage_rights_confirmed_at IS NULL RETURNING id`,
      [assignmentId, contractorId, USAGE_RIGHTS_VERSION]);
    if (r.rows.length !== 1) return false;
    await audit(tx, contractorId, "job_assignment", assignmentId, "job_assignment.usage_rights_confirmed", { version: USAGE_RIGHTS_VERSION });
    return true;
  });
}

// ---------- Quotes ----------
export interface QuoteRow { id: string; assignmentId: string; amountCents: number; description: string; status: "sent" | "accepted" | "declined" | "withdrawn"; createdAt: string; decidedAt: string | null }
const toQuote = (r: Record<string, unknown>): QuoteRow => ({
  id: text(r["id"]), assignmentId: text(r["assignment_id"]), amountCents: Number(r["amount_cents"]), description: text(r["description"]), status: text(r["status"]) as QuoteRow["status"],
  createdAt: iso(r["created_at"]), decidedAt: r["decided_at"] ? iso(r["decided_at"]) : null
});
export async function quotesForAssignmentPg(db: Queryable, assignmentId: string): Promise<QuoteRow[]> {
  return (await db.query("SELECT id, assignment_id, amount_cents, description, status, created_at, decided_at FROM job_quote WHERE assignment_id = $1::uuid ORDER BY created_at DESC LIMIT 50", [assignmentId])).rows.map(toQuote);
}

export type SendQuoteResult = "created" | "not_allowed" | "pending_exists";
/** The contractor of an accepted job who is not suspended. One quote waits for the owner at a time. */
export async function sendQuotePg(db: Queryable, contractorId: string, assignmentId: string, q: { amountCents: number; description: string }): Promise<SendQuoteResult> {
  return inTx(db, async tx => {
    const ok = (await tx.query(
      `SELECT 1 FROM job_assignment a WHERE a.id = $1::uuid AND a.contractor_user_id = $2::uuid AND a.status = 'approved'
       AND NOT EXISTS (SELECT 1 FROM contractor_standing s WHERE s.user_id = a.contractor_user_id AND s.suspended)`, [assignmentId, contractorId])).rows.length === 1;
    if (!ok) return "not_allowed";
    const r = await tx.query(
      `INSERT INTO job_quote (assignment_id, contractor_user_id, amount_cents, description) VALUES ($1::uuid, $2::uuid, $3, $4)
       ON CONFLICT (assignment_id) WHERE status = 'sent' DO NOTHING RETURNING id`, [assignmentId, contractorId, q.amountCents, q.description]);
    if (!r.rows[0]) return "pending_exists";
    await audit(tx, contractorId, "job_quote", text(r.rows[0]["id"]), "job_quote.sent", { assignmentId, amountCents: q.amountCents });
    return "created";
  });
}

/** Owner accepts or declines; the contractor withdraws their own. Only while the quote is still waiting. */
export async function decideQuotePg(db: Queryable, actorId: string, quoteId: string, action: "accept" | "decline" | "withdraw"): Promise<boolean> {
  return inTx(db, async tx => {
    const r = await tx.query(
      `UPDATE job_quote q SET status = $3, decided_at = CASE WHEN $3 = 'withdrawn' THEN NULL ELSE now() END FROM job_assignment a
       WHERE q.id = $1::uuid AND q.status = 'sent' AND a.id = q.assignment_id AND a.status = 'approved'
       AND ((($3 = 'withdrawn') AND q.contractor_user_id = $2::uuid) OR (($3 <> 'withdrawn') AND a.owner_user_id = $2::uuid)) RETURNING q.id`,
      [quoteId, actorId, action === "accept" ? "accepted" : action === "decline" ? "declined" : "withdrawn"]);
    if (r.rows.length !== 1) return false;
    await audit(tx, actorId, "job_quote", quoteId, `job_quote.${action}`);
    return true;
  });
}

// ---------- Reviews ----------
export interface ReviewRow { id: string; assignmentId: string; rating: number; comment: string | null; createdAt: string; reply: string | null; repliedAt: string | null; reviewerFirstName: string }
const toReview = (r: Record<string, unknown>): ReviewRow => ({
  id: text(r["id"]), assignmentId: text(r["assignment_id"]), rating: Number(r["rating"]), comment: opt(r["comment"]), createdAt: iso(r["created_at"]), reply: opt(r["reply"]),
  repliedAt: r["replied_at"] ? iso(r["replied_at"]) : null, reviewerFirstName: text(r["display_name"]).trim().split(/\s+/)[0] ?? ""
});
const REVIEW_SELECT = "SELECT r.id, r.assignment_id, r.rating, r.body AS comment, r.created_at, r.reply, r.replied_at, u.display_name FROM contractor_review r JOIN app_user u ON u.id = r.owner_user_id";
const VISIBLE = "r.status = 'visible'";

/** The reviewed contractor posts one public reply; it cannot be changed afterwards. */
export async function replyToReviewPg(db: Queryable, contractorId: string, reviewId: string, reply: string): Promise<boolean> {
  return inTx(db, async tx => {
    const r = await tx.query("UPDATE contractor_review SET reply = $3, replied_at = now() WHERE id = $1::uuid AND contractor_user_id = $2::uuid AND reply IS NULL RETURNING id", [reviewId, contractorId, reply]);
    if (r.rows.length !== 1) return false;
    await audit(tx, contractorId, "contractor_review", reviewId, "contractor_review.replied");
    return true;
  });
}

export async function reviewForAssignmentPg(db: Queryable, assignmentId: string): Promise<ReviewRow | undefined> {
  const r = (await db.query(`${REVIEW_SELECT} WHERE r.assignment_id = $1::uuid AND ${VISIBLE}`, [assignmentId])).rows[0];
  return r ? toReview(r) : undefined;
}

export interface PublicTrust {
  contractorId: string; displayName: string; badge: boolean; suspended: boolean; rating: { average: number | null; count: number }; reviews: ReviewRow[];
}
/** What anyone may see about a contractor: the badge (never the licence, ABN or policy numbers), the rating and reviews with replies. */
export async function publicTrustPg(db: Queryable, contractorId: string, today: string): Promise<PublicTrust | undefined> {
  const u = (await db.query("SELECT display_name FROM app_user WHERE id = $1::uuid AND user_type IN ('vendor', 'agent') AND status NOT IN ('suspended', 'closed')", [contractorId])).rows[0];
  if (!u) return undefined;
  const [v0, certs, standing, ratings, reviews] = await Promise.all([
    getVerificationPg(db, contractorId), currentCertificatesPg(db, [contractorId]), getStandingPg(db, contractorId),
    db.query("SELECT rating FROM contractor_review WHERE contractor_user_id = $1::uuid AND status = 'visible'", [contractorId]),
    db.query(`${REVIEW_SELECT} WHERE r.contractor_user_id = $1::uuid AND ${VISIBLE} ORDER BY r.created_at DESC LIMIT 50`, [contractorId])
  ]);
  const v = v0 ? effectiveDates(v0, certDates(certs.get(contractorId))) : undefined;
  return {
    contractorId, displayName: text(u["display_name"]), badge: !standing.suspended && verificationState(v, today).badge, suspended: standing.suspended,
    rating: summariseRatings(ratings.rows.map(r => Number(r["rating"]))), reviews: reviews.rows.map(toReview)
  };
}

/** Reviews of the signed-in contractor, to reply to. */
export async function reviewsForContractorPg(db: Queryable, contractorId: string): Promise<ReviewRow[]> {
  return (await db.query(`${REVIEW_SELECT} WHERE r.contractor_user_id = $1::uuid ORDER BY r.created_at DESC LIMIT 100`, [contractorId])).rows.map(toReview);
}
