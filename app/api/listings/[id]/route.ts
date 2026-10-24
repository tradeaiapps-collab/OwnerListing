import { NextResponse } from "next/server";
import { getListing, parseDraftPatch, updateDraft } from "../../../../src/domain/listing-service";
import { getActor, getDeps } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const actor = getActor(req);
  const deps = getDeps();
  const r = await getListing(deps, actor, id);
  if (!r.ok) return failure(r);
  // The bond pathway is returned to the listing's owner only. Everyone else gets the same body as before.
  if (actor && actor.userId === r.value.ownerUserId) {
    const rec = await deps.repo.get(id);
    if (rec?.rentalBondPathway !== undefined) return NextResponse.json({ listing: r.value, rentalBondPathway: rec.rentalBondPathway });
  }
  return NextResponse.json({ listing: r.value });
}

/** Edits a draft. Published listings cannot be edited here. */
export async function PATCH(req: Request, { params }: Ctx) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parseDraftPatch(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  const { id } = await params;
  const r = await updateDraft(getDeps(), actor, id, parsed.value);
  return r.ok ? NextResponse.json({ listing: r.value }) : failure(r);
}
