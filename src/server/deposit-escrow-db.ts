import { createHash, randomBytes, randomUUID } from "node:crypto";
import { maskName } from "../domain/admin-report-builder";
import {
  balanceOf, depositReference, lineKey, planCancel, planMatch, planReceipt, planReleaseDecision, planReleaseRequest, statusAfterPayout,
  type DepositHolding, type DepositMovement, type DepositRelease, type HoldingStatus, type NewHoldingInput, type ParsedStatement, type Plan,
  type ReceiptInput, type ReleaseRequestInput, type StatementLine
} from "../domain/deposit-escrow";
import { appendAuditPg, type Queryable } from "./db";
import { casesForHolding, finishIfPaid, FROZEN_MESSAGE, holdingFrozen, liveCases, type FallThroughCase } from "./sale-fall-through-db";

// Constant SQL text; user input only travels as bound parameters. Every write and its audit_event row run in one transaction, with the
// deposit row locked first so two staff members cannot act on the same deposit at once. Nothing here deletes a row (db triggers block it).

export interface StaffRef { id: string; role: string }
export type Out<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const denied = (p: Plan) => (p.allow ? null : no(p.status, p.error));
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());
const today = () => new Date().toISOString().slice(0, 10);

async function audit(tx: Queryable, staff: StaffRef, aggregateType: string, id: string, eventType: string, payload: Record<string, unknown>) {
  await appendAuditPg(tx, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: staff.id,
    aggregateType, aggregateId: id, eventType, correlationId: randomUUID(), payload: { role: staff.role, ...payload }
  });
}

const HOLDING_COLS =
  "h.id, h.listing_id, l.title AS listing_title, h.offer_id, h.trust_account_id, f.name || ' · ' || ta.account_name AS account_label, h.reference, " +
  "h.required_cents, to_char(h.due_date,'YYYY-MM-DD') AS due_date, h.status, h.closed_reason, h.created_at, o.price_cents AS offer_price_cents, " +
  "u.display_name AS buyer_name";
const HOLDING_FROM =
  "FROM deposit_holding h JOIN property_listing l ON l.id = h.listing_id JOIN formal_offer o ON o.id = h.offer_id " +
  "JOIN app_user u ON u.id = o.buyer_user_id JOIN trust_account ta ON ta.id = h.trust_account_id JOIN law_firm f ON f.id = ta.firm_id";
const MOVEMENT_COLS =
  "m.id, m.holding_id, m.kind, m.amount_cents, to_char(m.occurred_on,'YYYY-MM-DD') AS occurred_on, m.bank_reference, m.release_id, m.recorded_by, m.created_at, " +
  "EXISTS (SELECT 1 FROM trust_statement_line s WHERE s.matched_movement_id = m.id) AS reconciled";
const RELEASE_COLS =
  "r.id, r.holding_id, r.kind, r.amount_cents, r.reason, r.settlement_confirmed, r.requested_by, r.requested_at, r.status, r.decided_by, r.decided_at, r.decision_reason, r.fall_through_id";
const LINE_COLS =
  "s.id, s.trust_account_id, to_char(s.line_date,'YYYY-MM-DD') AS line_date, s.amount_cents, s.description, s.reference, s.matched_movement_id";

export const LIST_HOLDINGS_SQL = `SELECT ${HOLDING_COLS} ${HOLDING_FROM} ORDER BY (h.status = 'open') DESC, h.created_at DESC LIMIT 500`;
const HOLDING_ONE_SQL = `SELECT ${HOLDING_COLS} ${HOLDING_FROM} WHERE h.id = $1::uuid`;
const LOCK_HOLDING_SQL = "SELECT id, status, required_cents, trust_account_id, reference FROM deposit_holding WHERE id = $1::uuid FOR UPDATE";
const MOVEMENTS_FOR_SQL = `SELECT ${MOVEMENT_COLS} FROM deposit_movement m WHERE m.holding_id = ANY($1::uuid[]) ORDER BY m.occurred_on, m.created_at`;
const RELEASES_FOR_SQL = `SELECT ${RELEASE_COLS} FROM deposit_release r WHERE r.holding_id = ANY($1::uuid[]) ORDER BY r.requested_at`;
const PENDING_RELEASES_SQL = `SELECT ${RELEASE_COLS} FROM deposit_release r WHERE r.status = 'pending' ORDER BY r.requested_at`;
/** The trust account a listing may use: its latest approved verification (the same gate that lets a listing publish). */
const APPROVED_ACCOUNT_SQL =
  "SELECT c.trust_account_id FROM trust_account_check c WHERE c.listing_id = $1::uuid AND c.decision = 'approved' ORDER BY c.checked_at DESC LIMIT 1";
