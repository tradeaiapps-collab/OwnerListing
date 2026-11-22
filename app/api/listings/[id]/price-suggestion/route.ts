import { NextResponse } from "next/server";
import { withApi } from "../../../../../src/server/api/with-api";
import { getDb, getDeps } from "../../../../../src/server/context";
import { requireListingHandler } from "../../../../../src/server/owner-listing";
import { suggestPrice } from "../../../../../src/server/price-suggestion";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Elena's asking-price suggestion (range, confidence, evidence, limits) for the owner or appointed agent. Rules over data we hold; no AI
 * writes a number. Read-only: it never changes the listing price. Everyone else gets 404; never public. Each view is logged for audit.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  const handler = await requireListingHandler(req, id, "listing.describe");
  if (handler instanceof NextResponse) return handler;
  const deps = getDeps();
  const l = handler.rec.listing;
  const now = deps.now();
  const result = await suggestPrice(getDb(), id, l.jurisdiction, {
    transactionType: l.transactionType, propertyType: l.propertyType,
    ...(l.suburb !== undefined ? { suburb: l.suburb } : {}), ...(l.postcode !== undefined ? { postcode: l.postcode } : {}),
    ...(l.bedrooms !== undefined ? { bedrooms: l.bedrooms } : {}), ...(l.bathrooms !== undefined ? { bathrooms: l.bathrooms } : {}),
    ...(l.parking !== undefined ? { parking: l.parking } : {}), ...(l.priceCents !== undefined ? { currentPriceCents: l.priceCents } : {}),
    ...(l.amenities?.length ? { amenities: l.amenities } : {})
  }, now);
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: handler.actor.userId, aggregateType: "listing", aggregateId: id,
    eventType: "listing.price_suggestion_shown", correlationId: deps.newId(),
    payload: result.state === "ready"
      ? { state: "ready", basis: result.basis, confidence: result.confidence, lowCents: result.lowCents, highCents: result.highCents, evidence: result.evidence.length, model: result.modelVersion }
      : { state: "insufficient", model: result.modelVersion }
  }).catch(() => undefined);
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
