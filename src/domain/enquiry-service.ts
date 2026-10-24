import type { AuditEvent } from "./audit";
import type { AutoReplySettings } from "./auto-reply";
import { canContactSeller, nextVerificationStep, type BuyerVerification, type VerificationStep } from "./buyer";
import { DEFAULT_AUTO_REPLY, queueReplyDraft, type DraftRepository, type ReplyDraft } from "./enquiry-drafts";
import type { Actor, Failure, ListingRepository, Result } from "./listing-service";
import { AUTOMATED_SENDER_ID, buildOfferPrompt, shouldSendOfferPrompt } from "./offer-intake";
import { ENQUIRY_RATE, windowStart, withinLimit } from "./rate-limit";
import type { AgentAppointment } from "./access";
import { isAppointedAgent } from "./appointed-agent";
import type { AgentLicence } from "./licence";

export interface Enquiry { id: string; listingId: string; buyerUserId: string; createdAt: string }
/** senderUserId is null for automated system messages (the chat-offer notice). */
export interface EnquiryMessage { id: string; enquiryId: string; senderUserId: string | null; automated: boolean; body: string; sentAt: string }
/** An enquiry as shown in an inbox: which listing it is about, the viewer's side, and unread messages from the other side. */
export interface InboxItem { enquiry: Enquiry; listingTitle: string; role: "buyer" | "owner"; unread: number }

export const MAX_MESSAGE_LENGTH = 4000;

/** Messages are only ever inserted. There is deliberately no update or delete (db trigger rejects them too). */
export interface EnquiryRepository {
  find(listingId: string, buyerUserId: string): Promise<Enquiry | undefined>;
  get(id: string): Promise<Enquiry | undefined>;
  insert(e: Enquiry): Promise<void>;
  listByBuyer(buyerUserId: string): Promise<Enquiry[]>;
  listByListings(listingIds: readonly string[]): Promise<Enquiry[]>;
  addMessage(m: EnquiryMessage): Promise<void>;
  /** Inserts an automated notice unless one already exists for this thread in the same UTC hour (db unique index). False means it lost the race. */
  addNotice(m: EnquiryMessage): Promise<boolean>;
  messages(enquiryId: string): Promise<EnquiryMessage[]>;
  lastAutomatedAt(enquiryId: string): Promise<string | undefined>;
  /** Count of messages from the other side newer than the viewer's last read, per thread. */
  unreadCounts(userId: string, enquiryIds: readonly string[]): Promise<Map<string, number>>;
  markRead(userId: string, enquiryId: string, at: string): Promise<void>;
}

export interface EnquiryDeps {
  enquiries: EnquiryRepository;
  listings: ListingRepository;
  drafts: DraftRepository;
  /** Missing verification data must come back as all false (fail closed). */
  verification: (userId: string) => Promise<BuyerVerification>;
  /** Counts one hit in a fixed window. undefined means the store gave nothing usable, which is treated as over the limit. */
  countHit: (key: string, windowMs: number) => Promise<number | undefined>;
  /** Where the buyer goes to ask for a formal offer link. */
  offerRequestUrl: (enquiryId: string) => string;
  /** True only when the user accepted the terms in force now. Starting or replying to an enquiry needs it. */
  termsCurrentFor: (userId: string) => Promise<boolean>;
  appendAudit: (e: AuditEvent) => Promise<void>;
  now: () => string;
  newId: () => string;
  /** With both set, an agent with an active appointment and a current licence may handle the listing's threads. Unset means owner only. */
  appointmentFor?: (listingId: string, agentUserId: string) => Promise<AgentAppointment | undefined>;
  licences?: () => Promise<readonly AgentLicence[]>;
}

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

const STEP_TEXT: Record<VerificationStep, string> = {
  verify_email: "Verify your email before contacting an owner.",
  verify_phone: "Verify your mobile number before contacting an owner.",
  verify_id: "Complete the ID check before contacting an owner."
};

export function parseMessageBody(body: unknown): Result<string> {
  const text = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["body"] : undefined;
  if (typeof text !== "string") return fail("invalid", "A message is required.");
  const t = text.trim();
  if (!t) return fail("invalid", "A message is required.");
  if (t.length > MAX_MESSAGE_LENGTH) return fail("invalid", `Messages can be up to ${MAX_MESSAGE_LENGTH} characters.`);
  return { ok: true, value: t };
}

