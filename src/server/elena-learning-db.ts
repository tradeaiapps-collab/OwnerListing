import { randomUUID } from "node:crypto";
import { aiLearningCovered, currentTermsVersion } from "../domain/terms";
import {
  assignArm, buildUserPattern, experimentResult, healthOf, proposeConfig, redactText, sanitiseContext,
  type Feature, type FeedbackAction, type LearnedConfig, type Outcome, type SuggestionFact
} from "../domain/elena-learning";
import type { Queryable } from "./db";
import { listAcceptances, listTermsVersions } from "./terms-db";

// Constant SQL text; every value is a bound parameter. elena_suggestion and elena_feedback are insert-only (db triggers).
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export interface NewSuggestion {
  id?: string;
  feature: Feature;
  type: string;
  text?: string;
  userId?: string;
  userRole?: string;
  region?: string;
  listingId?: string;
  offerId?: string;
  context?: Record<string, unknown>;
  experimentKey?: string;
  arm?: string;
  consent?: boolean;
  source?: "ai_draft" | "direct";
}

/** True when the person accepted a terms version that includes the AI-learning clause. Fails closed. */
export async function trainingConsentPg(db: Queryable, userId: string, nowIso: string): Promise<boolean> {
  try {
    const current = currentTermsVersion(await listTermsVersions(db), nowIso);
    return current !== undefined && aiLearningCovered(await listAcceptances(db, userId), userId, current);
  } catch { return false; }
}

export async function recordSuggestionPg(db: Queryable, s: NewSuggestion): Promise<string> {
  const id = s.id ?? randomUUID();
  await db.query(
    `INSERT INTO elena_suggestion (id, feature, suggestion_type, suggestion_text, user_id, user_role, region, listing_id, offer_id, context, experiment_key, arm, consent_for_training, source)
     VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6,$7,$8::uuid,$9::uuid,$10::jsonb,$11,$12,$13,$14) ON CONFLICT (id) DO NOTHING`,
    [id, s.feature, s.type.slice(0, 60), s.text === undefined ? null : redactText(s.text), s.userId ?? null, s.userRole ?? "unknown", s.region ?? null,
      s.listingId ?? null, s.offerId ?? null, JSON.stringify(sanitiseContext(s.context ?? {})), s.experimentKey ?? null, s.arm ?? null, s.consent === true, s.source ?? "direct"]
  );
  return id;
}

export interface NewFeedback { suggestionId: string; action: FeedbackAction; helpful?: "yes" | "no" | "partial"; rating?: number; responseSeconds?: number; source: "auto" | "user" | "staff"; recordedBy?: string }

