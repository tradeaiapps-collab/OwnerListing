import {
  DEFAULT_OPTIMIZATION_SETTINGS, isSuggestionType, type Impact, type OptimizationSettings, type Suggestion, type SuggestionStatus, type SuggestionType
} from "../domain/listing-optimization";
import type { Queryable } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const OUTCOME_DAYS = 14;
export interface StoredOptimizationSettings extends OptimizationSettings { updatedAt: string | null; updatedBy: string | null; updatedByName: string | null }
const blank = (): StoredOptimizationSettings => ({ ...DEFAULT_OPTIMIZATION_SETTINGS, updatedAt: null, updatedBy: null, updatedByName: null });

/** The one settings row. FAILS CLOSED: a read error or a missing row means optimization is off. */
export async function getOptimizationSettings(db: Queryable): Promise<StoredOptimizationSettings> {
  try {
    const x = (await db.query("SELECT s.*, u.display_name AS updated_by_name FROM listing_optimization_settings s LEFT JOIN app_user u ON u.id = s.updated_by WHERE s.id = 1")).rows[0];
    if (!x) return blank();
    return {
      enabled: x["enabled"] === true, minPhotos: Number(x["min_photos"]), minDescriptionWords: Number(x["min_description_words"]), maxPriceCutPercent: Number(x["max_price_cut_percent"]),
      disabledTypes: ((x["disabled_types"] as unknown[]) ?? []).filter(isSuggestionType), updatedAt: iso(x["updated_at"]),
      updatedBy: x["updated_by"] ? String(x["updated_by"]) : null, updatedByName: x["updated_by_name"] ? String(x["updated_by_name"]) : null
    };
  } catch { return blank(); }
}

export async function saveOptimizationSettings(db: Queryable, s: OptimizationSettings, staffId: string): Promise<void> {
  await db.query(
    `INSERT INTO listing_optimization_settings (id, enabled, min_photos, min_description_words, max_price_cut_percent, disabled_types, updated_by, updated_at)
     VALUES (1,$1,$2,$3,$4,$5::text[],$6::uuid,now())
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, min_photos = EXCLUDED.min_photos, min_description_words = EXCLUDED.min_description_words,
       max_price_cut_percent = EXCLUDED.max_price_cut_percent, disabled_types = EXCLUDED.disabled_types, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [s.enabled, s.minPhotos, s.minDescriptionWords, s.maxPriceCutPercent, s.disabledTypes, staffId]);
}

export interface Outcome { days: number; enquiriesBefore: number; enquiriesAfter: number; offersBefore: number; offersAfter: number }
export interface StoredSuggestion {
  id: string; listingId: string; type: SuggestionType; title?: string; description: string; impact: Impact; status: SuggestionStatus;
  createdAt: string; statusChangedAt: string; implementedAt: string | null; outcome: Outcome | null;
}

const COUNTS = `
  LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE created_at >= o.implemented_at - interval '${OUTCOME_DAYS} days' AND created_at < o.implemented_at)::int AS before_n,
                            count(*) FILTER (WHERE created_at >= o.implemented_at AND created_at < o.implemented_at + interval '${OUTCOME_DAYS} days')::int AS after_n
                       FROM enquiry WHERE listing_id = o.listing_id) e ON o.implemented_at IS NOT NULL
  LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE submitted_at >= o.implemented_at - interval '${OUTCOME_DAYS} days' AND submitted_at < o.implemented_at)::int AS before_n,
                            count(*) FILTER (WHERE submitted_at >= o.implemented_at AND submitted_at < o.implemented_at + interval '${OUTCOME_DAYS} days')::int AS after_n
                       FROM formal_offer WHERE listing_id = o.listing_id) f ON o.implemented_at IS NOT NULL`;

const toRow = (x: Record<string, unknown>): StoredSuggestion => ({
  id: String(x["id"]), listingId: String(x["listing_id"]), type: String(x["suggestion_type"]) as SuggestionType, description: String(x["description"]),
  impact: x["estimated_impact"] as Impact, status: String(x["status"]) as SuggestionStatus, createdAt: iso(x["created_at"]), statusChangedAt: iso(x["status_changed_at"]),
  implementedAt: x["implemented_at"] ? iso(x["implemented_at"]) : null,
  outcome: x["measured"] === true
    ? { days: OUTCOME_DAYS, enquiriesBefore: Number(x["enq_before"]), enquiriesAfter: Number(x["enq_after"]), offersBefore: Number(x["off_before"]), offersAfter: Number(x["off_after"]) } : null
});

/** Every suggestion kept for a listing, newest first. An outcome appears once 14 days have passed since the seller marked it done. */
export async function listSuggestions(db: Queryable, listingId: string, now: string): Promise<StoredSuggestion[]> {
  const r = await db.query(
    `SELECT o.*, (o.implemented_at IS NOT NULL AND o.implemented_at <= $2::timestamptz - interval '${OUTCOME_DAYS} days') AS measured,
            e.before_n AS enq_before, e.after_n AS enq_after, f.before_n AS off_before, f.after_n AS off_after
       FROM listing_optimizations o ${COUNTS} WHERE o.listing_id = $1::uuid ORDER BY o.created_at DESC, o.suggestion_type`, [listingId, now]);
  return r.rows.map(toRow);
}

/**
 * Brings the stored suggestions in line with what the rules found now. New ones are added; open ones are refreshed; an open one
 * the rules no longer find becomes "outdated"; an outdated one that comes back reopens. Done and dismissed ones keep the seller's answer.
 */
export async function syncSuggestions(db: Queryable, listingId: string, found: readonly Suggestion[], now: string): Promise<void> {
  for (const s of found) {
    await db.query(
      `INSERT INTO listing_optimizations (listing_id, suggestion_type, description, estimated_impact, created_at, status_changed_at)
       VALUES ($1::uuid,$2,$3,$4::jsonb,$5::timestamptz,$5::timestamptz)
       ON CONFLICT (listing_id, suggestion_type) DO UPDATE SET
         description = CASE WHEN listing_optimizations.status IN ('open','outdated') THEN EXCLUDED.description ELSE listing_optimizations.description END,
         estimated_impact = CASE WHEN listing_optimizations.status IN ('open','outdated') THEN EXCLUDED.estimated_impact ELSE listing_optimizations.estimated_impact END,
         status_changed_at = CASE WHEN listing_optimizations.status = 'outdated' THEN EXCLUDED.status_changed_at ELSE listing_optimizations.status_changed_at END,
         status = CASE WHEN listing_optimizations.status = 'outdated' THEN 'open' ELSE listing_optimizations.status END`,
      [listingId, s.type, s.description, JSON.stringify(s.impact), now]);
  }
  await db.query(
    `UPDATE listing_optimizations SET status = 'outdated', status_changed_at = $3::timestamptz
      WHERE listing_id = $1::uuid AND status = 'open' AND NOT (suggestion_type = ANY($2::text[]))`,
    [listingId, found.map(s => s.type), now]);
}

/** The seller's answer. Scoped to the listing, so a suggestion id from another listing changes nothing. Returns false when none matched. */
export async function setSuggestionStatus(db: Queryable, listingId: string, id: string, status: "open" | "implemented" | "dismissed", now: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE listing_optimizations SET status = $3, status_changed_at = $4::timestamptz, implemented_at = CASE WHEN $3 = 'implemented' THEN $4::timestamptz ELSE NULL END
      WHERE id = $2::uuid AND listing_id = $1::uuid AND status <> 'outdated' RETURNING id`, [listingId, id, status, now]);
  return r.rows.length > 0;
}

