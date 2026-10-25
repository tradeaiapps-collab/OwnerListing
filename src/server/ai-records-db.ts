import type { AiDraftRecord, AiDraftRepository, StoredSafetyFlag } from "../domain/ai-draft-record";
import type { SafetyResult } from "../domain/message-safety";
import type { Queryable } from "./db";

// Constant SQL text only; every value is a bound parameter. ai_draft and message_safety_flag have db triggers that refuse
// content changes and deletes, so these functions only ever insert or move a status once.
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

const toDraft = (r: Record<string, unknown>): AiDraftRecord => ({
  id: String(r["id"]), kind: r["kind"] as AiDraftRecord["kind"], listingId: String(r["listing_id"]),
  ...(r["enquiry_id"] ? { enquiryId: String(r["enquiry_id"]) } : {}),
  ...(r["offer_id"] ? { offerId: String(r["offer_id"]) } : {}),
  ...(r["action"] ? { action: r["action"] as NonNullable<AiDraftRecord["action"]> } : {}),
  ...(r["intent"] ? { intent: r["intent"] as NonNullable<AiDraftRecord["intent"]> } : {}),
  text: String(r["text"]),
  policyDecision: r["policy_decision"] as AiDraftRecord["policyDecision"],
  guardResult: r["guard_result"] as AiDraftRecord["guardResult"],
  engineId: String(r["engine_id"]), modelVersion: String(r["model_version"]), promptVersion: String(r["prompt_version"]),
  inputHash: String(r["input_hash"]).trim(),
  status: r["status"] as AiDraftRecord["status"], createdBy: String(r["created_by"]), createdAt: iso(r["created_at"])
});

export function createPgAiDraftRepository(db: Queryable): AiDraftRepository {
  return {
    async insert(d) {
      await db.query(
        `INSERT INTO ai_draft (id, kind, listing_id, enquiry_id, offer_id, action, intent, text, policy_decision, guard_result,
           engine_id, model_version, prompt_version, input_hash, status, created_by, created_at)
         VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16::uuid,$17::timestamptz)`,
        [d.id, d.kind, d.listingId, d.enquiryId ?? null, d.offerId ?? null, d.action ?? null, d.intent ?? null, d.text,
          JSON.stringify(d.policyDecision), JSON.stringify(d.guardResult), d.engineId, d.modelVersion, d.promptVersion, d.inputHash,
          d.status, d.createdBy, d.createdAt]
      );
    },
    async get(id) {
      const r = await db.query("SELECT * FROM ai_draft WHERE id = $1::uuid", [id]);
      return r.rows[0] ? toDraft(r.rows[0]) : undefined;
    },
    async finish(id, to, by, at, sentMessageId) {
      const r = await db.query(
        `UPDATE ai_draft SET status = $2, finished_by = $3::uuid, finished_at = $4::timestamptz, sent_message_id = $5::uuid
         WHERE id = $1::uuid AND status IN ('pending','held') RETURNING id`,
        [id, to, by, at, sentMessageId ?? null]
      );
      return r.rows.length === 1;
    }
  };
}

export const SAFETY_RULES_VERSION = "message-safety@1";

/** Stores a flagged result for one message. Results with no flag are not stored. A second insert for the same message does nothing. */
export async function insertSafetyFlagPg(db: Queryable, id: string, enquiryId: string, messageId: string, r: SafetyResult, at: string): Promise<boolean> {
  if (r.risk === "none") return false;
  const res = await db.query(
    `INSERT INTO message_safety_flag (id, enquiry_id, message_id, risk, categories, flags, handoff, staff_review, rules_version, created_at)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::text[],$6::jsonb,$7,$8,$9,$10::timestamptz)
     ON CONFLICT (message_id) DO NOTHING RETURNING id`,
    [id, enquiryId, messageId, r.risk, r.flags.map(f => f.category), JSON.stringify(r.flags), r.handoff, r.staffReview, SAFETY_RULES_VERSION, at]
  );
  return res.rows.length === 1;
}

const toFlag = (r: Record<string, unknown>): StoredSafetyFlag => ({
  id: String(r["id"]), enquiryId: String(r["enquiry_id"]), messageId: String(r["message_id"]),
  risk: r["risk"] as StoredSafetyFlag["risk"], flags: r["flags"] as StoredSafetyFlag["flags"],
  handoff: Boolean(r["handoff"]), staffReview: Boolean(r["staff_review"]), createdAt: iso(r["created_at"]),
  ...(r["review_outcome"] ? { reviewOutcome: r["review_outcome"] as "confirmed" | "dismissed" } : {})
});

export async function safetyFlagsForEnquiryPg(db: Queryable, enquiryId: string): Promise<StoredSafetyFlag[]> {
  const r = await db.query("SELECT * FROM message_safety_flag WHERE enquiry_id = $1::uuid ORDER BY created_at", [enquiryId]);
  return r.rows.map(toFlag);
}

/** Staff queue: unreviewed flags that need a person, oldest first, with the message text (staff hold case.manage). */
export async function safetyQueuePg(db: Queryable, limit = 100): Promise<(StoredSafetyFlag & { body: string; listingId: string })[]> {
  const r = await db.query(
    `SELECT f.*, m.body, e.listing_id FROM message_safety_flag f
     JOIN enquiry_message m ON m.id = f.message_id JOIN enquiry e ON e.id = f.enquiry_id
     WHERE f.staff_review AND f.reviewed_at IS NULL ORDER BY f.created_at LIMIT $1`,
    [limit]
  );
  return r.rows.map(row => ({ ...toFlag(row), body: String(row["body"]), listingId: String(row["listing_id"]) }));
}

export async function reviewSafetyFlagPg(db: Queryable, id: string, by: string, outcome: "confirmed" | "dismissed", note: string | null, at: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE message_safety_flag SET reviewed_by = $2::uuid, reviewed_at = $5::timestamptz, review_outcome = $3, review_note = $4
     WHERE id = $1::uuid AND reviewed_at IS NULL RETURNING id`,
    [id, by, outcome, note, at]
  );
  return r.rows.length === 1;
}

/** Is AI paused on this thread? No row means not paused. */
export async function aiPausedPg(db: Queryable, enquiryId: string): Promise<{ paused: boolean; reason?: string }> {
  const r = await db.query("SELECT paused, reason FROM enquiry_ai_pause WHERE enquiry_id = $1::uuid", [enquiryId]);
  const row = r.rows[0];
  return row && row["paused"] ? { paused: true, reason: String(row["reason"]) } : { paused: false };
}

export async function setAiPausePg(db: Queryable, enquiryId: string, paused: boolean, reason: string, by: string | null, at: string): Promise<void> {
  await db.query(
    `INSERT INTO enquiry_ai_pause (enquiry_id, paused, reason, changed_by, changed_at) VALUES ($1::uuid,$2,$3,$4::uuid,$5::timestamptz)
     ON CONFLICT (enquiry_id) DO UPDATE SET paused = EXCLUDED.paused, reason = EXCLUDED.reason, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
    [enquiryId, paused, reason, by, at]
  );
}