export async function recordFeedbackPg(db: Queryable, f: NewFeedback): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO elena_feedback (suggestion_id, action, helpful, rating, response_seconds, source, recorded_by)
     SELECT $1::uuid,$2,$3,$4,$5,$6,$7::uuid WHERE EXISTS (SELECT 1 FROM elena_suggestion WHERE id = $1::uuid)
     ON CONFLICT DO NOTHING RETURNING id`,
    [f.suggestionId, f.action, f.helpful ?? null, f.rating ?? null, f.responseSeconds ?? null, f.source, f.recordedBy ?? null]
  );
  return r.rows.length === 1;
}

/** The suggestion's owner, for the "is this yours" check on user feedback. */
export async function suggestionOwnerPg(db: Queryable, id: string): Promise<string | undefined> {
  const r = await db.query("SELECT user_id FROM elena_suggestion WHERE id = $1::uuid", [id]);
  const u = r.rows[0]?.["user_id"];
  return u ? String(u) : undefined;
}

const DRAFT_FEATURE = "CASE WHEN d.engine_id = 'elena-coach-rules' THEN 'negotiation_coach' WHEN d.kind = 'enquiry_reply' THEN 'enquiry_reply' ELSE 'offer_response' END";

/** Called when an AI draft is saved: the draft becomes a learning suggestion with the same id. Never blocks the draft if it fails. */
export async function captureDraftCreated(db: Queryable, draftId: string, nowIso: string): Promise<void> {
  try {
    const who = await db.query("SELECT created_by FROM ai_draft WHERE id = $1::uuid", [draftId]);
    const userId = who.rows[0] ? String(who.rows[0]["created_by"]) : undefined;
    const consent = userId ? await trainingConsentPg(db, userId, nowIso) : false;
    await db.query(
      `INSERT INTO elena_suggestion (id, feature, suggestion_type, suggestion_text, user_id, user_role, region, listing_id, offer_id, consent_for_training, source)
       SELECT d.id, ${DRAFT_FEATURE}, COALESCE(d.action, d.intent, 'other'), CASE WHEN $2 THEN left(d.text, 5000) END, d.created_by, u.user_type, l.jurisdiction, d.listing_id, d.offer_id, $2, 'ai_draft'
       FROM ai_draft d JOIN app_user u ON u.id = d.created_by JOIN property_listing l ON l.id = d.listing_id WHERE d.id = $1::uuid ON CONFLICT (id) DO NOTHING`,
      [draftId, consent]
    );
  } catch { /* learning capture must never block the draft */ }
}

/** Called when an AI draft is finished: sent, edited and sent, or discarded becomes the automatic reaction. */
export async function captureDraftFinished(db: Queryable, draftId: string): Promise<void> {
  try {
    await db.query(
      `INSERT INTO elena_feedback (suggestion_id, action, response_seconds, source)
       SELECT d.id, CASE d.status WHEN 'sent' THEN 'accepted' WHEN 'edited_sent' THEN 'modified' ELSE 'rejected' END,
         GREATEST(0, EXTRACT(EPOCH FROM (d.finished_at - d.created_at)))::int, 'auto'
       FROM ai_draft d WHERE d.id = $1::uuid AND d.status IN ('sent','edited_sent','discarded') AND EXISTS (SELECT 1 FROM elena_suggestion WHERE id = d.id)
       ON CONFLICT DO NOTHING`,
      [draftId]
    );
  } catch { /* same */ }
}

/** Fills settlement_outcomes from the settlement timeline and agreed fall-throughs. Idempotent. */
export async function syncSettlementOutcomesPg(db: Queryable): Promise<number> {
  const r = await db.query(
    `INSERT INTO settlement_outcomes (settlement_id, outcome, time_to_settlement_days, final_price_cents, negotiation_count, source)
     SELECT s.id, CASE WHEN s.completed_at IS NOT NULL THEN 'settled' ELSE 'fell_through' END,
       CASE WHEN s.completed_at IS NOT NULL THEN GREATEST(0, EXTRACT(DAY FROM (s.completed_at - s.created_at)))::int END,
       o.price_cents, (SELECT count(*)::int FROM formal_offer x WHERE x.listing_id = s.listing_id AND x.buyer_user_id = s.buyer_id), 'auto'
     FROM settlement_timeline s JOIN formal_offer o ON o.id = s.offer_id
     WHERE (s.completed_at IS NOT NULL OR EXISTS (SELECT 1 FROM sale_fall_through f WHERE f.offer_id = s.offer_id AND f.status = 'agreed'))
     ON CONFLICT (settlement_id) DO NOTHING RETURNING id`
  );
  return r.rows.length;
}

export interface ManualOutcome { settlementId: string; outcome: "settled" | "fell_through"; timeToSettlementDays?: number; finalPriceCents?: number; negotiationCount?: number; userSatisfaction?: number; recordedBy: string }

/** Staff entry for what is not captured automatically. An existing automatic row is completed, never overwritten with blanks. */
export async function recordManualOutcomePg(db: Queryable, o: ManualOutcome): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO settlement_outcomes (settlement_id, outcome, time_to_settlement_days, final_price_cents, negotiation_count, user_satisfaction, source, recorded_by)
     SELECT $1::uuid,$2,$3,$4,$5,$6,'staff',$7::uuid WHERE EXISTS (SELECT 1 FROM settlement_timeline WHERE id = $1::uuid)
     ON CONFLICT (settlement_id) DO UPDATE SET
       time_to_settlement_days = COALESCE(EXCLUDED.time_to_settlement_days, settlement_outcomes.time_to_settlement_days),
       final_price_cents = COALESCE(EXCLUDED.final_price_cents, settlement_outcomes.final_price_cents),
       negotiation_count = COALESCE(EXCLUDED.negotiation_count, settlement_outcomes.negotiation_count),
       user_satisfaction = COALESCE(EXCLUDED.user_satisfaction, settlement_outcomes.user_satisfaction),
       recorded_by = EXCLUDED.recorded_by
     RETURNING id`,
    [o.settlementId, o.outcome, o.timeToSettlementDays ?? null, o.finalPriceCents ?? null, o.negotiationCount ?? null, o.userSatisfaction ?? null, o.recordedBy]
  );
  return r.rows.length === 1;
}

