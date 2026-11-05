import { randomUUID } from "node:crypto";
import type { Plan } from "../domain/deposit-escrow";
import {
  allPaid, localDay, planCasePayout, planRespond, planResolutionDecision, planStaffResolve, planWithdraw, proposeOutcome, reasonsFor, REASON_LABEL, RULES_CONFIRMED, RULES_VERSION,
  type CaseStatus, type FallThroughReason, type Outcome, type Party, type ResolutionInput, type ResolutionSource
} from "../domain/sale-fall-through";
import { appendAuditPg, type Queryable } from "./db";
import { notifyFallThrough } from "./fall-through-notify";
import type { StaffRef } from "./deposit-escrow-db";
import { holidayDatesPg } from "./public-holidays-db";

// Parameterised SQL only. Every write and its audit_event row share one transaction, with the deposit row locked first (the same lock the
// escrow screens take), so a dispute and a payout can never race. The case table is never deleted from (db trigger).

export type Out<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const denied = (p: Plan) => (p.allow ? null : no(p.status, p.error));
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const other = (p: Party): Party => (p === "buyer" ? "owner" : "buyer");

export interface FallThroughCase {
  id: string; offerId: string; holdingId: string; state: string; reason: FallThroughReason; raisedByParty: Party; raisedOn: string; note: string | null;
  heldCents: number; refundCents: number; releaseCents: number; penaltyCents: number; penaltyUnconfirmed: boolean; basis: string; rulesVersion: string;
  status: CaseStatus; respondedAt: string | null; disputeReason: string | null; resolutionSource: ResolutionSource | null; resolutionReference: string | null;
  resolvedAt: string | null; createdAt: string; proposedBy: string | null; proposal: ResolutionInput | null;
}
const CASE_COLS =
  "c.id, c.offer_id, c.holding_id, c.state, c.reason, c.raised_by_party, c.raised_on, c.note, c.held_cents, c.refund_cents, c.release_cents, c.penalty_cents, " +
  "c.penalty_unconfirmed, c.basis, c.rules_version, c.status, c.responded_at, c.dispute_reason, c.resolution_source, c.resolution_reference, c.resolved_at, c.created_at, c.resolution_proposed_by, c.resolution_proposal";
const LIVE = "c.status IN ('proposed','disputed','agreed')";

export const caseFromRow = (r: Record<string, unknown>): FallThroughCase => ({
  id: String(r["id"]), offerId: String(r["offer_id"]), holdingId: String(r["holding_id"]), state: String(r["state"]), reason: String(r["reason"]) as FallThroughReason,
  raisedByParty: String(r["raised_by_party"]) as Party, raisedOn: day(r["raised_on"]), note: r["note"] ? String(r["note"]) : null,
  heldCents: Number(r["held_cents"]), refundCents: Number(r["refund_cents"]), releaseCents: Number(r["release_cents"]), penaltyCents: Number(r["penalty_cents"]),
  penaltyUnconfirmed: r["penalty_unconfirmed"] === true, basis: String(r["basis"]), rulesVersion: String(r["rules_version"]), status: String(r["status"]) as CaseStatus,
  respondedAt: iso(r["responded_at"]), disputeReason: r["dispute_reason"] ? String(r["dispute_reason"]) : null,
  resolutionSource: r["resolution_source"] ? (String(r["resolution_source"]) as ResolutionSource) : null,
  resolutionReference: r["resolution_reference"] ? String(r["resolution_reference"]) : null, resolvedAt: iso(r["resolved_at"]), createdAt: iso(r["created_at"])!,
  proposedBy: r["resolution_proposed_by"] ? String(r["resolution_proposed_by"]) : null,
  proposal: r["resolution_proposal"] && typeof r["resolution_proposal"] === "object" ? (r["resolution_proposal"] as ResolutionInput) : null
});

async function audit(tx: Queryable, actorId: string, actorRole: string, holdingId: string, eventType: string, payload: Record<string, unknown>) {
  await appendAuditPg(tx, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId, aggregateType: "deposit_holding", aggregateId: holdingId,
    eventType, correlationId: randomUUID(), payload: { role: actorRole, ...payload }
  });
}

