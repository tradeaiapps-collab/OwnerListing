import { NextResponse } from "next/server";
import { readAgentConversation, sendAgentMessage } from "../../../../../src/domain/agent-messages";
import { agentMessageIds, getAgentMessageRepo } from "../../../../../src/server/agent-message-db";
import { getActor, getDb } from "../../../../../src/server/context";
import { createPgContentFlagStore } from "../../../../../src/server/content-flag-db";
import { guardContent } from "../../../../../src/server/content-guard";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

// Only GET and POST exist on purpose. Messages are never edited or deleted (CLAUDE.md).

/** The owner-agent conversation for one appointment. Owner always; agent only while the appointment is active. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await readAgentConversation(getAgentMessageRepo(), actor, id);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

/** Sends a message while the appointment is active. Body: { "body": "text" }. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const input: unknown = await req.json().catch(() => null);
  const text = typeof (input as Record<string, unknown> | null)?.["body"] === "string" ? String((input as Record<string, unknown>)["body"]) : "";
  // Abuse is refused and spam is flagged for staff. Contact details are fine here: the owner has appointed this agent.
  const g = await guardContent(createPgContentFlagStore(getDb()), { source: "message", subjectType: "agent_appointment_message", userId: actor.userId, fields: { body: text }, ignore: ["contact_details"] });
  if (!g.ok) return failure({ ok: false, code: "invalid", message: g.message });
  const r = await sendAgentMessage(getAgentMessageRepo(), actor, id, input, agentMessageIds);
  if (r.ok) await g.after(r.value.id);
  return r.ok ? NextResponse.json({ message: { ...r.value, mine: true } }, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