export const ACCEPTED_WITHOUT_SQL =
  "SELECT o.id AS offer_id, o.listing_id, l.title AS listing_title, o.price_cents, o.deposit_cents, u.display_name AS buyer_name, " +
  "(SELECT f.name || ' · ' || ta.account_name FROM trust_account_check c JOIN trust_account ta ON ta.id = c.trust_account_id JOIN law_firm f ON f.id = ta.firm_id " +
  " WHERE c.listing_id = o.listing_id AND c.decision = 'approved' ORDER BY c.checked_at DESC LIMIT 1) AS account_label " +
  "FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id JOIN app_user u ON u.id = o.buyer_user_id " +
  "WHERE o.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM deposit_holding h WHERE h.offer_id = o.id) ORDER BY o.submitted_at DESC LIMIT 200";
/** Trust accounts that have at least one deposit record, for the reconciliation picker. */
export const ACCOUNTS_SQL =
  "SELECT ta.id, f.name || ' · ' || ta.account_name AS label, ta.bsb FROM trust_account ta JOIN law_firm f ON f.id = ta.firm_id " +
  "WHERE EXISTS (SELECT 1 FROM deposit_holding h WHERE h.trust_account_id = ta.id) ORDER BY label LIMIT 200";
const AUDIT_SQL =
  "SELECT a.occurred_at, a.event_type, a.payload, COALESCE(u.display_name, 'Staff') AS actor_name FROM audit_event a LEFT JOIN app_user u ON u.id::text = a.actor_id " +
  "WHERE a.aggregate_type = 'deposit_holding' AND a.aggregate_id = $1 ORDER BY a.occurred_at, a.id LIMIT 500";

export const holdingFromRow = (r: Record<string, unknown>): DepositHolding => ({
  id: String(r["id"]), listingId: String(r["listing_id"]), listingTitle: String(r["listing_title"] ?? ""), offerId: String(r["offer_id"]),
  trustAccountId: String(r["trust_account_id"]), trustAccountLabel: String(r["account_label"] ?? ""), reference: String(r["reference"]),
  requiredCents: Number(r["required_cents"]), dueDate: r["due_date"] ? String(r["due_date"]) : null, status: String(r["status"]) as HoldingStatus,
  closedReason: r["closed_reason"] ? String(r["closed_reason"]) : null, createdAt: iso(r["created_at"])!,
  offerPriceCents: Number(r["offer_price_cents"]), buyerName: maskName(String(r["buyer_name"] ?? ""))
});
export const movementFromRow = (r: Record<string, unknown>): DepositMovement => ({
  id: String(r["id"]), holdingId: String(r["holding_id"]), kind: String(r["kind"]) as DepositMovement["kind"], amountCents: Number(r["amount_cents"]),
  occurredOn: String(r["occurred_on"]), bankReference: r["bank_reference"] ? String(r["bank_reference"]) : null,
  releaseId: r["release_id"] ? String(r["release_id"]) : null, recordedBy: String(r["recorded_by"]), createdAt: iso(r["created_at"])!, reconciled: r["reconciled"] === true
});
export const releaseFromRow = (r: Record<string, unknown>): DepositRelease => ({
  id: String(r["id"]), holdingId: String(r["holding_id"]), kind: String(r["kind"]) as DepositRelease["kind"], amountCents: Number(r["amount_cents"]),
  reason: String(r["reason"]), settlementConfirmed: r["settlement_confirmed"] === true, requestedBy: String(r["requested_by"]), requestedAt: iso(r["requested_at"])!,
  status: String(r["status"]) as DepositRelease["status"], decidedBy: r["decided_by"] ? String(r["decided_by"]) : null, decidedAt: iso(r["decided_at"]),
  decisionReason: r["decision_reason"] ? String(r["decision_reason"]) : null, fallThroughId: r["fall_through_id"] ? String(r["fall_through_id"]) : null
});
export const lineFromRow = (r: Record<string, unknown>): StatementLine => ({
  id: String(r["id"]), trustAccountId: String(r["trust_account_id"]), lineDate: String(r["line_date"]), amountCents: Number(r["amount_cents"]),
  description: String(r["description"] ?? ""), reference: String(r["reference"] ?? ""), matchedMovementId: r["matched_movement_id"] ? String(r["matched_movement_id"]) : null
});

