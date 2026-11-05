import { NextResponse } from "next/server";
import { agentLeads } from "../../../../src/domain/lead-service";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getLeadDeps } from "../../../../src/server/lead-db";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in agent's own leads, open ones first. Contact details are in the lead's own detail route, only for the assigned agent. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await agentLeads(await getLeadDeps(), actor);
  return r.ok ? NextResponse.json({ leads: r.value }, { headers: { "cache-control": "no-store" } }) : failure(r);
}

export const GET = withApi(handleGet);