const heldOf = async (q: Queryable, holdingId: string) =>
  Number((await q.query("SELECT COALESCE(SUM(CASE WHEN kind = 'receipt' THEN amount_cents ELSE -amount_cents END), 0) AS held FROM deposit_movement WHERE holding_id = $1::uuid", [holdingId])).rows[0]?.["held"] ?? 0);

/** True while a case on this deposit is proposed, disputed or agreed: the escrow screens refuse ordinary receipts, requests, approvals and cancels. */
export async function holdingFrozen(q: Queryable, holdingId: string): Promise<boolean> {
  return (await q.query(`SELECT 1 FROM sale_fall_through c WHERE c.holding_id = $1::uuid AND ${LIVE} LIMIT 1`, [holdingId])).rows.length > 0;
}
export const FROZEN_MESSAGE = "A sale-fell-through case is open on this deposit. Nothing can be received, requested or approved here until it is settled.";

export async function casesForHolding(q: Queryable, holdingId: string): Promise<FallThroughCase[]> {
  return (await q.query(`SELECT ${CASE_COLS} FROM sale_fall_through c WHERE c.holding_id = $1::uuid ORDER BY c.created_at DESC LIMIT 20`, [holdingId])).rows.map(caseFromRow);
}
/** Live cases across all deposits, for the staff list. */
export async function liveCases(q: Queryable): Promise<FallThroughCase[]> {
  return (await q.query(`SELECT ${CASE_COLS} FROM sale_fall_through c WHERE ${LIVE} ORDER BY c.created_at DESC LIMIT 500`)).rows.map(caseFromRow);
}

// ---------- the offer's own sides ----------

interface Ctx { status: string; priceCents: number; party: Party | null; state: string; acceptedOn: string; holdingId: string | null; holdingStatus: string | null }
const CTX_SQL =
  "SELECT o.status, o.price_cents, o.buyer_user_id, l.owner_user_id, l.jurisdiction, o.submitted_at, " +
  "(SELECT e.occurred_at FROM offer_event e WHERE e.offer_id = o.id AND e.event_type = 'accepted' ORDER BY e.occurred_at DESC LIMIT 1) AS accepted_at, " +
  "h.id AS holding_id, h.status AS holding_status FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id LEFT JOIN deposit_holding h ON h.offer_id = o.id WHERE o.id = $1::uuid";

/** The offer as this user sees it: their side comes from the database (buyer of the offer, owner of the listing), never from the request. */
async function context(q: Queryable, offerId: string, userId: string): Promise<Ctx | null> {
  const r = (await q.query(CTX_SQL, [offerId])).rows[0];
  if (!r) return null;
  // Someone who is both the buyer and the owner of the listing has no side: they cannot raise or answer a case against themselves.
  const party: Party | null = String(r["buyer_user_id"]) === String(r["owner_user_id"]) ? null : String(r["buyer_user_id"]) === userId ? "buyer" : String(r["owner_user_id"]) === userId ? "owner" : null;
  const state = String(r["jurisdiction"] ?? "").trim();
  const acceptedAt = r["accepted_at"] ?? r["submitted_at"];
  return {
    status: String(r["status"]), priceCents: Number(r["price_cents"]), party, state, acceptedOn: acceptedAt instanceof Date ? localDay(acceptedAt, state) : day(acceptedAt),
    holdingId: r["holding_id"] ? String(r["holding_id"]) : null, holdingStatus: r["holding_status"] ? String(r["holding_status"]) : null
  };
}

const today = (state: string) => localDay(new Date(), state);
/** At most this many cases per offer in a day: stops raise / withdraw cycles from flooding the other side with messages. */
export const MAX_RAISES_PER_DAY = 3;

