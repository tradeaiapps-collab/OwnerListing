import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Commission } from "../src/domain/agency-team";
import { applyProviderEvent, initiatePayout, startPayoutOnboarding, type Payout, type PayoutAccount, type PayoutProvider, type TeamPayoutRepository } from "../src/domain/team-payout";
import { createStripePayoutProvider, handleStripeWebhook, parseStripeEvent, payoutsEnabled, stripeSignatureValid } from "../src/server/stripe-payouts";

const TEAM = randomUUID(), BOSS = randomUUID(), MEMBER = randomUUID(), COMM = randomUUID();
const ids = { newId: () => randomUUID(), now: () => "2026-11-05T00:00:00.000Z" };
const boss = { userId: BOSS, userType: "agent" as const };
const commission = (o: Partial<Commission> = {}): Commission => ({
  id: COMM, teamId: TEAM, memberUserId: MEMBER, listingId: null, description: "", grossCents: 1_000_000, memberBps: 7000, memberCents: 700_000,
  officeCents: 300_000, status: "approved", payoutReference: "", createdAt: ids.now(), approvedAt: ids.now(), paidAt: null, ...o
});

function fakeRepo(c: Commission = commission(), kyc: PayoutAccount["kycStatus"] | null = "verified") {
  const payouts: Payout[] = [];
  const events = new Set<string>();
  const state = { commission: c, kyc, audits: [] as string[] };
  const repo: TeamPayoutRepository = {
    getAccount: async u => (u === MEMBER && state.kyc ? { userId: u, providerAccountId: "acct_1", kycStatus: state.kyc } : undefined),
    saveAccount: async (u, a) => ({ userId: u, providerAccountId: a, kycStatus: "pending" }),
    setKycByProviderAccount: async (a, k) => { if (a !== "acct_1") return false; state.kyc = k; return true; },
    isManager: async (t, u) => t === TEAM && u === BOSS,
    getCommission: async (t, id) => (t === TEAM && id === COMM ? state.commission : undefined),
    userEmail: async () => "m@example.com",
    createPayout: async (p, _by, a) => { if (payouts.some(x => x.commissionId === p.commissionId && x.status !== "failed")) return undefined; payouts.push({ ...p }); state.audits.push(a.eventType); return p; },
    markSent: async (id, t) => { Object.assign(payouts.find(p => p.id === id)!, { status: "sent", providerTransferId: t }); },
    markFailed: async (id, r, _n, a) => { Object.assign(payouts.find(p => p.id === id)!, { status: "failed", failureReason: r }); state.audits.push(a.eventType); },
    settleByTransfer: async (t, outcome, reason, now) => {
      const p = payouts.find(x => x.providerTransferId === t && x.status === "sent");
      if (!p) return undefined;
      Object.assign(p, { status: outcome, failureReason: reason, paidAt: outcome === "paid" ? now : null });
      if (outcome === "paid") state.commission = { ...state.commission, status: "paid" };
      return p;
    },
    claimEvent: async id => { if (events.has(id)) return false; events.add(id); return true; },
    listPayouts: async () => payouts
  };
  return { repo, payouts, state };
}
const provider = (over: Partial<PayoutProvider> = {}): PayoutProvider & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls, enabled: () => true,
    createAccount: async () => ({ accountId: "acct_1" }), onboardingLink: async () => ({ url: "https://connect.stripe.com/x" }),
    transfer: async i => { calls.push(i); return { transferId: "tr_1" }; }, ...over
  };
};

