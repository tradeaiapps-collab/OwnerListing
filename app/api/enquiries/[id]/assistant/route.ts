import { NextResponse } from "next/server";
import { askAssistant, getAssistantThread, parseQuestion } from "../../../../../src/domain/chat-assistant";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getChatAssistantDeps } from "../../../../../src/server/chat-assistant-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

const notFound = { ok: false, code: "not_found", message: "Enquiry not found." } as const;

// Only GET and POST exist on purpose. Questions to the assistant and her answers are a permanent record, like messages.

/** The assistant's side of the thread (welcome, every question and answer, and the facts she uses), for the thread's parties only. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure(notFound);
  const r = await getAssistantThread(getChatAssistantDeps(), actor, id);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

/** Asks the assistant. Body: { "question": "text" }. Both parties see the question and the answer. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure(notFound);
  const q = parseQuestion(await req.json().catch(() => null));
  if (!q.ok) return failure(q);
  const r = await askAssistant(getChatAssistantDeps(), actor, id, q.value);
  return r.ok ? NextResponse.json({ turn: r.value }, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
