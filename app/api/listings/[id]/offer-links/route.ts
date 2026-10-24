import { NextResponse } from "next/server";
import { forbiddenFor } from "../../../../../src/domain/access";
import { createOfferLink, hashToken } from "../../../../../src/domain/offer-intake";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getActor, getDb, getDeps } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { OFFER_LINK_ISSUE_RATE, windowStart, withinLimit } from "../../../../../src/domain/rate-limit";
import { countHitPg, eligibleBuyerPg, issueOfferLinkPg } from "../../../../../src/server/offer-flow-db";

type Ctx = { params: Promise<{ id: string }> };

const notFound = { ok: false, code: "not_found", message: "Listing not found." } as const;
const notEligible = { ok: false, code: "invalid", message: "An offer link could not be created for that buyer." } as const;

/**
 * The listing's owner issues a single-use offer link for one verified buyer. The owner id comes from the session only.
 * Only the token hash is stored; the raw token is returned once and cannot be read back.
 */
export async function POST(req: Request, { params }: Ctx) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "offer.approve");
  if (denied) return failure(denied);
  const { id } = await params;
  const deps = getDeps();
  const rec = await deps.repo.get(id);
  if (!rec || rec.listing.ownerUserId !== actor.userId || rec.listing.status !== "published") return failure(notFound);

  const body: unknown = await req.json().catch(() => null);
  const buyerUserId = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["buyerUserId"] : undefined;
  if (!isUuid(buyerUserId)) return failure(notEligible);

  const db = getDb();
  const now = deps.now();
  // Per-owner cap on issuing links, counted before the eligibility lookup so it also limits probing. Fails closed.
  try {
    const hits = await countHitPg(db, await hashToken(`issue:${actor.userId}`), windowStart(now, OFFER_LINK_ISSUE_RATE.windowMs));
    if (!withinLimit(hits, OFFER_LINK_ISSUE_RATE.perOwner)) {
      return NextResponse.json({ error: "Too many offer links requested. Try again later." }, { status: 429, headers: { "Retry-After": "600" } });
    }
  } catch {
    return NextResponse.json({ error: "Offer links are unavailable right now. Try again later." }, { status: 503 });
  }
  if (!(await eligibleBuyerPg(db, buyerUserId, actor.userId))) return failure(notEligible);

  const { token, record } = await createOfferLink(id, buyerUserId, now);
  await issueOfferLinkPg(db, record, now);
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "offer_link", aggregateId: record.tokenHash, eventType: "offer_link.issued",
    correlationId: deps.newId(), payload: { listingId: id, expiresAt: record.expiresAt }
  });
  return NextResponse.json({ token, expiresAt: record.expiresAt }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
