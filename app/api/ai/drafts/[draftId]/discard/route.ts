import { NextResponse } from "next/server";
import { isUuid } from "../../../../../../src/domain/offer-decision";
import { discardReplyDraft, getAiReplyDeps } from "../../../../../../src/server/ai-reply";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";

type Ctx = { params: Promise<{ draftId: string }> };

/** The seller throws away an AI draft. The draft row stays as a record with status "discarded". */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { draftId } = await params;
  if (!isUuid(draftId)) return failure({ ok: false, code: "not_found", message: "Draft not found." });
  const r = await discardReplyDraft(await getAiReplyDeps(), actor, draftId);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
