import { NextResponse } from "next/server";
import { isUuid } from "../domain/offer-decision";
import { parseFallThrough, type Party } from "../domain/sale-fall-through";
import { getActor, getDb } from "./context";
import { csrfGuard } from "./csrf";
import { fallThroughView, previewFallThrough, raiseFallThrough, respondFallThrough, withdrawFallThrough } from "./sale-fall-through-db";
import { unauthenticated } from "./http";
import { requireRecentMfa } from "./mfa-context";

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });
const NO_STORE = { "cache-control": "no-store" };

/**
 * Shared by the buyer route (/api/offers/[offerId]/fall-through) and the owner route (/api/listings/[id]/offers/[offerId]/fall-through).
 * The caller's side is worked out in the database from the offer (its buyer, or its listing's owner); `expected` is the side the route
 * is for, and anyone else gets 404. Agreeing to an outcome that moves money needs a recent second-factor check, like accepting an offer.
 */
export async function fallThroughGet(req: Request, offerId: string, expected: Party) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!isUuid(offerId)) return fail(404, "Offer not found.");
  const r = await fallThroughView(getDb(), actor.userId, expected, offerId);
  return r.ok ? NextResponse.json(r.value, { headers: NO_STORE }) : fail(r.status, r.error);
}

export async function fallThroughPost(req: Request, offerId: string, expected: Party) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!isUuid(offerId)) return fail(404, "Offer not found.");
  const body = await req.json().catch(() => null);
  const input = parseFallThrough(body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null);
  if (!input.ok) return fail(400, input.error);
  const a = input.value, db = getDb();
  switch (a.action) {
    case "preview": {
      const r = await previewFallThrough(db, actor.userId, expected, offerId, a.reason);
      return r.ok ? NextResponse.json(r.value, { headers: NO_STORE }) : fail(r.status, r.error);
    }
    case "raise": {
      const r = await raiseFallThrough(db, actor.userId, expected, offerId, a.reason, a.note);
      return r.ok ? NextResponse.json(r.value, { status: 201 }) : fail(r.status, r.error);
    }
    case "respond": {
      if (a.decision === "agree") {
        const stale = await requireRecentMfa(req);
        if (stale) return stale;
      }
      const r = await respondFallThrough(db, actor.userId, expected, offerId, a.decision, a.note);
      return r.ok ? NextResponse.json(r.value) : fail(r.status, r.error);
    }
    case "withdraw": {
      const r = await withdrawFallThrough(db, actor.userId, expected, offerId);
      return r.ok ? NextResponse.json(r.value) : fail(r.status, r.error);
    }
  }
}
