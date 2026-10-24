import { NextResponse } from "next/server";
import { getListing, parseDraftPatch, toPublicListing, updateDraft } from "../../../../src/domain/listing-service";
import { getActor, getDeps } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { csrfGuard } from "../../../../src/server/csrf";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const actor = getActor(req);
  const deps = getDeps();
  const r = await getListing(deps, actor, id);
  if (!r.ok) return failure(r);
  // Ownership is decided here from the signed-in actor and returned as a flag; the owner's id is never sent.
  const isOwner = actor !== null && actor.userId === r.value.ownerUserId;
  const listing = toPublicListing(r.value);
  // The bond pathway is returned to the listing's owner only.
  if (isOwner) {
    const rec = await deps.repo.get(id);
    if (rec?.rentalBondPathway !== undefined) return NextResponse.json({ listing, isOwner, rentalBondPathway: rec.rentalBondPathway });
  }
  return NextResponse.json({ listing, isOwner });
}

/** Edits a draft. Published listings cannot be edited here. */
export async function PATCH(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parseDraftPatch(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  const { id } = await params;
  const r = await updateDraft(getDeps(), actor, id, parsed.value);
  return r.ok ? NextResponse.json({ listing: r.value }) : failure(r);
}
