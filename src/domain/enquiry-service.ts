import type { AuditEvent } from "./audit";
import { canContactSeller, nextVerificationStep, type BuyerVerification, type VerificationStep } from "./buyer";
import { buildOfferPrompt, AUTOMATED_SENDER_ID, shouldSendOfferPrompt } from "./offer-intake";
import { fail, type Actor, type ListingRepository, type Result } from "./listing-service";

export interface Enquiry { id: string; listingId: string; buyerUserId: string; createdAt: string }
/** senderUserId is null for automated messages such as the offer-link prompt. */
export interface EnquiryMessage { id: string; enquiryId: string; senderUserId: string | null; automated: boolean; body: string; sentAt: string }
/** An enquiry as shown in an inbox: which listing it is about and the viewer's side of it. */
export interface InboxItem { enquiry: Enquiry; listingTitle: string; role: "buyer" | "owner"; unread: boolean }

export const MAX_MESSAGE_LENGTH = 4000;
/** Spam limits. Automated messages do not count. */
export const MAX_MESSAGES_PER_HOUR = 20;
export const MAX_NEW_ENQUIRIES_PER_DAY = 5;
/** A buyer cannot keep writing without the owner replying. */
export const MAX_UNANSWERED_BUYER_MESSAGES = 5;

/** Tells a person that someone wrote to them. At most one unread alert per conversation. */
export interface NotificationRepository {
  notifyMessage(userId: string, enquiryId: string, at: string): Promise<void>;
  markRead(userId: string, enquiryId: string, at: string): Promise<void>;
  unreadEnquiryIds(userId: string): Promise<string[]>;
}

export interface EnquiryRepository {
  find(listingId: string, buyerUserId: string): Promise<Enquiry | undefined>;
  get(id: string): Promise<Enquiry | undefined>;
  insert(e: Enquiry): Promise<void>;
  listByBuyer(buyerUserId: string): Promise<Enquiry[]>;
  listByListings(listingIds: readonly string[]): Promise<Enquiry[]>;
  addMessage(m: EnquiryMessage): Promise<void>;
  messages(enquiryId: string): Promise<EnquiryMessage[]>;
  /** Messages written by a person (not automated) since the time. */
  countSentSince(senderUserId: string, sinceIso: string): Promise<number>;
  countStartedSince(buyerUserId: string, sinceIso: string): Promise<number>;
}

export interface EnquiryDeps {
  enquiries: EnquiryRepository;
  listings: ListingRepository;
  /** Missing verification data must come back as all false (fail closed). */
  verification: (userId: string) => Promise<BuyerVerification>;
  /** Issues a single-use offer link URL for the buyer. When absent, offer prompts are not sent. */
  offerLinks?: (listingId: string, buyerUserId: string) => Promise<string>;
  notifications?: NotificationRepository;
  appendAudit: (e: AuditEvent) => Promise<void>;
  now: () => string;
  newId: () => string;
}

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

const ago = (now: string, ms: number) => new Date(new Date(now).getTime() - ms).toISOString();

/** Checks the spam limits for a person writing in a thread. */
async function checkLimits(deps: EnquiryDeps, e: Enquiry, senderUserId: string, body: string): Promise<Result<true>> {
  const now = deps.now();
  if ((await deps.enquiries.countSentSince(senderUserId, ago(now, 3_600_000))) >= MAX_MESSAGES_PER_HOUR) {
    return fail("rate_limited", "You are sending messages too quickly. Try again later.");
  }
  const thread = (await deps.enquiries.messages(e.id)).filter(m => !m.automated);
  const last = thread.at(-1);
  if (last && last.senderUserId === senderUserId && last.body === body) return fail("invalid", "You already sent that message.");
  if (senderUserId === e.buyerUserId) {
    let unanswered = 0;
    for (let i = thread.length - 1; i >= 0 && thread[i]?.senderUserId === e.buyerUserId; i--) unanswered++;
    if (unanswered >= MAX_UNANSWERED_BUYER_MESSAGES) return fail("rate_limited", "Please wait for the owner to reply before sending more.");
  }
  return { ok: true, value: true };
}

