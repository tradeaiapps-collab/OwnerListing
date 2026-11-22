import { NextResponse } from "next/server";
import { compareOffers, type CompareInput } from "../../../../../../src/domain/offer-compare";
import { windowStart, withinLimit } from "../../../../../../src/domain/rate-limit";
import { getDb, getDeps } from "../../../../../../src/server/context";
import { countHitPg } from "../../../../../../src/server/offer-flow-db";
import { expireCountersPg } from "../../../../../../src/server/offer-counter-db";
import { offersForOwnerPg } from "../../../../../../src/server/offers-db";
import { requireListingHandler } from "../../../../../../src/server/owner-listing";
import { prequalsForListing } from "../../../../../../src/server/prequalification-db";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const COMPARE_RATE = { windowMs: 60 * 60 * 1000, perUser: 120 } as const;

/**
 * Side-by-side comparison of the open offers on this listing, for its owner or appointed agent (offers.view). Buyers are "Offer A", "Offer B":
 * no identity, nothing from the negotiation mandate. Elena's reading is rules only and is the same with the AI off. Read-only: it never
 * accepts, rejects, counters or sends anything.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  const handler = await requireListingHandler(req, id, "offers.view");
  if (handler instanceof NextResponse) return handler;
  const db = getDb();
  const deps = getDeps();
  const now = deps.now();
  const hits = await countHitPg(db, `compare:${handler.actor.userId}`, windowStart(now, COMPARE_RATE.windowMs));
  if (!withinLimit(hits, COMPARE_RATE.perUser)) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  await expireCountersPg(db, now, {});
  const l = handler.rec.listing;
  const [offers, prequals] = await Promise.all([offersForOwnerPg(db, id, l.ownerUserId), prequalsForListing(db, id, now)]);
  const pre = new Map(prequals.map(p => [p.offerId, p.prequal]));
  const inputs: CompareInput[] = offers.map(o => {
    const p = pre.get(o.id);
    return {
      id: o.id, priceCents: o.priceCents, depositCents: o.depositCents, settlementDays: o.settlementDays, conditions: o.conditions, status: o.status, submittedAt: o.submittedAt,
      ...(o.openCounter ? { openCounter: { expiresAt: o.openCounter.expiresAt } } : {}),
      ...(p ? { prequal: { state: p.state, label: p.label, ...(p.approvedCents !== undefined ? { approvedCents: p.approvedCents } : {}), ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}) } } : {})
    };
  });
  const result = compareOffers(inputs, l.priceCents);
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: handler.actor.userId, aggregateType: "property_listing", aggregateId: id,
    eventType: "offer.compare_viewed", correlationId: deps.newId(), payload: { offers: result.columns.length, asAgent: handler.asAgent }
  });
  return NextResponse.json({ ...result, listing: { id, address: l.address, transactionType: l.transactionType, ...(l.priceCents !== undefined ? { askingPriceCents: l.priceCents } : {}) } }, { headers: { "cache-control": "private, no-store" } });
}

export const GET = withApi(handleGet);