export interface AcceptedOffer { offerId: string; listingId: string; listingTitle: string; priceCents: number; depositCents: number; buyerName: string; accountLabel: string | null }
export interface Overview {
  holdings: DepositHolding[]; movements: DepositMovement[]; releases: DepositRelease[]; acceptedWithout: AcceptedOffer[];
  accounts: { id: string; label: string; bsb: string }[]; cases: FallThroughCase[];
}

/** Everything the deposits screen needs: records, their ledgers and requests, accepted offers still without a record, and accounts. */
export async function overview(db: Queryable): Promise<Overview> {
  const holdings = (await db.query(LIST_HOLDINGS_SQL)).rows.map(holdingFromRow);
  const ids = holdings.map(h => h.id);
  const [movements, releases, accepted, accounts, cases] = await Promise.all([
    db.query(MOVEMENTS_FOR_SQL, [ids]), db.query(RELEASES_FOR_SQL, [ids]), db.query(ACCEPTED_WITHOUT_SQL), db.query(ACCOUNTS_SQL), liveCases(db)
  ]);
  return {
    holdings, movements: movements.rows.map(movementFromRow), releases: releases.rows.map(releaseFromRow),
    acceptedWithout: accepted.rows.map(r => ({
      offerId: String(r["offer_id"]), listingId: String(r["listing_id"]), listingTitle: String(r["listing_title"] ?? ""), priceCents: Number(r["price_cents"]),
      depositCents: Number(r["deposit_cents"]), buyerName: maskName(String(r["buyer_name"] ?? "")), accountLabel: r["account_label"] ? String(r["account_label"]) : null
    })),
    accounts: accounts.rows.map(r => ({ id: String(r["id"]), label: String(r["label"]), bsb: String(r["bsb"]) })), cases
  };
}

export const pendingReleases = async (db: Queryable) => (await db.query(PENDING_RELEASES_SQL)).rows.map(releaseFromRow);

export interface AuditEntry { at: string; event: string; actor: string; payload: Record<string, unknown> }
export interface HoldingDetail { holding: DepositHolding; movements: DepositMovement[]; releases: DepositRelease[]; audit: AuditEntry[]; cases: FallThroughCase[] }

export async function getHolding(db: Queryable, id: string): Promise<HoldingDetail | null> {
  const row = (await db.query(HOLDING_ONE_SQL, [id])).rows[0];
  if (!row) return null;
  const [m, r, a, cases] = await Promise.all([db.query(MOVEMENTS_FOR_SQL, [[id]]), db.query(RELEASES_FOR_SQL, [[id]]), db.query(AUDIT_SQL, [id]), casesForHolding(db, id)]);
  return {
    holding: holdingFromRow(row), movements: m.rows.map(movementFromRow), releases: r.rows.map(releaseFromRow),
    audit: a.rows.map(x => ({ at: iso(x["occurred_at"])!, event: String(x["event_type"]), actor: String(x["actor_name"]), payload: (x["payload"] ?? {}) as Record<string, unknown> })), cases
  };
}

