import { coachingActive, compareHistory, suggestionsFor, SUGGESTION_TYPES, type CoachFacts, type Comparison, type Suggestion, type SuggestionType } from "../domain/settlement-coach";
import type { Side, Stage } from "../domain/settlement";
import { OPEN_STATUSES_FOR_STRATEGY } from "../domain/negotiation-coach";
import { SIDE_SQL } from "./settlement-db";
import { randomUUID } from "node:crypto";
import { appendAuditPg, type Queryable } from "./db";

// Parameterised SQL only. The side always comes from the database (SIDE_SQL), never from the request.

export type Out<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

interface Loaded { settlementId: string; offerId: string; active: boolean; facts: CoachFacts }

async function load(db: Queryable, userId: string, settlementId: string): Promise<Loaded | undefined> {
  const r = (await db.query(
    `SELECT t.id, t.offer_id, t.current_stage, t.completed_at, o.status AS offer_status, o.price_cents, o.deposit_cents, o.settlement_days, o.conditions,
            o.buyer_user_id, l.price_cents AS asking, l.transaction_type, ${SIDE_SQL} AS side,
            (SELECT (m.target_date - t.created_at::date) FROM settlement_milestones m WHERE m.settlement_id = t.id AND m.stage = 'inspection_completed') AS inspection_days,
            (SELECT count(*) FROM formal_offer x WHERE x.listing_id = o.listing_id AND x.id <> o.id AND x.status = ANY($3::text[])
               AND x.submitted_at BETWEEN o.submitted_at - interval '30 days' AND o.submitted_at + interval '30 days') AS others,
            (SELECT GREATEST(0, (now()::date - l.created_at::date))) AS days_listed,
            EXISTS (SELECT 1 FROM buyer_prequalifications p WHERE p.buyer_id = t.buyer_id AND p.status = 'verified' AND p.expires_at > now()) AS verified,
            (SELECT count(*) FROM formal_offer b WHERE b.buyer_user_id = t.buyer_id AND b.id <> o.id AND b.status IN ('accepted','fallen_through')) AS prior_deals,
            (SELECT count(*) FROM inspection_booking ib WHERE ib.buyer_id = t.buyer_id AND ib.listing_id = t.listing_id) AS inspections
       FROM settlement_timeline t JOIN property_listing l ON l.id = t.listing_id JOIN formal_offer o ON o.id = t.offer_id
      WHERE t.id = $2::uuid`,
    [userId, settlementId, [...OPEN_STATUSES_FOR_STRATEGY]]
  )).rows[0];
  if (!r || !r["side"]) return undefined;
  const conditions = Array.isArray(r["conditions"]) ? (r["conditions"] as unknown[]).map(String) : [];
  const days = r["inspection_days"] == null ? null : Number(r["inspection_days"]);
  const stage = String(r["current_stage"]) as Stage;
  const finance = conditions.some(c => /\bfinance\b/i.test(c));
  return {
    settlementId: String(r["id"]), offerId: String(r["offer_id"]),
    active: coachingActive(stage, r["completed_at"] != null, r["offer_status"] === "fallen_through"),
    facts: {
      side: String(r["side"]) as Side, currentStage: stage,
      offer: { priceCents: Number(r["price_cents"]), depositCents: Number(r["deposit_cents"]), settlementDays: Number(r["settlement_days"]), conditions },
      askingPriceCents: r["asking"] == null ? null : Number(r["asking"]), transactionType: r["transaction_type"] === "rent" ? "rent" : "sale",
      inspectionTargetDays: days,
      buyer: { financed: finance, verifiedPrequal: r["verified"] === true, firstTime: Number(r["prior_deals"]) === 0, inspectionsBooked: Number(r["inspections"]) },
      seller: { otherOffers: Number(r["others"]), daysOnMarket: r["days_listed"] == null ? null : Number(r["days_listed"]) }
    }
  };
}

