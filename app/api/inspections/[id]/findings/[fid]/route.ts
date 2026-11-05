import { NextResponse } from "next/server";
import { updateFollowup } from "../../../../../../src/domain/inspection";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { getInspectionRepo, inspectionIds } from "../../../../../../src/server/inspection-db";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; fid: string }> };

/** Body: { status: "open" | "in_progress" | "resolved" | "wont_fix", note? }. Owner or appointed agent, once the report is completed. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id, fid } = await params;
  const r = await updateFollowup(getInspectionRepo(), actor, id, fid, await req.json().catch(() => null), inspectionIds);
  return r.ok ? NextResponse.json({ finding: r.value }) : failure(r);
}

export const POST = withApi(handlePost);
