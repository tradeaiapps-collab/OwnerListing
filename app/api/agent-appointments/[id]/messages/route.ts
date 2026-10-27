import { NextResponse } from "next/server";
import { readAgentConversation, sendAgentMessage } from "../../../../../src/domain/agent-messages";
import { agentMessageIds, getAgentMessageRepo } from "../../../../../src/server/agent-message-db";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";

type Ctx = { params: Promise<{ id: string }> };

// Only GET and POST exist on purpose. Messages are never edited or deleted (CLAUDE.md).

/** The owner-agent conversation for one appointment. Owner always; agent only while the appointment is active. */
export async function GET(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await readAgentConversation(getAgentMessageRepo(), actor, id);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

/** Sends a message while the appointment is active. Body: { "body": "text" }. */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await sendAgentMessage(getAgentMessageRepo(), actor, id, await req.json().catch(() => null), agentMessageIds);
  return r.ok ? NextResponse.json({ message: { ...r.value, mine: true } }, { status: 201 }) : failure(r);
}
