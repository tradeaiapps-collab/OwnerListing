import { NextResponse } from "next/server";
import { addFinding } from "../../../../../src/domain/inspection";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { getInspectionRepo, inspectionIds } from "../../../../../src/server/inspection-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { area, title, detail?, severity }. The booked inspector only, while the inspection is accepted. Findings are never edited. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await addFinding(getInspectionRepo(), actor, id, await req.json().catch(() => null), inspectionIds);
  return r.ok ? NextResponse.json({ finding: r.value }, { status: 201 }) : failure(r);
}

export const POST = withApi(handlePost);
