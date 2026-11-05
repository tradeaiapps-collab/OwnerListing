import { randomUUID } from "node:crypto";
import {
  daysBetween, deadlineFor, evaluateRound, ESCALATION_LABEL, isOverdue, mediate, medianPct, MIN_HISTORY, TYPE_LABEL,
  type CreateInput, type DisputeStatus, type DisputeType, type EscalationReason, type History, type MediationInput, type Party, type PositionInput,
  type ResponseInput, type ResponseKind, type Suggestion
} from "../domain/dispute";
import { appendAuditPg, type Queryable } from "./db";
import { notifyUser } from "./notifier";
import { postSystemNote } from "./transaction-message-db";

// Parameterised SQL only. Each write and its audit_event row share one transaction with the settlement row locked first. Rows are never deleted (db trigger).

export type Out<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

export type Side = Party | "agent";
export interface RoundView {
  round: number; suggestion: Suggestion; resolved: boolean; buyerResponded: boolean; sellerResponded: boolean;
  /** Each side's answer is hidden from the other until the round is closed. */
  buyerResponse: ResponseKind | null; buyerCounterPct: number | null; buyerNote: string | null;
  sellerResponse: ResponseKind | null; sellerCounterPct: number | null; sellerNote: string | null;
}
export interface StaffAction { action: string; note: string | null; at: string }
export interface DisputeSummary {
  id: string; settlementId: string; listingTitle: string; type: DisputeType; title: string; status: DisputeStatus; currentRound: number;
  initiatedBy: Party; deadlineAt: string; createdAt: string; escalationReason: EscalationReason | null; side: Side | "staff";
  /** True when this person has something to do now. */
  yourTurn: boolean;
}
export interface DisputeView extends DisputeSummary {
  description: string; claimCents: number | null; buyerPosition: string | null; buyerSharePct: number | null; sellerPosition: string | null; sellerSharePct: number | null;
  agreedSellerSharePct: number | null; outcome: string | null; resolvedAt: string | null; rounds: RoundView[]; staffActions: StaffAction[];
  canPosition: boolean; canRespond: boolean; canWithdraw: boolean; escalationText: string | null;
}

// ---------- shared lookups ----------

interface Ctx {
  id: string; buyerId: string; sellerId: string; agentId: string | null; completed: boolean; fellThrough: boolean; title: string; address: string;
  settleTarget: string | null; blocked: boolean;
}
const CTX_SQL =
  `SELECT t.id, t.buyer_id, t.seller_id, t.completed_at, o.status AS offer_status, l.title, l.address_text,
          (SELECT a.agent_user_id FROM listing_agent_appointment a WHERE a.listing_id = t.listing_id AND a.revoked_at IS NULL LIMIT 1) AS agent_id,
          (SELECT m.target_date FROM settlement_milestones m WHERE m.settlement_id = t.id AND m.stage = 'settlement_completed') AS settle_target,
          (SELECT m.status FROM settlement_milestones m WHERE m.settlement_id = t.id AND m.stage = t.current_stage) AS current_status
     FROM settlement_timeline t JOIN formal_offer o ON o.id = t.offer_id JOIN property_listing l ON l.id = t.listing_id`;
const ctxOf = (r: Record<string, unknown>): Ctx => ({
  id: String(r["id"]), buyerId: String(r["buyer_id"]), sellerId: String(r["seller_id"]), agentId: str(r["agent_id"]),
  completed: r["completed_at"] != null, fellThrough: r["offer_status"] === "fallen_through", title: String(r["title"]), address: String(r["address_text"] ?? r["title"]),
  settleTarget: r["settle_target"] == null ? null : (r["settle_target"] instanceof Date ? r["settle_target"].toISOString() : String(r["settle_target"])).slice(0, 10), blocked: r["current_status"] === "blocked"
});
async function loadCtx(tx: Queryable, settlementId: string, lock = false): Promise<Ctx | null> {
  const r = (await tx.query(`${CTX_SQL} WHERE t.id = $1::uuid${lock ? " FOR UPDATE OF t" : ""}`, [settlementId])).rows[0];
  return r ? ctxOf(r) : null;
}
const sideIn = (c: Ctx, userId: string): Side | null =>
  c.buyerId === c.sellerId ? null : c.buyerId === userId ? "buyer" : c.sellerId === userId ? "seller" : c.agentId === userId ? "agent" : null;
