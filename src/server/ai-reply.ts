import type { AiEnginePort } from "../domain/ai-engine";
import type { AiDraftRepository } from "../domain/ai-draft-record";
import { checkSend, draftEnquiryReply, type ReplyDraftOutcome, type SendMode, type ThreadLine } from "../domain/ai-reply-draft";
import type { WordingFilter } from "../domain/ai-pipeline";
import { participantEnquiry, reply, type EnquiryDeps, type EnquiryMessage } from "../domain/enquiry-service";
import type { Actor, Failure, Result } from "../domain/listing-service";
import { withinLimit } from "../domain/rate-limit";

/** Per user: AI reply drafts are generated on a GPU, so they are limited. Product can change the numbers. */
export const AI_REPLY_RATE = { windowMs: 60 * 60 * 1000, perUser: 30 } as const;

export interface AiReplyDeps {
  enquiry: EnquiryDeps;
  drafts: AiDraftRepository;
  engine: () => Promise<AiEnginePort>;
  wordingFilter: WordingFilter;
  aiPaused: (enquiryId: string) => Promise<boolean>;
}

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const notFound = fail("not_found", "Enquiry not found.");

/** Seller side only (the listing's owner or its appointed agent). The buyer and everyone else get not_found. */
async function sellerSide(deps: EnquiryDeps, actor: Actor, enquiryId: string) {
  const p = await participantEnquiry(deps, actor, enquiryId);
  if (!p.ok || p.value.enquiry.buyerUserId === actor.userId) return undefined;
  return p.value;
}

const toLines = (messages: readonly EnquiryMessage[], buyerUserId: string): ThreadLine[] =>
  messages.map(m => ({ from: m.automated ? "notice" : m.senderUserId === buyerUserId ? "buyer" : "seller", body: m.body }));

export async function requestReplyDraft(deps: AiReplyDeps, actor: Actor, enquiryId: string): Promise<Result<ReplyDraftOutcome>> {
  const side = await sellerSide(deps.enquiry, actor, enquiryId);
  if (!side) return notFound;
  const hits = await deps.enquiry.countHit(`ai-reply:${actor.userId}`, AI_REPLY_RATE.windowMs);
  if (!withinLimit(hits, AI_REPLY_RATE.perUser)) return fail("rate_limited", "Too many AI drafts. Try again later.");
  const rec = await deps.enquiry.listings.get(side.enquiry.listingId);
  if (!rec) return notFound;
  const l = rec.listing;
  const template = await deps.enquiry.drafts.approvedTemplate(side.ownerUserId);
  const now = deps.enquiry.now();
  const outcome = await draftEnquiryReply({ engine: await deps.engine(), wordingFilter: deps.wordingFilter }, {
    listingId: l.id, enquiryId,
    listing: {
      title: l.title, transactionType: l.transactionType, propertyType: l.propertyType, jurisdiction: l.jurisdiction, status: l.status,
      ...(l.suburb !== undefined ? { suburb: l.suburb } : {}), ...(l.bedrooms !== undefined ? { bedrooms: l.bedrooms } : {}),
      ...(l.bathrooms !== undefined ? { bathrooms: l.bathrooms } : {}), ...(l.parking !== undefined ? { parking: l.parking } : {}),
      ...(l.priceCents !== undefined ? { priceCents: l.priceCents } : {})
    },
    thread: toLines(await deps.enquiry.enquiries.messages(enquiryId), side.enquiry.buyerUserId),
    ...(template ? { templateBody: template.body } : {}),
    aiPaused: await deps.aiPaused(enquiryId),
    requestedBy: actor.userId, now, newId: deps.enquiry.newId
  });
  if (outcome.state === "drafted") await deps.drafts.insert(outcome.draft);
  await deps.enquiry.appendAudit({
    id: deps.enquiry.newId(), occurredAt: now, actorType: "user", actorId: actor.userId, aggregateType: "enquiry", aggregateId: enquiryId,
    eventType: "enquiry.ai_draft_requested", correlationId: deps.enquiry.newId(),
    payload: { state: outcome.state, ...(outcome.state === "drafted" ? { draftId: outcome.draft.id, status: outcome.draft.status, promptVersion: outcome.draft.promptVersion } : {}) }
  });
  return { ok: true, value: outcome };
}