/** Why a new case cannot be raised now, or null when it can. */
async function blocker(q: Queryable, ctx: Ctx, offerId: string): Promise<string | null> {
  if (ctx.status === "fallen_through") return "This sale is already marked as fallen through.";
  if (ctx.status !== "accepted") return "Only an accepted offer can fall through. Before that, withdraw the offer.";
  if (!ctx.holdingId || ctx.holdingStatus !== "open") return "No open deposit record exists for this offer yet. Ask us to open it, then try again.";
  if ((await q.query(`SELECT 1 FROM sale_fall_through c WHERE c.offer_id = $1::uuid AND ${LIVE} LIMIT 1`, [offerId])).rows.length > 0) return "A sale-fell-through request is already open on this offer.";
  if (Number((await q.query("SELECT count(*) AS n FROM sale_fall_through WHERE offer_id = $1::uuid AND created_at > now() - interval '1 day'", [offerId])).rows[0]?.["n"] ?? 0) >= MAX_RAISES_PER_DAY) return "Too many requests on this offer today. Try again tomorrow or ask us for help.";
  if ((await q.query("SELECT 1 FROM deposit_release WHERE holding_id = $1::uuid AND status = 'pending' LIMIT 1", [ctx.holdingId])).rows.length > 0) return "A payment from the deposit is waiting for staff approval. Ask us to settle it first.";
  return null;
}

export interface FallThroughView {
  party: Party; cases: FallThroughCase[]; canRaise: { ok: true } | { ok: false; reason: string };
  reasons: { value: FallThroughReason; label: string }[]; rulesVersion: string; rulesConfirmed: boolean;
}
/** What one side of an offer sees: the history of cases, whether a new one can be raised, and the reasons they may choose. */
export async function fallThroughView(db: Queryable, userId: string, expected: Party, offerId: string): Promise<Out<FallThroughView>> {
  const ctx = await context(db, offerId, userId);
  if (!ctx || ctx.party !== expected) return no(404, "Offer not found.");
  const cases = (await db.query(`SELECT ${CASE_COLS} FROM sale_fall_through c WHERE c.offer_id = $1::uuid ORDER BY c.created_at DESC LIMIT 10`, [offerId])).rows.map(caseFromRow);
  const why = await blocker(db, ctx, offerId);
  return {
    ok: true,
    value: {
      party: expected, cases, canRaise: why ? { ok: false, reason: why } : { ok: true },
      reasons: reasonsFor(expected).map(value => ({ value, label: REASON_LABEL[value] })), rulesVersion: RULES_VERSION, rulesConfirmed: RULES_CONFIRMED
    }
  };
}

async function compute(q: Queryable, ctx: Ctx, party: Party, reason: FallThroughReason): Promise<Out<Outcome & { heldCents: number }>> {
  const heldCents = await heldOf(q, ctx.holdingId!);
  const raisedOn = today(ctx.state);
  const holidays = reason === "cooling_off" ? await holidayDatesPg(q, ctx.state, ctx.acceptedOn, raisedOn) : [];
  const r = proposeOutcome({ reason, party, state: ctx.state, priceCents: ctx.priceCents, heldCents, acceptedOn: ctx.acceptedOn, raisedOn, holidays });
  return r.ok ? { ok: true, value: { ...r.value, heldCents } } : no(409, r.error);
}

/** The outcome the rules would propose, without saving anything. */
export async function previewFallThrough(db: Queryable, userId: string, expected: Party, offerId: string, reason: FallThroughReason): Promise<Out<Outcome & { heldCents: number }>> {
  const ctx = await context(db, offerId, userId);
  if (!ctx || ctx.party !== expected) return no(404, "Offer not found.");
  const why = await blocker(db, ctx, offerId);
  if (why) return no(409, why);
  return compute(db, ctx, expected, reason);
}

/** Locks the deposit, then returns the offer's live case (if any) with its row locked. */
async function liveCase(tx: Queryable, holdingId: string, offerId: string): Promise<FallThroughCase | null> {
  await tx.query("SELECT 1 FROM deposit_holding WHERE id = $1::uuid FOR UPDATE", [holdingId]);
  const r = (await tx.query(`SELECT ${CASE_COLS} FROM sale_fall_through c WHERE c.offer_id = $1::uuid AND ${LIVE} FOR UPDATE`, [offerId])).rows[0];
  return r ? caseFromRow(r) : null;
}

