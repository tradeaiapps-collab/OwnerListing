import { learnFrom, type FeedbackAction, type FeedbackEvent, type FeedbackKind, type LearnedProfile } from "../domain/listing-assistant";
import type { Queryable } from "./db";

/** Newest rows read when building a profile, so one very active author cannot make the query slow. */
export const PROFILE_ROWS = 500;

export async function insertFeedbackPg(db: Queryable, userId: string, events: readonly FeedbackEvent[]): Promise<void> {
  for (const e of events) {
    await db.query(
      "INSERT INTO listing_assistant_feedback (user_id, kind, key, action, delta_pct) VALUES ($1::uuid,$2,$3,$4,$5)",
      [userId, e.kind, e.key, e.action, e.deltaPct ?? null]
    );
  }
}

export async function loadProfilePg(db: Queryable, userId: string): Promise<LearnedProfile> {
  const r = await db.query(
    "SELECT kind, key, action, delta_pct FROM listing_assistant_feedback WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT $2",
    [userId, PROFILE_ROWS]
  );
  return learnFrom(r.rows.map(x => {
    const e: FeedbackEvent = { kind: String(x["kind"]) as FeedbackKind, key: String(x["key"]), action: String(x["action"]) as FeedbackAction };
    if (x["delta_pct"] !== null && x["delta_pct"] !== undefined) e.deltaPct = Number(x["delta_pct"]);
    return e;
  }));
}

/** The author asked Elena to forget what she learned from them. */
export async function resetFeedbackPg(db: Queryable, userId: string): Promise<void> {
  await db.query("DELETE FROM listing_assistant_feedback WHERE user_id = $1::uuid", [userId]);
}
