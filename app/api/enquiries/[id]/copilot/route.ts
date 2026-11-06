import { NextResponse } from "next/server";
import { getAssistantContext } from "../../../../../src/domain/chat-assistant";
import { analyseConversation, draftFromWords, MAX_WORDS_LENGTH, type CopilotMessage } from "../../../../../src/domain/chat-copilot";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getChatAssistantDeps } from "../../../../../src/server/chat-assistant-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const notFound = { ok: false, code: "not_found", message: "Enquiry not found." } as const;
const noStore = { headers: { "cache-control": "no-store" } };

// Elena's coaching is private to the person who asks. Nothing here is stored, and nothing is ever sent for them. GET and POST only.

/** Reads the whole thread from the viewer's side: verdicts with ready drafts, and replies to the latest message. Parties only. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure(notFound);
  const deps = getChatAssistantDeps();
  const c = await getAssistantContext(deps, actor, id);
  if (!c.ok) return failure(c);
  const raw = await deps.enquiries.messages(id);
  const messages: CopilotMessage[] = raw
    .filter(m => !m.automated && m.senderUserId)
    .map(m => ({ side: m.senderUserId === c.value.enquiry.buyerUserId ? "buyer" : "seller", body: m.body, sentAt: m.sentAt }));
  return NextResponse.json({ role: c.value.role, analysis: analyseConversation({ role: c.value.role, messages, facts: c.value.facts, now: deps.now() }) }, noStore);
}

/** Turns what the person said (typed, or spoken in their own browser) into drafts. Body: { "words": text }. Nothing is stored or sent. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure(notFound);
  const c = await getAssistantContext(getChatAssistantDeps(), actor, id);
  if (!c.ok) return failure(c);
  const b: unknown = await req.json().catch(() => null);
  const words = typeof b === "object" && b !== null ? (b as Record<string, unknown>)["words"] : undefined;
  if (typeof words !== "string" || words.trim().length === 0 || words.length > MAX_WORDS_LENGTH) {
    return NextResponse.json({ error: `Tell Elena what you want to say, up to ${MAX_WORDS_LENGTH} characters.` }, { status: 400 });
  }
  return NextResponse.json(draftFromWords(words), noStore);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
