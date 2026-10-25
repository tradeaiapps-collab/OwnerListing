import { flagKey, type FieldFlags } from "../domain/discrimination-filter";
import type { Queryable } from "./db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WordingFlagStatus = "open" | "cleared" | "upheld";
export const WORDING_FLAG_STATUSES: readonly WordingFlagStatus[] = ["open", "cleared", "upheld"];

export interface WordingFlagRow {
  id: string;
  listingId: string;
  listingTitle: string;
  listingStatus: string;
  jurisdiction: string;
  field: string;
  matchText: string;
  category: string;
  ruleId: string;
  status: WordingFlagStatus;
  attempts: number;
  firstRaisedAt: string;
  lastRaisedAt: string;
  reviewedAt: string | null;
  reviewReason: string | null;
  /** The field's current text, so the reviewer sees the match in context. */
  context: string;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null ? null : new Date(String(v)).toISOString());

/**
 * Records each blocking match from a publish attempt. A match already on file counts another attempt; a reviewed one keeps its
 * decision (an upheld match stays upheld, a cleared one stays cleared). Only "block" flags are recorded; warnings are advice only.
 */
export async function recordWordingFlagsPg(db: Queryable, listingId: string, actorUserId: string, fields: readonly FieldFlags[]): Promise<void> {
  for (const { field, flags } of fields) {
    for (const f of flags) {
      if (f.severity !== "block") continue;
      await db.query(
        `INSERT INTO wording_flag (listing_id, field, flag_key, match_text, category, rule_id, raised_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (listing_id, flag_key) DO UPDATE SET last_raised_at = now(), attempts = wording_flag.attempts + 1`,
        [listingId, field, flagKey(field, f.match).slice(0, 400), f.match.slice(0, 300), f.category, f.ruleId, actorUserId]
      );
    }
  }
}

/** flagKey values staff cleared for this listing. */
export async function clearedWordingFlagsPg(db: Queryable, listingId: string): Promise<ReadonlySet<string>> {
  if (!UUID_RE.test(listingId)) return new Set();
  const r = await db.query("SELECT flag_key FROM wording_flag WHERE listing_id = $1 AND status = 'cleared'", [listingId]);
  return new Set(r.rows.map(row => String(row["flag_key"])));
}

/** The review queue (oldest first for open flags, newest first otherwise), with the listing's current text for context. */
export async function listWordingFlagsPg(db: Queryable, status: WordingFlagStatus, limit = 100): Promise<WordingFlagRow[]> {
  const r = await db.query(
    `SELECT f.id, f.listing_id, l.title AS listing_title, l.status AS listing_status, l.jurisdiction, f.field, f.match_text, f.category,
       f.rule_id, f.status, f.attempts, f.first_raised_at, f.last_raised_at, f.reviewed_at, f.review_reason,
       CASE WHEN f.field = 'title' THEN l.title ELSE coalesce(l.description, '') END AS context
     FROM wording_flag f JOIN property_listing l ON l.id = f.listing_id
     WHERE f.status = $1
     ORDER BY CASE WHEN $1 = 'open' THEN f.first_raised_at END ASC, f.reviewed_at DESC NULLS LAST
     LIMIT $2`,
    [status, limit]
  );
  return r.rows.map(row => ({
    id: String(row["id"]), listingId: String(row["listing_id"]), listingTitle: String(row["listing_title"]),
    listingStatus: String(row["listing_status"]), jurisdiction: String(row["jurisdiction"]).trim(), field: String(row["field"]),
    matchText: String(row["match_text"]), category: String(row["category"]), ruleId: String(row["rule_id"]),
    status: row["status"] as WordingFlagStatus, attempts: Number(row["attempts"]),
    firstRaisedAt: iso(row["first_raised_at"])!, lastRaisedAt: iso(row["last_raised_at"])!,
    reviewedAt: iso(row["reviewed_at"]), reviewReason: (row["review_reason"] as string | null) ?? null,
    context: String(row["context"]).slice(0, 5000)
  }));
}

export type ReviewOutcome = "reviewed" | "not_found" | "already_reviewed" | "own_flag";

/**
 * A staff member clears or upholds an open flag. Guarded UPDATE: only an open flag changes, and never by the person who raised it.
 */
export async function reviewWordingFlagPg(
  db: Queryable, id: string, staffId: string, decision: "clear" | "uphold", reason: string
): Promise<{ outcome: ReviewOutcome; listingId?: string }> {
  if (!UUID_RE.test(id)) return { outcome: "not_found" };
  const r = await db.query(
    `UPDATE wording_flag SET status = $3, reviewed_by = $2, reviewed_at = now(), review_reason = $4
     WHERE id = $1 AND status = 'open' AND raised_by <> $2
     RETURNING listing_id`,
    [id, staffId, decision === "clear" ? "cleared" : "upheld", reason]
  );
  if (r.rows[0]) return { outcome: "reviewed", listingId: String(r.rows[0]["listing_id"]) };
  const cur = await db.query("SELECT status, raised_by FROM wording_flag WHERE id = $1", [id]);
  const row = cur.rows[0];
  if (!row) return { outcome: "not_found" };
  if (row["status"] !== "open") return { outcome: "already_reviewed" };
  return { outcome: "own_flag" };
}