const audit = (deps: EnquiryDeps, actorId: string, enquiryId: string, eventType: string, payload: Record<string, unknown>) =>
  deps.appendAudit({
    id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId,
    aggregateType: "enquiry", aggregateId: enquiryId, eventType, correlationId: deps.newId(), payload
  });

/** One hit against a per-buyer limit. Fails closed: an unreadable counter blocks the message. */
async function underLimit(deps: EnquiryDeps, key: string, rate: { windowMs: number; perBuyer: number }): Promise<boolean> {
  try {
    return withinLimit(await deps.countHit(key, rate.windowMs), rate.perBuyer);
  } catch {
    return false;
  }
}

const TOO_FAST = fail("rate_limited", "You are sending too many messages. Try again later.");

/**
 * Stores a message. A buyer must still be fully verified and under the spam limits. After a buyer message:
 * an offer-looking one gets one automated notice (at most an hour apart) pointing to the formal offer-link flow
 * (no link is issued here), and any other one may queue an owner-review draft (preview only, nothing is sent).
 */
async function post(deps: EnquiryDeps, e: Enquiry, ownerUserId: string, senderUserId: string, body: string): Promise<Result<EnquiryMessage>> {
  const fromBuyer = senderUserId === e.buyerUserId;
  const verification = fromBuyer ? await deps.verification(senderUserId) : undefined;
  if (fromBuyer && verification && !canContactSeller(verification)) {
    return fail("forbidden", STEP_TEXT[nextVerificationStep(verification) ?? "verify_id"]);
  }
  if (fromBuyer && !(await underLimit(deps, `enq-msg:${senderUserId}`, ENQUIRY_RATE.messages))) return TOO_FAST;

  const now = deps.now();
  const m: EnquiryMessage = { id: deps.newId(), enquiryId: e.id, senderUserId, automated: false, body, sentAt: now };
  await deps.enquiries.addMessage(m);
  await audit(deps, senderUserId, e.id, "enquiry.message_sent", { messageId: m.id });

  if (fromBuyer && verification) {
    const prompt = shouldSendOfferPrompt({ senderRole: "buyer", text: body }, verification, await deps.enquiries.lastAutomatedAt(e.id), now);
    if (prompt.send) {
      const notice: EnquiryMessage = {
        id: deps.newId(), enquiryId: e.id, senderUserId: null, automated: true, body: buildOfferPrompt(deps.offerRequestUrl(e.id)), sentAt: now
      };
      if (await deps.enquiries.addNotice(notice)) await audit(deps, AUTOMATED_SENDER_ID, e.id, "enquiry.offer_notice_sent", { messageId: notice.id });
    } else {
      const draft = await queueReplyDraft(deps.drafts, ownerUserId, e.id, body, now, deps.newId);
      if (draft) await audit(deps, AUTOMATED_SENDER_ID, e.id, "enquiry.reply_draft_queued", { draftId: draft.id, reviewUntil: draft.reviewUntil });
    }
  }
  return { ok: true, value: m };
}

/** A verified buyer messages the owner of a published listing. Re-uses the buyer's existing thread for that listing. */
export async function startEnquiry(
  deps: EnquiryDeps, actor: Actor, listingId: string, body: string
): Promise<Result<{ enquiry: Enquiry; message: EnquiryMessage }>> {
  if (actor.userType !== "buyer") return fail("forbidden", "Only buyer accounts can enquire.");
  const rec = await deps.listings.get(listingId);
  if (!rec || rec.listing.status !== "published") return fail("not_found", "Listing not found.");
  if (rec.listing.ownerUserId === actor.userId) return fail("forbidden", "You cannot enquire on your own listing.");

  const v = await deps.verification(actor.userId);
  if (!canContactSeller(v)) return fail("forbidden", STEP_TEXT[nextVerificationStep(v) ?? "verify_id"]);

  let enquiry = await deps.enquiries.find(listingId, actor.userId);
  if (!enquiry) {
    if (!(await underLimit(deps, `enq-new:${actor.userId}`, ENQUIRY_RATE.newThreads))) return TOO_FAST;
    enquiry = { id: deps.newId(), listingId, buyerUserId: actor.userId, createdAt: deps.now() };
    await deps.enquiries.insert(enquiry);
  }
  const m = await post(deps, enquiry, rec.listing.ownerUserId, actor.userId, body);
  return m.ok ? { ok: true, value: { enquiry, message: m.value } } : m;
}

