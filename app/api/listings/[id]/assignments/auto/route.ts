import { NextResponse } from "next/server";
import { autoDispatch } from "../../../../../../src/domain/contractor-dispatch";
import { assignmentIds, getAssignmentRepo } from "../../../../../../src/server/assignment-db";
import { createPgContractorProfileStore } from "../../../../../../src/server/contractor-profile-db";
import { getActor, getDb, getDeps } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The owner's listing asks for a photographer and an inspector in its suburb or postcode. Only accounts that opted in with their service
 * areas are asked, through the normal invitation. Safe to call more than once: kinds that already have a live invitation are skipped.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const rec = await getDeps().repo.get(id);
  if (!rec || rec.listing.ownerUserId !== actor.userId) return failure({ ok: false, code: "not_found", message: "Not found." });
  const r = await autoDispatch(getAssignmentRepo(), createPgContractorProfileStore(getDb()), actor, id, { ...(rec.listing.suburb ? { suburb: rec.listing.suburb } : {}), ...(rec.listing.postcode ? { postcode: rec.listing.postcode } : {}) }, assignmentIds);
  return r.ok ? NextResponse.json({ outcomes: r.value }) : failure(r);
}

export const POST = withApi(handlePost);
