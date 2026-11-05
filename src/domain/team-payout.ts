import type { AuditEvent } from "./audit";
import type { Actor, Result } from "./listing-service";
import type { Commission, TeamIds } from "./agency-team";

// Real payouts for approved team commissions. Money moves only at the provider (Stripe Connect); this module decides who may
// start a payout and keeps our record in step. Off unless the server is configured for it (see PayoutProvider.enabled).
// Recipients are identity-checked (KYC) by the provider before they can be paid. No card or bank numbers pass through here.

export type PayoutStatus = "pending" | "sent" | "paid" | "failed";
export type KycStatus = "pending" | "verified" | "restricted";

export interface PayoutAccount { userId: string; providerAccountId: string; kycStatus: KycStatus }
export interface Payout {
  id: string; commissionId: string; teamId: string; memberUserId: string; amountCents: number; status: PayoutStatus;
  providerTransferId: string | null; failureReason: string; createdAt: string; paidAt: string | null;
}

/** What the provider adapter must do. Amounts are whole AUD cents. */
export interface PayoutProvider {
  /** False when keys are missing or a live key is used without explicit permission; nothing below is called then. */
  enabled(): boolean;
  createAccount(user: { userId: string; email: string }): Promise<{ accountId: string }>;
  /** A hosted page where the person enters identity and bank details. */
  onboardingLink(accountId: string, urls: { returnUrl: string; refreshUrl: string }): Promise<{ url: string }>;
  /** idempotencyKey makes a retried call return the same transfer instead of paying twice. */
  transfer(input: { accountId: string; amountCents: number; idempotencyKey: string; metadata: Record<string, string> }): Promise<{ transferId: string }>;
}

