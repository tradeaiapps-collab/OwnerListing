import { NextResponse } from "next/server";
import { stripFooter } from "../../../../../../src/domain/ai-pipeline";
import { isUuid } from "../../../../../../src/domain/offer-decision";
import { getAiReplyDeps, requestReplyDraft } from "../../../../../../src/server/ai-reply";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The seller (owner or appointed agent) asks the AI to draft a reply to the buyer's latest message. Nothing is sent.
 * 200 always carries a state: drafted (with the guard result; a failed guard means status "held"), unavailable (AI off),
 * paused, or owner_only (offers, complaints and safety handoffs are never drafted). Buyers and strangers get 404.
 */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure({ ok: false, code: "not_found", message: "Enquiry not found." });
  const r = await requestReplyDraft(await getAiReplyDeps(), actor, id);
  if (!r.ok) return failure(r);
  const o = r.value;
  const body = o.state === "drafted"
    ? {
      state: o.state, intent: o.intent.intent, quietHours: o.quietHours, earliestSend: o.earliestSend,
      draft: { id: o.draft.id, text: stripFooter(o.draft.text), status: o.draft.status, violations: o.guard.violations }
    }
    : o.state === "owner_only" ? { state: o.state, intent: o.intent, message: o.message, reasons: o.flags.map(f => f.explanation) } : o;
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}
