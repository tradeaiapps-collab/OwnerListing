import { NextResponse } from "next/server";
import { getAgentProfile, saveAgentProfile } from "../../../../src/domain/agent-matching";
import { getAgentMatchingRepo, matchingIds } from "../../../../src/server/agent-matching-db";
import { getActor, getDb } from "../../../../src/server/context";
import { guardContent } from "../../../../src/server/content-guard";
import { createPgContentFlagStore } from "../../../../src/server/content-flag-db";
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
  const input = await req.json().catch(() => null);
  const bio = typeof (input as Record<string, unknown> | null)?.["bio"] === "string" ? String((input as Record<string, unknown>)["bio"]) : "";
  // Contact details, abuse and spam in the public bio. Refused text is not saved.
  const g = await guardContent(createPgContentFlagStore(getDb()), { source: "profile", subjectType: "agent_profile", userId: actor.userId, fields: { bio } });
  if (!g.ok) return failure({ ok: false, code: "invalid", message: g.message });
  const r = await saveAgentProfile(getAgentMatchingRepo(), actor, input, matchingIds);
  if (r.ok) await g.after(actor.userId);
  return r.ok ? NextResponse.json({ profile: r.value }) : failure(r);
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
