import type { Commission } from "../domain/agency-team";
import type { Payout, PayoutAccount, PayoutProvider, TeamPayoutRepository, KycStatus } from "../domain/team-payout";
import { getDb } from "./context";
import { appendAuditPg, type Queryable } from "./db";
import { sendNotice } from "./messaging";
import { createStripePayoutProvider } from "./stripe-payouts";

// Constant SQL text; input only travels as bound parameters. Nothing here deletes a payout.
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const s = (v: unknown) => String(v);

export const GET_ACCOUNT_SQL = "SELECT user_id, provider_account_id, kyc_status FROM payout_account WHERE user_id = $1::uuid";
export const SAVE_ACCOUNT_SQL =
  "INSERT INTO payout_account (user_id, provider_account_id) VALUES ($1::uuid, $2) ON CONFLICT (user_id) DO NOTHING";
export const SET_KYC_SQL = "UPDATE payout_account SET kyc_status = $2, updated_at = now() WHERE provider_account_id = $1 RETURNING user_id";
export const IS_MANAGER_SQL = "SELECT 1 FROM agency_team_member WHERE team_id = $1::uuid AND user_id = $2::uuid AND role = 'manager' AND removed_at IS NULL";
export const GET_COMMISSION_SQL =
  "SELECT id, team_id, member_user_id, listing_id, description, gross_cents, member_bps, member_cents, office_cents, status, payout_reference, created_at, approved_at, paid_at " +
  "FROM agency_commission WHERE team_id = $1::uuid AND id = $2::uuid";
export const USER_EMAIL_SQL = "SELECT email::text AS email FROM app_user WHERE id = $1::uuid";
export const INSERT_PAYOUT_SQL =
  "INSERT INTO team_payout (id, commission_id, team_id, member_user_id, amount_cents, initiated_by, created_at, updated_at) " +
  "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, $7::timestamptz, $7::timestamptz) ON CONFLICT DO NOTHING RETURNING id";
export const MARK_SENT_SQL = "UPDATE team_payout SET status = 'sent', provider_transfer_id = $2, updated_at = $3::timestamptz WHERE id = $1::uuid AND status = 'pending'";
export const MARK_FAILED_SQL = "UPDATE team_payout SET status = 'failed', failure_reason = $2, updated_at = $3::timestamptz WHERE id = $1::uuid AND status IN ('pending','sent')";
/** Params: 1 transfer id, 2 new status, 3 reason, 4 now. Only a sent payout settles, and a failed one never comes back. */
export const SETTLE_PAYOUT_SQL =
  "UPDATE team_payout SET status = $2, failure_reason = $3, updated_at = $4::timestamptz, paid_at = CASE WHEN $2 = 'paid' THEN $4::timestamptz ELSE NULL END " +
  "WHERE provider_transfer_id = $1 AND status = 'sent' RETURNING id, commission_id, team_id, member_user_id, amount_cents, status, provider_transfer_id, failure_reason, created_at, paid_at";
export const PAY_COMMISSION_SQL =
  "UPDATE agency_commission SET status = 'paid', paid_at = $3::timestamptz, payout_reference = $2 WHERE id = $1::uuid AND status = 'approved'";
export const CLAIM_EVENT_SQL = "INSERT INTO payout_webhook_event (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id";
const PAYOUT_COLS = "id, commission_id, team_id, member_user_id, amount_cents, status, provider_transfer_id, failure_reason, created_at, paid_at";
export const LIST_PAYOUTS_SQL =
  `SELECT ${PAYOUT_COLS} FROM team_payout WHERE team_id = $1::uuid AND ($2::uuid IS NULL OR member_user_id = $2::uuid) ORDER BY created_at DESC, id LIMIT 200`;