describe("initiatePayout", () => {
  it("pays the member's share once, emails, and then refuses a second payout", async () => {
    const { repo, payouts } = fakeRepo(); const p = provider(); const mails: unknown[] = [];
    const r = await initiatePayout(repo, p, boss, TEAM, COMM, ids, async (to, c) => { mails.push([to, c]); });
    expect(r).toMatchObject({ ok: true, value: { status: "sent", amountCents: 700_000, providerTransferId: "tr_1" } });
    expect(p.calls).toMatchObject([{ accountId: "acct_1", amountCents: 700_000, idempotencyKey: `payout-${payouts[0]!.id}` }]);
    expect(mails).toEqual([["m@example.com", 700_000]]);
    expect(await initiatePayout(repo, p, boss, TEAM, COMM, ids)).toMatchObject({ ok: false, code: "conflict" });
    expect(p.calls).toHaveLength(1);
  });
  it("does nothing while payouts are off, for non-managers, unapproved entries, own commission and unverified members", async () => {
    const off = provider({ enabled: () => false });
    expect(await initiatePayout(fakeRepo().repo, off, boss, TEAM, COMM, ids)).toMatchObject({ ok: false, code: "unavailable" });
    const p = provider();
    expect(await initiatePayout(fakeRepo().repo, p, { userId: randomUUID(), userType: "agent" }, TEAM, COMM, ids)).toMatchObject({ code: "not_found" });
    expect(await initiatePayout(fakeRepo(commission({ status: "recorded" })).repo, p, boss, TEAM, COMM, ids)).toMatchObject({ code: "conflict" });
    expect(await initiatePayout(fakeRepo(commission({ memberUserId: BOSS })).repo, p, boss, TEAM, COMM, ids)).toMatchObject({ code: "forbidden" });
    expect(await initiatePayout(fakeRepo(commission(), "pending").repo, p, boss, TEAM, COMM, ids)).toMatchObject({ code: "conflict" });
    expect(await initiatePayout(fakeRepo(commission(), null).repo, p, boss, TEAM, COMM, ids)).toMatchObject({ code: "conflict" });
    expect(p.calls).toHaveLength(0);
  });
  it("records a provider failure and lets the commission be paid again", async () => {
    const { repo, payouts } = fakeRepo();
    const bad = provider({ transfer: async () => { throw new Error("Stripe 402: insufficient funds"); } });
    expect(await initiatePayout(repo, bad, boss, TEAM, COMM, ids)).toMatchObject({ ok: false, code: "unavailable" });
    expect(payouts[0]).toMatchObject({ status: "failed", failureReason: "Stripe 402: insufficient funds" });
    expect(await initiatePayout(repo, provider(), boss, TEAM, COMM, ids)).toMatchObject({ ok: true });
  });
});

describe("provider events", () => {
  it("confirms a sent transfer once, marks the commission paid, and ignores repeats and unknown transfers", async () => {
    const { repo, state } = fakeRepo(); await initiatePayout(repo, provider(), boss, TEAM, COMM, ids);
    const seen: string[] = [];
    const ev = { id: "evt_1", kind: "transfer" as const, transferId: "tr_1", outcome: "paid" as const, reason: "" };
    expect(await applyProviderEvent(repo, ev, ids, async u => { seen.push(u); })).toBe("applied");
    expect(state.commission.status).toBe("paid");
    expect(seen).toEqual([MEMBER]);
    expect(await applyProviderEvent(repo, ev, ids)).toBe("duplicate");
    expect(await applyProviderEvent(repo, { ...ev, id: "evt_2", transferId: "tr_other" }, ids)).toBe("ignored");
  });
  it("a reversed transfer fails the payout without marking the commission paid", async () => {
    const { repo, state, payouts } = fakeRepo(); await initiatePayout(repo, provider(), boss, TEAM, COMM, ids);
    expect(await applyProviderEvent(repo, { id: "e", kind: "transfer", transferId: "tr_1", outcome: "failed", reason: "r" }, ids)).toBe("applied");
    expect([payouts[0]!.status, state.commission.status]).toEqual(["failed", "approved"]);
  });
  it("account.updated sets KYC status", async () => {
    const { repo, state } = fakeRepo(commission(), "pending");
    expect(await applyProviderEvent(repo, { id: "a1", kind: "account", providerAccountId: "acct_1", kycStatus: "verified" }, ids)).toBe("applied");
    expect(state.kyc).toBe("verified");
    expect(await applyProviderEvent(repo, { id: "a2", kind: "account", providerAccountId: "acct_x", kycStatus: "verified" }, ids)).toBe("ignored");
  });
});

describe("onboarding", () => {
  it("creates the account once and returns the hosted link; refuses while off", async () => {
    const { repo } = fakeRepo(commission(), null);
    expect(await startPayoutOnboarding(repo, provider(), { userId: MEMBER, userType: "agent" }, "m@example.com", { returnUrl: "a", refreshUrl: "b" })).toMatchObject({ ok: true, value: { url: "https://connect.stripe.com/x" } });
    expect(await startPayoutOnboarding(repo, provider({ enabled: () => false }), { userId: MEMBER, userType: "agent" }, "m@example.com", { returnUrl: "a", refreshUrl: "b" })).toMatchObject({ code: "unavailable" });
  });
});