/** Non-parties get the same not_found as a missing thread, so existence is never revealed. */
export async function participantEnquiry(deps: EnquiryDeps, actor: Actor, id: string): Promise<Result<{ enquiry: Enquiry; ownerUserId: string; asAgent: boolean }>> {
  const e = await deps.enquiries.get(id);
  const rec = e ? await deps.listings.get(e.listingId) : undefined;
  if (!e || !rec) return fail("not_found", "Enquiry not found.");
  const ownerUserId = rec.listing.ownerUserId;
  // The owner and the buyer are parties. So is the listing's appointed agent while the appointment and licence are valid.
  const isParty = e.buyerUserId === actor.userId || ownerUserId === actor.userId;
  const asAgent = !isParty && (await isAppointedAgent(deps, actor, rec.listing));
  if (!isParty && !asAgent) return fail("not_found", "Enquiry not found.");
  return { ok: true, value: { enquiry: e, ownerUserId, asAgent } };
}

export async function getThread(deps: EnquiryDeps, actor: Actor, id: string): Promise<Result<{ enquiry: Enquiry; messages: EnquiryMessage[] }>> {
  const p = await participantEnquiry(deps, actor, id);
  if (!p.ok) return p;
  const messages = await deps.enquiries.messages(id);
  await deps.enquiries.markRead(actor.userId, id, deps.now());
  return { ok: true, value: { enquiry: p.value.enquiry, messages } };
}

export async function reply(deps: EnquiryDeps, actor: Actor, id: string, body: string): Promise<Result<EnquiryMessage>> {
  const p = await participantEnquiry(deps, actor, id);
  return p.ok ? post(deps, p.value.enquiry, p.value.ownerUserId, actor.userId, body) : p;
}

/** Everything the user is part of: threads they started and threads on their own listings, newest first, with unread counts. */
export async function inbox(deps: EnquiryDeps, actor: Actor): Promise<InboxItem[]> {
  const mine = await deps.listings.listByOwner(actor.userId);
  const titles = new Map(mine.map(r => [r.listing.id, r.listing.title] as const));
  const asOwner = await deps.enquiries.listByListings([...titles.keys()]);
  const asBuyer = await deps.enquiries.listByBuyer(actor.userId);
  const all = [...asOwner, ...asBuyer.filter(b => !asOwner.some(o => o.id === b.id))];
  const unread = await deps.enquiries.unreadCounts(actor.userId, all.map(e => e.id));

  const items: InboxItem[] = [];
  for (const e of all) {
    const own = titles.has(e.listingId);
    const title = titles.get(e.listingId) ?? (await deps.listings.get(e.listingId))?.listing.title ?? "";
    items.push({ enquiry: e, listingTitle: title, role: own ? "owner" : "buyer", unread: unread.get(e.id) ?? 0 });
  }
  return items.sort((a, b) => (a.enquiry.createdAt < b.enquiry.createdAt ? 1 : a.enquiry.createdAt > b.enquiry.createdAt ? -1 : 0));
}

// ---- Owner-only: auto-reply preview (drafts, templates, pause switch) ----

const ownerOnly = (actor: Actor): Failure | undefined =>
  actor.userType === "buyer" ? fail("forbidden", "Only listing owners can use auto-reply drafts.") : undefined;

export async function listDrafts(deps: EnquiryDeps, actor: Actor): Promise<Result<ReplyDraft[]>> {
  return ownerOnly(actor) ?? { ok: true, value: await deps.drafts.listQueued(actor.userId) };
}

/** The draft, only if its thread is on one of the actor's listings. Anyone else gets not_found. */
async function ownedDraft(deps: EnquiryDeps, actor: Actor, draftId: string): Promise<Result<{ draft: ReplyDraft; enquiry: Enquiry }>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  const draft = await deps.drafts.get(draftId);
  const p = draft ? await participantEnquiry(deps, actor, draft.enquiryId) : undefined;
  if (!draft || !p?.ok || p.value.ownerUserId !== actor.userId || draft.status !== "queued") return fail("not_found", "Draft not found.");
  return { ok: true, value: { draft, enquiry: p.value.enquiry } };
}

