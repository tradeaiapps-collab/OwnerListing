import { NextResponse } from "next/server";
import { updateLayout } from "../../../../../../src/domain/photo-service";
import { hashToken } from "../../../../../../src/domain/offer-intake";
import { PHOTO_LAYOUT_RATE, windowStart, withinLimit } from "../../../../../../src/domain/rate-limit";
import { getActor, getDb, getDeps } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { countHitPg } from "../../../../../../src/server/offer-flow-db";
import { UUID } from "../../../../../../src/server/photo-route";
import { createPgPhotoStore } from "../../../../../../src/server/photos-db";
import { requireCurrentTerms } from "../../../../../../src/server/terms-guard";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Owner only. Saves the whole gallery: { version, entries: [{ photoId, caption, alt, hidden }], tourUrl }.
 * The first visible photo is the cover. Leaving a photo out removes it, allowed only before the listing was ever published;
 * after that photos can only be hidden or replaced. Each save is a new history row; nothing is overwritten.
 */
export async function PUT(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const deps = getDeps();
  const noTerms = await requireCurrentTerms(deps.termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  try {
    const hits = await countHitPg(getDb(), await hashToken(`photo-layout:${actor.userId}`), windowStart(deps.now(), PHOTO_LAYOUT_RATE.windowMs));
    if (!withinLimit(hits, PHOTO_LAYOUT_RATE.perUser)) {
      return NextResponse.json({ error: "Too many changes. Try again in a few minutes." }, { status: 429, headers: { "Retry-After": "600" } });
    }
  } catch {
    return NextResponse.json({ error: "Saving is unavailable right now. Try again later." }, { status: 503 });
  }
  const body = await req.json().catch(() => null);
  const r = await updateLayout(deps, createPgPhotoStore(getDb()), actor, id, body);
  return r.ok ? NextResponse.json({ version: r.value.version }) : failure(r);
}