const toPayout = (r: Record<string, unknown>): Payout => ({
  id: s(r["id"]), commissionId: s(r["commission_id"]), teamId: s(r["team_id"]), memberUserId: s(r["member_user_id"]), amountCents: Number(r["amount_cents"]),
  status: s(r["status"]) as Payout["status"], providerTransferId: r["provider_transfer_id"] === null ? null : s(r["provider_transfer_id"]),
  failureReason: s(r["failure_reason"]), createdAt: iso(r["created_at"]), paidAt: r["paid_at"] === null || r["paid_at"] === undefined ? null : iso(r["paid_at"])
});
const toAccount = (r: Record<string, unknown>): PayoutAccount => ({ userId: s(r["user_id"]), providerAccountId: s(r["provider_account_id"]), kycStatus: s(r["kyc_status"]) as KycStatus });
const toCommission = (r: Record<string, unknown>): Commission => ({
  id: s(r["id"]), teamId: s(r["team_id"]), memberUserId: s(r["member_user_id"]), listingId: r["listing_id"] === null ? null : s(r["listing_id"]),
  description: s(r["description"]), grossCents: Number(r["gross_cents"]), memberBps: Number(r["member_bps"]), memberCents: Number(r["member_cents"]),
  officeCents: Number(r["office_cents"]), status: s(r["status"]) as Commission["status"], payoutReference: s(r["payout_reference"]),
  createdAt: iso(r["created_at"]), approvedAt: r["approved_at"] === null ? null : iso(r["approved_at"]), paidAt: r["paid_at"] === null ? null : iso(r["paid_at"])
});

export function createPgTeamPayoutRepository(db: Queryable): TeamPayoutRepository {
  return {
    async getAccount(userId) { const r = (await db.query(GET_ACCOUNT_SQL, [userId])).rows[0]; return r ? toAccount(r) : undefined; },
    async saveAccount(userId, providerAccountId) {
      await db.query(SAVE_ACCOUNT_SQL, [userId, providerAccountId]);
      return toAccount((await db.query(GET_ACCOUNT_SQL, [userId])).rows[0]!);
    },
    async setKycByProviderAccount(id, status) { return (await db.query(SET_KYC_SQL, [id, status])).rows.length > 0; },
    async isManager(teamId, userId) { return (await db.query(IS_MANAGER_SQL, [teamId, userId])).rows.length > 0; },
    async getCommission(teamId, id) { const r = (await db.query(GET_COMMISSION_SQL, [teamId, id])).rows[0]; return r ? toCommission(r) : undefined; },
    async userEmail(userId) { const r = (await db.query(USER_EMAIL_SQL, [userId])).rows[0]; return r ? s(r["email"]) : undefined; },
    createPayout: (p, by, audit) => atomic(db, async tx => {
      const ok = (await tx.query(INSERT_PAYOUT_SQL, [p.id, p.commissionId, p.teamId, p.memberUserId, p.amountCents, by, p.createdAt])).rows.length > 0;
      if (ok) await appendAuditPg(tx, audit);
      return ok ? p : undefined;
    }),
    async markSent(id, transferId, now) { await db.query(MARK_SENT_SQL, [id, transferId, now]); },
    markFailed: (id, reason, now, audit) => atomic(db, async tx => {
      await tx.query(MARK_FAILED_SQL, [id, reason, now]);
      await appendAuditPg(tx, audit);
    }),
    settleByTransfer: (transferId, outcome, reason, now, audit) => atomic(db, async tx => {
      const r = (await tx.query(SETTLE_PAYOUT_SQL, [transferId, outcome, reason, now])).rows[0];
      if (!r) return undefined;
      if (outcome === "paid") await tx.query(PAY_COMMISSION_SQL, [s(r["commission_id"]), `stripe:${transferId}`, now]);
      await appendAuditPg(tx, audit);
      return toPayout(r);
    }),
    async claimEvent(id) { return (await db.query(CLAIM_EVENT_SQL, [id])).rows.length > 0; },
    async listPayouts(teamId, member) { return (await db.query(LIST_PAYOUTS_SQL, [teamId, member ?? null])).rows.map(toPayout); }
  };
}

export const getTeamPayoutRepo = () => createPgTeamPayoutRepository(getDb());
export const getPayoutProvider = (): PayoutProvider => createStripePayoutProvider();

const aud = (cents: number) => `A$${(cents / 100).toFixed(2)}`;
/** Email to the member. Never throws and never blocks the payout (sendNotice logs to the outbox). */
export async function emailPayout(to: string, amountCents: number, kind: "sent" | "paid"): Promise<void> {
  const subject = kind === "sent" ? `Your payout of ${aud(amountCents)} is on its way` : `Your payout of ${aud(amountCents)} was paid`;
  const text = kind === "sent"
    ? `Your agency has sent you ${aud(amountCents)}. Your payment provider will move it to your bank account, usually within a few business days.`
    : `Your payout of ${aud(amountCents)} has been confirmed by the payment provider and is on its way to your bank account.`;
  await sendNotice(getDb(), `payout_${kind}`, to, { subject, text });
}
