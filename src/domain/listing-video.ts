import type { ObjectStoragePort } from "../adapters/object-storage";
import type { AuditEvent } from "./audit";
import type { Actor, Failure, Result } from "./listing-service";

// AI tour videos made by Hedra. Pure rules and the queue live here; Hedra, Stripe, Postgres and file storage are ports.
// Model "team": an agency team spends its monthly video budget (managers set it; agents appointed to the listing generate).
// Model "buyer": a signed-in visitor pays once through hosted Stripe Checkout and the video is made after the payment is confirmed.

export const VIDEO_STATUSES = ["queued", "processing", "ready", "failed"] as const;
export type VideoStatus = typeof VIDEO_STATUSES[number];
export type VideoModel = "team" | "buyer";

export const MAX_ATTEMPTS = 3;
/** A video not finished this long after it was requested is failed (and refunded) instead of waiting forever. */
export const DEADLINE_MS = 45 * 60_000;
export const POLL_MS = 30_000;
/** A claimed row is left alone this long, so two overlapping queue runs never work on the same video. */
export const LEASE_MS = 2 * 60_000;
export const RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000] as const;
export const MAX_BUDGET_CENTS = 100_000_000;
export const MIN_PHOTOS = 2;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export interface VideoPricing { teamCostCents: number; buyerPriceCents: number }
/** AUD cents. Defaults: A$5.00 charged to the team, A$6.00 to a buyer (covers the card fee). Override with VIDEO_TEAM_COST_CENTS / VIDEO_BUYER_PRICE_CENTS. */
export function videoPricing(env: Readonly<Record<string, string | undefined>> = {}): VideoPricing {
  const n = (v: string | undefined, d: number) => (v && /^\d{1,7}$/.test(v) && Number(v) > 0 ? Number(v) : d);
  return { teamCostCents: n(env["VIDEO_TEAM_COST_CENTS"], 500), buyerPriceCents: n(env["VIDEO_BUYER_PRICE_CENTS"], 600) };
}

export interface ListingVideo {
  id: string; listingId: string; model: VideoModel; requestedBy: string; teamId: string | null; status: VideoStatus;
  providerJobId: string | null; storageKey: string | null; contentType: string | null; costCents: number; attempts: number;
  nextAttemptAt: string; deadlineAt: string; error: string; visibility: "private" | "public";
  requestedAt: string; generatedAt: string | null; publishedAt: string | null; archivedAt: string | null;
}
export interface VideoListing { id: string; ownerUserId: string; status: string; title: string; description: string; propertyType: string; suburb: string }
export interface Membership { teamId: string; role: "manager" | "agent" | "staff" }
export interface PhotoFile { storageKey: string; contentType: string }
export interface BudgetView { teamId: string; monthlyBudgetCents: number; spentCents: number; remainingCents: number; monthStart: string }

