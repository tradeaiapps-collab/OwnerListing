import { NextResponse } from "next/server";
import { revokeShare } from "../../../../../../src/domain/inspection";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { getInspectionRepo, inspectionIds } from "../../../../../../src/server/inspection-db";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; sid: string }> };

/** Stops sharing with one person. The share record stays; it is marked revoked. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id, sid } = await params;
  const r = await revokeShare(getInspectionRepo(), actor, id, sid, inspectionIds);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const POST = withApi(handlePost);