export async function loadFactsPg(db: Queryable, sinceIso: string, userId?: string): Promise<SuggestionFact[]> {
  const r = await db.query(
    `SELECT s.id, s.feature, s.suggestion_type, s.user_role, s.region, s.user_id, s.consent_for_training, s.arm, s.experiment_key, s.context, s.created_at,
            f.action, f.helpful, f.rating, f.response_seconds, so.outcome
     FROM elena_suggestion s
     LEFT JOIN LATERAL (SELECT action, helpful, rating, response_seconds FROM elena_feedback WHERE suggestion_id = s.id ORDER BY (source = 'user') DESC, created_at DESC, id DESC LIMIT 1) f ON true
     LEFT JOIN settlement_timeline st ON st.offer_id = s.offer_id
     LEFT JOIN settlement_outcomes so ON so.settlement_id = st.id
     WHERE s.created_at >= $1::timestamptz AND ($2::uuid IS NULL OR s.user_id = $2::uuid)`,
    [sinceIso, userId ?? null]
  );
  return r.rows.map(x => ({
    id: String(x["id"]), feature: x["feature"] as Feature, type: String(x["suggestion_type"]), userRole: String(x["user_role"]),
    region: x["region"] ? String(x["region"]).trim() : undefined, userId: x["user_id"] ? String(x["user_id"]) : undefined,
    consent: x["consent_for_training"] === true, arm: x["arm"] ? String(x["arm"]) : undefined, experimentKey: x["experiment_key"] ? String(x["experiment_key"]) : undefined,
    context: (x["context"] ?? {}) as SuggestionFact["context"], createdAt: iso(x["created_at"]),
    action: (x["action"] ?? undefined) as FeedbackAction | undefined, helpful: (x["helpful"] ?? undefined) as SuggestionFact["helpful"],
    rating: x["rating"] === null || x["rating"] === undefined ? undefined : Number(x["rating"]),
    responseSeconds: x["response_seconds"] === null || x["response_seconds"] === undefined ? undefined : Number(x["response_seconds"]),
    dealOutcome: (x["outcome"] ?? undefined) as SuggestionFact["dealOutcome"]
  }));
}

export async function loadOutcomesPg(db: Queryable): Promise<Outcome[]> {
  const r = await db.query("SELECT outcome, time_to_settlement_days, negotiation_count, user_satisfaction FROM settlement_outcomes");
  return r.rows.map(x => ({
    outcome: x["outcome"] as Outcome["outcome"],
    timeToSettlementDays: x["time_to_settlement_days"] === null ? undefined : Number(x["time_to_settlement_days"]),
    negotiationCount: x["negotiation_count"] === null ? undefined : Number(x["negotiation_count"]),
    satisfaction: x["user_satisfaction"] === null ? undefined : Number(x["user_satisfaction"])
  }));
}

export const DAY_MS = 86_400_000;

/** Weekly job: refresh each consenting person's pattern from their last 180 days. Returns how many patterns were written. */
export async function refreshUserPatternsPg(db: Queryable, now: Date): Promise<number> {
  const facts = await loadFactsPg(db, new Date(now.getTime() - 180 * DAY_MS).toISOString());
  const by = new Map<string, SuggestionFact[]>();
  for (const f of facts) if (f.userId && f.consent) by.set(f.userId, [...(by.get(f.userId) ?? []), f]);
  let n = 0;
  for (const [userId, xs] of by) {
    const p = buildUserPattern(xs);
    if (p.style === "unknown") continue;
    await db.query(
      `INSERT INTO user_patterns (user_id, profile_data, sample_size, updated_at) VALUES ($1::uuid,$2::jsonb,$3,$4::timestamptz)
       ON CONFLICT (user_id) DO UPDATE SET profile_data = EXCLUDED.profile_data, sample_size = EXCLUDED.sample_size, updated_at = EXCLUDED.updated_at`,
      [userId, JSON.stringify(p), p.sampleSize, now.toISOString()]
    );
    n++;
  }
  return n;
}

export async function getUserPatternPg(db: Queryable, userId: string): Promise<Record<string, unknown> | undefined> {
  const r = await db.query("SELECT profile_data FROM user_patterns WHERE user_id = $1::uuid", [userId]);
  return r.rows[0] ? (r.rows[0]["profile_data"] as Record<string, unknown>) : undefined;
}