export interface VideoRepository {
  listing(listingId: string): Promise<VideoListing | undefined>;
  isAppointedAgent(listingId: string, userId: string): Promise<boolean>;
  membership(userId: string): Promise<Membership | undefined>;
  isTeamMember(teamId: string, userId: string): Promise<boolean>;
  budget(teamId: string, monthStartIso: string): Promise<BudgetView | undefined>;
  setBudget(teamId: string, cents: number, by: string, audit: AuditEvent): Promise<void>;
  /** Under a lock on the team's budget: checks the remaining allowance, inserts the video and its charge together. */
  queueTeamVideo(v: ListingVideo, monthStartIso: string, audit: AuditEvent): Promise<"queued" | "budget" | "exists">;
  /** The shared buyer video of a listing: inserts, or answers the one already live. */
  queueBuyerVideo(v: ListingVideo, audit: AuditEvent): Promise<ListingVideo>;
  video(id: string): Promise<ListingVideo | undefined>;
  videosForListing(listingId: string): Promise<ListingVideo[]>;
  /** Newest live (not archived, not failed) video per model for a listing. */
  liveVideo(listingId: string, model: VideoModel): Promise<ListingVideo | undefined>;
  publicVideo(listingId: string): Promise<ListingVideo | undefined>;
  setVisibility(id: string, visibility: "private" | "public", nowIso: string): Promise<boolean>;
  archive(id: string, nowIso: string): Promise<boolean>;
  photoFiles(listingId: string, max: number): Promise<PhotoFile[]>;
  agentOverview(userId: string): Promise<AgentVideoRow[]>;
  // Queue
  claimDue(nowIso: string, leaseUntilIso: string, limit: number): Promise<ListingVideo[]>;
  markSubmitted(id: string, jobId: string, attempts: number, nextAttemptIso: string): Promise<void>;
  keepWaiting(id: string, nextAttemptIso: string): Promise<void>;
  /** The provider says a job finished: make its video due now (the answer is still read from the provider). */
  pullForward(providerJobId: string, nowIso: string): Promise<void>;
  markReady(id: string, storageKey: string, contentType: string, nowIso: string): Promise<void>;
  scheduleRetry(id: string, attempts: number, nextAttemptIso: string, error: string): Promise<void>;
  /** Ends the video as failed; a team video also gets its refund row, in the same write. */
  markFailed(id: string, error: string, nowIso: string, audit: AuditEvent): Promise<void>;
  // Buyer payments
  /** False when this buyer already has an open payment for the listing (the unique index); that one is reused. */
  createPurchase(p: Purchase): Promise<boolean>;
  pendingPurchase(listingId: string, buyerId: string): Promise<Purchase | undefined>;
  attachCheckout(purchaseId: string, sessionId: string, url: string): Promise<void>;
  purchaseBySession(sessionId: string): Promise<Purchase | undefined>;
  hasPaid(listingId: string, buyerId: string): Promise<boolean>;
  /** Claims the Stripe event id, marks the purchase paid and links the video; false when the event was already handled. */
  settlePurchase(eventId: string, purchaseId: string, videoId: string, nowIso: string, audit: AuditEvent): Promise<boolean>;
  expirePurchase(sessionId: string): Promise<void>;
  appendAudit(e: AuditEvent): Promise<void>;
}

export interface Purchase { id: string; listingId: string; buyerId: string; videoId: string | null; amountCents: number; sessionId: string | null; checkoutUrl?: string | null; createdAt?: string; status: "pending" | "paid" | "expired" }
export interface AgentVideoRow {
  listingId: string; title: string; suburb: string; status: string; photoCount: number;
  video: Pick<ListingVideo, "id" | "status" | "visibility" | "requestedAt" | "generatedAt" | "error" | "attempts"> | null;
}