export async function raiseFallThrough(db: Queryable, userId: string, expected: Party, offerId: string, reason: FallThroughReason, note: string | null): Promise<Out<{ id: string }>> {
  const out = await atomic<Out<{ id: string }>>(db, async tx => {
    const first = await context(tx, offerId, userId);
    if (!first || first.party !== expected) return no(404, "Offer not found.");
    // Lock the deposit first, then read the offer and deposit state again: what was read before the lock can be stale.
    if (first.holdingId) await tx.query("SELECT 1 FROM deposit_holding WHERE id = $1::uuid FOR UPDATE", [first.holdingId]);
    const ctx = await context(tx, offerId, userId);
    if (!ctx || ctx.party !== expected) return no(404, "Offer not found.");
    const why = await blocker(tx, ctx, offerId);
    if (why) return no(409, why);
    const o = await compute(tx, ctx, expected, reason);
    if (!o.ok) return o;
    const v = o.value, id = randomUUID();
    await tx.query(
      "INSERT INTO sale_fall_through (id, offer_id, holding_id, state, reason, raised_by_party, raised_by, raised_on, note, held_cents, refund_cents, release_cents, penalty_cents, penalty_unconfirmed, basis, rules_version) " +
      "VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8::date,$9,$10,$11,$12,$13,$14,$15,$16)",
      [id, offerId, ctx.holdingId, ctx.state, reason, expected, userId, today(ctx.state), note, v.heldCents, v.refundCents, v.releaseCents, v.penaltyCents, v.penaltyUnconfirmed, v.basis, v.rulesVersion]
    );
    await audit(tx, userId, expected, ctx.holdingId!, "escrow.fall_through_raised", {
      caseId: id, offerId, reason, heldCents: v.heldCents, refundCents: v.refundCents, releaseCents: v.releaseCents, penaltyCents: v.penaltyCents, rulesVersion: v.rulesVersion, rulesConfirmed: v.rulesConfirmed
    });
    return { ok: true, value: { id } };
  });
  if (out.ok) await notifyFallThrough(db, offerId, { kind: "proposed", to: other(expected), reason });
  return out;
}

/** Marks the offer fallen through, records it on the offer timeline and voids its sold/rented market event. Inside the caller's transaction. */
async function markFallenThrough(tx: Queryable, offerId: string, by: { kind: "buyer" | "owner" | "system"; userId: string }) {
  const r = await tx.query("UPDATE formal_offer SET status = 'fallen_through' WHERE id = $1::uuid AND status = 'accepted' RETURNING id", [offerId]);
  if (r.rows.length === 0) return;
  await tx.query(
    "INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, from_status, to_status) VALUES ($1::uuid,'fallen_through',$2,$3::uuid,'accepted','fallen_through')",
    [offerId, by.kind, by.userId]
  );
  await tx.query(
    "UPDATE property_event SET voided_at = now(), voided_by = 'system', void_reason = 'Sale fell through' WHERE offer_id = $1::uuid AND event_type IN ('sold','rented') AND voided_at IS NULL", [offerId]);
}

/** The outcome is final: the offer falls through, and a case with nothing held finishes at once (the record closes). Inside the caller's transaction. */
async function settleAgreed(tx: Queryable, c: FallThroughCase, by: { kind: "buyer" | "owner" | "system"; userId: string }) {
  await markFallenThrough(tx, c.offerId, by);
  if (c.refundCents + c.releaseCents === 0) {
    await tx.query("UPDATE sale_fall_through SET status = 'resolved', updated_at = now() WHERE id = $1::uuid", [c.id]);
    if (c.heldCents === 0 && (await heldOf(tx, c.holdingId)) === 0 && (await tx.query("SELECT 1 FROM deposit_movement WHERE holding_id = $1::uuid LIMIT 1", [c.holdingId])).rows.length === 0) {
      await tx.query("UPDATE deposit_holding SET status = 'cancelled', closed_reason = 'Sale fell through before any deposit was received', updated_at = now() WHERE id = $1::uuid AND status = 'open'", [c.holdingId]);
    }
  }
}

