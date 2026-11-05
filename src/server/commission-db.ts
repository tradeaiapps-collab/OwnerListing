import { randomUUID } from "node:crypto";
import {
  computeCommission, effectiveCents, parseTerms,
  type CommissionDeal, type CommissionPayout, type CommissionTerms, type DealStatus, type NewDealInput, type PayoutInput, type PayoutStatus
} from "../domain/commission";
import { appendAuditPg, type Queryable } from "./db";

// Constant SQL text; user input only travels as bound parameters. Each write and its audit_event row run in one transaction, and the deal
// row is locked first so two staff members cannot change the same deal at once. Nothing here deletes a row (db trigger blocks it too).

export type Out<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));

const DEAL_COLS =
  "d.id, d.agent_user_id, COALESCE(u.display_name, u.email::text) AS agent_name, d.listing_id, d.title, d.sale_price_cents, d.kind, d.rate_bps, d.fixed_cents, d.tiers, " +
  "d.calculated_cents, d.override_cents, d.override_reason, d.override_at, d.status, to_char(d.deal_date,'YYYY-MM-DD') AS deal_date, " +
  "to_char(d.settlement_date,'YYYY-MM-DD') AS settlement_date, d.closed_reason, d.created_at";
const DEAL_FROM = "FROM commission_deal d JOIN app_user u ON u.id = d.agent_user_id";
const PAYOUT_COLS =
  "p.id, p.deal_id, p.agent_user_id, to_char(p.due_date,'YYYY-MM-DD') AS due_date, p.amount_cents, p.status, p.paid_at, p.payment_reference";

export const AGENT_DEALS_SQL = `SELECT ${DEAL_COLS} ${DEAL_FROM} WHERE d.agent_user_id = $1::uuid ORDER BY d.deal_date DESC, d.created_at DESC LIMIT 500`;
export const AGENT_PAYOUTS_SQL = `SELECT ${PAYOUT_COLS} FROM commission_payout p WHERE p.agent_user_id = $1::uuid ORDER BY p.due_date, p.created_at LIMIT 2000`;
export const ALL_DEALS_SQL = `SELECT ${DEAL_COLS} ${DEAL_FROM} WHERE ($1::text IS NULL OR d.status = $1::text) AND ($2::uuid IS NULL OR d.agent_user_id = $2::uuid) ORDER BY d.deal_date DESC, d.created_at DESC LIMIT 1000`;
export const ALL_PAYOUTS_SQL = `SELECT ${PAYOUT_COLS} FROM commission_payout p WHERE ($1::uuid IS NULL OR p.agent_user_id = $1::uuid) ORDER BY p.due_date, p.created_at LIMIT 5000`;
const DEAL_ONE_SQL = `SELECT ${DEAL_COLS} ${DEAL_FROM} WHERE d.id = $1::uuid`;
const LOCK_DEAL_SQL = "SELECT id, status, calculated_cents, override_cents FROM commission_deal WHERE id = $1::uuid FOR UPDATE";
const DEAL_PAYOUTS_SQL = `SELECT ${PAYOUT_COLS} FROM commission_payout p WHERE p.deal_id = $1::uuid ORDER BY p.due_date, p.created_at`;
const CHECK_AGENT_SQL = "SELECT 1 FROM app_user WHERE id = $1::uuid AND user_type = 'agent' AND status NOT IN ('suspended','closed')";
const CHECK_LISTING_SQL = "SELECT 1 FROM property_listing WHERE id = $1::uuid";
const INSERT_DEAL_SQL =
  "INSERT INTO commission_deal (id, agent_user_id, listing_id, title, sale_price_cents, kind, rate_bps, fixed_cents, tiers, calculated_cents, deal_date, settlement_date, created_by) " +
  "VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::date,$12::date,$13::uuid)";
const INSERT_PAYOUT_SQL =
  "INSERT INTO commission_payout (id, deal_id, agent_user_id, due_date, amount_cents) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::date,$5)";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());

function termsOf(r: Record<string, unknown>): CommissionTerms {
  const raw = r["kind"] === "percentage" ? { kind: "percentage", bps: Number(r["rate_bps"]) }
    : r["kind"] === "fixed" ? { kind: "fixed", fixedCents: Number(r["fixed_cents"]) }
    : { kind: "tiered", tiers: r["tiers"] };
  const t = parseTerms(raw);
  if (!t.ok) throw new Error("Stored commission terms are invalid.");
  return t.value;
}

