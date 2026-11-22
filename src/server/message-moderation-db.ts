import { noteReaction, noteSuggestion, stableId } from "./elena-wiring-db";
import { randomUUID } from "node:crypto";
import type { Enquiry, EnquiryMessage } from "../domain/enquiry-service";
import { MODERATION_RULES_VERSION, moderateMessage, needsTraining, TRAINING_THRESHOLD, type ModerationFlag, type ModerationResult, type Tone } from "../domain/message-moderation";
import type { Queryable } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export type ModerationStatus = "open" | "approved" | "revision_requested" | "educated";
export type ModerationAction = "approve" | "request_revision" | "educate";
export const MODERATION_ACTIONS: readonly ModerationAction[] = ["approve", "request_revision", "educate"];
const STATUS_OF: Record<ModerationAction, Exclude<ModerationStatus, "open">> = { approve: "approved", request_revision: "revision_requested", educate: "educated" };

export interface StoredModerationFlag {
  id: string; enquiryId: string; messageId: string; senderUserId: string; severity: "low" | "medium" | "high"; tone: Tone;
  flags: ModerationFlag[]; status: ModerationStatus; reviewNote?: string; createdAt: string;
}

const toFlag = (r: Record<string, unknown>): StoredModerationFlag => ({
  id: String(r["id"]), enquiryId: String(r["enquiry_id"]), messageId: String(r["message_id"]), senderUserId: String(r["sender_user_id"]),
  severity: r["severity"] as StoredModerationFlag["severity"], tone: r["tone"] as Tone, flags: r["flags"] as ModerationFlag[],
  status: r["status"] as ModerationStatus, ...(r["review_note"] ? { reviewNote: String(r["review_note"]) } : {}), createdAt: iso(r["created_at"])
});

/** Stores the result for one sent message. Clean messages are not stored. A second insert for the same message does nothing. */
export async function insertModerationFlagPg(db: Queryable, enquiryId: string, message: EnquiryMessage, r: ModerationResult): Promise<boolean> {
  if (r.risk === "none" || !message.senderUserId) return false;
  const res = await db.query(
    `INSERT INTO message_moderation_flag (id, enquiry_id, message_id, sender_user_id, severity, tone, categories, flags, rules_version, created_at)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::text[],$8::jsonb,$9,$10::timestamptz)
     ON CONFLICT (message_id) DO NOTHING RETURNING id`,
    [randomUUID(), enquiryId, message.id, message.senderUserId, r.risk, r.tone, [...new Set(r.flags.map(f => f.category))], JSON.stringify(r.flags), MODERATION_RULES_VERSION, message.sentAt]
  );
  return res.rows.length === 1;
}

/** Flags on one thread. Callers show only the sender's own flags to them. */
export async function moderationFlagsForEnquiryPg(db: Queryable, enquiryId: string, senderUserId: string): Promise<StoredModerationFlag[]> {
  const r = await db.query("SELECT * FROM message_moderation_flag WHERE enquiry_id = $1::uuid AND sender_user_id = $2::uuid ORDER BY created_at", [enquiryId, senderUserId]);
  return r.rows.map(toFlag);
}

export interface ModerationQueueItem extends StoredModerationFlag {
  body: string; listingId: string; senderName: string; senderFlags30d: number; trainingSuggested: boolean;
}

/** Staff queue: open flags, highest severity first then oldest, with the message text and how many flags the sender has had lately. */
export async function moderationQueuePg(db: Queryable, status: "open" | "reviewed" = "open", limit = 100): Promise<ModerationQueueItem[]> {
  const r = await db.query(
    `SELECT f.*, m.body, e.listing_id, u.display_name,
            (SELECT count(*) FROM message_moderation_flag x WHERE x.sender_user_id = f.sender_user_id AND x.created_at > now() - make_interval(days => $3::int))::int AS n30
     FROM message_moderation_flag f
     JOIN enquiry_message m ON m.id = f.message_id JOIN enquiry e ON e.id = f.enquiry_id JOIN app_user u ON u.id = f.sender_user_id
     WHERE (CASE WHEN $2 = 'open' THEN f.status = 'open' ELSE f.status <> 'open' END)
     ORDER BY (CASE f.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END), f.created_at LIMIT $1`,
    [limit, status, TRAINING_THRESHOLD.days]
  );
  return r.rows.map(row => ({
    ...toFlag(row), body: String(row["body"]), listingId: String(row["listing_id"]), senderName: String(row["display_name"] ?? ""),
    senderFlags30d: Number(row["n30"]), trainingSuggested: needsTraining(Number(row["n30"]))
  }));
}

/** Staff decision, once. "request_revision" and "educate" need a note so the sender knows what to change or learn. */
export async function reviewModerationFlagPg(db: Queryable, id: string, by: string, action: ModerationAction, note: string | null, at: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE message_moderation_flag SET status = $3, reviewed_by = $2::uuid, reviewed_at = $5::timestamptz, review_note = $4
     WHERE id = $1::uuid AND status = 'open' RETURNING id`,
    [id, by, STATUS_OF[action], note, at]
  );
  if (r.rows.length === 1) {
    // Staff approving the message means the flag was not needed; asking for a revision or training means it was.
    const m = (await db.query("SELECT message_id FROM message_moderation_flag WHERE id = $1::uuid", [id]).catch(() => ({ rows: [] }))).rows[0];
    if (m) await noteReaction(db, stableId("moderation", String(m["message_id"])), action === "approve" ? "rejected" : "accepted", by);
  }
  return r.rows.length === 1;
}

/** Screens a message the seller side just sent and stores any flag. Never throws: the message is already stored. */
export async function moderateSentMessage(db: Queryable, enquiry: Enquiry, message: EnquiryMessage): Promise<ModerationResult | undefined> {
  if (message.automated || !message.senderUserId || message.senderUserId === enquiry.buyerUserId) return undefined;
  try {
    const result = moderateMessage(message.body);
    const stored = await insertModerationFlagPg(db, enquiry.id, message, result);
    if (stored && message.senderUserId) {
      const top = [...result.flags].sort((a, b) => ({ high: 3, medium: 2, low: 1 })[b.severity] - ({ high: 3, medium: 2, low: 1 })[a.severity])[0];
      await noteSuggestion(db, {
        id: stableId("moderation", message.id), feature: "message_moderation", type: top?.category ?? "flagged", userId: message.senderUserId, userRole: "seller_side",
        context: { risk: result.risk, tone: result.tone, flags: result.flags.length }
      });
    }
    return result;
  } catch {
    return undefined;
  }
}