export async function respondFallThrough(db: Queryable, userId: string, expected: Party, offerId: string, decision: "agree" | "dispute", note: string | null): Promise<Out<{ status: CaseStatus }>> {
  const out = await atomic<Out<{ status: CaseStatus }>>(db, async tx => {
    const ctx = await context(tx, offerId, userId);
    if (!ctx || ctx.party !== expected || !ctx.holdingId) return no(404, "Offer not found.");
    const c = await liveCase(tx, ctx.holdingId, offerId);
    if (!c) return no(404, "There is nothing to answer on this offer.");
    const stop = denied(planRespond(c, expected));
    if (stop) return stop;
    const status: CaseStatus = decision === "agree" ? "agreed" : "disputed";
    await tx.query(
      "UPDATE sale_fall_through SET status = $2, responded_by = $3::uuid, responded_at = now(), dispute_reason = $4, resolution_source = $5, updated_at = now() WHERE id = $1::uuid",
      [c.id, status, userId, decision === "dispute" ? note : null, decision === "agree" ? "parties" : null]
    );
    if (decision === "agree") await settleAgreed(tx, c, { kind: expected, userId });
    await audit(tx, userId, expected, c.holdingId, `escrow.fall_through_${decision === "agree" ? "agreed" : "disputed"}`, { caseId: c.id, offerId, note });
    return { ok: true, value: { status } };
  });
  if (out.ok && decision === "agree") await notifyFallThrough(db, offerId, { kind: "fallen_through", to: ["buyer", "owner"] });
  if (out.ok && decision === "dispute") await notifyFallThrough(db, offerId, { kind: "update", to: other(expected), title: "Outcome disputed: deposit frozen", text: "The other side disputed the proposed outcome. The deposit is frozen until staff record an agreement or court order." });
  return out;
}

export async function withdrawFallThrough(db: Queryable, userId: string, expected: Party, offerId: string): Promise<Out<{ status: CaseStatus }>> {
  const out = await atomic<Out<{ status: CaseStatus }>>(db, async tx => {
    const ctx = await context(tx, offerId, userId);
    if (!ctx || ctx.party !== expected || !ctx.holdingId) return no(404, "Offer not found.");
    const c = await liveCase(tx, ctx.holdingId, offerId);
    if (!c) return no(404, "There is nothing to withdraw on this offer.");
    const stop = denied(planWithdraw(c, expected));
    if (stop) return stop;
    await tx.query("UPDATE sale_fall_through SET status = 'withdrawn', updated_at = now() WHERE id = $1::uuid", [c.id]);
    await audit(tx, userId, expected, c.holdingId, "escrow.fall_through_withdrawn", { caseId: c.id, offerId });
    return { ok: true, value: { status: "withdrawn" as CaseStatus } };
  });
  if (out.ok) await notifyFallThrough(db, offerId, { kind: "update", to: other(expected), title: "Sale request withdrawn", text: "The other side withdrew the sale-fell-through request. The deposit is no longer frozen." });
  return out;
}

// ---------- staff ----------

async function staffCase(tx: Queryable, caseId: string): Promise<FallThroughCase | null> {
  const h = (await tx.query("SELECT holding_id FROM sale_fall_through WHERE id = $1::uuid", [caseId])).rows[0];
  if (!h) return null;
  await tx.query("SELECT 1 FROM deposit_holding WHERE id = $1::uuid FOR UPDATE", [String(h["holding_id"])]);
  const r = (await tx.query(`SELECT ${CASE_COLS} FROM sale_fall_through c WHERE c.id = $1::uuid FOR UPDATE`, [caseId])).rows[0];
  return r ? caseFromRow(r) : null;
}

const ownHolding = (c: FallThroughCase, holdingId: string) => c.holdingId === holdingId;

/**
 * After a dispute, step one: a staff member records the agreement or court order (or that the sale goes ahead) as a PROPOSAL. Nothing changes
 * for the parties and the deposit stays frozen until a different person with approval rights decides it (decideResolution).
 */
