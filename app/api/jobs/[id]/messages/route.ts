import { NextResponse } from "next/server";
import { postChatMessage, readChat } from "../../../../../src/domain/job-chat-service";
import { getActor } from "../../../../../src/server/context";
import { chatIds, getChatRepo } from "../../../../../src/server/job-chat-db";
import { failure, unauthenticated } from "../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

// Only GET and POST exist on purpose. Chat messages are never edited or deleted (CLAUDE.md).

/** Reads the chat for a job assignment. Only the owner and the assigned contractor can read it. */
export async function GET(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await readChat(getChatRepo(), actor, id);
  return r.ok ? NextResponse.json({ messages: r.value }) : failure(r);
}

/** Posts a message while the assignment is approved. Body: { "body": "text" }. */
export async function POST(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await postChatMessage(getChatRepo(), actor, id, await req.json().catch(() => null), chatIds);
  return r.ok ? NextResponse.json({ message: r.value }, { status: 201 }) : failure(r);
}