const closedReason = (c: Ctx) => (c.completed ? "This sale has settled." : c.fellThrough ? "This sale has fallen through." : null);

async function audit(tx: Queryable, actorType: "user" | "system", actorId: string | null, id: string, eventType: string, payload: Record<string, unknown>) {
  await appendAuditPg(tx, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType, actorId: actorId ?? "system", aggregateType: "dispute", aggregateId: id,
    eventType, correlationId: randomUUID(), payload
  });
}

/** Past agreed or staff-settled disputes of one type: how much of the amount the seller covered. Only counts, never who or where. */
export async function historyFor(db: Queryable, type: DisputeType): Promise<History | null> {
  const rows = (await db.query(
    "SELECT agreed_seller_share_pct FROM disputes WHERE type = $1 AND status IN ('agreed','resolved') AND agreed_seller_share_pct IS NOT NULL ORDER BY resolved_at DESC LIMIT 500", [type])).rows;
  if (rows.length < MIN_HISTORY) return null;
  return { samples: rows.length, medianSellerSharePct: medianPct(rows.map(r => Number(r["agreed_seller_share_pct"]))) };
}

async function suggestionFor(tx: Queryable, d: { type: DisputeType; claim: number | null; description: string; created: Date }, c: Ctx, round: number,
  stances: { buyer: number | null; seller: number | null }, texts: { buyer: string; seller: string }, now: Date): Promise<Suggestion> {
  const input: MediationInput = {
    type: d.type, round, claimCents: d.claim, buyerSharePct: stances.buyer, sellerSharePct: stances.seller, buyerText: texts.buyer, sellerText: texts.seller, description: d.description,
    daysOpen: daysBetween(d.created, now), daysToSettlement: c.settleTarget ? daysBetween(now, new Date(`${c.settleTarget}T00:00:00Z`)) : null, settlementBlocked: c.blocked,
    history: await historyFor(tx, d.type)
  };
  return mediate(input);
}

// ---------- notifications ----------

/** Tells the chosen sides of a settlement about a dispute step. Ids and the address come from the database. Never throws. */
async function tell(db: Queryable, c: Ctx, sides: Side[], disputeId: string, what: { kind: "opened"; title: string } | { kind: "update"; title: string; text: string }): Promise<void> {
  try {
    const link = `/settlements/${c.id}/disputes#${disputeId}`;
    const id = (s: Side) => (s === "buyer" ? c.buyerId : s === "seller" ? c.sellerId : c.agentId);
    for (const s of sides) {
      const to = id(s);
      if (!to) continue;
      if (what.kind === "opened") await notifyUser(db, to, "dispute_opened", { listing: c.address, title: what.title, link });
      else await notifyUser(db, to, "dispute_update", { listing: c.address, title: what.title, text: what.text, link });
    }
  } catch {
    // A notification never blocks the step that caused it.
  }
}
const other = (s: Party): Party => (s === "buyer" ? "seller" : "buyer");

// ---------- create and position ----------

/** Opens a dispute. Only the buyer or the owner can; the agent and staff are told. One live dispute per type per sale. */
export async function createDispute(db: Queryable, userId: string, settlementId: string, input: CreateInput, now: Date = new Date()): Promise<Out<{ id: string }>> {
  const h: { ctx: Ctx | null; side: Party | null } = { ctx: null, side: null };
  const out = await atomic(db, async tx => {
    const c = h.ctx = await loadCtx(tx, settlementId, true);
    const side = c ? sideIn(c, userId) : null;
    if (!c || !side) return no(404, "Settlement not found.");
    if (side === "agent") return no(403, "Only the buyer or the owner can raise a dispute. Ask them, or message them in the sale thread.");
    const closed = closedReason(c);
    if (closed) return no(409, `${closed} A dispute cannot be raised now.`);
    const live = (await tx.query("SELECT 1 FROM disputes WHERE settlement_id = $1::uuid AND type = $2 AND status IN ('awaiting_position','mediating','escalated')", [settlementId, input.type])).rows;
    if (live.length) return no(409, "There is already an open dispute of this kind on this sale.");
    h.side = side;
    const id = randomUUID();
    const mine = side === "buyer" ? { text: "buyer_position", pct: "buyer_share_pct" } : { text: "seller_position", pct: "seller_share_pct" };
    await tx.query(
      `INSERT INTO disputes (id, settlement_id, type, title, description, initiated_by, initiated_by_side, claim_cents, ${mine.text}, ${mine.pct}, deadline_at, created_at, updated_at)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7,$8,$9,$10,$11,$12,$12)`,
      [id, settlementId, input.type, input.title, input.description, userId, side, input.claimCents, input.position, input.sellerSharePct, deadlineFor(now), now]);
    await audit(tx, "user", userId, id, "dispute.opened", { settlementId, type: input.type, side, hasAmount: input.claimCents !== null });
    await postSystemNote(tx, settlementId, `A ${TYPE_LABEL[input.type].toLowerCase()} dispute was raised: "${input.title}". Open the disputes page for this sale to add your side and see Elena's suggestion.`);
    return { ok: true as const, value: { id } };
  });
  if (out.ok && h.ctx && h.side) await tell(db, h.ctx, [other(h.side), "agent"], out.value.id, { kind: "opened", title: input.title });
  return out;
}

