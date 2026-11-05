import { NextResponse } from "next/server";
import { coach, parseOfferText, redFlagsFor } from "../../../../../../src/domain/negotiation-coach";
import { windowStart, withinLimit } from "../../../../../../src/domain/rate-limit";
import { getDb, getDeps } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { currentModelPg } from "../../../../../../src/server/negotiation-coach-db";
import { openMandatePg } from "../../../../../../src/server/negotiation-coach-service";
import { countHitPg } from "../../../../../../src/server/offer-flow-db";
import { offersForOwnerPg } from "../../../../../../src/server/offers-db";
import { requireListingHandler } from "../../../../../../src/server/owner-listing";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const RATE = { windowMs: 60 * 60 * 1000, perUser: 60 } as const;

/**
 * Reads an offer the seller pasted in (an email or text message, not yet a formal offer) and coaches on it the same way.
 * Body: { "text": string (up to 4000 characters) }. Nothing is stored and nothing is sent. If the price cannot be read the
 * response says what is missing instead of guessing.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { id } = await params;
  const handler = await requireListingHandler(req, id, "offers.view");
  if (handler instanceof NextResponse) return handler;
  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  if (typeof body.text !== "string" || body.text.trim().length < 5 || body.text.length > 4000) {
    return NextResponse.json({ error: "Paste the offer text (5 to 4000 characters)." }, { status: 400 });
  }
  const db = getDb();
  const hits = await countHitPg(db, `coach:${handler.actor.userId}`, windowStart(new Date().toISOString(), RATE.windowMs));
  if (!withinLimit(hits, RATE.perUser)) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });

  const l = handler.rec.listing;
  const listing = { transactionType: l.transactionType, ...(l.priceCents !== undefined ? { askingPriceCents: l.priceCents } : {}) };
  const parsed = parseOfferText(body.text, listing.askingPriceCents !== undefined ? { askingPriceCents: listing.askingPriceCents } : {});
  if (parsed.priceCents === undefined) return NextResponse.json({ parsed, coach: null }, { headers: { "cache-control": "no-store" } });

  const now = getDeps().now();
  const offers = await offersForOwnerPg(db, id, l.ownerUserId);
  const depositCents = parsed.depositCents ?? 0;
  const offer = { id: "pasted", priceCents: parsed.priceCents, depositCents, settlementDays: parsed.settlementDays ?? 42, conditions: parsed.conditions, status: "submitted", submittedAt: now };
  const mandate = await openMandatePg(db, id);
  const result = coach({ offer, allOffers: [...offers, offer], buyerHistory: [], counterRound: 0, listing, ...(mandate ? { mandate } : {}) }, await currentModelPg(db));
  const extra = redFlagsFor({ offer, allOffers: [offer], buyerHistory: [], counterRound: 0, listing }, [parsed.priceCents], parsed.pressure);
  return NextResponse.json({ parsed, assumed: { settlementDays: parsed.settlementDays === undefined, deposit: parsed.depositCents === undefined }, coach: { ...result, redFlags: extra } }, { headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