/** Monthly job: learn from the last 180 days and store a PROPOSED config. Nothing is activated here. Returns undefined when there is not enough data. */
export async function proposeMonthlyConfigPg(db: Queryable, now: Date): Promise<{ version: number; sample: number } | undefined> {
  const facts = await loadFactsPg(db, new Date(now.getTime() - 180 * DAY_MS).toISOString());
  const p = proposeConfig(facts);
  if (!p.enough) return undefined;
  const r = await db.query(
    `INSERT INTO elena_learned_config (version, config, evidence) SELECT COALESCE(max(version), 0) + 1, $1::jsonb, $2::jsonb FROM elena_learned_config RETURNING version`,
    [JSON.stringify(p.config), JSON.stringify({ sample: p.sample, notes: p.notes, at: now.toISOString() })]
  );
  return { version: Number(r.rows[0]!["version"]), sample: p.sample };
}

export async function activeConfigPg(db: Queryable): Promise<LearnedConfig | undefined> {
  const r = await db.query("SELECT config FROM elena_learned_config WHERE status = 'active'");
  return r.rows[0] ? (r.rows[0]["config"] as LearnedConfig) : undefined;
}

/** Super admin activates a proposed version; the previous active one is retired in the same statement. */
export async function activateConfigPg(db: Queryable, version: number, by: string, nowIso: string): Promise<boolean> {
  const run = async (q: Queryable) => {
    const exists = await q.query("SELECT 1 FROM elena_learned_config WHERE version = $1 AND status = 'proposed'", [version]);
    if (exists.rows.length === 0) return false;
    await q.query("UPDATE elena_learned_config SET status = 'retired' WHERE status = 'active'");
    await q.query("UPDATE elena_learned_config SET status = 'active', activated_by = $2::uuid, activated_at = $3::timestamptz WHERE version = $1", [version, by, nowIso]);
    return true;
  };
  return db.transaction ? db.transaction(run) : run(db);
}

export async function listConfigsPg(db: Queryable): Promise<{ version: number; status: string; trainedOn: number; notes: string[]; createdAt: string }[]> {
  const r = await db.query("SELECT version, status, config, evidence, created_at FROM elena_learned_config ORDER BY version DESC LIMIT 12");
  return r.rows.map(x => ({
    version: Number(x["version"]), status: String(x["status"]), trainedOn: Number((x["config"] as LearnedConfig).trainedOn),
    notes: ((x["evidence"] as { notes?: string[] }).notes ?? []), createdAt: iso(x["created_at"])
  }));
}

export async function createExperimentPg(db: Queryable, key: string, feature: string, arms: string[], by: string): Promise<boolean> {
  const r = await db.query("INSERT INTO elena_experiment (key, feature, arms, created_by) VALUES ($1,$2,$3::text[],$4::uuid) ON CONFLICT (key) DO NOTHING RETURNING key", [key, feature, arms, by]);
  return r.rows.length === 1;
}

export async function stopExperimentPg(db: Queryable, key: string): Promise<boolean> {
  return (await db.query("UPDATE elena_experiment SET status = 'stopped' WHERE key = $1 AND status = 'running' RETURNING key", [key])).rows.length === 1;
}

/** The arm for this person in a running experiment, or undefined when none runs for the feature. */
export async function armForPg(db: Queryable, feature: Feature, subjectId: string): Promise<{ key: string; arm: string } | undefined> {
  const r = await db.query("SELECT key, arms FROM elena_experiment WHERE feature = $1 AND status = 'running' ORDER BY created_at LIMIT 1", [feature]);
  const row = r.rows[0];
  return row ? { key: String(row["key"]), arm: assignArm(String(row["key"]), subjectId, row["arms"] as string[]) } : undefined;
}

export async function experimentsPg(db: Queryable, facts: readonly SuggestionFact[]) {
  const r = await db.query("SELECT key, feature, arms, status FROM elena_experiment ORDER BY created_at DESC LIMIT 20");
  return r.rows.map(x => {
    const arms = x["arms"] as string[], key = String(x["key"]);
    return { key, feature: String(x["feature"]), status: String(x["status"]), ...experimentResult(facts.filter(f => f.experimentKey === key), arms) };
  });
}

export async function trainingDashboardPg(db: Queryable, now: Date) {
  const facts = await loadFactsPg(db, new Date(now.getTime() - 365 * DAY_MS).toISOString());
  const outcomes = await loadOutcomesPg(db);
  return { facts, outcomes, health: healthOf(facts, outcomes, now.toISOString()) };
}