type DRow = Record<string, unknown>;
async function lockDispute(tx: Queryable, settlementId: string, id: string): Promise<DRow | undefined> {
  return (await tx.query("SELECT * FROM disputes WHERE id = $1::uuid AND settlement_id = $2::uuid FOR UPDATE", [id, settlementId])).rows[0];
}

/** The other side states their position; Elena then opens round 1. */
export async function submitPosition(db: Queryable, userId: string, settlementId: string, id: string, input: PositionInput, now: Date = new Date()): Promise<Out<{ round: number }>> {
  const h: { ctx: Ctx | null } = { ctx: null };
  const out = await atomic(db, async tx => {
    const c = h.ctx = await loadCtx(tx, settlementId, true);
    const side = c ? sideIn(c, userId) : null;
    const d = c && side ? await lockDispute(tx, settlementId, id) : undefined;
    if (!c || !side || !d) return no(404, "Dispute not found.");
    if (side === "agent") return no(403, "Only the buyer or the owner can add their side.");
    if (d["status"] !== "awaiting_position") return no(409, "This dispute is not waiting for your side.");
    if (d["initiated_by_side"] === side) return no(409, "You already gave your side. Waiting for the other party.");
    const col = side === "buyer" ? { text: "buyer_position", pct: "buyer_share_pct" } : { text: "seller_position", pct: "seller_share_pct" };
    await tx.query(`UPDATE disputes SET ${col.text} = $2, ${col.pct} = $3, status = 'mediating', current_round = 1, updated_at = $4 WHERE id = $1::uuid`, [id, input.position, input.sellerSharePct, now]);
    const fresh = (await tx.query("SELECT * FROM disputes WHERE id = $1::uuid", [id])).rows[0]!;
    const s = await suggestionFor(tx, { type: String(fresh["type"]) as DisputeType, claim: num(fresh["claim_cents"]), description: String(fresh["description"]), created: new Date(iso(fresh["created_at"])!) }, c, 1,
      { buyer: num(fresh["buyer_share_pct"]), seller: num(fresh["seller_share_pct"]) }, { buyer: String(fresh["buyer_position"] ?? ""), seller: String(fresh["seller_position"] ?? "") }, now);
    await tx.query("INSERT INTO dispute_mediation_rounds (dispute_id, round, elena_suggestion) VALUES ($1::uuid, 1, $2::jsonb)", [id, JSON.stringify(s)]);
    await audit(tx, "user", userId, id, "dispute.position_added", { side });
    await postSystemNote(tx, settlementId, `Both sides have given their position on "${String(fresh["title"])}". Elena has a suggestion ready on the disputes page.`);
    return { ok: true as const, value: { round: 1 } };
  });
  if (out.ok && h.ctx) await tell(db, h.ctx, ["buyer", "seller"], id, { kind: "update", title: "Elena has a suggestion", text: "Both sides have given their position. Open the dispute to see Elena's suggestion and accept, counter or ask for staff." });
  return out;
}

// ---------- respond ----------

const stanceOf = (resp: unknown, counter: unknown, suggested: number | null): number | null => (resp === "counter" ? num(counter) : suggested);

