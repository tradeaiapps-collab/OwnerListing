import { NextResponse } from "next/server";
import { agentInbox } from "../../../../src/domain/agent-inbox";
import { getAgentInboxDeps } from "../../../../src/server/agent-inbox-db";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";

/** Listings the signed-in agent is appointed to, with unread enquiry counts. Agents with a verified licence only. */
export async function GET(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await agentInbox(getAgentInboxDeps(), actor);
  return r.ok ? NextResponse.json({ listings: r.value }) : failure(r);
}