/**
 * Opens the deposit record for an accepted offer. The deposit goes to the listing's approved solicitor trust account (fail closed:
 * no approved account, no record). The required amount defaults to the deposit in the offer.
 */
export async function createHolding(db: Queryable, staff: StaffRef, input: NewHoldingInput, random: (n: number) => Uint8Array = randomBytes): Promise<Out<{ id: string; reference: string }>> {
  const offer = (await db.query("SELECT listing_id, deposit_cents, status FROM formal_offer WHERE id = $1::uuid", [input.offerId])).rows[0];
  if (!offer) return no(404, "Offer not found.");
  if (offer["status"] !== "accepted") return no(409, "Only an accepted offer can have a deposit record.");
  const listingId = String(offer["listing_id"]);
  const account = (await db.query(APPROVED_ACCOUNT_SQL, [listingId])).rows[0];
  if (!account) return no(409, "This listing has no approved solicitor trust account. Approve one first.");
  const required = input.requiredCents ?? Number(offer["deposit_cents"]);
  if (!(required > 0)) return no(400, "The offer has no deposit. Enter the deposit amount.");
  const id = randomUUID();
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = depositReference(random(6));
    try {
      await atomic(db, async tx => {
        await tx.query(
          "INSERT INTO deposit_holding (id, listing_id, offer_id, trust_account_id, reference, required_cents, due_date, created_by) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::date,$8::uuid)",
          [id, listingId, input.offerId, String(account["trust_account_id"]), reference, required, input.dueDate, staff.id]
        );
        await audit(tx, staff, "deposit_holding", id, "escrow.holding_opened", { offerId: input.offerId, listingId, requiredCents: required, dueDate: input.dueDate, reference });
      });
      return { ok: true, value: { id, reference } };
    } catch (e) {
      const msg = (e as Error).message;
      if (/offer_id/.test(msg)) return no(409, "This offer already has a deposit record.");
      if (!/reference/.test(msg)) throw e;
    }
  }
  return no(503, "Could not create a unique reference; try again.");
}

/** Locks the record and hands its row, ledger and requests to `fn`; 404 when it does not exist. */
async function withHolding<T>(db: Queryable, id: string,
  fn: (tx: Queryable, h: { status: HoldingStatus; requiredCents: number; trustAccountId: string; reference: string }, m: DepositMovement[], r: DepositRelease[]) => Promise<Out<T>>): Promise<Out<T>> {
  return atomic(db, async tx => {
    const row = (await tx.query(LOCK_HOLDING_SQL, [id])).rows[0];
    if (!row) return no(404, "Deposit record not found.");
    const [m, r] = await Promise.all([tx.query(MOVEMENTS_FOR_SQL, [[id]]), tx.query(RELEASES_FOR_SQL, [[id]])]);
    const h = { status: String(row["status"]) as HoldingStatus, requiredCents: Number(row["required_cents"]), trustAccountId: String(row["trust_account_id"]), reference: String(row["reference"]) };
    return fn(tx, h, m.rows.map(movementFromRow), r.rows.map(releaseFromRow));
  });
}

const INSERT_MOVEMENT_SQL =
  "INSERT INTO deposit_movement (id, holding_id, kind, amount_cents, occurred_on, bank_reference, release_id, recorded_by) VALUES ($1::uuid,$2::uuid,$3,$4,$5::date,$6,$7::uuid,$8::uuid)";
const MATCH_LINE_SQL =
  "UPDATE trust_statement_line SET matched_movement_id = $2::uuid, matched_by = $3::uuid, matched_at = now() WHERE id = $1::uuid AND matched_movement_id IS NULL RETURNING id";