/** Accept, counter or ask for staff on the current round. Answers are private until both sides have answered. */
export async function respond(db: Queryable, userId: string, settlementId: string, id: string, input: ResponseInput, now: Date = new Date()): Promise<Out<{ status: DisputeStatus; round: number }>> {
  const h: { ctx: Ctx | null; told: { sides: Side[]; title: string; text: string } | null } = { ctx: null, told: null };
  const out = await atomic(db, async tx => {
    const c = h.ctx = await loadCtx(tx, settlementId, true);
    const side = c ? sideIn(c, userId) : null;
    const d = c && side ? await lockDispute(tx, settlementId, id) : undefined;
    if (!c || !side || !d) return no(404, "Dispute not found.");
    if (side === "agent") return no(403, "Only the buyer or the owner can answer a dispute.");
    if (d["status"] !== "mediating") return no(409, "This dispute is not open for answers.");
    const round = Number(d["current_round"]);
    const r = (await tx.query("SELECT * FROM dispute_mediation_rounds WHERE dispute_id = $1::uuid AND round = $2 FOR UPDATE", [id, round])).rows[0];
    if (!r || r["resolved"]) return no(409, "This round is already closed.");
    if (r[`${side}_response`] != null) return no(409, "You already answered this round.");
    await tx.query(
      `UPDATE dispute_mediation_rounds SET ${side}_response = $3, ${side}_counter_pct = $4, ${side}_note = $5 WHERE dispute_id = $1::uuid AND round = $2`,
      [id, round, input.response, input.response === "counter" ? input.sellerSharePct : null, input.note]);
    const buyerResp = (side === "buyer" ? input.response : r["buyer_response"]) as ResponseKind | null;
    const sellerResp = (side === "seller" ? input.response : r["seller_response"]) as ResponseKind | null;
    const o = evaluateRound(round, buyerResp, sellerResp);
    const title = String(d["title"]);
    if (o.kind === "wait") {
      await audit(tx, "user", userId, id, "dispute.responded", { side, round, response: input.response });
      return { ok: true as const, value: { status: "mediating" as DisputeStatus, round } };
    }
    await tx.query("UPDATE dispute_mediation_rounds SET resolved = true WHERE dispute_id = $1::uuid AND round = $2", [id, round]);
    const suggestion = r["elena_suggestion"] as Suggestion;
    if (o.kind === "agreed") {
      const outcome = `Both sides accepted Elena's suggestion: ${suggestion.headline}`;
      await tx.query("UPDATE disputes SET status = 'agreed', resolved_at = $2, agreed_seller_share_pct = $3, outcome = $4, updated_at = $2 WHERE id = $1::uuid", [id, now, suggestion.sellerSharePct, outcome]);
      await audit(tx, "user", userId, id, "dispute.agreed", { round, sellerSharePct: suggestion.sellerSharePct });
      await postSystemNote(tx, settlementId, `Dispute agreed: "${title}". ${suggestion.headline} Record it in the contract through your solicitors.`);
      h.told = { sides: ["buyer", "seller", "agent"], title: "Dispute agreed", text: `Both sides accepted. ${suggestion.headline}` };
      return { ok: true as const, value: { status: "agreed" as DisputeStatus, round } };
    }
    if (o.kind === "escalate") {
      await escalate(tx, c, d, o.reason, userId, now);
      h.told = { sides: ["buyer", "seller", "agent"], title: "Dispute sent to staff", text: `${ESCALATION_LABEL[o.reason]}. A staff member will review it.` };
      return { ok: true as const, value: { status: "escalated" as DisputeStatus, round } };
    }
    // Next round: each side's stance is their counter, or Elena's suggestion if they accepted it.
    const stances = {
      buyer: stanceOf(buyerResp, side === "buyer" ? input.sellerSharePct : r["buyer_counter_pct"], suggestion.sellerSharePct),
      seller: stanceOf(sellerResp, side === "seller" ? input.sellerSharePct : r["seller_counter_pct"], suggestion.sellerSharePct)
    };
    const notes = { buyer: String((side === "buyer" ? input.note : r["buyer_note"]) ?? d["buyer_position"] ?? ""), seller: String((side === "seller" ? input.note : r["seller_note"]) ?? d["seller_position"] ?? "") };
    const next = await suggestionFor(tx, { type: String(d["type"]) as DisputeType, claim: num(d["claim_cents"]), description: String(d["description"]), created: new Date(iso(d["created_at"])!) }, c, round + 1, stances, notes, now);
    await tx.query("INSERT INTO dispute_mediation_rounds (dispute_id, round, elena_suggestion) VALUES ($1::uuid,$2,$3::jsonb)", [id, round + 1, JSON.stringify(next)]);
    await tx.query("UPDATE disputes SET current_round = $2, updated_at = $3 WHERE id = $1::uuid", [id, round + 1, now]);
    await audit(tx, "user", userId, id, "dispute.next_round", { round: round + 1 });
    h.told = { sides: ["buyer", "seller"], title: `Round ${round + 1}: a new suggestion`, text: "Elena has a new suggestion based on both answers. Open the dispute to respond." };
    return { ok: true as const, value: { status: "mediating" as DisputeStatus, round: round + 1 } };
  });
  if (out.ok && h.ctx && h.told) await tell(db, h.ctx, h.told.sides, id, { kind: "update", title: h.told.title, text: h.told.text });
  return out;
}

