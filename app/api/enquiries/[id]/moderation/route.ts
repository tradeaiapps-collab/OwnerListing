import { NextResponse } from "next/server";
import { participantEnquiry } from "../../../../../src/domain/enquiry-service";
import {
  analyseConversation, isToneChoice, MESSAGE_TEMPLATES, moderateMessage, rewriteAll, rewriteMessage, SCENARIO_LABEL
} from "../../../../../src/domain/message-moderation";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getEnquiryDeps } from "../../../../../src/server/enquiry-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { moderationFlagsForEnquiryPg } from "../../../../../src/server/message-moderation-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const notFound = { ok: false, code: "not_found", message: "Enquiry not found." } as const;
const noStore = { headers: { "cache-control": "no-store" } };

/**
 * Seller side of a thread (owner or appointed agent) only: message templates, stalled or tense conversation notes, and
 * staff feedback on the seller's own flagged messages. The buyer gets 404 so flags and templates never reach them.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure(notFound);
  const deps = getEnquiryDeps();
  const p = await participantEnquiry(deps, actor, id);
  if (!p.ok) return failure(p);
  if (p.value.enquiry.buyerUserId === actor.userId) return failure(notFound);
  const messages = await deps.enquiries.messages(id);
  const insight = analyseConversation(messages, p.value.enquiry.buyerUserId, deps.now());
  const mine = await moderationFlagsForEnquiryPg(getDb(), id, actor.userId);
  return NextResponse.json({
    templates: MESSAGE_TEMPLATES, scenarios: SCENARIO_LABEL, insight,
    feedback: mine.filter(f => f.status === "revision_requested" || f.status === "educated").map(f => ({
      messageId: f.messageId, status: f.status, note: f.reviewNote ?? "", reasons: f.flags.map(x => ({ category: x.category, explanation: x.explanation, suggestion: x.suggestion }))
    }))
  }, noStore);
}

/** Checks a draft before it is sent. Nothing is stored or sent. Body: { "body": text, "tone"?: tone }. Returns flags and softer versions. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure(notFound);
  const p = await participantEnquiry(getEnquiryDeps(), actor, id);
  if (!p.ok) return failure(p);
  if (p.value.enquiry.buyerUserId === actor.userId) return failure(notFound);
  const b: unknown = await req.json().catch(() => null);
  const body = typeof b === "object" && b !== null ? (b as Record<string, unknown>)["body"] : undefined;
  const tone = typeof b === "object" && b !== null ? (b as Record<string, unknown>)["tone"] : undefined;
  if (typeof body !== "string" || body.trim().length === 0 || body.length > 4000) return NextResponse.json({ error: "A message of up to 4000 characters is required." }, { status: 400 });
  const result = moderateMessage(body);
  const rewrites = tone === undefined ? rewriteAll(body) : isToneChoice(tone) ? [rewriteMessage(body, tone)].flatMap(r => r ?? []) : null;
  if (rewrites === null) return NextResponse.json({ error: "Unknown tone." }, { status: 400 });
  return NextResponse.json({ ...result, rewrites: result.risk === "none" ? [] : rewrites }, noStore);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
