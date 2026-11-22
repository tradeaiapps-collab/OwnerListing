import { createHash } from "node:crypto";
import { CONTROL_ARM, weightsApply, type Feature, type FeedbackAction, type LearnedConfig } from "../domain/elena-learning";
import type { Queryable } from "./db";
import { SIDE_SQL } from "./settlement-db";
import { activeConfigPg, armForPg, recordFeedbackPg, recordSuggestionPg, trainingConsentPg, type NewSuggestion } from "./elena-learning-db";

/**
 * How the Elena features use the learning loop. Two rules: a feature never fails because learning failed (everything here swallows errors),
 * and an A/B test arm named "control" always gets the original behaviour while every other arm gets the active learned settings.
 */

/** Same inputs, same UUID: one suggestion row per thing shown, however often the page is opened. */
export function stableId(...parts: string[]): string {
  const h = createHash("sha1").update(parts.join("|")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface Learned { config: LearnedConfig | undefined; weighted: boolean; experimentKey?: string; arm?: string }

/** The settings a feature should use for this person right now. */
export async function learnedFor(db: Queryable, feature: Feature, userId: string | undefined): Promise<Learned> {
  try {
    const config = await activeConfigPg(db);
    const exp = userId ? await armForPg(db, feature, userId) : undefined;
    return { config, weighted: weightsApply(config, exp?.arm), ...(exp ? { experimentKey: exp.key, arm: exp.arm } : {}) };
  } catch {
    return { config: undefined, weighted: false };
  }
}

/** Config to hand to rankSuggestions: undefined when this person should get the original order. */
export const configIfWeighted = (l: Learned): LearnedConfig | undefined => (l.weighted ? l.config : undefined);

export type Shown = Omit<NewSuggestion, "experimentKey" | "arm" | "consent" | "context"> & { context?: Record<string, unknown> };

/** Records that Elena suggested something, with the person's test arm and whether learned settings were used. Returns the id, or undefined on failure. */
export async function noteSuggestion(db: Queryable, s: Shown, l?: Learned, now: Date = new Date()): Promise<string | undefined> {
  try {
    const consent = s.userId ? await trainingConsentPg(db, s.userId, now.toISOString()) : false;
    return await recordSuggestionPg(db, {
      ...s, consent, context: { ...(s.context ?? {}), ...(l ? { weighted: l.weighted } : {}) },
      ...(l?.experimentKey ? { experimentKey: l.experimentKey } : {}), ...(l?.arm ? { arm: l.arm } : {})
    });
  } catch {
    return undefined;
  }
}

/** Several suggestions at once (every item needs an id). Rows that already exist are skipped, and consent is looked up once per person. */
export async function noteMany(db: Queryable, items: readonly (Shown & { id: string })[], l?: Learned, now: Date = new Date()): Promise<void> {
  try {
    if (items.length === 0) return;
    const have = new Set((await db.query("SELECT id::text AS id FROM elena_suggestion WHERE id = ANY($1::uuid[])", [items.map(i => i.id)])).rows.map(r => String(r["id"])));
    const consent = new Map<string, boolean>();
    for (const i of items) {
      if (have.has(i.id)) continue;
      const u = i.userId;
      if (u && !consent.has(u)) consent.set(u, await trainingConsentPg(db, u, now.toISOString()));
      await recordSuggestionPg(db, {
        ...i, consent: u ? consent.get(u) === true : false, context: { ...(i.context ?? {}), ...(l ? { weighted: l.weighted } : {}) },
        ...(l?.experimentKey ? { experimentKey: l.experimentKey } : {}), ...(l?.arm ? { arm: l.arm } : {})
      });
    }
  } catch { /* learning must never break the feature */ }
}

/** Records what the person did with a suggestion. Safe to call twice: the first reaction by the system for a suggestion stays. */
export async function noteReaction(db: Queryable, suggestionId: string, action: FeedbackAction, userId: string | undefined): Promise<void> {
  try {
    const seen = await db.query("SELECT 1 FROM elena_feedback WHERE suggestion_id = $1::uuid AND source = 'auto' LIMIT 1", [suggestionId]);
    if (seen.rows.length > 0) return;
    await recordFeedbackPg(db, { suggestionId, action, source: "auto", ...(userId ? { recordedBy: userId } : {}) });
  } catch { /* learning must never break the feature */ }
}


export interface SweepResult { pricing: number; listingOptimization: number; inspectionResponder: number }

/**
 * Weekly. Suggestions whose answer lives in another table get their reaction from it, so those features need no prompt:
 *  - pricing: the seller's asking price now vs the advised price (within 3% accepted, within 8% modified, else ignored after 14 days)
 *  - listing_optimization: implemented = accepted, dismissed = rejected, still open or outdated after 30 days = ignored
 *  - inspection_responder: sent = accepted, sent after editing = modified, skipped = rejected, expired = ignored
 * Each reaction is the automatic one (one per suggestion), so running the sweep again changes nothing.
 */
export async function sweepImpliedReactionsPg(db: Queryable): Promise<SweepResult> {
  const count = async (sql: string) => (await db.query(sql)).rows.length;
  const pricing = await count(
    `INSERT INTO elena_feedback (suggestion_id, action, source)
     SELECT s.id, CASE WHEN abs(l.price_cents - rec) <= rec * 0.03 THEN 'accepted' WHEN abs(l.price_cents - rec) <= rec * 0.08 THEN 'modified' ELSE 'ignored' END, 'auto'
       FROM (SELECT s.*, (s.context->>'recommendedCents')::numeric AS rec FROM elena_suggestion s
              WHERE s.feature = 'pricing' AND s.created_at < now() - interval '14 days' AND s.context ? 'recommendedCents'
                AND NOT EXISTS (SELECT 1 FROM elena_feedback f WHERE f.suggestion_id = s.id)) s
       JOIN property_listing l ON l.id = s.listing_id AND l.price_cents IS NOT NULL AND s.rec > 0
     ON CONFLICT DO NOTHING RETURNING id`);
  const listingOptimization = await count(
    `INSERT INTO elena_feedback (suggestion_id, action, source)
     SELECT s.id, CASE o.status WHEN 'implemented' THEN 'accepted' WHEN 'dismissed' THEN 'rejected' ELSE 'ignored' END, 'auto'
       FROM elena_suggestion s JOIN listing_optimizations o ON o.id = s.id
      WHERE s.feature = 'listing_optimization' AND NOT EXISTS (SELECT 1 FROM elena_feedback f WHERE f.suggestion_id = s.id)
        AND (o.status IN ('implemented','dismissed') OR s.created_at < now() - interval '30 days')
     ON CONFLICT DO NOTHING RETURNING id`);
  const inspectionResponder = await count(
    `INSERT INTO elena_feedback (suggestion_id, action, source)
     SELECT s.id, CASE WHEN m.status = 'sent' AND m.edited THEN 'modified' WHEN m.status = 'sent' THEN 'accepted' WHEN m.status = 'skipped' THEN 'rejected' ELSE 'ignored' END, 'auto'
       FROM elena_suggestion s JOIN elena_scheduled_message m ON m.id = s.id
      WHERE s.feature = 'inspection_responder' AND m.status IN ('sent','skipped','expired') AND NOT EXISTS (SELECT 1 FROM elena_feedback f WHERE f.suggestion_id = s.id)
     ON CONFLICT DO NOTHING RETURNING id`);
  return { pricing, listingOptimization, inspectionResponder };
}

/**
 * The whole-experience question after a settlement or dispute ends ("Was Elena helpful?"). Finds or creates one suggestion per person for that
 * settlement or dispute (so it joins the deal outcome through the offer) and records the answer. Only the buyer or seller, only once it has ended.
 */
export async function recordOverallFeedbackPg(
  db: Queryable, userId: string, kind: "settlement" | "dispute", subjectId: string, answer: { helpful?: "yes" | "no" | "partial"; rating?: number }
): Promise<"ok" | "not_found" | "not_ended"> {
  const q = kind === "settlement"
    ? `SELECT t.offer_id, l.jurisdiction AS region, ${SIDE_SQL} AS side, (t.completed_at IS NOT NULL OR o.status = 'fallen_through') AS ended
         FROM settlement_timeline t JOIN property_listing l ON l.id = t.listing_id JOIN formal_offer o ON o.id = t.offer_id WHERE t.id = $2::uuid`
    : `SELECT t.offer_id, l.jurisdiction AS region, ${SIDE_SQL} AS side, (d.status IN ('agreed','resolved')) AS ended
         FROM disputes d JOIN settlement_timeline t ON t.id = d.settlement_id JOIN property_listing l ON l.id = t.listing_id WHERE d.id = $2::uuid`;
  const row = (await db.query(q, [userId, subjectId])).rows[0];
  const side = row?.["side"];
  if (!row || (side !== "buyer" && side !== "seller")) return "not_found";
  if (row["ended"] !== true) return "not_ended";
  const feature: Feature = kind === "settlement" ? "negotiation_coach" : "mediation";
  const id = await noteSuggestion(db, {
    id: stableId("overall", kind, subjectId, userId), feature, type: `${kind}_overall`, userId, userRole: side, offerId: String(row["offer_id"]),
    ...(row["region"] ? { region: String(row["region"]).trim() } : {}), context: { kind }
  });
  if (!id) return "not_found";
  const { helpful, rating } = answer;
  const action = helpful === "no" ? "rejected" : helpful === "partial" ? "modified" : helpful === "yes" ? "accepted" : (rating ?? 3) >= 4 ? "accepted" : (rating ?? 3) <= 2 ? "rejected" : "modified";
  await recordFeedbackPg(db, { suggestionId: id, action, source: "user", recordedBy: userId, ...(helpful ? { helpful } : {}), ...(rating !== undefined ? { rating } : {}) });
  return "ok";
}

export { CONTROL_ARM };
