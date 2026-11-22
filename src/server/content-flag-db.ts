import { randomUUID } from "node:crypto";
import { CONTENT_RULES_VERSION, type ContentFlagInput, type ContentFlagStore } from "../domain/content-filter";
import type { Queryable } from "./db";
import { enqueueModerationItemPg } from "./moderation-queue-db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export interface StoredContentFlag {
  id: string; source: "message" | "profile"; subjectType: string; subjectId?: string; field: string; userId: string;
  action: "flag" | "block"; categories: string[]; hits: { category: string; action: string; match: string }[]; excerpt: string;
  createdAt: string; reviewOutcome?: "confirmed" | "dismissed"; reviewNote?: string;
}

const toFlag = (r: Record<string, unknown>): StoredContentFlag => ({
  id: String(r["id"]), source: r["source"] as StoredContentFlag["source"], subjectType: String(r["subject_type"]),
  ...(r["subject_id"] ? { subjectId: String(r["subject_id"]) } : {}), field: String(r["field"]), userId: String(r["user_id"]),
  action: r["action"] as StoredContentFlag["action"], categories: r["categories"] as string[], hits: r["hits"] as StoredContentFlag["hits"],
  excerpt: String(r["excerpt"]), createdAt: iso(r["created_at"]),
  ...(r["review_outcome"] ? { reviewOutcome: r["review_outcome"] as "confirmed" | "dismissed" } : {}), ...(r["review_note"] ? { reviewNote: String(r["review_note"]) } : {})
});

export function createPgContentFlagStore(db: Queryable): ContentFlagStore {
  return {
    async record(f: ContentFlagInput) {
      await db.query(
        `INSERT INTO content_flag (id, source, subject_type, subject_id, field, user_id, action, categories, hits, excerpt, rules_version)
         VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6::uuid,$7,$8::text[],$9::jsonb,$10,$11)`,
        [randomUUID(), f.source, f.subjectType, f.subjectId ?? null, f.field, f.userId, f.action, [...new Set(f.hits.map(h => h.category))],
          JSON.stringify(f.hits), f.excerpt.slice(0, 500), CONTENT_RULES_VERSION]);
      // Flagged text that was stored goes to the staff moderation queue too (refused text was never stored, so there is nothing to review).
      if (f.action === "flag" && f.subjectId) {
        const cats = [...new Set(f.hits.map(h => h.category))].map(c => c.replace(/_/g, " "));
        await enqueueModerationItemPg(db, {
          subjectType: f.source, subjectId: f.subjectId, subjectLabel: `${f.subjectType.replace(/_/g, " ")}: ${f.field}`, subjectOwnerId: f.userId,
          source: "content_filter", reason: `Flagged: ${cats.join(", ")}`.slice(0, 120), detail: f.excerpt, severity: f.hits.some(h => h.category === "abuse") ? "high" : "medium"
        });
      }
    }
  };
}

/** Open flags, oldest first. For the staff moderation queue. */
export async function listOpenContentFlagsPg(db: Queryable, limit = 50): Promise<StoredContentFlag[]> {
  const r = await db.query("SELECT * FROM content_flag WHERE reviewed_at IS NULL ORDER BY created_at LIMIT $1", [Math.min(Math.max(limit, 1), 200)]);
  return r.rows.map(toFlag);
}

/** Marks one flag reviewed. Returns false when it does not exist or was already reviewed. */
export async function reviewContentFlagPg(db: Queryable, id: string, staffUserId: string, outcome: "confirmed" | "dismissed", note?: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE content_flag SET reviewed_by = $2::uuid, reviewed_at = now(), review_outcome = $3, review_note = $4
      WHERE id = $1::uuid AND reviewed_at IS NULL RETURNING id`, [id, staffUserId, outcome, note?.trim() ? note.trim().slice(0, 500) : null]);
  return r.rows.length === 1;
}
