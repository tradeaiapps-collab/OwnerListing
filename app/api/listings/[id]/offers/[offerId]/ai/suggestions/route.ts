import { NextResponse } from "next/server";
import { stripFooter } from "../../../../../../../../src/domain/ai-pipeline";
import { isUuid } from "../../../../../../../../src/domain/offer-decision";
import { AI_OFFER_RATE, offerSuggestions } from "../../../../../../../../src/domain/offer-suggestions";
import { windowStart, withinLimit } from "../../../../../../../../src/domain/rate-limit";
import { getAiEngine } from "../../../../../../../../src/server/ai";
import { createPgAiDraftRepository } from "../../../../../../../../src/server/ai-records-db";
import { getDb, getDeps } from "../../../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../../../src/server/csrf";
import { failure } from "../../../../../../../../src/server/http";
import { countHitPg } from "../../../../../../../../src/server/offer-flow-db";
import { offersForOwnerPg } from "../../../../../../../../src/server/offers-db";
import { enquiryForOfferPg, sameBuyerOffersPg } from "../../../../../../../../src/server/offer-suggestions-db";
import { requireListingHandler } from "../../../../../../../../src/server/owner-listing";
import { getWordingFilter } from "../../../../../../../../src/server/wording-filter";

type Ctx = { params: Promise<{ id: string; offerId: string }> };

const notFound = { ok: false, code: "not_found", message: "Offer not found." } as const;

/**
 * Analysis and AI drafts for one offer, for the owner or the appointed agent (spec 2.4). Returns the analysis (worked out by rules),
 * a suggested counter where one applies, and up to 3 drafts: counter, request information, decline. Never an accept draft.
 * AI off = the same analysis with "drafts": [] and "aiAvailable": false. Drafts are stored (ai_draft) and sent with
 * POST /api/ai/drafts/[draftId]/send into the buyer's conversation, when the buyer has one.
 */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { id, offerId } = await params;
  if (!isUuid(offerId)) return failure(notFound);
  const handler = await requireListingHandler(req, id);
  if (handler instanceof NextResponse) return handler;
  const db = getDb();
  const deps = getDeps();
  const offers = await offersForOwnerPg(db, id, handler.rec.listing.ownerUserId);
  const offer = offers.find(o => o.id === offerId);
  if (!offer) return failure(notFound);
  const hits = await countHitPg(db, `ai-offer:${handler.actor.userId}`, windowStart(new Date().toISOString(), AI_OFFER_RATE.windowMs));
  if (!withinLimit(hits, AI_OFFER_RATE.perUser)) return NextResponse.json({ error: "Too many AI suggestions. Try again later." }, { status: 429 });

  const history = await sameBuyerOffersPg(db, id, offerId);
  const l = handler.rec.listing;
  const enquiryId = await enquiryForOfferPg(db, id, offerId);
  const now = deps.now();
  // The negotiation mandate (spec 019) and stored price guidance plug in here when those tables exist; until then both are absent
  // and the analysis says every response needs the owner's approval.
  const result = await offerSuggestions({ engine: await getAiEngine(), wordingFilter: getWordingFilter() }, {
    offer, allOffers: offers, buyerHistory: history, counterRound: history.filter(h => h.status === "countered").length,
    listing: { transactionType: l.transactionType, ...(l.priceCents !== undefined ? { askingPriceCents: l.priceCents } : {}) }
  }, { listingId: id, ...(enquiryId ? { enquiryId } : {}), requestedBy: handler.actor.userId, now, newId: deps.newId });

  const repo = createPgAiDraftRepository(db);
  for (const d of result.drafts) await repo.insert(d.record);
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: handler.actor.userId, aggregateType: "formal_offer", aggregateId: offerId,
    eventType: "offer.ai_suggestions_requested", correlationId: deps.newId(),
    payload: { listingId: id, aiAvailable: result.aiAvailable, drafts: result.drafts.map(d => ({ id: d.record.id, action: d.action, status: d.record.status })), handoff: result.analysis.handoff }
  });
  return NextResponse.json({
    analysis: result.analysis,
    aiAvailable: result.aiAvailable,
    canSendInThread: enquiryId !== undefined,
    drafts: result.drafts.map(d => ({ id: d.record.id, action: d.action, text: stripFooter(d.record.text), status: d.record.status, violations: d.violations }))
  }, { headers: { "cache-control": "no-store" } });
}
