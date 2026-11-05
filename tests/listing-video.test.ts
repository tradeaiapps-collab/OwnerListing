import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hedraVideoFromEnv } from "../src/adapters/hedra-video";
import type { ObjectStoragePort } from "../src/adapters/object-storage";
import type { Actor } from "../src/domain/listing-service";
import {
  DEADLINE_MS, MAX_ATTEMPTS, archiveVideo, canWatch, completeBuyerPurchase, elenaVideoSuggestion, getVideo, monthStart, publishVideo, requestTeamVideo,
  MAX_REFUND_ATTEMPTS, RefundError, REFUND_RETRY_MS, refundNoticeText, refundTrail, runVideoQueue, setTeamBudget, startBuyerPurchase, teamBudget, videoForListing, videoPricing, videoPrompt,
  type CheckoutPort, type JobPoll, type ListingVideo, type Purchase, type RefundPort, type VideoIds, type VideoProvider, type VideoRefund, type VideoRepository
} from "../src/domain/listing-video";
import { handleVideoStripeWebhook } from "../src/server/listing-video-db";
import { parseCheckoutEvent, stripeCheckoutFromEnv, stripeRefundsFromEnv, videoPaymentsEnabled } from "../src/server/stripe-checkout";

const LISTING = randomUUID(), OWNER = randomUUID(), AGENT = randomUUID(), OTHER_AGENT = randomUUID(), BUYER = randomUUID(), TEAM = randomUUID(), MANAGER = randomUUID();
const agent: Actor = { userId: AGENT, userType: "agent" };
const manager: Actor = { userId: MANAGER, userType: "agent" };
const buyer: Actor = { userId: BUYER, userType: "buyer" };
const pricing = videoPricing({});

function clock(start = "2026-11-05T01:00:00.000Z") {
  let t = Date.parse(start);
  const ids: VideoIds = { newId: () => randomUUID(), now: () => new Date(t).toISOString() };
  return { ids, advance: (ms: number) => { t += ms; } };
}