async function escalate(tx: Queryable, c: Ctx, d: DRow, reason: EscalationReason, byUserId: string | null, now: Date) {
  const id = String(d["id"]);
  await tx.query("UPDATE disputes SET status = 'escalated', escalation_reason = $2, escalated_at = $3, updated_at = $3 WHERE id = $1::uuid", [id, reason, now]);
  await tx.query("INSERT INTO dispute_staff_actions (dispute_id, staff_user_id, action, note) VALUES ($1::uuid,$2,$3,$4)", [id, byUserId, reason === "timeout" ? "auto_escalated" : "escalated", ESCALATION_LABEL[reason]]);
  await audit(tx, byUserId ? "user" : "system", byUserId, id, "dispute.escalated", { reason });
  await postSystemNote(tx, c.id, `The dispute "${String(d["title"])}" was sent to staff: ${ESCALATION_LABEL[reason].toLowerCase()}.`);
}

/** The person who raised it can pull it back while it is still with the two parties. */
export async function withdraw(db: Queryable, userId: string, settlementId: string, id: string, now: Date = new Date()): Promise<Out<{ status: DisputeStatus }>> {
  const h: { ctx: Ctx | null } = { ctx: null };
  const out = await atomic(db, async tx => {
    const c = h.ctx = await loadCtx(tx, settlementId, true);
    const side = c ? sideIn(c, userId) : null;
    const d = c && side ? await lockDispute(tx, settlementId, id) : undefined;
    if (!c || !side || !d) return no(404, "Dispute not found.");
    if (String(d["initiated_by"]) !== userId) return no(403, "Only the person who raised this dispute can withdraw it.");
    if (d["status"] !== "awaiting_position" && d["status"] !== "mediating") return no(409, "This dispute can no longer be withdrawn.");
    await tx.query("UPDATE disputes SET status = 'withdrawn', resolved_at = $2, updated_at = $2 WHERE id = $1::uuid", [id, now]);
    await audit(tx, "user", userId, id, "dispute.withdrawn", {});
    await postSystemNote(tx, settlementId, `The dispute "${String(d["title"])}" was withdrawn.`);
    return { ok: true as const, value: { status: "withdrawn" as DisputeStatus } };
  });
  if (out.ok && h.ctx) await tell(db, h.ctx, ["buyer", "seller", "agent"], id, { kind: "update", title: "Dispute withdrawn", text: "The dispute was withdrawn by the person who raised it." });
  return out;
}

// ---------- timeout ----------

/** Sends every dispute still with the two parties after 5 days to staff. Safe to call often (cron, and on every read). Returns how many moved. */
export async function escalateOverdue(db: Queryable, now: Date = new Date()): Promise<{ escalated: number }> {
  const due = (await db.query("SELECT id, settlement_id FROM disputes WHERE status IN ('awaiting_position','mediating') AND deadline_at <= $1 ORDER BY deadline_at LIMIT 200", [now])).rows;
  let escalated = 0;
  for (const row of due) {
    const h: { ctx: Ctx | null } = { ctx: null };
    const moved = await atomic(db, async tx => {
      const c = h.ctx = await loadCtx(tx, String(row["settlement_id"]), true);
      const d = c ? await lockDispute(tx, c.id, String(row["id"])) : undefined;
      if (!c || !d || (d["status"] !== "awaiting_position" && d["status"] !== "mediating") || !isOverdue(new Date(iso(d["deadline_at"])!), now)) return false;
      await escalate(tx, c, d, "timeout", null, now);
      return true;
    });
    if (moved && h.ctx) { escalated++; await tell(db, h.ctx, ["buyer", "seller", "agent"], String(row["id"]), { kind: "update", title: "Dispute sent to staff", text: `${ESCALATION_LABEL.timeout}. A staff member will review it.` }); }
  }
  return { escalated };
}

