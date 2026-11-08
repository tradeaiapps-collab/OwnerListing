import { NextResponse } from "next/server";
import {
  ESTIMATE_UNAVAILABLE, estimatePrice, explainEstimate, PRICE_GUIDANCE_NOTE, PRICE_GUIDANCE_RATE, type Explanation, type PriceEstimate
} from "../../../../../src/domain/price-guidance";
import { windowStart, withinLimit } from "../../../../../src/domain/rate-limit";
import { getAiEngine } from "../../../../../src/server/ai";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { requireListingHandler } from "../../../../../src/server/owner-listing";
import { getComparablesSource, insertPriceEstimatePg, latestPriceEstimatePg } from "../../../../../src/server/price-guidance";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

const DAY_MS = 86_400_000;

async function guidance(req: Request, id: string, explain: boolean) {
  const handler = await requireListingHandler(req, id, "listing.describe");
  if (handler instanceof NextResponse) return handler;
  const db = getDb();
  const deps = getDeps();
  if (explain) {
    const hits = await countHitPg(db, `price-guide:${handler.actor.userId}`, windowStart(new Date().toISOString(), PRICE_GUIDANCE_RATE.windowMs));
    if (!withinLimit(hits, PRICE_GUIDANCE_RATE.perUser)) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  }
  const l = handler.rec.listing;
  const now = deps.now();
  const subject = {
    transactionType: l.transactionType, propertyType: l.propertyType,
    ...(l.suburb !== undefined ? { suburb: l.suburb } : {}), ...(l.postcode !== undefined ? { postcode: l.postcode } : {}),
    ...(l.bedrooms !== undefined ? { bedrooms: l.bedrooms } : {}), ...(l.bathrooms !== undefined ? { bathrooms: l.bathrooms } : {}),
    ...(l.parking !== undefined ? { parking: l.parking } : {})
  };
  const source = getComparablesSource();
  const estimate: PriceEstimate | undefined = estimatePrice(subject, await source.find(subject, now), now);
  if (!estimate) {
    return NextResponse.json({ state: "unavailable", message: ESTIMATE_UNAVAILABLE, note: PRICE_GUIDANCE_NOTE }, { headers: { "cache-control": "no-store" } });
  }
  // Store a row when the numbers change or a day has passed, so the history of what the owner saw is kept without a row per view.
  const last = await latestPriceEstimatePg(db, id);
  const changed = !last || last.lowCents !== estimate.lowCents || last.midCents !== estimate.midCents || last.highCents !== estimate.highCents ||
    Date.parse(now) - Date.parse(last.createdAt) > DAY_MS;
  if (changed) {
    await insertPriceEstimatePg(db, deps.newId(), id, estimate, source.id, now);
    await deps.appendAudit({
      id: deps.newId(), occurredAt: now, actorType: "user", actorId: handler.actor.userId, aggregateType: "listing", aggregateId: id,
      eventType: "listing.price_guidance_estimated", correlationId: deps.newId(),
      payload: { lowCents: estimate.lowCents, midCents: estimate.midCents, highCents: estimate.highCents, confidence: estimate.confidence, source: source.id }
    });
  }
  const explanation: Explanation | { state: "not_requested" } = explain ? await explainEstimate(await getAiEngine(), estimate, l.transactionType) : { state: "not_requested" };
  return NextResponse.json({
    state: "ready",
    lowCents: estimate.lowCents, midCents: estimate.midCents, highCents: estimate.highCents, confidence: estimate.confidence,
    comparables: estimate.comparables.map(c => ({
      suburb: c.suburb, date: c.date, priceCents: c.priceCents, adjustedCents: c.adjustedCents, propertyType: c.propertyType,
      ...(c.bedrooms !== undefined ? { bedrooms: c.bedrooms } : {}), ...(c.bathrooms !== undefined ? { bathrooms: c.bathrooms } : {}),
      ...(c.parking !== undefined ? { parking: c.parking } : {}), ...(c.distanceKm !== undefined ? { distanceKm: c.distanceKm } : {}),
      ...(c.label ? { label: c.label } : {})
    })),
    basis: estimate.basis, modelVersion: estimate.modelVersion, note: PRICE_GUIDANCE_NOTE, explanation
  }, { headers: { "cache-control": "no-store" } });
}

/** Price guidance for the owner or appointed agent (spec 2.4). Rules only, no AI. Everyone else gets 404; never public. */
async function handleGet(req: Request, { params }: Ctx) {
  return guidance(req, (await params).id, false);
}

/** The same guidance plus an optional AI explanation (rate limited). The AI cannot change the numbers. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  return guidance(req, (await params).id, true);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
