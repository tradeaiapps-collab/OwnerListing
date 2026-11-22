import { NextResponse } from "next/server";
import { COUNTER_DRAFT_NOTE, counterDraftFrom } from "../../../../../../../src/domain/offer-compare";
import type { ScenarioKey } from "../../../../../../../src/domain/negotiation-coach";
import { isUuid } from "../../../../../../../src/domain/offer-decision";
import { windowStart, withinLimit } from "../../../../../../../src/domain/rate-limit";
import { getDb, getDeps } from "../../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../../src/server/csrf";
import { failure } from "../../../../../../../src/server/http";
import { currentModelPg } from "../../../../../../../src/server/negotiation-coach-db";
import { coachListingPg, openMandatePg } from "../../../../../../../src/server/negotiation-coach-service";
import { countHitPg } from "../../../../../../../src/server/offer-flow-db";
import { offersForOwnerPg } from "../../../../../../../src/server/offers-db";
import { requireListingHandler } from "../../../../../../../src/server/owner-listing";
import { withApi } from "../../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; offerId: string }> };
const notFound = { ok: false, code: "not_found", message: "Offer not found." } as const;
const DRAFT_RATE = { windowMs: 60 * 60 * 1000, perUser: 30 } as const;
const KEYS: readonly ScenarioKey[] = ["firm", "balanced", "quick"];

/**
 * Elena drafts counter-offer terms for one offer. The owner (or appointed agent) sees them, edits them and presses send on the existing counter
 * form, which is owner-only. Nothing is sent, accepted or rejected here and no message is written to the buyer, so no other buyer's terms can
 * reach this offer's buyer. The floor price is only used server-side to clamp the scenarios and is never returned.
 * Body: { "scenario"?: "firm" | "balanced" | "quick" } (default: the coach's recommended one).
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { id, offerId } = await params;
  if (!isUuid(offerId)) return failure(notFound);
  const handler = await requireListingHandler(req, id, "offers.view");
  if (handler instanceof NextResponse) return handler;
  const body = (await req.json().catch(() => ({}))) as { scenario?: unknown };
  const want = KEYS.find(k => k === body.scenario);
  const db = getDb();
  const deps = getDeps();
  const now = deps.now();
  const hits = await countHitPg(db, `counterdraft:${handler.actor.userId}`, windowStart(now, DRAFT_RATE.windowMs));
  if (!withinLimit(hits, DRAFT_RATE.perUser)) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  const l = handler.rec.listing;
  const offers = await offersForOwnerPg(db, id, l.ownerUserId);
  const listing = { transactionType: l.transactionType, ...(l.priceCents !== undefined ? { askingPriceCents: l.priceCents } : {}) };
  const out = await coachListingPg(db, id, offers, offerId, listing, await currentModelPg(db), await openMandatePg(db, id));
  if (!out) return failure(notFound);
  const { result } = out;
  const chosen = result.scenarios.find(s => s.key === (want ?? result.recommended)) ?? result.scenarios[0];
  const draft = chosen ? counterDraftFrom(chosen) : undefined;
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: handler.actor.userId, aggregateType: "formal_offer", aggregateId: offerId,
    eventType: "offer.counter_drafted", correlationId: deps.newId(), payload: { listingId: id, scenario: draft?.scenario ?? null, asAgent: handler.asAgent }
  });
  const sendNote = handler.asAgent ? "Only the owner can send a counter-offer." : "";
  const alternatives = result.scenarios.map(s => ({ key: s.key, label: s.label }));
  if (!draft) {
    return NextResponse.json({ draft: null, alternatives, summary: result.summary, note: result.scenarios.length === 0 ? "This offer needs your own decision: Elena has no counter to suggest." : "Elena could not draft valid terms for this offer.", sendNote }, { headers: { "cache-control": "private, no-store" } });
  }
  return NextResponse.json({ draft, alternatives, summary: result.summary, note: COUNTER_DRAFT_NOTE, sendNote }, { headers: { "cache-control": "private, no-store" } });
}

export const POST = withApi(handlePost);