export async function resolveDispute(db: Queryable, staff: StaffRef, holdingId: string, caseId: string, input: ResolutionInput): Promise<Out<{ status: CaseStatus; pendingApproval: true }>> {
  return atomic<Out<{ status: CaseStatus; pendingApproval: true }>>(db, async tx => {
    const c = await staffCase(tx, caseId);
    if (!c || !ownHolding(c, holdingId)) return no(404, "Case not found.");
    const stop = denied(planStaffResolve(c));
    if (stop) return stop;
    if (input.source !== "sale_continues" && input.refundCents + input.releaseCents > (await heldOf(tx, c.holdingId))) return no(409, "More than is held in trust.");
    await tx.query(
      "UPDATE sale_fall_through SET resolution_proposal = $2::jsonb, resolution_proposed_by = $3::uuid, resolution_proposed_at = now(), updated_at = now() WHERE id = $1::uuid",
      [caseId, JSON.stringify(input), staff.id]
    );
    await audit(tx, staff.id, staff.role, c.holdingId, "escrow.fall_through_resolution_proposed", {
      caseId, source: input.source, reference: input.reference, reason: input.reason, refundCents: input.refundCents, releaseCents: input.releaseCents
    });
    return { ok: true, value: { status: c.status, pendingApproval: true as const } };
  });
}

/** Step two: a different staff member with escrow.approve approves (the resolution takes effect) or rejects (the proposal is cleared) it. */
export async function decideResolution(db: Queryable, staff: StaffRef, holdingId: string, caseId: string, outcome: "approve" | "reject", reason: string): Promise<Out<{ status: CaseStatus }>> {
  const out = await atomic<Out<{ status: CaseStatus; offerId: string }>>(db, async tx => {
    const c = await staffCase(tx, caseId);
    if (!c || !ownHolding(c, holdingId)) return no(404, "Case not found.");
    const stop = denied(planResolutionDecision(c, staff.id));
    if (stop) return stop;
    const input = c.proposal!;
    if (outcome === "reject") {
      await tx.query("UPDATE sale_fall_through SET resolution_proposal = NULL, resolution_proposed_by = NULL, resolution_proposed_at = NULL, updated_at = now() WHERE id = $1::uuid", [caseId]);
      await audit(tx, staff.id, staff.role, c.holdingId, "escrow.fall_through_resolution_rejected", { caseId, reason, proposedBy: c.proposedBy });
      return { ok: true, value: { status: c.status, offerId: c.offerId } };
    }
    const goesAhead = input.source === "sale_continues";
    if (!goesAhead && input.refundCents + input.releaseCents > (await heldOf(tx, c.holdingId))) return no(409, "More than is held in trust.");
    const status: CaseStatus = goesAhead ? "withdrawn" : "agreed";
    await tx.query(
      "UPDATE sale_fall_through SET status = $2, refund_cents = $3, release_cents = $4, penalty_cents = CASE WHEN $5::boolean THEN penalty_cents ELSE 0 END, resolution_source = $6, resolution_reference = $7, resolved_by = $8::uuid, resolved_at = now(), updated_at = now() WHERE id = $1::uuid",
      [caseId, status, goesAhead ? c.refundCents : input.refundCents, goesAhead ? c.releaseCents : input.releaseCents, goesAhead, input.source, input.reference, staff.id]
    );
    if (!goesAhead) await settleAgreed(tx, { ...c, refundCents: input.refundCents, releaseCents: input.releaseCents }, { kind: "system", userId: staff.id });
    await audit(tx, staff.id, staff.role, c.holdingId, "escrow.fall_through_resolved", {
      caseId, source: input.source, reference: input.reference, reason: input.reason, decisionReason: reason, proposedBy: c.proposedBy, refundCents: input.refundCents, releaseCents: input.releaseCents,
      proposedRefundCents: c.refundCents, proposedReleaseCents: c.releaseCents
    });
    return { ok: true, value: { status, offerId: c.offerId } };
  });
  if (!out.ok) return out;
  if (outcome === "reject") return { ok: true, value: { status: out.value.status } };
  await notifyFallThrough(db, out.value.offerId, out.value.status === "agreed"
    ? { kind: "fallen_through", to: ["buyer", "owner"] }
    : { kind: "update", to: "buyer", title: "Dispute settled: the sale goes ahead", text: "Staff recorded that the sale goes ahead. The deposit is no longer frozen." });
  if (out.value.status === "withdrawn") await notifyFallThrough(db, out.value.offerId, { kind: "update", to: "owner", title: "Dispute settled: the sale goes ahead", text: "Staff recorded that the sale goes ahead. The deposit is no longer frozen." });
  return { ok: true, value: { status: out.value.status } };
}

