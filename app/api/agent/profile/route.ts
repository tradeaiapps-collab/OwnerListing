import { NextResponse } from "next/server";
import { getAgentProfile, saveAgentProfile } from "../../../../src/domain/agent-matching";
import { getAgentMatchingRepo, matchingIds } from "../../../../src/server/agent-matching-db";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { csrfGuard } from "../../../../src/server/csrf";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in agent's own profile: service areas, expertise and capacity. Agents only. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await getAgentProfile(getAgentMatchingRepo(), actor);
  return r.ok ? NextResponse.json({ profile: r.value }) : failure(r);
}

/** Replaces the signed-in agent's profile. The agent id comes from the session, never the body. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await saveAgentProfile(getAgentMatchingRepo(), actor, await req.json().catch(() => null), matchingIds);
  return r.ok ? NextResponse.json({ profile: r.value }) : failure(r);
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