export interface CoachingView {
  active: boolean; side: Side; comparison: Comparison | null;
  suggestions: (Suggestion & { decision: "used" | "dismissed" | null })[];
}

/** Settled deals (terms in days, days from acceptance to settlement) used for "similar offers took X days". No ids leave this function. */
async function settledHistory(db: Queryable): Promise<{ terms: number; days: number }[]> {
  const rows = (await db.query(
    `SELECT o.settlement_days AS terms, (t.completed_at::date - t.created_at::date) AS days
       FROM settlement_timeline t JOIN formal_offer o ON o.id = t.offer_id WHERE t.completed_at IS NOT NULL ORDER BY t.completed_at DESC LIMIT 500`
  )).rows;
  return rows.map(x => ({ terms: Number(x["terms"]), days: Number(x["days"]) }));
}

/**
 * Elena's suggestions for the caller's side of one settlement. Records that each was shown (once per offer, suggestion and side).
 * Buyers see buyer-audience suggestions; the owner and agent see seller-audience ones. Nothing is sent or changed.
 */
export async function coachingView(db: Queryable, userId: string, settlementId: string): Promise<Out<CoachingView>> {
  const l = await load(db, userId, settlementId);
  if (!l) return no(404, "Settlement not found.");
  if (!l.active) return { ok: true, value: { active: false, side: l.facts.side, comparison: null, suggestions: [] } };
  const list = suggestionsFor(l.facts);
  const side = l.facts.side;
  for (const s of list) {
    await db.query(
      "INSERT INTO negotiation_coaching_offers (offer_id, settlement_id, suggestion_type, side) VALUES ($1::uuid,$2::uuid,$3,$4) ON CONFLICT (offer_id, suggestion_type, side) DO NOTHING",
      [l.offerId, l.settlementId, s.type, side]
    );
  }
  const decided = new Map((await db.query("SELECT suggestion_type, accepted FROM negotiation_coaching_offers WHERE offer_id = $1::uuid AND side = $2 AND accepted IS NOT NULL", [l.offerId, side])).rows
    .map(x => [String(x["suggestion_type"]), x["accepted"] === true] as const));
  const comparison = compareHistory(l.facts.offer.settlementDays, await settledHistory(db));
  return { ok: true, value: { active: true, side, comparison, suggestions: list.map(s => ({ ...s, decision: decided.has(s.type) ? (decided.get(s.type) ? "used" : "dismissed") : null })) } };
}

/** Records that the caller used or dismissed a suggestion that was shown to them. Decided once; the template is returned for them to copy. */
export async function decideSuggestion(db: Queryable, userId: string, settlementId: string, type: SuggestionType, used: boolean): Promise<Out<{ decision: "used" | "dismissed"; template: string | null }>> {
  const l = await load(db, userId, settlementId);
  if (!l) return no(404, "Settlement not found.");
  if (!l.active) return no(409, "Coaching has ended for this sale.");
  const s = suggestionsFor(l.facts).find(x => x.type === type);
  if (!s) return no(404, "That suggestion does not apply any more.");
  const done = await db.query(
    "UPDATE negotiation_coaching_offers SET accepted = $5, decided_by = $1::uuid, decided_at = now() WHERE offer_id = $2::uuid AND suggestion_type = $3 AND side = $4 AND accepted IS NULL RETURNING id",
    [userId, l.offerId, type, l.facts.side, used]
  );
  if (!done.rows.length) {
    const seen = await db.query("SELECT accepted FROM negotiation_coaching_offers WHERE offer_id = $1::uuid AND suggestion_type = $2 AND side = $3", [l.offerId, type, l.facts.side]);
    if (!seen.rows.length) return no(409, "Open the coaching panel first so the suggestion is recorded.");
    return no(409, "You have already answered this suggestion.");
  }
  await appendAuditPg(db, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: userId, aggregateType: "settlement", aggregateId: settlementId,
    eventType: "settlement.coaching_decided", correlationId: randomUUID(), payload: { suggestion: type, used }
  });
  return { ok: true, value: { decision: used ? "used" : "dismissed", template: used ? s.template : null } };
}