export async function discardDraft(deps: EnquiryDeps, actor: Actor, draftId: string): Promise<Result<true>> {
  const d = await ownedDraft(deps, actor, draftId);
  if (!d.ok) return d;
  return (await deps.drafts.finish(draftId, "cancelled")) ? { ok: true, value: true } : fail("conflict", "That draft was already handled.");
}

/** The owner chooses to send the draft; it is then posted as the owner's own message. */
export async function sendDraft(deps: EnquiryDeps, actor: Actor, draftId: string): Promise<Result<EnquiryMessage>> {
  const d = await ownedDraft(deps, actor, draftId);
  if (!d.ok) return d;
  if (!(await deps.drafts.finish(draftId, "sent_by_owner"))) return fail("conflict", "That draft was already handled.");
  return post(deps, d.value.enquiry, actor.userId, actor.userId, d.value.draft.body);
}

export async function getAutoReply(deps: EnquiryDeps, actor: Actor): Promise<Result<AutoReplySettings>> {
  return ownerOnly(actor) ?? { ok: true, value: await deps.drafts.getSettings(actor.userId) };
}

/**
 * Updates the owner's switches and/or adds a template. Writing a template is the owner's approval of it.
 * Auto-reply stays off until the owner turns it on, and `paused` stops new drafts at once.
 */
export async function updateAutoReply(deps: EnquiryDeps, actor: Actor, input: unknown): Promise<Result<AutoReplySettings>> {
  const denied = ownerOnly(actor);
  if (denied) return denied;
  const b = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined;
  if (!b) return fail("invalid", "Invalid input.");
  const cur = await deps.drafts.getSettings(actor.userId);
  const next = { ...DEFAULT_AUTO_REPLY, ...cur };
  for (const k of ["enabled", "paused"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") return fail("invalid", `${k} must be true or false.`);
    next[k] = b[k];
  }
  const w = b["reviewWindowMinutes"];
  if (w !== undefined) {
    if (typeof w !== "number" || !Number.isInteger(w) || w < 1 || w > 1440) return fail("invalid", "Review window must be 1 to 1440 minutes.");
    next.reviewWindowMinutes = w;
  }
  const t = b["templateBody"];
  if (t !== undefined) {
    const parsed = parseMessageBody({ body: t });
    if (!parsed.ok) return parsed;
    await deps.drafts.addTemplate({ id: deps.newId(), ownerUserId: actor.userId, body: parsed.value }, deps.now());
  }
  await deps.drafts.saveSettings(actor.userId, next);
  return { ok: true, value: next };
}

export function createInMemoryEnquiryRepository(): EnquiryRepository & { messagesAll: EnquiryMessage[] } {
  const enquiries = new Map<string, Enquiry>();
  const messages: EnquiryMessage[] = [];
  const reads = new Map<string, string>();
  return {
    messagesAll: messages,
    async find(listingId, buyerUserId) {
      return [...enquiries.values()].find(e => e.listingId === listingId && e.buyerUserId === buyerUserId);
    },
    async get(id) { return enquiries.get(id); },
    async insert(e) { enquiries.set(e.id, e); },
    async listByBuyer(buyerUserId) { return [...enquiries.values()].filter(e => e.buyerUserId === buyerUserId); },
    async listByListings(ids) { return [...enquiries.values()].filter(e => ids.includes(e.listingId)); },
    async addMessage(m) { messages.push(m); },
    async addNotice(m) {
      const hour = (t: string) => t.slice(0, 13);
      if (messages.some(x => x.enquiryId === m.enquiryId && x.automated && hour(x.sentAt) === hour(m.sentAt))) return false;
      messages.push(m);
      return true;
    },
    async messages(enquiryId) { return messages.filter(m => m.enquiryId === enquiryId); },
    async lastAutomatedAt(enquiryId) { return messages.filter(m => m.enquiryId === enquiryId && m.automated).at(-1)?.sentAt; },
    async unreadCounts(userId, ids) {
      const out = new Map<string, number>();
      for (const id of ids) {
        const seen = reads.get(`${userId}|${id}`);
        out.set(id, messages.filter(m => m.enquiryId === id && m.senderUserId !== userId && (!seen || m.sentAt > seen)).length);
      }
      return out;
    },
    async markRead(userId, enquiryId, at) { reads.set(`${userId}|${enquiryId}`, at); }
  };
}
