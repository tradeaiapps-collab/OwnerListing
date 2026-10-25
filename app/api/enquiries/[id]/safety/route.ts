import { NextResponse } from "next/server";
import { participantEnquiry } from "../../../../../src/domain/enquiry-service";
import { MONEY_SAFETY_NOTE, ownerWarning } from "../../../../../src/domain/message-safety";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { aiPausedPg, safetyFlagsForEnquiryPg, setAiPausePg } from "../../../../../src/server/ai-records-db";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getEnquiryDeps } from "../../../../../src/server/enquiry-db";
import { failure, unauthenticated } from "../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

const notFound = { ok: false, code: "not_found", message: "Enquiry not found." } as const;

/**
 * Safety warnings on a thread, for the seller side only (owner or appointed agent). The buyer gets an empty list:
 * flags are a private note to the seller, never shown to the person who wrote the message.
 */
export async function GET(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure(notFound);
  const p = await participantEnquiry(getEnquiryDeps(), actor, id);
  if (!p.ok) return failure(p);
  if (p.value.enquiry.buyerUserId === actor.userId) return NextResponse.json({ flags: [], aiPaused: false, note: MONEY_SAFETY_NOTE });
  const db = getDb();
  const flags = await safetyFlagsForEnquiryPg(db, id);
  const pause = await aiPausedPg(db, id);
  return NextResponse.json({
    flags: flags.map(f => ({
      messageId: f.messageId, risk: f.risk, handoff: f.handoff,
      warning: ownerWarning({ risk: f.risk, flags: f.flags, handoff: f.handoff, staffReview: f.staffReview }),
      reasons: f.flags.map(x => ({ category: x.category, explanation: x.explanation })),
      ...(f.reviewOutcome ? { reviewOutcome: f.reviewOutcome } : {})
    })),
    aiPaused: pause.paused,
    note: MONEY_SAFETY_NOTE
  }, { headers: { "cache-control": "no-store" } });
}

/** The listing's owner turns AI drafting back on for this thread after a handoff. Body: { "action": "resume_ai" }. */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure(notFound);
  const deps = getEnquiryDeps();
  const p = await participantEnquiry(deps, actor, id);
  if (!p.ok || p.value.ownerUserId !== actor.userId) return failure(notFound);
  const body: unknown = await req.json().catch(() => null);
  if (body === null || typeof body !== "object" || (body as Record<string, unknown>)["action"] !== "resume_ai") {
    return failure({ ok: false, code: "invalid", message: "Action must be resume_ai." });
  }
  const now = deps.now();
  await setAiPausePg(getDb(), id, false, "Resumed by the owner", actor.userId, now);
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "enquiry", aggregateId: id, eventType: "enquiry.ai_resumed", correlationId: deps.newId(), payload: {}
  });
  return NextResponse.json({ aiPaused: false });
}