/** Records money the bank shows arrived in trust. With a statement line, the receipt is created from it and reconciled at once. */
export function recordReceipt(db: Queryable, staff: StaffRef, holdingId: string, input: ReceiptInput, statementLineId: string | null = null) {
  return withHolding<{ movementId: string }>(db, holdingId, async (tx, h, movements) => {
    if (await holdingFrozen(tx, holdingId)) return no(409, FROZEN_MESSAGE);
    const stop = denied(planReceipt(h, movements, input.amountCents));
    if (stop) return stop;
    const movementId = randomUUID();
    await tx.query(INSERT_MOVEMENT_SQL, [movementId, holdingId, "receipt", input.amountCents, input.receivedOn, input.bankReference, null, staff.id]);
    if (statementLineId && (await tx.query(MATCH_LINE_SQL, [statementLineId, movementId, staff.id])).rows.length === 0) throw new Error("statement line already matched");
    const b = balanceOf(h.requiredCents, [...movements, { kind: "receipt", amountCents: input.amountCents }]);
    await audit(tx, staff, "deposit_holding", holdingId, "escrow.receipt_recorded", {
      movementId, amountCents: input.amountCents, receivedOn: input.receivedOn, bankReference: input.bankReference, statementLineId, outstandingCents: b.outstandingCents
    });
    return { ok: true, value: { movementId } };
  });
}

/** First person: asks for the held deposit to be paid out. Nothing moves until a different person approves. */
export function requestRelease(db: Queryable, staff: StaffRef, holdingId: string, input: ReleaseRequestInput) {
  return withHolding<{ releaseId: string }>(db, holdingId, async (tx, h, movements, releases) => {
    if (await holdingFrozen(tx, holdingId)) return no(409, FROZEN_MESSAGE);
    const stop = denied(planReleaseRequest(h, movements, releases, input));
    if (stop) return stop;
    const releaseId = randomUUID();
    await tx.query(
      "INSERT INTO deposit_release (id, holding_id, kind, amount_cents, reason, settlement_confirmed, requested_by) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::uuid)",
      [releaseId, holdingId, input.kind, input.amountCents, input.reason, input.settlementConfirmed, staff.id]
    );
    await audit(tx, staff, "deposit_holding", holdingId, `escrow.${input.kind}_requested`, { releaseId, amountCents: input.amountCents, reason: input.reason, settlementConfirmed: input.settlementConfirmed });
    return { ok: true, value: { releaseId } };
  });
}

/**
 * Second person: approves or rejects. Approval writes the payout into the ledger (the instruction to the solicitor to pay from trust)
 * and closes the record once nothing is left held. The bank line for the payment is matched later in reconciliation.
 */
export async function decideRelease(db: Queryable, staff: StaffRef, releaseId: string, outcome: unknown, reason: unknown): Promise<Out<{ outcome: "approved" | "rejected"; holdingStatus: HoldingStatus }>> {
  const holdingId = (await db.query("SELECT holding_id FROM deposit_release WHERE id = $1::uuid", [releaseId])).rows[0]?.["holding_id"];
  if (!holdingId) return no(404, "Request not found.");
  return withHolding(db, String(holdingId), async (tx, h, movements, releases) => {
    const r = releases.find(x => x.id === releaseId)!;
    const held = balanceOf(h.requiredCents, movements).heldCents;
    const stop = denied(planReleaseDecision(staff.id, r, outcome, reason, held, r.amountCents));
    if (stop) return stop;
    const text = String(reason).trim();
    const approved = outcome === "approve";
    // While a case is open only the payments it asked for can be approved; anything else waits (it can still be rejected).
    if (approved && !r.fallThroughId && (await holdingFrozen(tx, String(holdingId)))) return no(409, FROZEN_MESSAGE);
    await tx.query(
      "UPDATE deposit_release SET status = $2, decided_by = $3::uuid, decided_at = now(), decision_reason = $4 WHERE id = $1::uuid AND status = 'pending'",
      [releaseId, approved ? "approved" : "rejected", staff.id, text]
    );
    let status: HoldingStatus = h.status;
    if (approved) {
      const movementId = randomUUID();
      await tx.query(INSERT_MOVEMENT_SQL, [movementId, String(holdingId), r.kind, r.amountCents, today(), null, releaseId, staff.id]);
      status = statusAfterPayout(r.kind, held - r.amountCents);
      if (status !== "open") {
        await tx.query("UPDATE deposit_holding SET status = $2, closed_reason = $3, updated_at = now() WHERE id = $1::uuid", [String(holdingId), status, r.reason]);
      }
    }
    await audit(tx, staff, "deposit_holding", String(holdingId), `escrow.${r.kind}_${approved ? "approved" : "rejected"}`, {
      releaseId, amountCents: r.amountCents, requestedBy: r.requestedBy, reason: text, holdingStatus: status
    });
    if (approved && r.fallThroughId) await finishIfPaid(tx, staff, r.fallThroughId);
    return { ok: true, value: { outcome: approved ? "approved" : "rejected", holdingStatus: status } };
  });
}

