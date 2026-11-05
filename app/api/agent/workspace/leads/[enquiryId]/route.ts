import { NextResponse } from "next/server";
import { getActor } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";
import { getWorkspaceDeps } from "../../../../../../src/server/agent-workspace-db";
import { updateLead } from "../../../../../../src/domain/agent-workspace";

/** Set a lead's pipeline stage and follow-up date: { stage, followUpAt? }. */
async function handlePut(req: Request, { params }: { params: Promise<{ enquiryId: string }> }) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await updateLead(getWorkspaceDeps(), actor, (await params).enquiryId, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const PUT = withApi(handlePut);
