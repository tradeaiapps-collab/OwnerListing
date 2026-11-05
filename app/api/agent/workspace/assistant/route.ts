import { NextResponse } from "next/server";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";
import { getWorkspaceDeps } from "../../../../../src/server/agent-workspace-db";
import { askWorkspaceAssistant } from "../../../../../src/domain/agent-workspace";

/** Ask the assistant about the agent's own numbers: { question, buyerId? }. Read only; it never sends or decides anything. */
async function handlePost(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const body = await req.json().catch(() => null);
  const r = await askWorkspaceAssistant(getWorkspaceDeps(), actor, body);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const POST = withApi(handlePost);