async function post(deps: EnquiryDeps, e: Enquiry, senderUserId: string, body: string): Promise<Result<EnquiryMessage>> {
  const limit = await checkLimits(deps, e, senderUserId, body);
  if (!limit.ok) return limit;
  const now = deps.now();
  const m: EnquiryMessage = { id: deps.newId(), enquiryId: e.id, senderUserId, automated: false, body, sentAt: now };
  await deps.enquiries.addMessage(m);
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: senderUserId,
    aggregateType: "enquiry", aggregateId: e.id, eventType: "enquiry.message_sent",
    correlationId: deps.newId(), payload: { messageId: m.id }
  });
  await notifyOther(deps, e, senderUserId, now);
  if (deps.offerLinks && e.buyerUserId === senderUserId) await maybePromptOffer(deps, e, body);
  return { ok: true, value: m };
}

/** Alerts the other side. The message is already saved, so an alert problem never loses it. */
async function notifyOther(deps: EnquiryDeps, e: Enquiry, senderUserId: string, at: string): Promise<void> {
  if (!deps.notifications) return;
  try {
    const rec = await deps.listings.get(e.listingId);
    const recipient = senderUserId === e.buyerUserId ? rec?.listing.ownerUserId : e.buyerUserId;
    if (recipient && recipient !== senderUserId) await deps.notifications.notifyMessage(recipient, e.id, at);
  } catch {
    // Alerts are best effort.
  }
}

/** If a buyer's message reads like an offer, the system replies in the thread with a single-use link to the offer form. */
async function maybePromptOffer(deps: EnquiryDeps, e: Enquiry, text: string): Promise<void> {
  if (!deps.offerLinks) return;
  const prior = (await deps.enquiries.messages(e.id)).filter(m => m.automated).at(-1)?.sentAt;
  const d = shouldSendOfferPrompt({ senderRole: "buyer", text }, await deps.verification(e.buyerUserId), prior, deps.now());
  if (!d.send) return;
  const url = await deps.offerLinks(e.listingId, e.buyerUserId);
  const now = deps.now();
  const m: EnquiryMessage = { id: deps.newId(), enquiryId: e.id, senderUserId: null, automated: true, body: buildOfferPrompt(url), sentAt: now };
  await deps.enquiries.addMessage(m);
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "system", actorId: AUTOMATED_SENDER_ID,
    aggregateType: "enquiry", aggregateId: e.id, eventType: "enquiry.offer_prompt_sent",
    correlationId: deps.newId(), payload: { messageId: m.id }
  });
}

/** A verified buyer messages the owner of a published listing. Re-uses the buyer's existing thread for that listing. */
export async function startEnquiry(
  deps: EnquiryDeps, actor: Actor, listingId: string, body: string
): Promise<Result<{ enquiry: Enquiry; message: EnquiryMessage }>> {
  const rec = await deps.listings.get(listingId);
  if (!rec || rec.listing.status !== "published") return fail("not_found", "Listing not found.");
  if (rec.listing.ownerUserId === actor.userId) return fail("forbidden", "You cannot enquire on your own listing.");

  const v = await deps.verification(actor.userId);
  if (!canContactSeller(v)) {
    const step = nextVerificationStep(v);
    return fail("forbidden", step ? STEP_TEXT[step] : "Verification is required before contacting an owner.");
  }

  let enquiry = await deps.enquiries.find(listingId, actor.userId);
  if (!enquiry) {
    if ((await deps.enquiries.countStartedSince(actor.userId, ago(deps.now(), 86_400_000))) >= MAX_NEW_ENQUIRIES_PER_DAY) {
      return fail("rate_limited", "You have contacted many owners today. Try again tomorrow.");
    }
    enquiry = { id: deps.newId(), listingId, buyerUserId: actor.userId, createdAt: deps.now() };
    await deps.enquiries.insert(enquiry);
  }
  const m = await post(deps, enquiry, actor.userId, body);
  return m.ok ? { ok: true, value: { enquiry, message: m.value } } : m;
}