/** Cancels a record opened in error or for an offer that fell through before any money arrived. */
export function cancelHolding(db: Queryable, staff: StaffRef, holdingId: string, reason: string) {
  return withHolding<{ status: HoldingStatus }>(db, holdingId, async (tx, h, movements, releases) => {
    if (await holdingFrozen(tx, holdingId)) return no(409, FROZEN_MESSAGE);
    const stop = denied(planCancel(h, movements, releases));
    if (stop) return stop;
    await tx.query("UPDATE deposit_holding SET status = 'cancelled', closed_reason = $2, updated_at = now() WHERE id = $1::uuid", [holdingId, reason]);
    await audit(tx, staff, "deposit_holding", holdingId, "escrow.holding_cancelled", { reason });
    return { ok: true, value: { status: "cancelled" as HoldingStatus } };
  });
}

// ---------- bank statements and reconciliation ----------

const fingerprint = (l: ParsedStatement["lines"][number]) => createHash("sha256").update(lineKey(l)).digest("hex");

/** Adds a statement's lines to a trust account. Lines already imported (same content) are skipped, so overlapping files are safe. */
export async function importStatement(db: Queryable, staff: StaffRef, trustAccountId: string, fileName: string | null, parsed: ParsedStatement): Promise<Out<{ importId: string; added: number; skipped: number }>> {
  const exists = (await db.query("SELECT 1 FROM deposit_holding WHERE trust_account_id = $1::uuid LIMIT 1", [trustAccountId])).rows.length > 0;
  if (!exists) return no(404, "No deposit is held in that trust account.");
  if (parsed.lines.length === 0) return no(400, parsed.errors[0] ?? "No transactions found.");
  const importId = randomUUID();
  return atomic(db, async tx => {
    // The import row goes first (lines reference it) and is insert-only, so the counts are worked out before it is written.
    const prints = parsed.lines.map(fingerprint);
    const have = new Set((await tx.query("SELECT fingerprint FROM trust_statement_line WHERE trust_account_id = $1::uuid AND fingerprint = ANY($2::text[])", [trustAccountId, prints])).rows.map(r => String(r["fingerprint"]).trim()));
    const fresh = parsed.lines.map((l, i) => ({ l, fp: prints[i]! })).filter(x => !have.has(x.fp));
    await tx.query("INSERT INTO trust_statement_import (id, trust_account_id, file_name, lines_added, lines_skipped, imported_by) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid)",
      [importId, trustAccountId, fileName, fresh.length, parsed.lines.length - fresh.length, staff.id]);
    for (const { l, fp } of fresh) {
      await tx.query(
        "INSERT INTO trust_statement_line (import_id, trust_account_id, line_date, amount_cents, description, reference, fingerprint) VALUES ($1::uuid,$2::uuid,$3::date,$4,$5,$6,$7)",
        [importId, trustAccountId, l.lineDate, l.amountCents, l.description, l.reference, fp]
      );
    }
    await audit(tx, staff, "trust_account", trustAccountId, "escrow.statement_imported", { importId, fileName, added: fresh.length, skipped: parsed.lines.length - fresh.length, unreadable: parsed.errors.length });
    return { ok: true, value: { importId, added: fresh.length, skipped: parsed.lines.length - fresh.length } };
  });
}