// ---------- read ----------

const LIST_COLS =
  `d.id, d.settlement_id, d.type, d.title, d.status, d.current_round, d.initiated_by_side, d.deadline_at, d.created_at, d.escalation_reason, l.title AS listing_title`;

function summaryOf(r: DRow, side: Side | "staff", rounds: Pick<RoundView, "round" | "buyerResponded" | "sellerResponded">[] = []): DisputeSummary {
  const status = String(r["status"]) as DisputeStatus, initiated = String(r["initiated_by_side"]) as Party, cur = rounds.find(x => x.round === Number(r["current_round"]));
  const yourTurn = (side === "buyer" || side === "seller") && (
    (status === "awaiting_position" && initiated !== side) || (status === "mediating" && !!cur && !(side === "buyer" ? cur.buyerResponded : cur.sellerResponded)));
  return {
    id: String(r["id"]), settlementId: String(r["settlement_id"]), listingTitle: String(r["listing_title"]), type: String(r["type"]) as DisputeType, title: String(r["title"]), status,
    currentRound: Number(r["current_round"]), initiatedBy: initiated, deadlineAt: iso(r["deadline_at"])!, createdAt: iso(r["created_at"])!,
    escalationReason: r["escalation_reason"] == null ? null : (String(r["escalation_reason"]) as EscalationReason), side, yourTurn
  };
}

/** Disputes on the sales the person is part of (buyer, owner or appointed agent), open ones first. */
export async function listDisputes(db: Queryable, userId: string, filter: { side?: Side; settlementId?: string } = {}, now: Date = new Date()): Promise<DisputeSummary[]> {
  try { await escalateOverdue(db, now); } catch { /* the list still works */ }
  const rows = (await db.query(
    `SELECT ${LIST_COLS}, t.buyer_id, t.seller_id,
            (SELECT a.agent_user_id FROM listing_agent_appointment a WHERE a.listing_id = t.listing_id AND a.revoked_at IS NULL LIMIT 1) AS agent_id,
            (SELECT json_agg(json_build_object('round', r.round, 'b', r.buyer_response IS NOT NULL, 's', r.seller_response IS NOT NULL)) FROM dispute_mediation_rounds r WHERE r.dispute_id = d.id) AS rounds
       FROM disputes d JOIN settlement_timeline t ON t.id = d.settlement_id JOIN property_listing l ON l.id = t.listing_id
      WHERE ($1::uuid IS NULL OR d.settlement_id = $1::uuid)
      ORDER BY d.created_at DESC LIMIT 500`, [filter.settlementId ?? null])).rows;
  const out: DisputeSummary[] = [];
  for (const r of rows) {
    const side = sideIn({ buyerId: String(r["buyer_id"]), sellerId: String(r["seller_id"]), agentId: str(r["agent_id"]) } as Ctx, userId);
    if (!side || (filter.side && filter.side !== side)) continue;
    const rounds = ((r["rounds"] as { round: number; b: boolean; s: boolean }[] | null) ?? []).map(x => ({ round: x.round, buyerResponded: x.b, sellerResponded: x.s }));
    out.push(summaryOf(r, side, rounds));
  }
  const live = (s: DisputeSummary) => Number(!["awaiting_position", "mediating", "escalated"].includes(s.status));
  return out.sort((a, b) => live(a) - live(b) || Number(b.yourTurn) - Number(a.yourTurn));
}