export interface VideoImage { bytes: Uint8Array; contentType: string }
export type JobPoll = { state: "running" } | { state: "ready"; downloadUrl: string; contentType: string } | { state: "failed"; message: string };
export interface VideoProvider {
  readonly configured: boolean;
  submit(input: { images: VideoImage[]; prompt: string; idempotencyKey: string }): Promise<{ jobId: string }>;
  poll(jobId: string): Promise<JobPoll>;
  download(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
}
export interface CheckoutPort {
  readonly enabled: boolean;
  createCheckout(input: { purchaseId: string; amountCents: number; description: string; successUrl: string; cancelUrl: string; buyerEmail?: string }): Promise<{ sessionId: string; url: string }>;
}
export interface VideoIds { newId: () => string; now: () => string }

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const iso = (ms: number) => new Date(ms).toISOString();
const at = (nowIso: string, plusMs: number) => iso(Date.parse(nowIso) + plusMs);

/** First instant (UTC) of the month `nowIso` falls in. The team budget resets then. */
export function monthStart(nowIso: string): string {
  const d = new Date(nowIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}
export const retryDelayMs = (attemptsMade: number): number | undefined => RETRY_DELAYS_MS[attemptsMade - 1];

/** Hedra's defaults for everything except the framing: a smooth, steady walk-through from the first photo to the next. */
export function videoPrompt(l: Pick<VideoListing, "title" | "propertyType" | "suburb" | "description">): string {
  const where = l.suburb ? ` in ${l.suburb}` : "";
  const kind = l.propertyType ? l.propertyType.replace(/_/g, " ") : "home";
  const about = l.description.replace(/\s+/g, " ").trim().slice(0, 400);
  return `A smooth, steady real-estate tour of a ${kind}${where}. Gentle camera movement from the first view towards the second, natural daylight, true-to-life colours, no people, no text or logos.${about ? ` About the property: ${about}` : ""}`.slice(0, 2400);
}

const audit = (ids: VideoIds, actorId: string, type: string, id: string, payload: Record<string, unknown>, actorType: AuditEvent["actorType"] = "user"): AuditEvent =>
  ({ id: ids.newId(), occurredAt: ids.now(), actorType, actorId, aggregateType: "listing_video", aggregateId: id, eventType: type, correlationId: id, payload });

function newVideo(ids: VideoIds, listingId: string, model: VideoModel, by: string, teamId: string | null, costCents: number): ListingVideo {
  const now = ids.now();
  return {
    id: ids.newId(), listingId, model, requestedBy: by, teamId, status: "queued", providerJobId: null, storageKey: null, contentType: null,
    costCents, attempts: 0, nextAttemptAt: now, deadlineAt: at(now, DEADLINE_MS), error: "", visibility: "private",
    requestedAt: now, generatedAt: null, publishedAt: null, archivedAt: null
  };
}

async function canManageVideos(repo: VideoRepository, actor: Actor, listing: VideoListing): Promise<boolean> {
  return actor.userType === "agent" && (await repo.isAppointedAgent(listing.id, actor.userId));
}

async function photoCheck(repo: VideoRepository, listingId: string): Promise<Failure | undefined> {
  const photos = await repo.photoFiles(listingId, MIN_PHOTOS);
  return photos.length < MIN_PHOTOS ? fail("invalid", `Add at least ${MIN_PHOTOS} photos to the listing before making a video.`) : undefined;
}

/** Model 1. An appointed agent in a team asks for a video; the team's budget is checked and charged before anything is queued. */
export async function requestTeamVideo(
  repo: VideoRepository, actor: Actor, listingId: unknown, pricing: VideoPricing, provider: Pick<VideoProvider, "configured">, ids: VideoIds
): Promise<Result<ListingVideo>> {
  if (!isId(listingId)) return fail("invalid", "Choose a listing.");
  const listing = await repo.listing(listingId);
  if (!listing || !(await canManageVideos(repo, actor, listing))) return fail("not_found", "Listing not found.");
  if (!provider.configured) return fail("unavailable", "Video generation is not switched on yet.");
  const member = await repo.membership(actor.userId);
  if (!member) return fail("forbidden", "Join an agency team to pay for videos from a team budget.");
  const bad = await photoCheck(repo, listingId);
  if (bad) return bad;
  const month = monthStart(ids.now());
  const v = newVideo(ids, listingId, "team", actor.userId, member.teamId, pricing.teamCostCents);
  const out = await repo.queueTeamVideo(v, month, audit(ids, actor.userId, "video.requested", v.id, { listingId, model: "team", teamId: member.teamId, costCents: v.costCents }));
  if (out === "exists") return fail("conflict", "This listing already has a video. Delete or replace it first.");
  if (out === "budget") return fail("forbidden", "The team's video budget for this month is used up. A team manager can raise it.");
  return { ok: true, value: v };
}

export async function teamBudget(repo: VideoRepository, actor: Actor, teamId: unknown, ids: VideoIds): Promise<Result<BudgetView>> {
  if (!isId(teamId) || !(await repo.isTeamMember(teamId, actor.userId))) return fail("not_found", "Team not found.");
  const b = await repo.budget(teamId, monthStart(ids.now()));
  return { ok: true, value: b ?? { teamId, monthlyBudgetCents: 0, spentCents: 0, remainingCents: 0, monthStart: monthStart(ids.now()) } };
}

/** Managers only. Dollars in the request body would invite rounding, so the input is whole cents. */
export async function setTeamBudget(repo: VideoRepository, actor: Actor, teamId: unknown, input: unknown, ids: VideoIds): Promise<Result<BudgetView>> {
  const m = isId(teamId) ? await repo.membership(actor.userId) : undefined;
  if (!isId(teamId) || !m || m.teamId !== teamId) return fail("not_found", "Team not found.");
  if (m.role !== "manager") return fail("forbidden", "Only a team manager can set the video budget.");
  const cents = (input as { monthlyBudgetCents?: unknown } | null)?.monthlyBudgetCents;
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents < 0 || cents > MAX_BUDGET_CENTS) return fail("invalid", "Enter the monthly budget in whole cents, from 0 up to 1,000,000 dollars.");
  await repo.setBudget(teamId, cents, actor.userId, audit(ids, actor.userId, "video.budget_set", teamId, { teamId, monthlyBudgetCents: cents }));
  return teamBudget(repo, actor, teamId, ids);
}

/** Model 2, step 1: the buyer confirms the price and is sent to hosted Stripe Checkout. No card data touches this server. */
export async function startBuyerPurchase(
  repo: VideoRepository, pay: CheckoutPort, provider: Pick<VideoProvider, "configured">, actor: Actor, listingId: unknown,
  pricing: VideoPricing, urls: { success: (listingId: string) => string; cancel: (listingId: string) => string }, ids: VideoIds, buyerEmail?: string
): Promise<Result<{ checkoutUrl: string } | { alreadyPaid: true; videoId: string }>> {
  if (!isId(listingId)) return fail("invalid", "Choose a listing.");
  const listing = await repo.listing(listingId);
  if (!listing || listing.status !== "published") return fail("not_found", "Listing not found.");
  if (!provider.configured || !pay.enabled) return fail("unavailable", "Tour videos are not available right now.");
  if (await repo.publicVideo(listingId)) return fail("conflict", "This listing already has a tour video to watch.");
  if (await repo.hasPaid(listingId, actor.userId)) {
    // Paid already: never charge twice. If the earlier video ended failed, a new one is queued for free.
    const live = (await repo.liveVideo(listingId, "buyer")) ?? (await repo.queueBuyerVideo(newVideo(ids, listingId, "buyer", actor.userId, null, 0), audit(ids, actor.userId, "video.requeued", listingId, { listingId, model: "buyer" })));
    return { ok: true, value: { alreadyPaid: true, videoId: live.id } };
  }
  const bad = await photoCheck(repo, listingId);
  if (bad) return bad;
  const purchase: Purchase = { id: ids.newId(), listingId, buyerId: actor.userId, videoId: null, amountCents: pricing.buyerPriceCents, sessionId: null, status: "pending" };
  if (!(await repo.createPurchase(purchase))) {
    // An open payment exists (double click, second tab): send the buyer to the same Checkout instead of opening another.
    const open = await repo.pendingPurchase(listingId, actor.userId);
    if (open?.checkoutUrl && Date.parse(ids.now()) - Date.parse(open.createdAt ?? ids.now()) < 23 * 3600_000) return { ok: true, value: { checkoutUrl: open.checkoutUrl } };
    return fail("conflict", "A payment for this video is already open. Finish it, or try again in a moment.");
  }
  try {
    const s = await pay.createCheckout({
      purchaseId: purchase.id, amountCents: purchase.amountCents, description: `Tour video: ${listing.title}`.slice(0, 120),
      successUrl: urls.success(listingId), cancelUrl: urls.cancel(listingId), ...(buyerEmail ? { buyerEmail } : {})
    });
    await repo.attachCheckout(purchase.id, s.sessionId, s.url);
    return { ok: true, value: { checkoutUrl: s.url } };
  } catch {
    return fail("unavailable", "Could not start the payment. Nothing was charged.");
  }
}

/**
 * Model 2, step 2: Stripe says the Checkout session is paid. The video is queued once per listing; a later buyer's payment just
 * grants them the same video. Safe to repeat: the event id is claimed in the same write.
 */
export async function completeBuyerPurchase(repo: VideoRepository, eventId: string, sessionId: string, ids: VideoIds): Promise<"done" | "unknown" | "repeat"> {
  const p = await repo.purchaseBySession(sessionId);
  if (!p) return "unknown";
  const probe = newVideo(ids, p.listingId, "buyer", p.buyerId, null, 0);
  const v = await repo.queueBuyerVideo(probe, audit(ids, p.buyerId, "video.requested", probe.id, { listingId: p.listingId, model: "buyer", purchaseId: p.id }));
  const settled = await repo.settlePurchase(eventId, p.id, v.id, ids.now(), audit(ids, p.buyerId, "video.purchase_paid", p.id, { listingId: p.listingId, videoId: v.id, amountCents: p.amountCents }, "service"));
  return settled ? "done" : "repeat";
}

export interface VideoView {
  id: string; listingId: string; model: VideoModel; status: VideoStatus; visibility: "private" | "public"; requestedAt: string;
  generatedAt: string | null; error: string; playbackUrl: string | null; canManage: boolean;
}
export const playbackUrl = (id: string) => `/api/videos/${id}/file`;

export async function canWatch(repo: VideoRepository, actor: Actor | null, v: ListingVideo, listing: VideoListing): Promise<boolean> {
  if (v.status !== "ready" || v.archivedAt) return false;
  if (v.visibility === "public" && listing.status === "published") return true;
  if (!actor) return false;
  if (actor.userId === listing.ownerUserId || actor.userId === v.requestedBy) return true;
  if (actor.userType === "agent" && (await repo.isAppointedAgent(listing.id, actor.userId))) return true;
  if (v.teamId && (await repo.isTeamMember(v.teamId, actor.userId))) return true;
  return v.model === "buyer" && (await repo.hasPaid(listing.id, actor.userId));
}

/** Owner, appointed agents and the paying team see status; a buyer sees the video they paid for. */
export async function getVideo(repo: VideoRepository, actor: Actor | null, id: unknown): Promise<Result<VideoView>> {
  const v = isId(id) ? await repo.video(id) : undefined;
  const listing = v ? await repo.listing(v.listingId) : undefined;
  if (!v || !listing) return fail("not_found", "Video not found.");
  const manage = !!actor && (actor.userId === listing.ownerUserId || (await canManageVideos(repo, actor, listing)) || (!!v.teamId && (await repo.isTeamMember(v.teamId, actor.userId))));
  const watch = await canWatch(repo, actor, v, listing);
  const paid = !!actor && v.model === "buyer" && (await repo.hasPaid(listing.id, actor.userId));
  if (!manage && !watch && !paid) return fail("not_found", "Video not found.");
  return {
    ok: true,
    value: {
      id: v.id, listingId: v.listingId, model: v.model, status: v.status, visibility: v.visibility, requestedAt: v.requestedAt, generatedAt: v.generatedAt,
      error: manage ? v.error : "", playbackUrl: watch ? playbackUrl(v.id) : null, canManage: manage
    }
  };
}

/** What a listing page shows everyone: the published video if there is one. Otherwise the viewer's own paid one, if any. */
export async function videoForListing(repo: VideoRepository, actor: Actor | null, listingId: unknown): Promise<Result<{ video: VideoView | null; priceCents: number | null; canBuy: boolean }>> {
  const listing = isId(listingId) ? await repo.listing(listingId) : undefined;
  if (!listing || (listing.status !== "published" && !actor)) return fail("not_found", "Listing not found.");
  const pub = await repo.publicVideo(listing.id);
  if (pub) { const r = await getVideo(repo, actor, pub.id); return { ok: true, value: { video: r.ok ? r.value : null, priceCents: null, canBuy: false } }; }
  const mine = actor ? await repo.liveVideo(listing.id, "buyer") : undefined;
  if (mine && actor && (await repo.hasPaid(listing.id, actor.userId))) {
    const r = await getVideo(repo, actor, mine.id);
    return { ok: true, value: { video: r.ok ? r.value : null, priceCents: null, canBuy: false } };
  }
  return { ok: true, value: { video: null, priceCents: null, canBuy: listing.status === "published" } };
}

export async function publishVideo(repo: VideoRepository, actor: Actor, id: unknown, ids: VideoIds): Promise<Result<{ id: string }>> {
  const v = isId(id) ? await repo.video(id) : undefined;
  const listing = v ? await repo.listing(v.listingId) : undefined;
  if (!v || !listing || v.archivedAt || !(await canManageVideos(repo, actor, listing))) return fail("not_found", "Video not found.");
  if (v.model !== "team") return fail("invalid", "Only a team video can be published to everyone.");
  if (v.status !== "ready") return fail("conflict", "The video is not ready to publish yet.");
  await repo.setVisibility(v.id, "public", ids.now());
  await repo.appendAudit(audit(ids, actor.userId, "video.published", v.id, { listingId: v.listingId }));
  return { ok: true, value: { id: v.id } };
}

/** Delete or replace: the video leaves the listing, the file stays in storage (published files are never deleted here). */
export async function archiveVideo(repo: VideoRepository, actor: Actor, id: unknown, ids: VideoIds): Promise<Result<{ id: string }>> {
  const v = isId(id) ? await repo.video(id) : undefined;
  const listing = v ? await repo.listing(v.listingId) : undefined;
  if (!v || !listing || v.archivedAt || !(await canManageVideos(repo, actor, listing))) return fail("not_found", "Video not found.");
  if (v.model !== "team") return fail("forbidden", "A buyer's video belongs to the buyer who paid for it.");
  if (v.status === "processing" || v.status === "queued") return fail("conflict", "Wait for the video to finish or fail before deleting it.");
  await repo.archive(v.id, ids.now());
  await repo.appendAudit(audit(ids, actor.userId, "video.archived", v.id, { listingId: v.listingId }));
  return { ok: true, value: { id: v.id } };
}

export interface AgentVideoOverview { rows: AgentVideoRow[]; budget: BudgetView | null; role: Membership["role"] | null; teamId: string | null; costCents: number; suggestion: string | null }

export async function agentVideos(repo: VideoRepository, actor: Actor, pricing: VideoPricing, ids: VideoIds): Promise<Result<AgentVideoOverview>> {
  if (actor.userType !== "agent") return fail("forbidden", "Agents only.");
  const [rows, m] = await Promise.all([repo.agentOverview(actor.userId), repo.membership(actor.userId)]);
  const budget = m ? ((await repo.budget(m.teamId, monthStart(ids.now()))) ?? { teamId: m.teamId, monthlyBudgetCents: 0, spentCents: 0, remainingCents: 0, monthStart: monthStart(ids.now()) }) : null;
  return { ok: true, value: { rows, budget, role: m?.role ?? null, teamId: m?.teamId ?? null, costCents: pricing.teamCostCents, suggestion: elenaVideoSuggestion(rows) } };
}

/** Elena's nudge: the first appointed listing with enough photos but no video. */
export function elenaVideoSuggestion(rows: readonly AgentVideoRow[]): string | null {
  const withVideo = rows.filter(r => r.video && r.video.status !== "failed").length;
  const next = rows.find(r => (!r.video || r.video.status === "failed") && r.photoCount >= MIN_PHOTOS);
  if (!next) return null;
  return `${next.title} could use a video tour. ${withVideo} of your ${rows.length} listing${rows.length === 1 ? " has" : "s have"} one.`;
}

// ---- The queue ------------------------------------------------------------------------------------------------------

export interface QueueSummary { submitted: number; ready: number; retried: number; failed: number; waiting: number }
export interface QueueDeps { repo: VideoRepository; provider: VideoProvider; storage: ObjectStoragePort; ids: VideoIds }

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

async function failOrRetry(d: QueueDeps, v: ListingVideo, reason: string, s: QueueSummary, retryable = true): Promise<void> {
  const attempts = v.attempts + 1;
  const delay = retryable ? retryDelayMs(attempts) : undefined;
  const now = d.ids.now();
  if (delay === undefined || Date.parse(now) + delay > Date.parse(v.deadlineAt)) {
    await d.repo.markFailed(v.id, reason, now, audit(d.ids, v.requestedBy, "video.failed", v.id, { listingId: v.listingId, attempts, reason }, "system"));
    s.failed++;
  } else {
    await d.repo.scheduleRetry(v.id, attempts, at(now, delay), reason);
    s.retried++;
  }
}

async function processOne(d: QueueDeps, v: ListingVideo, s: QueueSummary): Promise<void> {
  const now = d.ids.now();
  if (Date.parse(now) > Date.parse(v.deadlineAt)) {
    await d.repo.markFailed(v.id, "Timed out waiting for the video.", now, audit(d.ids, v.requestedBy, "video.failed", v.id, { listingId: v.listingId, reason: "deadline" }, "system"));
    s.failed++;
    return;
  }
  if (!v.providerJobId) {
    try {
      const listing = await d.repo.listing(v.listingId);
      const files = await d.repo.photoFiles(v.listingId, 2);
      if (!listing || files.length < MIN_PHOTOS) return failOrRetry(d, v, "The listing does not have enough photos.", s, false);
      const images = await Promise.all(files.map(async f => ({ bytes: await d.storage.get(f.storageKey), contentType: f.contentType })));
      // Same key per attempt: if the reply is lost and we submit again, Hedra replays the job instead of charging twice.
      const { jobId } = await d.provider.submit({ images, prompt: videoPrompt(listing), idempotencyKey: `${v.id}:${v.attempts}` });
      await d.repo.markSubmitted(v.id, jobId, v.attempts, at(now, POLL_MS));
      s.submitted++;
    } catch (e) { await failOrRetry(d, v, msg(e), s); }
    return;
  }
  // A poll or download error says nothing about the Hedra job, so the job id is kept and only the check is repeated
  // (resubmitting could pay for a second job while the first still finishes). Only a FAILED report, or the deadline, ends an attempt.
  let r: JobPoll;
  try { r = await d.provider.poll(v.providerJobId); } catch { await d.repo.keepWaiting(v.id, at(now, POLL_MS)); s.waiting++; return; }
  if (r.state === "running") { await d.repo.keepWaiting(v.id, at(now, POLL_MS)); s.waiting++; return; }
  if (r.state === "failed") return failOrRetry(d, { ...v, providerJobId: null }, r.message, s);
  let file: { bytes: Uint8Array; contentType: string };
  try { file = await d.provider.download(r.downloadUrl); } catch { await d.repo.keepWaiting(v.id, at(now, POLL_MS)); s.waiting++; return; }
  try {
    if (file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_VIDEO_BYTES) return failOrRetry(d, v, "The video file was empty or too large.", s);
    const key = `listings/${v.listingId}/video-${v.id}`;
    const ct = r.contentType.startsWith("video/") ? r.contentType : "video/mp4";
    await d.storage.put(key, file.bytes, ct);
    await d.repo.markReady(v.id, key, ct, d.ids.now());
    s.ready++;
  } catch (e) { await d.repo.keepWaiting(v.id, at(now, POLL_MS)); s.waiting++; void e; }
}

/** One pass of the queue (called by the scheduler and, best effort, right after a request). Each due video is worked on at most once per pass. */
export async function runVideoQueue(d: QueueDeps, limit = 10): Promise<QueueSummary> {
  const s: QueueSummary = { submitted: 0, ready: 0, retried: 0, failed: 0, waiting: 0 };
  if (!d.provider.configured || !d.storage.configured) return s;
  const now = d.ids.now();
  const due = await d.repo.claimDue(now, at(now, LEASE_MS), limit);
  for (const v of due) await processOne(d, v, s);
  return s;
}
