import { NextResponse } from "next/server";
import { guardDraft } from "../../../../../../../src/domain/ai-output-guard";
import type { AiDraftAction, AiDraftRecord } from "../../../../../../../src/domain/ai-draft-record";
import { inputHash, stripFooter, withFooter } from "../../../../../../../src/domain/ai-pipeline";
import { MODEL_VERSION, templatesFor, type TemplateKind } from "../../../../../../../src/domain/negotiation-coach";
import { isUuid } from "../../../../../../../src/domain/offer-decision";
import { windowStart, withinLimit } from "../../../../../../../src/domain/rate-limit";
import { createPgAiDraftRepository } from "../../../../../../../src/server/ai-records-db";
import { getDb, getDeps } from "../../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../../src/server/csrf";
import { failure } from "../../../../../../../src/server/http";
import { currentModelPg } from "../../../../../../../src/server/negotiation-coach-db";
import { coachListingPg, openMandatePg } from "../../../../../../../src/server/negotiation-coach-service";
import { countHitPg } from "../../../../../../../src/server/offer-flow-db";
import { offersForOwnerPg } from "../../../../../../../src/server/offers-db";
import { enquiryForOfferPg } from "../../../../../../../src/server/offer-suggestions-db";
import { requireListingHandler } from "../../../../../../../src/server/owner-listing";
import { getWordingFilter } from "../../../../../../../src/server/wording-filter";
import { withApi } from "../../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; offerId: string }> };
const notFound = { ok: false, code: "not_found", message: "Offer not found." } as const;
const COACH_RATE = { windowMs: 60 * 60 * 1000, perUser: 60 } as const;
const ACTION: Record<TemplateKind, AiDraftAction> = {
  counter_firm: "recommend_counter", counter_balanced: "recommend_counter", counter_quick: "recommend_counter",
  best_and_final: "draft_reply", request_information: "request_information", decline_politely: "reject", holding_message: "draft_reply"
};

/**
 * Elena's negotiation coach for one offer, for the owner or the appointed agent. Everything is worked out by rules and a small
 * model trained on past outcomes, so it is the same with AI off. Returns the analysis, three counter scenarios with close
 * probabilities, risk, red flags, concession ideas, the multi-party view of the listing, and message templates. Templates are saved
 * as drafts (ai_draft) so they go through the same checks and the same send step as any AI draft. Nothing is sent or accepted here.
 * Body: { "mentionOtherOffers"?: boolean } (default false: the seller has to choose to tell a buyer there are other offers).
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { id, offerId } = await params;
  if (!isUuid(offerId)) return failure(notFound);
  const handler = await requireListingHandler(req, id, "offers.view");
  if (handler instanceof NextResponse) return handler;
  const body = (await req.json().catch(() => ({}))) as { mentionOtherOffers?: unknown };
  const mention = body.mentionOtherOffers === true;
  const db = getDb();
  const deps = getDeps();
  const hits = await countHitPg(db, `coach:${handler.actor.userId}`, windowStart(new Date().toISOString(), COACH_RATE.windowMs));
  if (!withinLimit(hits, COACH_RATE.perUser)) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });

  const offers = await offersForOwnerPg(db, id, handler.rec.listing.ownerUserId);
  const l = handler.rec.listing;
  const listing = { transactionType: l.transactionType, ...(l.priceCents !== undefined ? { askingPriceCents: l.priceCents } : {}) };
  const out = await coachListingPg(db, id, offers, offerId, listing, await currentModelPg(db), await openMandatePg(db, id));
  if (!out) return failure(notFound);
  const { input, result, strategy } = out;

  const now = deps.now();
  const enquiryId = await enquiryForOfferPg(db, id, offerId);
  const rendered = templatesFor(result, listing.transactionType, input.offer.priceCents, listing.askingPriceCents, { mentionOtherOffers: mention, includeBestAndFinal: strategy.bestAndFinalAdvised });
  const repo = createPgAiDraftRepository(db);
  const templates = [];
  for (const t of rendered) {
    const guard = guardDraft(t.text, {
      wordingFilter: getWordingFilter(), allowedAmountsCents: t.allowedAmountsCents,
      ...(input.mandate ? { floorPriceCents: input.mandate.floorPriceCents } : {}), ownerAllowsOtherOffersMention: mention
    });
    const record: AiDraftRecord = {
      id: deps.newId(), kind: "offer_response", listingId: id, offerId, ...(enquiryId ? { enquiryId } : {}), action: ACTION[t.kind],
      text: withFooter(t.text), policyDecision: result.analysis.policy, guardResult: guard, status: guard.ok ? "pending" : "held",
      engineId: "elena-coach-rules", modelVersion: MODEL_VERSION, promptVersion: "negotiation-coach@1", inputHash: inputHash("negotiation-coach@1", t.kind, t.text),
      createdBy: handler.actor.userId, createdAt: now
    };
    await repo.insert(record);
    templates.push({ id: record.id, kind: t.kind, label: t.label, text: stripFooter(record.text), status: record.status, violations: guard.violations });
  }
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: handler.actor.userId, aggregateType: "formal_offer", aggregateId: offerId,
    eventType: "offer.coach_requested", correlationId: deps.newId(),
    payload: { listingId: id, scenarios: result.scenarios.length, recommended: result.recommended ?? null, risk: result.risk.level, model: result.model.source, templates: templates.length }
  });
  return NextResponse.json({ ...result, strategy, canSendInThread: enquiryId !== undefined, templates }, { headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