async function buildView(db: Queryable, r: DRow, side: Side | "staff"): Promise<DisputeView> {
  const id = String(r["id"]);
  const roundRows = (await db.query("SELECT * FROM dispute_mediation_rounds WHERE dispute_id = $1::uuid ORDER BY round", [id])).rows;
  const rounds: RoundView[] = roundRows.map(x => {
    const resolved = x["resolved"] === true, show = (s: Party) => side === "staff" || resolved || side === s;
    return {
      round: Number(x["round"]), suggestion: x["elena_suggestion"] as Suggestion, resolved, buyerResponded: x["buyer_response"] != null, sellerResponded: x["seller_response"] != null,
      buyerResponse: show("buyer") ? (str(x["buyer_response"]) as ResponseKind | null) : null, buyerCounterPct: show("buyer") ? num(x["buyer_counter_pct"]) : null, buyerNote: show("buyer") ? str(x["buyer_note"]) : null,
      sellerResponse: show("seller") ? (str(x["seller_response"]) as ResponseKind | null) : null, sellerCounterPct: show("seller") ? num(x["seller_counter_pct"]) : null, sellerNote: show("seller") ? str(x["seller_note"]) : null
    };
  });
  const base = summaryOf(r, side, rounds);
  const staffActions = (await db.query("SELECT action, note, created_at FROM dispute_staff_actions WHERE dispute_id = $1::uuid ORDER BY created_at, id", [id])).rows
    .map(a => ({ action: String(a["action"]), note: str(a["note"]), at: iso(a["created_at"])! }));
  const cur = rounds.find(x => x.round === base.currentRound);
  const isParty = side === "buyer" || side === "seller";
  const live = base.status === "awaiting_position" || base.status === "mediating";
  return {
    ...base, description: String(r["description"]), claimCents: num(r["claim_cents"]), buyerPosition: str(r["buyer_position"]), buyerSharePct: num(r["buyer_share_pct"]),
    sellerPosition: str(r["seller_position"]), sellerSharePct: num(r["seller_share_pct"]), agreedSellerSharePct: num(r["agreed_seller_share_pct"]), outcome: str(r["outcome"]),
    resolvedAt: iso(r["resolved_at"]), rounds, staffActions,
    canPosition: isParty && base.status === "awaiting_position" && base.initiatedBy !== side,
    canRespond: isParty && base.status === "mediating" && !!cur && !cur.resolved && !(side === "buyer" ? cur.buyerResponded : cur.sellerResponded),
    canWithdraw: isParty && live && base.initiatedBy === side,
    escalationText: base.escalationReason ? ESCALATION_LABEL[base.escalationReason] : null
  };
}

export async function disputeView(db: Queryable, userId: string, settlementId: string, id: string, now: Date = new Date()): Promise<Out<DisputeView>> {
  try { await escalateOverdue(db, now); } catch { /* the view still works */ }
  const c = await loadCtx(db, settlementId);
  const side = c ? sideIn(c, userId) : null;
  const r = c && side ? (await db.query(`SELECT d.*, l.title AS listing_title FROM disputes d JOIN settlement_timeline t ON t.id = d.settlement_id JOIN property_listing l ON l.id = t.listing_id WHERE d.id = $1::uuid AND d.settlement_id = $2::uuid`, [id, settlementId])).rows[0] : undefined;
  if (!c || !side || !r) return no(404, "Dispute not found.");
  return { ok: true, value: await buildView(db, r, side) };
}

// ---------- staff ----------

export async function staffQueue(db: Queryable, now: Date = new Date()): Promise<{ rows: (DisputeSummary & { claimed: boolean; ageDays: number })[]; metrics: Metrics }> {
  await escalateOverdue(db, now);
  const rows = (await db.query(
    `SELECT ${LIST_COLS}, EXISTS (SELECT 1 FROM dispute_staff_actions a WHERE a.dispute_id = d.id AND a.action = 'claimed') AS claimed
       FROM disputes d JOIN settlement_timeline t ON t.id = d.settlement_id JOIN property_listing l ON l.id = t.listing_id
      ORDER BY (d.status = 'escalated') DESC, (d.status IN ('awaiting_position','mediating')) DESC, d.created_at DESC LIMIT 500`, [])).rows;
  return { rows: rows.map(r => ({ ...summaryOf(r, "staff"), claimed: r["claimed"] === true, ageDays: daysBetween(new Date(iso(r["created_at"])!), now) })), metrics: await metrics(db) };
}

export async function staffView(db: Queryable, id: string): Promise<Out<DisputeView>> {
  const r = (await db.query(`SELECT d.*, l.title AS listing_title FROM disputes d JOIN settlement_timeline t ON t.id = d.settlement_id JOIN property_listing l ON l.id = t.listing_id WHERE d.id = $1::uuid`, [id])).rows[0];
  if (!r) return no(404, "Dispute not found.");
  return { ok: true, value: await buildView(db, r, "staff") };
}

export type StaffChange = { action: "claim" } | { action: "note"; note: string } | { action: "resolve"; outcome: string; sellerSharePct: number | null };