/** In-memory twin of the Postgres repository, with the same rules the SQL enforces (budget under lock, one live video per model, refund on failure). */
function fakeRepo(opts: { budgetCents?: number; photos?: number; listingStatus?: string } = {}) {
  const videos: ListingVideo[] = [];
  const ledger: { teamId: string; videoId: string; kind: "charge" | "refund"; cents: number; at: string }[] = [];
  const purchases: Purchase[] = [];
  const refunds: VideoRefund[] = [];
  const events = new Set<string>();
  const audits: string[] = [];
  const notified = new Set<string>();
  const state = { budget: opts.budgetCents as number | undefined, photos: opts.photos ?? 3, status: opts.listingStatus ?? "published" };
  const spent = (since: string) => ledger.filter(l => l.at >= since).reduce((a, l) => a + l.cents, 0);
  const live = (listingId: string, model: string) => videos.find(v => v.listingId === listingId && v.model === model && !v.archivedAt && v.status !== "failed");
  const repo: VideoRepository = {
    listing: async id => (id === LISTING ? { id, ownerUserId: OWNER, status: state.status, title: "12 Palm St", description: "Light-filled family home.", propertyType: "house", suburb: "Paddington" } : undefined),
    isAppointedAgent: async (l, u) => l === LISTING && (u === AGENT || u === MANAGER),
    membership: async u => (u === AGENT ? { teamId: TEAM, role: "agent" } : u === MANAGER ? { teamId: TEAM, role: "manager" } : undefined),
    isTeamMember: async (t, u) => t === TEAM && (u === AGENT || u === MANAGER),
    budget: async (t, m) => (t === TEAM && state.budget !== undefined ? { teamId: t, monthlyBudgetCents: state.budget, spentCents: spent(m), remainingCents: Math.max(0, state.budget - spent(m)), monthStart: m } : undefined),
    setBudget: async (_t, c, _b, a) => { state.budget = c; audits.push(a.eventType); },
    queueTeamVideo: async (v, m, a) => {
      if (state.budget === undefined || spent(m) + v.costCents > state.budget) return "budget";
      if (live(v.listingId, "team")) return "exists";
      videos.push({ ...v }); ledger.push({ teamId: v.teamId!, videoId: v.id, kind: "charge", cents: v.costCents, at: v.requestedAt }); audits.push(a.eventType);
      return "queued";
    },
    queueBuyerVideo: async v => { const e = live(v.listingId, "buyer"); if (e) return e; videos.push({ ...v }); return v; },
    video: async id => videos.find(v => v.id === id),
    videosForListing: async l => videos.filter(v => v.listingId === l),
    liveVideo: async (l, m) => live(l, m),
    publicVideo: async l => videos.find(v => v.listingId === l && v.visibility === "public" && v.status === "ready" && !v.archivedAt),
    setVisibility: async (id, vis) => { const v = videos.find(x => x.id === id); if (v) v.visibility = vis; return !!v; },
    archive: async (id, now) => { const v = videos.find(x => x.id === id); if (v) v.archivedAt = now; return !!v; },
    photoFiles: async (_l, max) => Array.from({ length: Math.min(state.photos, max) }, (_, i) => ({ storageKey: `listings/${LISTING}/p${i}`, contentType: "image/jpeg" })),
    agentOverview: async () => [{ listingId: LISTING, title: "12 Palm St", suburb: "Paddington", status: "published", photoCount: state.photos, video: null }],
    claimDue: async (now, lease, limit) => {
      const due = videos.filter(v => (v.status === "queued" || v.status === "processing") && !v.archivedAt && v.nextAttemptAt <= now).slice(0, limit);
      due.forEach(v => { v.nextAttemptAt = lease; });
      return due.map(v => ({ ...v }));
    },
    markSubmitted: async (id, job, attempts, next) => { Object.assign(videos.find(v => v.id === id)!, { status: "processing", providerJobId: job, attempts, nextAttemptAt: next }); },
    keepWaiting: async (id, next) => { videos.find(v => v.id === id)!.nextAttemptAt = next; },
    pullForward: async (job, now) => { const v = videos.find(x => x.providerJobId === job); if (v) v.nextAttemptAt = now; },
    markReady: async (id, key, ct, now) => { Object.assign(videos.find(v => v.id === id)!, { status: "ready", storageKey: key, contentType: ct, generatedAt: now }); },
    scheduleRetry: async (id, attempts, next, error) => { Object.assign(videos.find(v => v.id === id)!, { status: "queued", providerJobId: null, attempts, nextAttemptAt: next, error }); },
    markFailed: async (id, error, _now, a) => {
      const v = videos.find(x => x.id === id)!;
      Object.assign(v, { status: "failed", error }); audits.push(a.eventType);
      if (v.model === "team") ledger.push({ teamId: v.teamId!, videoId: id, kind: "refund", cents: -v.costCents, at: v.requestedAt });
      if (v.model === "buyer") {
        // Same rule as the SQL: one refund row per paid purchase of this video, never a second.
        for (const p of purchases.filter(x => x.videoId === id && x.status === "paid")) {
          if (refunds.some(r => r.purchaseId === p.id)) continue;
          refunds.push({ id: randomUUID(), purchaseId: p.id, videoId: id, listingId: p.listingId, buyerId: p.buyerId, amountCents: p.amountCents, reason: `Video generation failed: ${error}`, status: "pending", stripeRefundId: null, attempts: 0, lastError: "", createdAt: _now, refundedAt: null, paymentIntentId: p.paymentIntentId ?? null, nextAt: _now } as VideoRefund & { nextAt: string });
        }
      }
    },
    createPurchase: async p => { if (purchases.some(x => x.listingId === p.listingId && x.buyerId === p.buyerId && x.status === "pending")) return false; purchases.push({ ...p, createdAt: "2026-11-05T01:00:00.000Z" }); return true; },
    pendingPurchase: async (l, b) => purchases.find(p => p.listingId === l && p.buyerId === b && p.status === "pending"),
    attachCheckout: async (id, s, u) => { Object.assign(purchases.find(p => p.id === id)!, { sessionId: s, checkoutUrl: u }); },
    purchaseBySession: async s => purchases.find(p => p.sessionId === s),
    hasPaid: async (l, b) => purchases.some(p => p.listingId === l && p.buyerId === b && p.status === "paid" && !refunds.some(r => r.purchaseId === p.id)),
    settlePurchase: async (event, pid, vid, _now, a, pi) => {
      if (events.has(event)) return false;
      events.add(event); Object.assign(purchases.find(p => p.id === pid)!, { status: "paid", videoId: vid, paymentIntentId: pi ?? null }); audits.push(a.eventType);
      return true;
    },
    claimRefunds: async (now, lease, limit) => {
      const due = (refunds as (VideoRefund & { nextAt: string })[]).filter(r => r.status !== "succeeded" && r.attempts < MAX_REFUND_ATTEMPTS && r.nextAt <= now).slice(0, limit);
      due.forEach(r => { r.nextAt = lease; });
      return due.map(r => ({ ...r }));
    },
    markRefunded: async (id, stripeId, now, a) => {
      const r = refunds.find(x => x.id === id)!;
      if (r.status === "succeeded") return;
      Object.assign(r, { status: "succeeded", stripeRefundId: stripeId, refundedAt: now, attempts: r.attempts + 1 }); audits.push(a.eventType);
    },
    markRefundFailed: async (id, error, next, giveUp, a) => {
      const r = refunds.find(x => x.id === id)! as VideoRefund & { nextAt: string };
      Object.assign(r, { status: "failed", lastError: error, attempts: r.attempts + 1, nextAt: giveUp ? "9999" : next }); audits.push(a.eventType);
    },
    markRefundNotified: async id => { notified.add(id); },
    refundsForListing: async l => refunds.filter(r => r.listingId === l),
    expirePurchase: async s => { const p = purchases.find(x => x.sessionId === s); if (p) p.status = "expired"; },
    appendAudit: async e => { audits.push(e.eventType); }
  };
  return { repo, videos, ledger, purchases, refunds, notified, audits, state };
}

function fakeStorage(): ObjectStoragePort & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  objects.set(`listings/${LISTING}/p0`, new Uint8Array([1])); objects.set(`listings/${LISTING}/p1`, new Uint8Array([2]));
  return { configured: true, objects, put: async (k, b) => { objects.set(k, b); }, get: async k => { const b = objects.get(k); if (!b) throw new Error("missing"); return b; } };
}

function fakeProvider(script: JobPoll[] = [{ state: "ready", downloadUrl: "https://files.example/v.mp4", contentType: "video/mp4" }]) {
  const calls = { submit: [] as string[], poll: 0 };
  let job = 0;
  const p: VideoProvider & { fail: { submit: boolean } } = {
    configured: true, fail: { submit: false },
    async submit(i) { if (p.fail.submit) throw new Error("Hedra 503: busy"); calls.submit.push(i.idempotencyKey); return { jobId: `job_${++job}` }; },
    async poll() { calls.poll++; return script[Math.min(calls.poll - 1, script.length - 1)]!; },
    async download() { return { bytes: new Uint8Array([9, 9, 9]), contentType: "video/mp4" }; }
  };
  return { p, calls };
}

const checkout: CheckoutPort & { made: unknown[] } = {
  enabled: true, made: [],
  async createCheckout(i) { checkout.made.push(i); return { sessionId: `cs_${i.purchaseId}`, url: `https://checkout.stripe.com/${i.purchaseId}` }; }
};
const urls = { success: (id: string) => `https://x/listings/${id}?video=paid`, cancel: (id: string) => `https://x/listings/${id}` };