export interface TypeStats {
  type: SuggestionType; total: number; open: number; implemented: number; dismissed: number; outdated: number; adoptionPercent: number | null;
  measured: number; enquiriesBefore: number; enquiriesAfter: number; offersBefore: number; offersAfter: number;
}

/** Staff view: how often each kind of suggestion is followed, and what happened to enquiries and offers 14 days either side of it being done. */
export async function adoptionStats(db: Queryable, now: string): Promise<TypeStats[]> {
  const a = await db.query(
    `SELECT suggestion_type, count(*)::int AS total, count(*) FILTER (WHERE status='open')::int AS open, count(*) FILTER (WHERE status='implemented')::int AS implemented,
            count(*) FILTER (WHERE status='dismissed')::int AS dismissed, count(*) FILTER (WHERE status='outdated')::int AS outdated
       FROM listing_optimizations GROUP BY suggestion_type`);
  const m = await db.query(
    `SELECT o.suggestion_type, count(*)::int AS measured, COALESCE(sum(e.before_n),0)::int AS enq_before, COALESCE(sum(e.after_n),0)::int AS enq_after,
            COALESCE(sum(f.before_n),0)::int AS off_before, COALESCE(sum(f.after_n),0)::int AS off_after
       FROM listing_optimizations o ${COUNTS}
      WHERE o.status = 'implemented' AND o.implemented_at <= $1::timestamptz - interval '${OUTCOME_DAYS} days' GROUP BY o.suggestion_type`, [now]);
  const meas = new Map(m.rows.map(x => [String(x["suggestion_type"]), x]));
  return a.rows.filter(x => isSuggestionType(x["suggestion_type"])).map(x => {
    const t = String(x["suggestion_type"]) as SuggestionType, y = meas.get(t);
    const impl = Number(x["implemented"]), dis = Number(x["dismissed"]), open = Number(x["open"]);
    const decided = impl + dis + open;
    return {
      type: t, total: Number(x["total"]), open, implemented: impl, dismissed: dis, outdated: Number(x["outdated"]),
      adoptionPercent: decided > 0 ? Math.round((impl / decided) * 1000) / 10 : null,
      measured: y ? Number(y["measured"]) : 0, enquiriesBefore: y ? Number(y["enq_before"]) : 0, enquiriesAfter: y ? Number(y["enq_after"]) : 0,
      offersBefore: y ? Number(y["off_before"]) : 0, offersAfter: y ? Number(y["off_after"]) : 0
    };
  }).sort((p, q) => q.total - p.total || p.type.localeCompare(q.type));
}

export async function recentOptimizationChanges(db: Queryable, limit = 20): Promise<{ at: string; actorName: string | null; event: string; payload: Record<string, unknown> }[]> {
  const r = await db.query(
    `SELECT a.occurred_at, u.display_name, a.event_type, a.payload FROM audit_event a LEFT JOIN app_user u ON u.id::text = a.actor_id
      WHERE a.event_type LIKE 'staff.listing_optimization.%' ORDER BY a.occurred_at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 100)]);
  return r.rows.map(x => ({ at: iso(x["occurred_at"]), actorName: x["display_name"] ? String(x["display_name"]) : null, event: String(x["event_type"]), payload: (x["payload"] ?? {}) as Record<string, unknown> }));
}