/** A draft the actor may act on: a reply draft whose thread is on the actor's listing (owner or appointed agent). */
async function actionableDraft(deps: AiReplyDeps, actor: Actor, draftId: string) {
  const d = await deps.drafts.get(draftId);
  if (!d?.enquiryId) return undefined;
  const side = await sellerSide(deps.enquiry, actor, d.enquiryId);
  return side && side.enquiry.listingId === d.listingId ? { draft: d, side } : undefined;
}

export type SendResult = Result<{ message: EnquiryMessage }> | { ok: false; code: "invalid"; message: string; violations: { code: string; message: string }[] };

export async function sendReplyDraft(deps: AiReplyDeps, actor: Actor, draftId: string, mode: SendMode, text: string | undefined): Promise<SendResult> {
  const found = await actionableDraft(deps, actor, draftId);
  if (!found) return fail("not_found", "Draft not found.");
  if (found.draft.status !== "pending" && found.draft.status !== "held") return fail("conflict", "This draft was already sent or discarded.");
  const rec = await deps.enquiry.listings.get(found.draft.listingId);
  const check = checkSend(found.draft, mode, text, deps.wordingFilter, rec?.listing.priceCents);
  if (!check.ok) {
    return { ok: false, code: "invalid", message: mode === "as_is" ? "This draft did not pass the checks. Edit it before sending." : "The edited reply did not pass the checks.", violations: check.guard.violations };
  }
  const sent = await reply(deps.enquiry, actor, found.draft.enquiryId!, check.text);
  if (!sent.ok) return sent;
  const now = deps.enquiry.now();
  await deps.drafts.finish(draftId, check.status, actor.userId, now, sent.value.id);
  await deps.enquiry.appendAudit({
    id: deps.enquiry.newId(), occurredAt: now, actorType: "user", actorId: actor.userId, aggregateType: "enquiry", aggregateId: found.draft.enquiryId!,
    eventType: "enquiry.ai_draft_sent", correlationId: deps.enquiry.newId(), payload: { draftId, mode, messageId: sent.value.id, asAgent: found.side.asAgent }
  });
  return { ok: true, value: { message: sent.value } };
}

export async function discardReplyDraft(deps: AiReplyDeps, actor: Actor, draftId: string): Promise<Result<{ discarded: true }>> {
  const found = await actionableDraft(deps, actor, draftId);
  if (!found) return fail("not_found", "Draft not found.");
  const now = deps.enquiry.now();
  if (!(await deps.drafts.finish(draftId, "discarded", actor.userId, now))) return fail("conflict", "This draft was already sent or discarded.");
  await deps.enquiry.appendAudit({
    id: deps.enquiry.newId(), occurredAt: now, actorType: "user", actorId: actor.userId, aggregateType: "enquiry", aggregateId: found.draft.enquiryId!,
    eventType: "enquiry.ai_draft_discarded", correlationId: deps.enquiry.newId(), payload: { draftId }
  });
  return { ok: true, value: { discarded: true } };
}

/** Wired from the shared pool, like getEnquiryDeps. */
export async function getAiReplyDeps(): Promise<AiReplyDeps> {
  const [{ getEnquiryDeps }, { getDb }, { getAiEngine }, { createPgAiDraftRepository, aiPausedPg }, { getWordingFilter }] = await Promise.all([
    import("./enquiry-db"), import("./context"), import("./ai"), import("./ai-records-db"), import("./wording-filter")
  ]);
  const db = getDb();
  return {
    enquiry: getEnquiryDeps(), drafts: createPgAiDraftRepository(db), engine: getAiEngine, wordingFilter: getWordingFilter(),
    aiPaused: async id => (await aiPausedPg(db, id)).paused
  };
}