export interface TeamPayoutRepository {
  getAccount(userId: string): Promise<PayoutAccount | undefined>;
  /** Insert-if-absent; returns the stored row (the first writer wins). */
  saveAccount(userId: string, providerAccountId: string): Promise<PayoutAccount>;
  setKycByProviderAccount(providerAccountId: string, status: KycStatus): Promise<boolean>;
  isManager(teamId: string, userId: string): Promise<boolean>;
  getCommission(teamId: string, id: string): Promise<Commission | undefined>;
  userEmail(userId: string): Promise<string | undefined>;
  /** Reserves the commission. Undefined when a live payout already exists (the unique index). */
  createPayout(p: Payout, initiatedBy: string, audit: AuditEvent): Promise<Payout | undefined>;
  markSent(id: string, transferId: string, now: string): Promise<void>;
  markFailed(id: string, reason: string, now: string, audit: AuditEvent): Promise<void>;
  /** Webhook: transfer confirmed. Also moves the commission approved->paid. Returns the payout when it changed, else undefined. */
  settleByTransfer(transferId: string, outcome: "paid" | "failed", reason: string, now: string, audit: AuditEvent): Promise<Payout | undefined>;
  /** Records an event id; false if it was seen before. */
  claimEvent(eventId: string): Promise<boolean>;
  listPayouts(teamId: string, memberUserId?: string): Promise<Payout[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = { ok: false, code: "not_found", message: "Not found." } as const;
const fail = (code: "invalid" | "forbidden" | "conflict" | "unavailable", message: string) => ({ ok: false as const, code, message });
const off = () => fail("unavailable", "Payouts are not switched on yet.");

const audit = (ids: TeamIds, actorId: string | null, aggregateId: string, eventType: string, payload: Record<string, unknown>): AuditEvent => ({
  id: ids.newId(), occurredAt: ids.now(), actorType: actorId ? "user" : "service", actorId: actorId ?? "system:stripe-webhook", aggregateType: "team_payout", aggregateId, eventType, correlationId: ids.newId(), payload
});

/** The member sets up (or resumes) their own payout account and gets the provider's hosted onboarding link. */
export async function startPayoutOnboarding(
  repo: TeamPayoutRepository, provider: PayoutProvider, actor: Actor, email: string, urls: { returnUrl: string; refreshUrl: string }
): Promise<Result<{ url: string; kycStatus: KycStatus }>> {
  if (!provider.enabled()) return off();
  let acct = await repo.getAccount(actor.userId);
  if (!acct) {
    const created = await provider.createAccount({ userId: actor.userId, email });
    acct = await repo.saveAccount(actor.userId, created.accountId);
  }
  const link = await provider.onboardingLink(acct.providerAccountId, urls);
  return { ok: true, value: { url: link.url, kycStatus: acct.kycStatus } };
}

/** Manager pays one approved commission. The member must have finished the provider's identity check. */
export async function initiatePayout(
  repo: TeamPayoutRepository, provider: PayoutProvider, actor: Actor, teamId: string, commissionId: string, ids: TeamIds,
  notify: (to: string, amountCents: number, kind: "sent") => Promise<void> = async () => {}
): Promise<Result<Payout>> {
  if (!provider.enabled()) return off();
  if (!UUID.test(teamId) || !UUID.test(commissionId)) return notFound;
  if (!(await repo.isManager(teamId, actor.userId))) return notFound;
  const c = await repo.getCommission(teamId, commissionId);
  if (!c) return notFound;
  if (c.status !== "approved") return fail("conflict", "Only an approved commission can be paid.");
  if (c.memberUserId === actor.userId) return fail("forbidden", "Another manager must pay your own commission.");
  if (c.memberCents <= 0) return fail("invalid", "Nothing to pay on this commission.");
  const acct = await repo.getAccount(c.memberUserId);
  if (!acct || acct.kycStatus !== "verified") return fail("conflict", "The member has not finished identity verification for payouts.");
  const now = ids.now();
  const draft: Payout = {
    id: ids.newId(), commissionId, teamId, memberUserId: c.memberUserId, amountCents: c.memberCents, status: "pending",
    providerTransferId: null, failureReason: "", createdAt: now, paidAt: null
  };
  const reserved = await repo.createPayout(draft, actor.userId, audit(ids, actor.userId, draft.id, "team_payout.created", { teamId, commissionId, amountCents: draft.amountCents }));
  if (!reserved) return fail("conflict", "This commission already has a payout.");
  try {
    // The payout id is the idempotency key: a retry after a timeout cannot pay twice.
    const t = await provider.transfer({ accountId: acct.providerAccountId, amountCents: draft.amountCents, idempotencyKey: `payout-${draft.id}`, metadata: { payoutId: draft.id, commissionId } });
    await repo.markSent(draft.id, t.transferId, ids.now());
    const to = await repo.userEmail(c.memberUserId);
    if (to) await notify(to, draft.amountCents, "sent");
    return { ok: true, value: { ...draft, status: "sent", providerTransferId: t.transferId } };
  } catch (e) {
    const reason = (e instanceof Error ? e.message : "Provider error").slice(0, 300);
    await repo.markFailed(draft.id, reason, ids.now(), audit(ids, actor.userId, draft.id, "team_payout.failed", { reason }));
    return fail("unavailable", "The payment provider rejected the payout. Nothing was paid.");
  }
}

export type ProviderEvent =
  | { id: string; kind: "account"; providerAccountId: string; kycStatus: KycStatus }
  | { id: string; kind: "transfer"; transferId: string; outcome: "paid" | "failed"; reason: string };

/** Applies one verified provider event once. Unknown ids are ignored, so a retry or a foreign event does nothing. */
export async function applyProviderEvent(
  repo: TeamPayoutRepository, e: ProviderEvent, ids: TeamIds, notify: (userId: string, p: Payout) => Promise<void> = async () => {}
): Promise<"applied" | "duplicate" | "ignored"> {
  if (!(await repo.claimEvent(e.id))) return "duplicate";
  if (e.kind === "account") return (await repo.setKycByProviderAccount(e.providerAccountId, e.kycStatus)) ? "applied" : "ignored";
  const p = await repo.settleByTransfer(e.transferId, e.outcome, e.reason, ids.now(), audit(ids, null, e.transferId, `team_payout.${e.outcome}`, { transferId: e.transferId, reason: e.reason }));
  if (!p) return "ignored";
  if (e.outcome === "paid") await notify(p.memberUserId, p);
  return "applied";
}

/** Managers see the team's payouts; others see only their own. */
export async function listPayouts(repo: TeamPayoutRepository, actor: Actor, teamId: string): Promise<Result<Payout[]>> {
  if (!UUID.test(teamId)) return notFound;
  const manager = await repo.isManager(teamId, actor.userId);
  return { ok: true, value: await repo.listPayouts(teamId, manager ? undefined : actor.userId) };
}

/** Manager only: which of these members have finished the provider's identity check (so the Pay button can be shown). */
export async function verifiedMembers(repo: TeamPayoutRepository, actor: Actor, teamId: string, userIds: string[]): Promise<string[]> {
  if (!UUID.test(teamId) || !(await repo.isManager(teamId, actor.userId))) return [];
  const out: string[] = [];
  for (const u of [...new Set(userIds.filter(x => UUID.test(x)))].slice(0, 100)) if ((await repo.getAccount(u))?.kycStatus === "verified") out.push(u);
  return out;
}