export const dealFromRow = (r: Record<string, unknown>): CommissionDeal => ({
  id: String(r["id"]), agentUserId: String(r["agent_user_id"]), agentName: String(r["agent_name"] ?? ""), listingId: r["listing_id"] ? String(r["listing_id"]) : null,
  title: String(r["title"]), salePriceCents: Number(r["sale_price_cents"]), terms: termsOf(r), calculatedCents: Number(r["calculated_cents"]),
  overrideCents: r["override_cents"] == null ? null : Number(r["override_cents"]), overrideReason: r["override_reason"] ? String(r["override_reason"]) : null,
  overrideAt: iso(r["override_at"]), status: String(r["status"]) as DealStatus, dealDate: String(r["deal_date"]),
  settlementDate: r["settlement_date"] ? String(r["settlement_date"]) : null, closedReason: r["closed_reason"] ? String(r["closed_reason"]) : null, createdAt: iso(r["created_at"])!
});
export const payoutFromRow = (r: Record<string, unknown>): CommissionPayout => ({
  id: String(r["id"]), dealId: String(r["deal_id"]), agentUserId: String(r["agent_user_id"]), dueDate: String(r["due_date"]), amountCents: Number(r["amount_cents"]),
  status: String(r["status"]) as PayoutStatus, paidAt: iso(r["paid_at"]), paymentReference: r["payment_reference"] ? String(r["payment_reference"]) : null
});

export interface StaffRef { id: string; role: string }
const audit = (tx: Queryable, staff: StaffRef, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendAuditPg(tx, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: staff.id, aggregateType: "commission_deal", aggregateId,
    eventType, correlationId: randomUUID(), payload: { role: staff.role, ...payload }
  });

export async function agentCommissions(db: Queryable, agentUserId: string) {
  const [d, p] = await Promise.all([db.query(AGENT_DEALS_SQL, [agentUserId]), db.query(AGENT_PAYOUTS_SQL, [agentUserId])]);
  return { deals: d.rows.map(dealFromRow), payouts: p.rows.map(payoutFromRow) };
}

export async function allCommissions(db: Queryable, filter: { status?: DealStatus; agentUserId?: string } = {}) {
  const [d, p] = await Promise.all([
    db.query(ALL_DEALS_SQL, [filter.status ?? null, filter.agentUserId ?? null]), db.query(ALL_PAYOUTS_SQL, [filter.agentUserId ?? null])
  ]);
  return { deals: d.rows.map(dealFromRow), payouts: p.rows.map(payoutFromRow) };
}

export async function getDeal(db: Queryable, id: string) {
  const d = (await db.query(DEAL_ONE_SQL, [id])).rows[0];
  if (!d) return null;
  return { deal: dealFromRow(d), payouts: (await db.query(DEAL_PAYOUTS_SQL, [id])).rows.map(payoutFromRow) };
}

export async function createDeal(db: Queryable, staff: StaffRef, input: NewDealInput): Promise<Out<{ id: string }>> {
  if ((await db.query(CHECK_AGENT_SQL, [input.agentUserId])).rows.length === 0) return no(404, "That agent was not found or cannot be used.");
  if (input.listingId && (await db.query(CHECK_LISTING_SQL, [input.listingId])).rows.length === 0) return no(404, "That listing was not found.");
  const id = randomUUID(), calculated = computeCommission(input.terms, input.salePriceCents), t = input.terms;
  await atomic(db, async tx => {
    await tx.query(INSERT_DEAL_SQL, [
      id, input.agentUserId, input.listingId, input.title, input.salePriceCents, t.kind, t.kind === "percentage" ? t.bps : null,
      t.kind === "fixed" ? t.fixedCents : null, t.kind === "tiered" ? JSON.stringify(t.tiers) : null, calculated, input.dealDate, input.settlementDate, staff.id
    ]);
    for (const p of input.schedule) await tx.query(INSERT_PAYOUT_SQL, [randomUUID(), id, input.agentUserId, p.dueDate, p.amountCents]);
    await audit(tx, staff, id, "commission.deal_created", { agentUserId: input.agentUserId, salePriceCents: input.salePriceCents, kind: t.kind, calculatedCents: calculated, payouts: input.schedule.length });
  });
  return { ok: true, value: { id } };
}

/** Locks the deal and hands its row and payouts to `fn`; returns 404 when it does not exist. */
async function withDeal<T>(db: Queryable, dealId: string, fn: (tx: Queryable, deal: Record<string, unknown>) => Promise<Out<T>>): Promise<Out<T>> {
  return atomic(db, async tx => {
    const row = (await tx.query(LOCK_DEAL_SQL, [dealId])).rows[0];
    return row ? fn(tx, row) : no(404, "Deal not found.");
  });
}

const paidTotal = async (tx: Queryable, dealId: string) =>
  Number((await tx.query("SELECT COALESCE(sum(amount_cents),0) AS n FROM commission_payout WHERE deal_id = $1::uuid AND status = 'paid'", [dealId])).rows[0]!["n"]);

/** Staff override of the commission amount (null clears it back to the calculated amount). Needs a reason; logged. */
export function overrideDeal(db: Queryable, staff: StaffRef, dealId: string, overrideCents: number | null, reason: string) {
  return withDeal<{ effectiveCents: number }>(db, dealId, async (tx, row) => {
    if (row["status"] === "cancelled") return no(409, "A cancelled deal cannot be changed.");
    const effective = overrideCents ?? Number(row["calculated_cents"]);
    if (effective < (await paidTotal(tx, dealId))) return no(409, "The commission cannot be lower than what has already been paid.");
    const at = new Date().toISOString();
    await tx.query(
      "UPDATE commission_deal SET override_cents = $2, override_reason = $3, override_by = $4::uuid, override_at = $5::timestamptz, updated_at = now() WHERE id = $1::uuid",
      overrideCents === null ? [dealId, null, null, null, null] : [dealId, overrideCents, reason, staff.id, at]
    );
    await audit(tx, staff, dealId, overrideCents === null ? "commission.override_cleared" : "commission.override_set", {
      reason, previousCents: effectiveCents({ calculatedCents: Number(row["calculated_cents"]), overrideCents: row["override_cents"] == null ? null : Number(row["override_cents"]) }), newCents: effective
    });
    return { ok: true, value: { effectiveCents: effective } };
  });
}