/** The enquiry if the actor is its buyer or the listing's owner; otherwise a not_found failure. */
async function participantEnquiry(deps: EnquiryDeps, actor: Actor, id: string): Promise<Result<Enquiry>> {
  const e = await deps.enquiries.get(id);
  if (!e) return fail("not_found", "Enquiry not found.");
  if (e.buyerUserId === actor.userId) return { ok: true, value: e };
  const rec = await deps.listings.get(e.listingId);
  if (rec && rec.listing.ownerUserId === actor.userId) return { ok: true, value: e };
  return fail("not_found", "Enquiry not found.");
}

export async function getThread(deps: EnquiryDeps, actor: Actor, id: string): Promise<Result<{ enquiry: Enquiry; messages: EnquiryMessage[] }>> {
  const e = await participantEnquiry(deps, actor, id);
  if (!e.ok) return e;
  await deps.notifications?.markRead(actor.userId, id, deps.now());
  return { ok: true, value: { enquiry: e.value, messages: await deps.enquiries.messages(id) } };
}

export async function reply(deps: EnquiryDeps, actor: Actor, id: string, body: string): Promise<Result<EnquiryMessage>> {
  const e = await participantEnquiry(deps, actor, id);
  if (!e.ok) return e;
  return post(deps, e.value, actor.userId, body);
}

/** Everything the user is part of: threads they started and threads on their own listings, newest first. */
export async function inbox(deps: EnquiryDeps, actor: Actor): Promise<InboxItem[]> {
  const mine = await deps.listings.listByOwner(actor.userId);
  const titles = new Map(mine.map(r => [r.listing.id, r.listing.title] as const));
  const asOwner = await deps.enquiries.listByListings([...titles.keys()]);
  const asBuyer = await deps.enquiries.listByBuyer(actor.userId);

  const unread = new Set(deps.notifications ? await deps.notifications.unreadEnquiryIds(actor.userId) : []);
  const items: InboxItem[] = asOwner.map(e => ({ enquiry: e, listingTitle: titles.get(e.listingId) ?? "", role: "owner" as const, unread: unread.has(e.id) }));
  for (const e of asBuyer) {
    if (items.some(i => i.enquiry.id === e.id)) continue;
    const rec = await deps.listings.get(e.listingId);
    items.push({ enquiry: e, listingTitle: rec?.listing.title ?? "", role: "buyer", unread: unread.has(e.id) });
  }
  return items.sort((a, b) => (a.enquiry.createdAt < b.enquiry.createdAt ? 1 : a.enquiry.createdAt > b.enquiry.createdAt ? -1 : 0));
}

export function createInMemoryEnquiryRepository(): EnquiryRepository {
  const enquiries = new Map<string, Enquiry>();
  const messages: EnquiryMessage[] = [];
  return {
    async find(listingId, buyerUserId) {
      return [...enquiries.values()].find(e => e.listingId === listingId && e.buyerUserId === buyerUserId);
    },
    async get(id) { return enquiries.get(id); },
    async insert(e) { enquiries.set(e.id, e); },
    async listByBuyer(buyerUserId) { return [...enquiries.values()].filter(e => e.buyerUserId === buyerUserId); },
    async listByListings(ids) { return [...enquiries.values()].filter(e => ids.includes(e.listingId)); },
    async addMessage(m) { messages.push(m); },
    async messages(enquiryId) { return messages.filter(m => m.enquiryId === enquiryId); },
    async countSentSince(senderUserId, since) {
      return messages.filter(m => !m.automated && m.senderUserId === senderUserId && m.sentAt >= since).length;
    },
    async countStartedSince(buyerUserId, since) {
      return [...enquiries.values()].filter(e => e.buyerUserId === buyerUserId && e.createdAt >= since).length;
    }
  };
}

export function createInMemoryNotificationRepository(): NotificationRepository {
  const unread = new Set<string>();
  const key = (u: string, e: string) => `${u}|${e}`;
  return {
    async notifyMessage(userId, enquiryId) { unread.add(key(userId, enquiryId)); },
    async markRead(userId, enquiryId) { unread.delete(key(userId, enquiryId)); },
    async unreadEnquiryIds(userId) { return [...unread].filter(k => k.startsWith(`${userId}|`)).map(k => k.slice(userId.length + 1)); }
  };
}
