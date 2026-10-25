import { NextResponse } from "next/server";
import { isUuid } from "../../../../../../src/domain/offer-decision";
import { getAiReplyDeps, sendReplyDraft } from "../../../../../../src/server/ai-reply";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { requireCurrentTerms } from "../../../../../../src/server/terms-guard";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ draftId: string }> };

/**
 * The seller sends an AI draft into the buyer's conversation. Body: { "mode": "as_is" } or { "mode": "edited", "text": "..." }.
 * The AI never sends: this is the seller's own action. The AI-assistance footer is always added. A draft that fails the checks
 * gets 422 with the reasons and nothing is sent.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const deps = await getAiReplyDeps();
  const noTerms = await requireCurrentTerms(deps.enquiry.termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  const { draftId } = await params;
  if (!isUuid(draftId)) return failure({ ok: false, code: "not_found", message: "Draft not found." });
  const b: unknown = await req.json().catch(() => null);
  const mode = b !== null && typeof b === "object" ? (b as Record<string, unknown>)["mode"] : undefined;
  const text = b !== null && typeof b === "object" ? (b as Record<string, unknown>)["text"] : undefined;
  if ((mode !== "as_is" && mode !== "edited") || (mode === "edited" && (typeof text !== "string" || text.length > 3800))) {
    return failure({ ok: false, code: "invalid", message: "Mode must be as_is, or edited with text of up to 3,800 characters." });
  }
  const r = await sendReplyDraft(deps, actor, draftId, mode, typeof text === "string" ? text : undefined);
  if (r.ok) return NextResponse.json(r.value, { status: 201 });
  if ("violations" in r) return NextResponse.json({ error: r.message, violations: r.violations }, { status: 422 });
  return failure(r);
}

export const POST = withApi(handlePost);