describe("Stripe adapter", () => {
  const sign = (body: string, secret: string, t: number) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const now = 1_800_000_000;
  it("verifies signatures, rejects tampering, old timestamps and malformed headers", () => {
    const body = '{"id":"evt_1"}';
    expect(stripeSignatureValid(body, sign(body, "whsec_a", now), "whsec_a", now)).toBe(true);
    expect(stripeSignatureValid(body + " ", sign(body, "whsec_a", now), "whsec_a", now)).toBe(false);
    expect(stripeSignatureValid(body, sign(body, "whsec_b", now), "whsec_a", now)).toBe(false);
    expect(stripeSignatureValid(body, sign(body, "whsec_a", now - 301), "whsec_a", now)).toBe(false);
    for (const h of [null, "", "garbage", "t=1,v1=zz"]) expect(stripeSignatureValid(body, h, "whsec_a", now)).toBe(false);
  });
  it("maps events and the webhook fails closed", async () => {
    const acct = JSON.stringify({ id: "evt_a", type: "account.updated", data: { object: { id: "acct_1", details_submitted: true, payouts_enabled: true } } });
    expect(parseStripeEvent(acct)).toMatchObject({ kind: "account", kycStatus: "verified" });
    expect(parseStripeEvent(JSON.stringify({ id: "e", type: "account.updated", data: { object: { id: "a", requirements: { disabled_reason: "rejected.fraud" } } } }))).toMatchObject({ kycStatus: "restricted" });
    expect(parseStripeEvent(JSON.stringify({ id: "e", type: "charge.succeeded", data: { object: { id: "c" } } }))).toBeUndefined();
    expect(parseStripeEvent("nope")).toBeNull();
    const { repo } = fakeRepo();
    expect(await handleStripeWebhook(repo, acct, null, undefined, ids)).toMatchObject({ status: 503 });
    expect(await handleStripeWebhook(repo, acct, "t=1,v1=" + "0".repeat(64), "whsec_a", ids)).toMatchObject({ status: 401 });
    const t = Math.floor(Date.now() / 1000);
    expect(await handleStripeWebhook(repo, acct, sign(acct, "whsec_a", t), "whsec_a", ids)).toMatchObject({ status: 200, body: { result: "applied" } });
  });
  it("is enabled only with the flag and a test key; a live key needs explicit permission", () => {
    const k = "sk_test_abcdefgh1234";
    expect(payoutsEnabled({})).toBe(false);
    expect(payoutsEnabled({ STRIPE_SECRET_KEY: k })).toBe(false);
    expect(payoutsEnabled({ STRIPE_SECRET_KEY: k, PAYOUTS_ENABLED: "1" })).toBe(true);
    expect(payoutsEnabled({ STRIPE_SECRET_KEY: "sk_live_abcdefgh1234", PAYOUTS_ENABLED: "1" })).toBe(false);
    expect(payoutsEnabled({ STRIPE_SECRET_KEY: "sk_live_abcdefgh1234", PAYOUTS_ENABLED: "1", PAYOUTS_ALLOW_LIVE: "1" })).toBe(true);
    expect(payoutsEnabled({ STRIPE_SECRET_KEY: "not-a-key", PAYOUTS_ENABLED: "1" })).toBe(false);
  });
  it("sends the transfer with an idempotency key and AUD, and surfaces Stripe errors", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(JSON.stringify({ id: "tr_9" }), { status: 200 }); }) as unknown as typeof fetch;
    const p = createStripePayoutProvider({ STRIPE_SECRET_KEY: "sk_test_abcdefgh1234", PAYOUTS_ENABLED: "1" }, f);
    expect(await p.transfer({ accountId: "acct_1", amountCents: 500, idempotencyKey: "k1", metadata: { payoutId: "p" } })).toEqual({ transferId: "tr_9" });
    expect(seen[0]!.url).toBe("https://api.stripe.com/v1/transfers");
    expect((seen[0]!.init.headers as Record<string, string>)["idempotency-key"]).toBe("k1");
    expect(String(seen[0]!.init.body)).toContain("currency=aud");
    const bad = createStripePayoutProvider({ STRIPE_SECRET_KEY: "sk_test_abcdefgh1234", PAYOUTS_ENABLED: "1" }, (async () => new Response(JSON.stringify({ error: { message: "no funds" } }), { status: 402 })) as unknown as typeof fetch);
    await expect(bad.transfer({ accountId: "a", amountCents: 1, idempotencyKey: "k", metadata: {} })).rejects.toThrow("Stripe 402: no funds");
  });
});