/** Fills in the outcome of every coaching row whose deal has ended: settled, or fallen through. Safe to run any time. */
export async function syncOutcomesPg(db: Queryable): Promise<number> {
  const r = await db.query(
    `UPDATE negotiation_coaching_offers c SET
       outcome = CASE WHEN t.completed_at IS NOT NULL THEN 'settled' ELSE 'fell_through' END,
       outcome_at = COALESCE(t.completed_at, now()),
       days_to_settle = CASE WHEN t.completed_at IS NOT NULL THEN (t.completed_at::date - t.created_at::date) END
     FROM settlement_timeline t JOIN formal_offer o ON o.id = t.offer_id
     WHERE c.settlement_id = t.id AND c.outcome IS NULL AND (t.completed_at IS NOT NULL OR o.status = 'fallen_through') RETURNING c.id`
  );
  return r.rows.length;
}

export interface CoachingStats {
  byType: { type: SuggestionType; shown: number; used: number; dismissed: number; settled: number; fellThrough: number }[];
  coached: { deals: number; settled: number; fellThrough: number; avgDaysToSettle: number | null };
  uncoached: { deals: number; settled: number; fellThrough: number; avgDaysToSettle: number | null };
}

/** Effectiveness for staff. "Coached" = at least one suggestion was used on the deal. Only counts: no names, no listings. */
export async function coachingStatsPg(db: Queryable): Promise<CoachingStats> {
  await syncOutcomesPg(db);
  const t = (await db.query(
    `SELECT suggestion_type, count(*) AS shown, count(*) FILTER (WHERE accepted IS TRUE) AS used, count(*) FILTER (WHERE accepted IS FALSE) AS dismissed,
            count(*) FILTER (WHERE outcome = 'settled') AS settled, count(*) FILTER (WHERE outcome = 'fell_through') AS fell
       FROM negotiation_coaching_offers GROUP BY suggestion_type`
  )).rows;
  const byType = SUGGESTION_TYPES.map(type => {
    const r = t.find(x => x["suggestion_type"] === type);
    return { type, shown: Number(r?.["shown"] ?? 0), used: Number(r?.["used"] ?? 0), dismissed: Number(r?.["dismissed"] ?? 0), settled: Number(r?.["settled"] ?? 0), fellThrough: Number(r?.["fell"] ?? 0) };
  }).filter(x => x.shown > 0);
  const d = (await db.query(
    `SELECT EXISTS (SELECT 1 FROM negotiation_coaching_offers c WHERE c.settlement_id = t.id AND c.accepted IS TRUE) AS coached,
            count(*) AS deals, count(*) FILTER (WHERE t.completed_at IS NOT NULL) AS settled,
            count(*) FILTER (WHERE t.completed_at IS NULL) AS fell,
            avg(t.completed_at::date - t.created_at::date) FILTER (WHERE t.completed_at IS NOT NULL) AS avg_days
       FROM settlement_timeline t JOIN formal_offer o ON o.id = t.offer_id
      WHERE (t.completed_at IS NOT NULL OR o.status = 'fallen_through')
        AND EXISTS (SELECT 1 FROM negotiation_coaching_offers c2 WHERE c2.settlement_id = t.id)
      GROUP BY 1`
  )).rows;
  const pick = (coached: boolean) => {
    const r = d.find(x => x["coached"] === coached);
    return { deals: Number(r?.["deals"] ?? 0), settled: Number(r?.["settled"] ?? 0), fellThrough: Number(r?.["fell"] ?? 0), avgDaysToSettle: r?.["avg_days"] == null ? null : Math.round(Number(r["avg_days"]) * 10) / 10 };
  };
  return { byType, coached: pick(true), uncoached: pick(false) };
}