/** Asks for the next payout of an agreed case, pre-filled from the case. A second staff member approves it in the usual way (decideRelease). */
export async function requestCasePayout(db: Queryable, staff: StaffRef, holdingId: string, caseId: string): Promise<Out<{ releaseId: string; kind: "refund" | "release"; amountCents: number }>> {
  return atomic(db, async tx => {
    const c = await staffCase(tx, caseId);
    if (!c || !ownHolding(c, holdingId)) return no(404, "Case not found.");
    if ((await tx.query("SELECT status FROM deposit_holding WHERE id = $1::uuid", [c.holdingId])).rows[0]?.["status"] !== "open") return no(409, "This deposit record is closed.");
    const linked = (await tx.query("SELECT kind, status FROM deposit_release WHERE fall_through_id = $1::uuid", [caseId])).rows.map(r => ({ kind: String(r["kind"]) as "refund" | "release", status: String(r["status"]) }));
    const pending = (await tx.query("SELECT 1 FROM deposit_release WHERE holding_id = $1::uuid AND status = 'pending' LIMIT 1", [c.holdingId])).rows.length > 0;
    const plan = planCasePayout(c, linked, pending, await heldOf(tx, c.holdingId));
    if (!plan.ok) return no(409, plan.error);
    const { kind, amountCents } = plan.value, releaseId = randomUUID();
    const reason = `Sale fell through (${REASON_LABEL[c.reason]}): ${kind === "refund" ? "refund to the buyer" : "release to the seller"} as agreed. Case ${c.id.slice(0, 8)}.`;
    await tx.query(
      "INSERT INTO deposit_release (id, holding_id, kind, amount_cents, reason, settlement_confirmed, requested_by, fall_through_id) VALUES ($1::uuid,$2::uuid,$3,$4,$5,false,$6::uuid,$7::uuid)",
      [releaseId, c.holdingId, kind, amountCents, reason, staff.id, caseId]
    );
    await audit(tx, staff.id, staff.role, c.holdingId, `escrow.${kind}_requested`, { releaseId, amountCents, reason, fallThroughId: caseId });
    return { ok: true, value: { releaseId, kind, amountCents } };
  });
}

/** Called inside decideRelease after an approval: when every agreed payment is approved the case is finished. */
export async function finishIfPaid(tx: Queryable, staff: StaffRef, fallThroughId: string): Promise<boolean> {
  const c = (await tx.query(`SELECT ${CASE_COLS} FROM sale_fall_through c WHERE c.id = $1::uuid FOR UPDATE`, [fallThroughId])).rows[0];
  if (!c) return false;
  const row = caseFromRow(c);
  if (row.status !== "agreed") return false;
  const linked = (await tx.query("SELECT kind, status FROM deposit_release WHERE fall_through_id = $1::uuid", [fallThroughId])).rows.map(r => ({ kind: String(r["kind"]) as "refund" | "release", status: String(r["status"]) }));
  if (!allPaid(row, linked)) return false;
  await tx.query("UPDATE sale_fall_through SET status = 'resolved', updated_at = now() WHERE id = $1::uuid", [fallThroughId]);
  await audit(tx, staff.id, staff.role, row.holdingId, "escrow.fall_through_finished", { caseId: fallThroughId });
  return true;
}