/** Staff work an escalated dispute: claim it, add a note, or record the outcome. Staff never move money here. */
export async function staffAct(db: Queryable, staffId: string, id: string, change: StaffChange, now: Date = new Date()): Promise<Out<{ status: DisputeStatus }>> {
  const h: { ctx: Ctx | null; outcome: string | null } = { ctx: null, outcome: null };
  const out = await atomic(db, async tx => {
    const found = (await tx.query("SELECT settlement_id FROM disputes WHERE id = $1::uuid", [id])).rows[0];
    const c = h.ctx = found ? await loadCtx(tx, String(found["settlement_id"]), true) : null;
    const d = c ? await lockDispute(tx, c.id, id) : undefined;
    if (!c || !d) return no(404, "Dispute not found.");
    if (d["status"] !== "escalated") return no(409, "Only a dispute that has been sent to staff can be worked here.");
    if (change.action === "resolve") {
      await tx.query("UPDATE disputes SET status = 'resolved', resolved_at = $2, outcome = $3, agreed_seller_share_pct = $4, updated_at = $2 WHERE id = $1::uuid", [id, now, change.outcome, change.sellerSharePct]);
      h.outcome = change.outcome;
    } else {
      await tx.query("UPDATE disputes SET updated_at = $2 WHERE id = $1::uuid", [id, now]);
    }
    const action = change.action === "claim" ? "claimed" : change.action === "note" ? "noted" : "resolved";
    await tx.query("INSERT INTO dispute_staff_actions (dispute_id, staff_user_id, action, note) VALUES ($1::uuid,$2::uuid,$3,$4)", [id, staffId, action, change.action === "claim" ? null : change.action === "note" ? change.note : change.outcome]);
    await audit(tx, "user", staffId, id, `dispute.staff_${action}`, { action });
    if (change.action === "resolve") await postSystemNote(tx, c.id, `Staff recorded how the dispute "${String(d["title"])}" ends: ${change.outcome}`);
    return { ok: true as const, value: { status: (change.action === "resolve" ? "resolved" : "escalated") as DisputeStatus } };
  });
  if (out.ok && h.ctx && h.outcome) await tell(db, h.ctx, ["buyer", "seller", "agent"], id, { kind: "update", title: "Dispute resolved by staff", text: h.outcome });
  return out;
}

// ---------- success metric ----------

export interface Metrics {
  total: number; open: number; agreedByParties: number; resolvedByStaff: number; withdrawn: number;
  /** Share of disputes that were settled by the two sides (with Elena) without staff, of those that ended either way. Null until one has ended. */
  mediationSuccessPct: number | null;
  /** Of sales whose dispute was agreed or resolved, how many settled and how many fell through. */
  afterMediation: { settled: number; fellThrough: number; inProgress: number; settledPct: number | null };
}

export async function metrics(db: Queryable): Promise<Metrics> {
  const s = (await db.query(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE d.status IN ('awaiting_position','mediating','escalated')) AS open,
            count(*) FILTER (WHERE d.status = 'agreed') AS agreed,
            count(*) FILTER (WHERE d.status = 'resolved') AS resolved,
            count(*) FILTER (WHERE d.status = 'withdrawn') AS withdrawn,
            count(*) FILTER (WHERE d.status IN ('agreed','resolved') AND t.completed_at IS NOT NULL) AS settled,
            count(*) FILTER (WHERE d.status IN ('agreed','resolved') AND o.status = 'fallen_through') AS fell,
            count(*) FILTER (WHERE d.status IN ('agreed','resolved') AND t.completed_at IS NULL AND o.status <> 'fallen_through') AS going
       FROM disputes d JOIN settlement_timeline t ON t.id = d.settlement_id JOIN formal_offer o ON o.id = t.offer_id`, [])).rows[0]!;
  const n = (k: string) => Number(s[k] ?? 0);
  const ended = n("agreed") + n("resolved"), settled = n("settled"), fell = n("fell");
  return {
    total: n("total"), open: n("open"), agreedByParties: n("agreed"), resolvedByStaff: n("resolved"), withdrawn: n("withdrawn"),
    mediationSuccessPct: ended ? Math.round((n("agreed") / ended) * 100) : null,
    afterMediation: { settled, fellThrough: fell, inProgress: n("going"), settledPct: settled + fell ? Math.round((settled / (settled + fell)) * 100) : null }
  };
}