describe("team pays per video (model 1)", () => {
  it("queues a video, charges the team and keeps the spend inside the monthly budget", async () => {
    const { repo, ledger, audits } = fakeRepo({ budgetCents: 1000 });
    const { ids } = clock();
    const { p } = fakeProvider();
    const a = await requestTeamVideo(repo, agent, LISTING, pricing, p, ids);
    expect(a.ok && a.value.status).toBe("queued");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.cents).toBe(500);
    expect(audits).toContain("video.requested");
    expect((await teamBudget(repo, agent, TEAM, ids)).ok).toBe(true);
    const b = await teamBudget(repo, agent, TEAM, ids);
    expect(b.ok && b.value).toMatchObject({ monthlyBudgetCents: 1000, spentCents: 500, remainingCents: 500 });
  });

  it("refuses when the budget is used up, never queues, and a manager can raise it", async () => {
    const { repo, videos } = fakeRepo({ budgetCents: 400 });
    const { ids } = clock();
    const { p } = fakeProvider();
    const r = await requestTeamVideo(repo, agent, LISTING, pricing, p, ids);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    expect(videos).toHaveLength(0);
    expect(await setTeamBudget(repo, agent, TEAM, { monthlyBudgetCents: 5000 }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect((await setTeamBudget(repo, manager, TEAM, { monthlyBudgetCents: 5000 }, ids)).ok).toBe(true);
    expect((await requestTeamVideo(repo, agent, LISTING, pricing, p, ids)).ok).toBe(true);
  });

  it("has no budget until a manager sets one, and rejects fractional or negative budgets", async () => {
    const { repo } = fakeRepo();
    const { ids } = clock();
    expect(await requestTeamVideo(repo, agent, LISTING, pricing, fakeProvider().p, ids)).toMatchObject({ ok: false, code: "forbidden" });
    for (const bad of [-1, 1.5, "100", 2_000_000_000, null]) expect((await setTeamBudget(repo, manager, TEAM, { monthlyBudgetCents: bad }, ids)).ok).toBe(false);
  });

  it("only an agent appointed to the listing, in a team, with photos and a configured provider can generate", async () => {
    const { repo, state } = fakeRepo({ budgetCents: 5000 });
    const { ids } = clock();
    const { p } = fakeProvider();
    expect(await requestTeamVideo(repo, { userId: OTHER_AGENT, userType: "agent" }, LISTING, pricing, p, ids)).toMatchObject({ code: "not_found" });
    expect(await requestTeamVideo(repo, buyer, LISTING, pricing, p, ids)).toMatchObject({ code: "not_found" });
    expect(await requestTeamVideo(repo, agent, "nope", pricing, p, ids)).toMatchObject({ code: "invalid" });
    expect(await requestTeamVideo(repo, agent, LISTING, pricing, { configured: false }, ids)).toMatchObject({ code: "unavailable" });
    state.photos = 1;
    expect(await requestTeamVideo(repo, agent, LISTING, pricing, p, ids)).toMatchObject({ code: "invalid" });
  });

  it("answers conflict for a second live video, and replace works by deleting first", async () => {
    const { repo, videos } = fakeRepo({ budgetCents: 5000 });
    const { ids } = clock();
    const { p } = fakeProvider();
    const first = await requestTeamVideo(repo, agent, LISTING, pricing, p, ids);
    expect(await requestTeamVideo(repo, agent, LISTING, pricing, p, ids)).toMatchObject({ code: "conflict" });
    if (!first.ok) throw new Error("first");
    expect(await archiveVideo(repo, agent, first.value.id, ids)).toMatchObject({ ok: false, code: "conflict" }); // still queued
    videos[0]!.status = "ready";
    expect((await archiveVideo(repo, agent, first.value.id, ids)).ok).toBe(true);
    expect((await requestTeamVideo(repo, agent, LISTING, pricing, p, ids)).ok).toBe(true);
  });

  it("preview before publishing: private to the team until published, then public with the listing", async () => {
    const { repo, videos } = fakeRepo({ budgetCents: 5000 });
    const { ids } = clock();
    const r = await requestTeamVideo(repo, agent, LISTING, pricing, fakeProvider().p, ids);
    if (!r.ok) throw new Error("r");
    expect(await publishVideo(repo, agent, r.value.id, ids)).toMatchObject({ code: "conflict" }); // not ready
    Object.assign(videos[0]!, { status: "ready", storageKey: "k", contentType: "video/mp4" });
    const preview = await getVideo(repo, agent, r.value.id);
    expect(preview.ok && preview.value.playbackUrl).toBe(`/api/videos/${r.value.id}/file`);
    expect((await getVideo(repo, null, r.value.id)).ok).toBe(false);
    expect((await getVideo(repo, buyer, r.value.id)).ok).toBe(false);
    const listing = (await repo.listing(LISTING))!;
    expect(await canWatch(repo, null, videos[0]!, listing)).toBe(false);
    expect(await publishVideo(repo, buyer, r.value.id, ids)).toMatchObject({ code: "not_found" });
    expect((await publishVideo(repo, agent, r.value.id, ids)).ok).toBe(true);
    expect(await canWatch(repo, null, videos[0]!, listing)).toBe(true);
    const page = await videoForListing(repo, null, LISTING);
    expect(page.ok && page.value.video?.playbackUrl).toBeTruthy();
    expect(page.ok && page.value.canBuy).toBe(false);
  });

  it("month start is UTC, so the budget resets on the first", () => {
    expect(monthStart("2026-11-30T23:59:59.000Z")).toBe("2026-11-01T00:00:00.000Z");
    expect(monthStart("2026-12-01T00:00:00.000Z")).toBe("2026-12-01T00:00:00.000Z");
  });
});

describe("the queue", () => {
  async function queued(budget = 5000) {
    const f = fakeRepo({ budgetCents: budget });
    const c = clock();
    const q = await requestTeamVideo(f.repo, agent, LISTING, pricing, fakeProvider().p, c.ids);
    if (!q.ok) throw new Error("queue");
    return { ...f, ...c, id: q.value.id, storage: fakeStorage() };
  }

  it("submits, polls while running, then stores the file and marks it ready", async () => {
    const t = await queued();
    const { p, calls } = fakeProvider([{ state: "running" }, { state: "ready", downloadUrl: "https://files.example/v.mp4", contentType: "video/mp4" }]);
    const deps = { repo: t.repo, provider: p, storage: t.storage, ids: t.ids };
    expect(await runVideoQueue(deps)).toMatchObject({ submitted: 1 });
    expect(t.videos[0]!.status).toBe("processing");
    expect(await runVideoQueue(deps)).toMatchObject({ submitted: 0, waiting: 0 }); // not due yet
    t.advance(31_000);
    expect(await runVideoQueue(deps)).toMatchObject({ waiting: 1 });
    t.advance(31_000);
    expect(await runVideoQueue(deps)).toMatchObject({ ready: 1 });
    expect(t.videos[0]).toMatchObject({ status: "ready", storageKey: `listings/${LISTING}/video-${t.id}`, contentType: "video/mp4" });
    expect(t.storage.objects.get(t.videos[0]!.storageKey!)).toEqual(new Uint8Array([9, 9, 9]));
    expect(calls.poll).toBe(2);
    expect(t.ledger).toHaveLength(1); // charged once, no refund
  });

  it("retries a failed generation with a fresh idempotency key, then succeeds", async () => {
    const t = await queued();
    const { p, calls } = fakeProvider([{ state: "failed", message: "model overloaded" }, { state: "ready", downloadUrl: "https://files.example/v.mp4", contentType: "video/mp4" }]);
    const deps = { repo: t.repo, provider: p, storage: t.storage, ids: t.ids };
    await runVideoQueue(deps); // submit
    t.advance(31_000);
    expect(await runVideoQueue(deps)).toMatchObject({ retried: 1 });
    expect(t.videos[0]).toMatchObject({ status: "queued", attempts: 1, providerJobId: null, error: "model overloaded" });
    t.advance(3 * 60_000);
    await runVideoQueue(deps); // resubmit
    t.advance(31_000);
    expect(await runVideoQueue(deps)).toMatchObject({ ready: 1 });
    expect(new Set(calls.submit).size).toBe(2);
    expect(t.ledger.filter(l => l.kind === "refund")).toHaveLength(0);
  });

  it("after the last attempt the video fails and the team is refunded", async () => {
    const t = await queued();
    const { p } = fakeProvider([{ state: "failed", message: "bad" }]);
    const deps = { repo: t.repo, provider: p, storage: t.storage, ids: t.ids };
    for (let i = 0; i < MAX_ATTEMPTS * 2 + 2; i++) { await runVideoQueue(deps); t.advance(11 * 60_000); }
    expect(t.videos[0]!.status).toBe("failed");
    expect(t.ledger.map(l => l.kind)).toEqual(["charge", "refund"]);
    expect(t.ledger.reduce((a, l) => a + l.cents, 0)).toBe(0);
    expect(t.audits).toContain("video.failed");
  });

  it("a submit error is retried too, and a job past its deadline is failed instead of waiting forever", async () => {
    const t = await queued();
    const { p } = fakeProvider([{ state: "running" }]);
    const deps = { repo: t.repo, provider: p, storage: t.storage, ids: t.ids };
    p.fail.submit = true;
    expect(await runVideoQueue(deps)).toMatchObject({ retried: 1 });
    p.fail.submit = false;
    t.advance(3 * 60_000);
    await runVideoQueue(deps);
    for (let i = 0; i < 100 && t.videos[0]!.status !== "failed"; i++) { t.advance(10 * 60_000); await runVideoQueue(deps); }
    expect(t.videos[0]!.status).toBe("failed");
    expect(Date.parse(t.videos[0]!.deadlineAt) - Date.parse(t.videos[0]!.requestedAt)).toBe(DEADLINE_MS);
    expect(t.ledger.at(-1)!.kind).toBe("refund");
  });

  it("does nothing while Hedra or file storage is not configured, and the notice from Hedra pulls a job forward", async () => {
    const t = await queued();
    const { p } = fakeProvider([{ state: "running" }, { state: "running" }]);
    expect(await runVideoQueue({ repo: t.repo, provider: { ...p, configured: false } as VideoProvider, storage: t.storage, ids: t.ids })).toMatchObject({ submitted: 0 });
    expect(await runVideoQueue({ repo: t.repo, provider: p, storage: { ...t.storage, configured: false }, ids: t.ids })).toMatchObject({ submitted: 0 });
    await runVideoQueue({ repo: t.repo, provider: p, storage: t.storage, ids: t.ids });
    await t.repo.pullForward(t.videos[0]!.providerJobId!, t.ids.now());
    expect(await runVideoQueue({ repo: t.repo, provider: p, storage: t.storage, ids: t.ids })).toMatchObject({ waiting: 1 });
  });
});

describe("buyer pays at embed (model 2)", () => {
  const start = (f: ReturnType<typeof fakeRepo>, ids: VideoIds, actor: Actor = buyer, prov: Pick<VideoProvider, "configured"> = { configured: true }) =>
    startBuyerPurchase(f.repo, checkout, prov, actor, LISTING, pricing, urls, ids);

  it("sends the buyer to Checkout, makes the video only after the paid event, and shows it only to them", async () => {
    const f = fakeRepo();
    const { ids } = clock();
    const s = await start(f, ids);
    expect(s.ok && "checkoutUrl" in s.value && s.value.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(f.videos).toHaveLength(0); // nothing is generated, or charged to Hedra, before payment
    const sess = f.purchases[0]!.sessionId!;
    expect(f.purchases[0]).toMatchObject({ amountCents: 600, status: "pending" });
    expect(await completeBuyerPurchase(f.repo, "evt_1", sess, ids)).toBe("done");
    expect(await completeBuyerPurchase(f.repo, "evt_1", sess, ids)).toBe("repeat");
    expect(f.videos).toHaveLength(1);
    expect(f.videos[0]).toMatchObject({ model: "buyer", visibility: "private", costCents: 0 });
    expect(f.purchases[0]!.status).toBe("paid");
    Object.assign(f.videos[0]!, { status: "ready", storageKey: "k" });
    const mine = await videoForListing(f.repo, buyer, LISTING);
    expect(mine.ok && mine.value.video?.playbackUrl).toBeTruthy();
    const stranger = await videoForListing(f.repo, { userId: randomUUID(), userType: "buyer" }, LISTING);
    expect(stranger.ok && stranger.value.video).toBeNull();
    expect(stranger.ok && stranger.value.canBuy).toBe(true);
    expect(await completeBuyerPurchase(f.repo, "evt_2", "cs_missing", ids)).toBe("unknown");
  });

  it("a second buyer pays but shares the one generated video (Hedra is paid once)", async () => {
    const f = fakeRepo();
    const { ids } = clock();
    const other: Actor = { userId: randomUUID(), userType: "buyer" };
    await start(f, ids); await start(f, ids, other);
    await completeBuyerPurchase(f.repo, "evt_a", f.purchases[0]!.sessionId!, ids);
    await completeBuyerPurchase(f.repo, "evt_b", f.purchases[1]!.sessionId!, ids);
    expect(f.videos).toHaveLength(1);
    expect(f.purchases.every(p => p.status === "paid")).toBe(true);
  });

  it("never charges twice, and queues a free retry if the paid video had failed", async () => {
    const f = fakeRepo();
    const { ids } = clock();
    await start(f, ids);
    await completeBuyerPurchase(f.repo, "evt_1", f.purchases[0]!.sessionId!, ids);
    f.videos[0]!.status = "failed";
    const again = await start(f, ids);
    expect(again.ok && "alreadyPaid" in again.value).toBe(true);
    expect(f.purchases).toHaveLength(1);
    expect(f.videos.filter(v => v.status === "queued")).toHaveLength(1);
  });

  it("is refused for unpublished listings, a published public video, missing providers and photos", async () => {
    const f = fakeRepo({ listingStatus: "draft" });
    const { ids } = clock();
    expect(await start(f, ids)).toMatchObject({ code: "not_found" });
    f.state.status = "published";
    expect(await start(f, ids, buyer, { configured: false })).toMatchObject({ code: "unavailable" });
    expect(await startBuyerPurchase(f.repo, { ...checkout, enabled: false }, { configured: true }, buyer, LISTING, pricing, urls, ids)).toMatchObject({ code: "unavailable" });
    f.state.photos = 1;
    expect(await start(f, ids)).toMatchObject({ code: "invalid" });
    f.state.photos = 3;
    f.videos.push({ id: randomUUID(), listingId: LISTING, model: "team", visibility: "public", status: "ready" } as ListingVideo);
    expect(await start(f, ids)).toMatchObject({ code: "conflict" });
    expect(f.purchases).toHaveLength(0);
  });

  it("a Checkout failure leaves no video and no charge", async () => {
    const f = fakeRepo();
    const { ids } = clock();
    const r = await startBuyerPurchase(f.repo, { enabled: true, createCheckout: async () => { throw new Error("stripe down"); } }, { configured: true }, buyer, LISTING, pricing, urls, ids);
    expect(r).toMatchObject({ ok: false, code: "unavailable" });
    expect(f.videos).toHaveLength(0);
  });
});

describe("Elena", () => {
  it("suggests a video for the first listing that has photos but no video", () => {
    const row = { listingId: "a", title: "12 Palm St", suburb: "", status: "published", photoCount: 4, video: null };
    expect(elenaVideoSuggestion([row])).toContain("12 Palm St could use a video tour");
    expect(elenaVideoSuggestion([{ ...row, photoCount: 1 }])).toBeNull();
    expect(elenaVideoSuggestion([{ ...row, video: { id: "v", status: "ready", visibility: "public", requestedAt: "", generatedAt: "", error: "", attempts: 0 } }])).toBeNull();
  });
  it("builds a bounded prompt from the listing", () => {
    const p = videoPrompt({ title: "t", propertyType: "town_house", suburb: "Paddington", description: "x".repeat(5000) });
    expect(p.length).toBeLessThanOrEqual(2400);
    expect(p).toContain("town house in Paddington");
  });
});

describe("Hedra adapter", () => {
  const env = { HEDRA_API_KEY: "hedra_test_key", HEDRA_WEBHOOK_URL: "https://site.example/api/webhooks/hedra" };
  function mockFetch() {
    const seen: { url: string; init?: RequestInit }[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/files")) return Response.json({ url: `https://files.hedra.test/${seen.length}`, content_type: "image/jpeg", expires_at: "x" }, { status: 201 });
      if (url.endsWith("/models/kling-v3")) return Response.json({ job_id: "job_9", status: "IN_QUEUE" }, { status: 202 });
      if (url.endsWith("/jobs/job_9")) return Response.json({ status: "COMPLETED", outputs: [{ status: "COMPLETED", url: "https://cdn.hedra.test/v.mp4", content_type: "video/mp4" }] });
      if (url.endsWith("/jobs/job_bad")) return Response.json({ status: "FAILED", error: { message: "nsfw" } });
      if (url.endsWith("/jobs/job_run")) return Response.json({ status: "IN_PROGRESS" });
      if (url.endsWith("/jobs/job_err")) return Response.json({ error: { message: "nope" } }, { status: 500 });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
    }) as unknown as typeof fetch;
    return { impl, seen };
  }
  const img = { bytes: new Uint8Array([1]), contentType: "image/jpeg" };

  it("is off without a key", () => { expect(hedraVideoFromEnv({}).configured).toBe(false); expect(hedraVideoFromEnv(env).configured).toBe(true); });

  it("uploads two photos then submits kling-v3 with the key, an idempotency key and the webhook", async () => {
    const { impl, seen } = mockFetch();
    const r = await hedraVideoFromEnv(env, impl).submit({ images: [img, img], prompt: "tour", idempotencyKey: "vid:0" });
    expect(r.jobId).toBe("job_9");
    const submit = seen.find(s => s.url.endsWith("/models/kling-v3"))!;
    const headers = submit.init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("hedra_test_key");
    expect(headers["idempotency-key"]).toBe("vid:0");
    const body = JSON.parse(String(submit.init!.body));
    expect(body.webhook).toBe(env.HEDRA_WEBHOOK_URL);
    expect(body.input).toMatchObject({ aspect_ratio: "16:9", duration_ms: 10000, generate_audio: false, prompt: "tour" });
    expect(body.input.start_image.url).not.toBe(body.input.end_image.url);
    expect(seen.filter(s => s.url.endsWith("/files"))).toHaveLength(2);
  });

  it("maps job states, treats a failed job as failed and surfaces API errors", async () => {
    const { impl } = mockFetch();
    const h = hedraVideoFromEnv(env, impl);
    expect(await h.poll("job_9")).toEqual({ state: "ready", downloadUrl: "https://cdn.hedra.test/v.mp4", contentType: "video/mp4" });
    expect(await h.poll("job_run")).toEqual({ state: "running" });
    expect(await h.poll("job_bad")).toEqual({ state: "failed", message: "nsfw" });
    await expect(h.poll("job_err")).rejects.toThrow(/Hedra 500: nope/);
    await expect(h.download("http://insecure.test/v.mp4")).rejects.toThrow(/non-https/);
    expect((await h.download("https://cdn.hedra.test/v.mp4")).bytes).toHaveLength(3);
    await expect(h.submit({ images: [img], prompt: "x", idempotencyKey: "k" })).rejects.toThrow(/Two photos/);
  });
});

describe("Stripe Checkout and the video webhook", () => {
  const key = "sk_test_abcdefgh12345678";
  it("is off unless enabled, and refuses live keys", () => {
    expect(videoPaymentsEnabled({ STRIPE_SECRET_KEY: key })).toBe(false);
    expect(videoPaymentsEnabled({ STRIPE_SECRET_KEY: key, VIDEO_PAYMENTS_ENABLED: "1" })).toBe(true);
    expect(videoPaymentsEnabled({ STRIPE_SECRET_KEY: "sk_live_abcdefgh12345678", VIDEO_PAYMENTS_ENABLED: "1" })).toBe(false);
    expect(videoPaymentsEnabled({ STRIPE_SECRET_KEY: "sk_live_abcdefgh12345678", VIDEO_PAYMENTS_ENABLED: "1", VIDEO_PAYMENTS_ALLOW_LIVE: "1" })).toBe(true);
  });

  it("creates a hosted Checkout session for the exact amount in AUD, idempotently", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const impl = (async (url: string, init: RequestInit) => { sent = { url, init }; return Response.json({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }); }) as unknown as typeof fetch;
    const r = await stripeCheckoutFromEnv({ STRIPE_SECRET_KEY: key, VIDEO_PAYMENTS_ENABLED: "1" }, impl).createCheckout({
      purchaseId: "p1", amountCents: 600, description: "Tour video", successUrl: "https://x/s", cancelUrl: "https://x/c"
    });
    expect(r).toEqual({ sessionId: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
    const form = new URLSearchParams(String(sent!.init.body));
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("600");
    expect(form.get("line_items[0][price_data][currency]")).toBe("aud");
    expect(form.get("mode")).toBe("payment");
    expect((sent!.init.headers as Record<string, string>)["idempotency-key"]).toBe("video-p1");
  });

  const secret = "whsec_test_secret";
  const sign = (body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const paid = (id = "evt_1") => JSON.stringify({ id, type: "checkout.session.completed", data: { object: { id: "cs_x", payment_status: "paid" } } });

  it("parses paid and expired sessions and ignores the rest", () => {
    expect(parseCheckoutEvent(paid())).toEqual({ eventId: "evt_1", kind: "paid", sessionId: "cs_x" });
    expect(parseCheckoutEvent(JSON.stringify({ id: "e", type: "checkout.session.completed", data: { object: { id: "cs", payment_status: "unpaid" } } }))).toBeUndefined();
    expect(parseCheckoutEvent(JSON.stringify({ id: "e", type: "checkout.session.expired", data: { object: { id: "cs" } } }))).toMatchObject({ kind: "expired" });
    expect(parseCheckoutEvent("{")).toBeNull();
  });

  it("verifies the signature, fails closed without a secret, and settles a payment once", async () => {
    const f = fakeRepo();
    const { ids } = clock();
    await startBuyerPurchase(f.repo, checkout, { configured: true }, buyer, LISTING, pricing, urls, ids);
    f.purchases[0]!.sessionId = "cs_x";
    const body = paid();
    expect((await handleVideoStripeWebhook(f.repo, body, sign(body), undefined, ids)).status).toBe(503);
    expect((await handleVideoStripeWebhook(f.repo, body, "t=1,v1=" + "0".repeat(64), secret, ids)).status).toBe(401);
    expect((await handleVideoStripeWebhook(f.repo, body, null, secret, ids)).status).toBe(401);
    expect(f.videos).toHaveLength(0);
    expect((await handleVideoStripeWebhook(f.repo, body, sign(body), secret, ids)).body).toMatchObject({ result: "done" });
    expect((await handleVideoStripeWebhook(f.repo, body, sign(body), secret, ids)).body).toMatchObject({ result: "repeat" });
    expect(f.videos).toHaveLength(1);
    const expired = JSON.stringify({ id: "evt_2", type: "checkout.session.expired", data: { object: { id: "cs_x" } } });
    expect((await handleVideoStripeWebhook(f.repo, expired, sign(expired), secret, ids)).status).toBe(200);
  });
});

describe("review fixes", () => {
  it("a poll or download error keeps the Hedra job and never resubmits", async () => {
    const f = fakeRepo({ budgetCents: 5000 });
    const c = clock();
    const q = await requestTeamVideo(f.repo, agent, LISTING, pricing, fakeProvider().p, c.ids);
    if (!q.ok) throw new Error("q");
    const { p, calls } = fakeProvider();
    let boom = true;
    p.poll = async () => { if (boom) throw new Error("timeout"); return { state: "ready", downloadUrl: "https://files.example/v.mp4", contentType: "video/mp4" }; };
    const deps = { repo: f.repo, provider: p, storage: fakeStorage(), ids: c.ids };
    await runVideoQueue(deps);
    const job = f.videos[0]!.providerJobId;
    c.advance(31_000);
    expect(await runVideoQueue(deps)).toMatchObject({ waiting: 1, retried: 0 });
    expect(f.videos[0]).toMatchObject({ providerJobId: job, attempts: 0, status: "processing" });
    boom = false;
    c.advance(31_000);
    expect(await runVideoQueue(deps)).toMatchObject({ ready: 1 });
    expect(calls.submit).toHaveLength(1);
  });

  it("a double click reuses the open Checkout instead of opening a second payment", async () => {
    const f = fakeRepo();
    const { ids } = clock();
    const a = await startBuyerPurchase(f.repo, checkout, { configured: true }, buyer, LISTING, pricing, urls, ids);
    const b = await startBuyerPurchase(f.repo, checkout, { configured: true }, buyer, LISTING, pricing, urls, ids);
    expect(a.ok && b.ok && "checkoutUrl" in a.value && "checkoutUrl" in b.value && a.value.checkoutUrl === b.value.checkoutUrl).toBe(true);
    expect(f.purchases).toHaveLength(1);
    expect(checkout.made.filter(m => (m as { purchaseId: string }).purchaseId === f.purchases[0]!.id)).toHaveLength(1);
  });
});

describe("refunds for failed buyer videos", () => {
  /** A buyer paid for a video (payment intent recorded) and Hedra then fails it for good. */
  async function paidThenFailed() {
    const f = fakeRepo();
    const c = clock();
    await startBuyerPurchase(f.repo, checkout, { configured: true }, buyer, LISTING, pricing, urls, c.ids);
    f.purchases[0]!.sessionId = "cs_r";
    await completeBuyerPurchase(f.repo, "evt_r", "cs_r", c.ids, "pi_123");
    const { p } = fakeProvider([{ state: "failed", message: "nsfw" }]);
    return { f, c, p };
  }
  const refundPort = (impl: RefundPort["refund"]): RefundPort & { calls: Parameters<RefundPort["refund"]>[0][] } => {
    const calls: Parameters<RefundPort["refund"]>[0][] = [];
    return { enabled: true, calls, refund: async i => { calls.push(i); return impl(i); } };
  };
  const failVideo = async (x: Awaited<ReturnType<typeof paidThenFailed>>, refunds: RefundPort, notify?: (r: VideoRefund) => Promise<boolean>) => {
    const deps = { repo: x.f.repo, provider: x.p, storage: fakeStorage(), ids: x.c.ids, refunds, ...(notify ? { notify } : {}) };
    let last = await runVideoQueue(deps);
    for (let i = 0; i < 200 && x.f.videos[0]!.status !== "failed"; i++) { x.c.advance(10 * 60_000); last = await runVideoQueue(deps); }
    return { deps, last };
  };

  it("a failed video refunds the paid buyer through Stripe and tells them", async () => {
    const x = await paidThenFailed();
    const port = refundPort(async () => ({ stripeRefundId: "re_1" }));
    const told: string[] = [];
    const { deps } = await failVideo(x, port, async r => { told.push(refundNoticeText(r.amountCents)); return true; });
    expect(x.f.videos[0]!.status).toBe("failed");
    expect(x.f.refunds).toHaveLength(1);
    expect(x.f.refunds[0]).toMatchObject({ status: "pending", amountCents: 600, reason: expect.stringContaining("Video generation failed:") });
    const s = await runVideoQueue(deps);
    expect(s.refunded).toBe(1);
    expect(port.calls).toEqual([{ paymentIntentId: "pi_123", amountCents: 600, idempotencyKey: `video-refund-${x.f.refunds[0]!.id}`, refundId: x.f.refunds[0]!.id }]);
    expect(x.f.refunds[0]).toMatchObject({ status: "succeeded", stripeRefundId: "re_1" });
    expect(x.f.refunds[0]!.refundedAt).not.toBeNull();
    expect(x.f.audits).toContain("video.refunded");
    expect(told).toEqual(["Video generation failed. Your $6 has been refunded to your card. Try again anytime."]);
    expect(x.f.notified.has(x.f.refunds[0]!.id)).toBe(true);
    // The refunded buyer is no longer treated as having paid: trying again means paying again.
    expect(await x.f.repo.hasPaid(LISTING, BUYER)).toBe(false);
  });

  it("a Stripe failure keeps the refund for a later try, then succeeds without telling the buyer early", async () => {
    const x = await paidThenFailed();
    let fail = true;
    const port = refundPort(async () => { if (fail) throw new RefundError("Stripe 500", false); return { stripeRefundId: "re_2" }; });
    let notices = 0;
    const { deps } = await failVideo(x, port, async () => { notices++; return true; });
    expect(await runVideoQueue(deps)).toMatchObject({ refunded: 0, refundFailed: 1 });
    expect(x.f.refunds[0]).toMatchObject({ status: "failed", attempts: 1, lastError: "Stripe 500" });
    expect(notices).toBe(0);
    expect(x.f.audits).toContain("video.refund_failed");
    expect(await runVideoQueue(deps)).toMatchObject({ refunded: 0, refundFailed: 0 }); // backing off, not due yet
    fail = false;
    x.c.advance(REFUND_RETRY_MS + 1000);
    expect(await runVideoQueue(deps)).toMatchObject({ refunded: 1 });
    expect(x.f.refunds[0]).toMatchObject({ status: "succeeded", stripeRefundId: "re_2", attempts: 2 });
    expect(notices).toBe(1);
  });

  it("a permanent error or too many failures stops retrying and leaves it failed for staff", async () => {
    const x = await paidThenFailed();
    const port = refundPort(async () => { throw new RefundError("Stripe 400 charge_disputed", true); });
    const { deps } = await failVideo(x, port);
    await runVideoQueue(deps);
    x.c.advance(24 * 3600_000);
    await runVideoQueue(deps);
    expect(port.calls).toHaveLength(1);
    expect(x.f.refunds[0]).toMatchObject({ status: "failed", attempts: 1 });
    const trail = await refundTrail(x.f.repo, LISTING);
    expect(trail.ok && trail.value.refunds[0]).toMatchObject({ status: "failed", lastError: "Stripe 400 charge_disputed" });
    expect(trail.ok && JSON.stringify(trail.value)).not.toContain("pi_123"); // staff never see the payment id
  });

  it("never refunds the same payment twice: a repeat failure, a re-run and a duplicate webhook add nothing", async () => {
    const x = await paidThenFailed();
    const port = refundPort(async () => ({ stripeRefundId: "re_3" }));
    const { deps } = await failVideo(x, port);
    await runVideoQueue(deps);
    await x.f.repo.markFailed(x.f.videos[0]!.id, "again", x.c.ids.now(), { id: randomUUID(), occurredAt: x.c.ids.now(), actorType: "system", actorId: BUYER, aggregateType: "listing_video", aggregateId: "v", eventType: "video.failed", correlationId: "c", payload: {} });
    expect(x.f.refunds).toHaveLength(1);
    expect(await completeBuyerPurchase(x.f.repo, "evt_r", "cs_r", x.c.ids, "pi_123")).toBe("repeat");
    for (let i = 0; i < 3; i++) { x.c.advance(REFUND_RETRY_MS); await runVideoQueue(deps); }
    expect(port.calls).toHaveLength(1);
    expect(x.f.refunds).toHaveLength(1);
  });

  it("a purchase without a recorded payment is parked for staff instead of calling Stripe", async () => {
    const x = await paidThenFailed();
    x.f.purchases[0]!.paymentIntentId = null;
    const port = refundPort(async () => ({ stripeRefundId: "re_x" }));
    const { deps } = await failVideo(x, port);
    await runVideoQueue(deps);
    expect(port.calls).toHaveLength(0);
    expect(x.f.refunds[0]).toMatchObject({ status: "failed", lastError: expect.stringContaining("No Stripe payment") });
  });

  it("does nothing while refunds are disabled, and team videos still use the ledger", async () => {
    const x = await paidThenFailed();
    const port = { ...refundPort(async () => ({ stripeRefundId: "re_y" })), enabled: false };
    const { deps } = await failVideo(x, port);
    expect(await runVideoQueue(deps)).toMatchObject({ refunded: 0 });
    expect(port.calls).toHaveLength(0);
    expect(x.f.refunds[0]!.status).toBe("pending"); // waits for payments to be switched on
    const t = fakeRepo({ budgetCents: 5000 });
    const c = clock();
    await requestTeamVideo(t.repo, agent, LISTING, pricing, fakeProvider().p, c.ids);
    await t.repo.markFailed(t.videos[0]!.id, "x", c.ids.now(), { id: randomUUID(), occurredAt: c.ids.now(), actorType: "system", actorId: AGENT, aggregateType: "listing_video", aggregateId: "v", eventType: "video.failed", correlationId: "c", payload: {} });
    expect(t.refunds).toHaveLength(0);
    expect(t.ledger.map(l => l.kind)).toEqual(["charge", "refund"]);
  });

  it("the Stripe adapter refunds the exact amount idempotently and maps errors", async () => {
    const env = { STRIPE_SECRET_KEY: "sk_test_abcdefgh12345678", VIDEO_PAYMENTS_ENABLED: "1" };
    let sent: { url: string; init: RequestInit } | undefined;
    const ok = (async (url: string, init: RequestInit) => { sent = { url, init }; return Response.json({ id: "re_ok" }); }) as unknown as typeof fetch;
    expect(await stripeRefundsFromEnv(env, ok).refund({ paymentIntentId: "pi_1", amountCents: 600, idempotencyKey: "video-refund-r1", refundId: "r1" })).toEqual({ stripeRefundId: "re_ok" });
    expect(sent!.url).toBe("https://api.stripe.com/v1/refunds");
    const form = new URLSearchParams(String(sent!.init.body));
    expect(form.get("payment_intent")).toBe("pi_1");
    expect(form.get("amount")).toBe("600");
    expect((sent!.init.headers as Record<string, string>)["idempotency-key"]).toBe("video-refund-r1");
    const err = (status: number, code: string) => (async () => Response.json({ error: { code } }, { status })) as unknown as typeof fetch;
    const call = (f: typeof fetch) => stripeRefundsFromEnv(env, f).refund({ paymentIntentId: "pi_1", amountCents: 600, idempotencyKey: "k", refundId: "r1" });
    expect(await call(err(400, "charge_already_refunded"))).toEqual({ stripeRefundId: "already_refunded" });
    await expect(call(err(400, "charge_disputed"))).rejects.toMatchObject({ permanent: true });
    await expect(call(err(500, "api_error"))).rejects.toMatchObject({ permanent: false });
    await expect(call(err(429, "rate_limit"))).rejects.toMatchObject({ permanent: false });
    await expect(call((async () => { throw new Error("net"); }) as unknown as typeof fetch)).rejects.toMatchObject({ permanent: false });
    expect(stripeRefundsFromEnv({ STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }).enabled).toBe(false);
  });

  it("the payment intent travels from the webhook to the purchase", async () => {
    const body = JSON.stringify({ id: "evt_pi", type: "checkout.session.completed", data: { object: { id: "cs_x", payment_status: "paid", payment_intent: "pi_77" } } });
    expect(parseCheckoutEvent(body)).toEqual({ eventId: "evt_pi", kind: "paid", sessionId: "cs_x", paymentIntentId: "pi_77" });
    const f = fakeRepo();
    const { ids } = clock();
    await startBuyerPurchase(f.repo, checkout, { configured: true }, buyer, LISTING, pricing, urls, ids);
    f.purchases[0]!.sessionId = "cs_x";
    const secret = "whsec_test_secret";
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
    await handleVideoStripeWebhook(f.repo, body, sig, secret, ids);
    expect(f.purchases[0]!.paymentIntentId).toBe("pi_77");
  });
});
