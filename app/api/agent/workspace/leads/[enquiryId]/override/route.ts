import { NextResponse } from "next/server";
import { getActor } from "../../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../../src/server/http";
import { withApi } from "../../../../../../../src/server/api/with-api";
import { getWorkspaceDeps } from "../../../../../../../src/server/agent-workspace-db";
import { clearLeadOverride, overrideLeadScore } from "../../../../../../../src/domain/agent-workspace";

type Ctx = { params: Promise<{ enquiryId: string }> };

/** Set the agent's own score for a lead: { score: 0-100, reason }. It replaces the automatic score until removed. */
async function handlePut(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await overrideLeadScore(getWorkspaceDeps(), actor, (await params).enquiryId, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

/** Go back to the automatic score. */
async function handleDelete(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await clearLeadOverride(getWorkspaceDeps(), actor, (await params).enquiryId);
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const PUT = withApi(handlePut);
export const DELETE = withApi(handleDelete);