/** expected -> earned (the sale settled) or -> cancelled (with a reason; unpaid payouts are cancelled, paid ones block it). */
export function setDealStatus(db: Queryable, staff: StaffRef, dealId: string, to: "earned" | "cancelled", reason: string | null) {
  return withDeal<{ status: DealStatus }>(db, dealId, async (tx, row) => {
    const from = String(row["status"]);
    if (to === "earned" && from !== "expected") return no(409, "Only an expected deal can be marked earned.");
    if (to === "cancelled" && from === "cancelled") return no(409, "This deal is already cancelled.");
    if (to === "cancelled" && (await paidTotal(tx, dealId)) > 0) return no(409, "A deal with paid payouts cannot be cancelled.");
    await tx.query("UPDATE commission_deal SET status = $2, closed_reason = $3, updated_at = now() WHERE id = $1::uuid", [dealId, to, reason]);
    if (to === "cancelled") await tx.query("UPDATE commission_payout SET status = 'cancelled' WHERE deal_id = $1::uuid AND status = 'scheduled'", [dealId]);
    await audit(tx, staff, dealId, to === "earned" ? "commission.deal_earned" : "commission.deal_cancelled", { from, reason });
    return { ok: true, value: { status: to } };
  });
}

/** Replaces the unpaid payments. The new payments must add up to the commission minus what is already paid. */
export function replaceSchedule(db: Queryable, staff: StaffRef, dealId: string, schedule: PayoutInput[]) {
  return withDeal<{ payouts: number }>(db, dealId, async (tx, row) => {
    if (row["status"] === "cancelled") return no(409, "A cancelled deal cannot be scheduled.");
    const effective = effectiveCents({ calculatedCents: Number(row["calculated_cents"]), overrideCents: row["override_cents"] == null ? null : Number(row["override_cents"]) });
    const remaining = effective - (await paidTotal(tx, dealId));
    if (schedule.length > 0 && schedule.reduce((s, p) => s + p.amountCents, 0) !== remaining) return no(400, "The payments must add up to the commission not yet paid.");
    const agent = String((await tx.query("SELECT agent_user_id FROM commission_deal WHERE id = $1::uuid", [dealId])).rows[0]!["agent_user_id"]);
    await tx.query("UPDATE commission_payout SET status = 'cancelled' WHERE deal_id = $1::uuid AND status = 'scheduled'", [dealId]);
    for (const p of schedule) await tx.query(INSERT_PAYOUT_SQL, [randomUUID(), dealId, agent, p.dueDate, p.amountCents]);
    await audit(tx, staff, dealId, "commission.schedule_set", { payments: schedule.length, remainingCents: remaining });
    return { ok: true, value: { payouts: schedule.length } };
  });
}

/** Staff confirm a scheduled payment was paid to the agent outside the platform. The deal must be earned first. */
export async function markPayoutPaid(db: Queryable, staff: StaffRef, payoutId: string, reference: string | null): Promise<Out<{ dealId: string }>> {
  const dealId = (await db.query("SELECT deal_id FROM commission_payout WHERE id = $1::uuid", [payoutId])).rows[0]?.["deal_id"];
  if (!dealId) return no(404, "Payout not found.");
  return withDeal<{ dealId: string }>(db, String(dealId), async (tx, row) => {
    if (row["status"] !== "earned") return no(409, "Mark the deal earned before recording a payment.");
    const r = await tx.query(
      "UPDATE commission_payout SET status = 'paid', paid_at = now(), paid_by = $2::uuid, payment_reference = $3 WHERE id = $1::uuid AND status = 'scheduled' RETURNING amount_cents",
      [payoutId, staff.id, reference]
    );
    if (r.rows.length === 0) return no(409, "That payment is not waiting to be paid.");
    await audit(tx, staff, String(dealId), "commission.payout_paid", { payoutId, amountCents: Number(r.rows[0]!["amount_cents"]), reference });
    return { ok: true, value: { dealId: String(dealId) } };
  });
}

export const agentDisplayName = async (db: Queryable, userId: string) =>
  String((await db.query("SELECT COALESCE(display_name, email::text) AS n FROM app_user WHERE id = $1::uuid", [userId])).rows[0]?.["n"] ?? "");

/** Active agents for the staff "new deal" picker. */
export async function listAgents(db: Queryable) {
  return (await db.query("SELECT id, COALESCE(display_name, email::text) AS name FROM app_user WHERE user_type = 'agent' AND status NOT IN ('suspended','closed') ORDER BY 2 LIMIT 500"))
    .rows.map(r => ({ id: String(r["id"]), name: String(r["name"]) }));
}
