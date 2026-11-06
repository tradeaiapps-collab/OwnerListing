import { NextResponse } from "next/server";
import { draftFromWords, MAX_WORDS_LENGTH } from "../../../../src/domain/chat-copilot";
import { getActor } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Elena drafts a first message from what a signed-in person said, before any conversation exists (the contact page).
 * Body: { "words": text }. Pure wording help: it reads nothing about the listing or anyone else, stores nothing and sends nothing. POST only.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const b: unknown = await req.json().catch(() => null);
  const words = typeof b === "object" && b !== null ? (b as Record<string, unknown>)["words"] : undefined;
  if (typeof words !== "string" || words.trim().length === 0 || words.length > MAX_WORDS_LENGTH) {
    return NextResponse.json({ error: `Tell Elena what you want to say, up to ${MAX_WORDS_LENGTH} characters.` }, { status: 400 });
  }
  return NextResponse.json(draftFromWords(words), { headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