export interface AccountLedger { lines: StatementLine[]; movements: DepositMovement[]; holdings: DepositHolding[] }
/** One trust account's statement lines (newest first), and the deposit records and ledger entries kept in it. */
export async function accountLedger(db: Queryable, trustAccountId: string): Promise<AccountLedger> {
  const holdings = (await db.query(`SELECT ${HOLDING_COLS} ${HOLDING_FROM} WHERE h.trust_account_id = $1::uuid ORDER BY h.created_at DESC LIMIT 1000`, [trustAccountId])).rows.map(holdingFromRow);
  const [lines, movements] = await Promise.all([
    db.query(`SELECT ${LINE_COLS} FROM trust_statement_line s WHERE s.trust_account_id = $1::uuid ORDER BY s.line_date DESC, s.id LIMIT 2000`, [trustAccountId]),
    db.query(MOVEMENTS_FOR_SQL, [holdings.map(h => h.id)])
  ]);
  return { lines: lines.rows.map(lineFromRow), movements: movements.rows.map(movementFromRow), holdings };
}

async function lineById(db: Queryable, id: string) {
  const row = (await db.query(`SELECT ${LINE_COLS} FROM trust_statement_line s WHERE s.id = $1::uuid`, [id])).rows[0];
  return row ? lineFromRow(row) : null;
}

/** Matches a bank line to a ledger entry recorded earlier. Both must be unmatched, same account, same direction and amount. */
export async function matchLine(db: Queryable, staff: StaffRef, lineId: string, movementId: string): Promise<Out<{ holdingId: string }>> {
  const line = await lineById(db, lineId);
  if (!line) return no(404, "Statement line not found.");
  const mrow = (await db.query(`SELECT ${MOVEMENT_COLS}, h.trust_account_id FROM deposit_movement m JOIN deposit_holding h ON h.id = m.holding_id WHERE m.id = $1::uuid`, [movementId])).rows[0];
  if (!mrow) return no(404, "Ledger entry not found.");
  const m = movementFromRow(mrow);
  const stop = denied(planMatch(line, m, String(mrow["trust_account_id"])));
  if (stop) return stop;
  try {
    return await atomic(db, async tx => {
      if ((await tx.query(MATCH_LINE_SQL, [lineId, movementId, staff.id])).rows.length === 0) return no(409, "This statement line is already matched.");
      await audit(tx, staff, "deposit_holding", m.holdingId, "escrow.reconciled", { lineId, movementId, kind: m.kind, amountCents: m.amountCents, lineDate: line.lineDate });
      return { ok: true as const, value: { holdingId: m.holdingId } };
    });
  } catch {
    return no(409, "That ledger entry was matched by someone else; reload.");
  }
}

/** Creates the receipt for a deposit straight from a bank credit line, already reconciled. */
export async function receiptFromLine(db: Queryable, staff: StaffRef, lineId: string, holdingId: string): Promise<Out<{ movementId: string }>> {
  const line = await lineById(db, lineId);
  if (!line) return no(404, "Statement line not found.");
  if (line.matchedMovementId) return no(409, "This statement line is already matched.");
  if (line.amountCents <= 0) return no(409, "Only money coming in can be a deposit receipt.");
  const acct = (await db.query("SELECT trust_account_id FROM deposit_holding WHERE id = $1::uuid", [holdingId])).rows[0];
  if (!acct) return no(404, "Deposit record not found.");
  if (String(acct["trust_account_id"]) !== line.trustAccountId) return no(409, "The statement line is from a different trust account.");
  const bankReference = (line.reference || line.description).slice(0, 100) || null;
  try {
    return await recordReceipt(db, staff, holdingId, { amountCents: line.amountCents, receivedOn: line.lineDate, bankReference }, lineId);
  } catch {
    return no(409, "This statement line was matched by someone else; reload.");
  }
}
