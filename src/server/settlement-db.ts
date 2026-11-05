import { randomUUID } from "node:crypto";
import {
  addBusinessDays, addDays, STAGE_LABEL, mayTick, mayUpdateMilestones, milestoneBlocker, newChecklists, nextStage, STAGES, stuckInfo,
  type ChecklistItem, type ItemRole, type MilestoneChange, type MilestoneStatus, type Side, type Stage, type Stuck, type TickChange
} from "../domain/settlement";
import { localDay, STATE_RULES } from "../domain/sale-fall-through";
import { appendAuditPg, type Queryable } from "./db";
import { holidayDatesPg } from "./public-holidays-db";
import { postSystemNote } from "./transaction-message-db";
import { STAGE_NOTE } from "../domain/transaction-messages";

// Parameterised SQL only. Every write and its audit_event row share one transaction with the timeline row locked first. Rows are never deleted (db trigger).

export type Out<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());
const day = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export interface Milestone { stage: Stage; status: MilestoneStatus; targetDate: string | null; actualDate: string | null; note: string | null }
export interface Checklist { stage: Stage; role: ItemRole; items: (ChecklistItem & { canTick: boolean })[]; completedAt: string | null }
export interface SettlementSummary {
  id: string; offerId: string; listingId: string; listingTitle: string; side: Side; currentStage: Stage; completed: boolean; fellThrough: boolean;
  doneStages: number; totalStages: number; stuck: Stuck; nextTarget: string | null;
}
export interface SettlementView extends SettlementSummary { milestones: Milestone[]; checklists: Checklist[]; canUpdate: boolean }

/** The caller's side of a settlement, worked out from the database. A person who is both buyer and owner has no side. */
const SIDE_SQL =
  `CASE WHEN t.buyer_id = t.seller_id THEN NULL WHEN t.buyer_id = $1::uuid THEN 'buyer' WHEN t.seller_id = $1::uuid THEN 'seller'
        WHEN EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = t.listing_id AND a.agent_user_id = $1::uuid AND a.revoked_at IS NULL) THEN 'agent' END`;
const BASE_SQL =
  `SELECT t.id, t.offer_id, t.listing_id, l.title, o.status AS offer_status, t.current_stage, t.stage_entered_at, t.completed_at, ${SIDE_SQL} AS side,
          (SELECT count(*) FROM settlement_milestones m WHERE m.settlement_id = t.id AND m.status = 'completed') AS done,
          (SELECT m.status FROM settlement_milestones m WHERE m.settlement_id = t.id AND m.stage = t.current_stage) AS current_status,
          (SELECT min(m.target_date) FROM settlement_milestones m WHERE m.settlement_id = t.id AND m.status <> 'completed' AND m.target_date IS NOT NULL) AS next_target
     FROM settlement_timeline t JOIN property_listing l ON l.id = t.listing_id JOIN formal_offer o ON o.id = t.offer_id`;

function summary(r: Record<string, unknown>, now: Date): SettlementSummary {
  const completed = r["completed_at"] != null, fellThrough = r["offer_status"] === "fallen_through";
  return {
    id: String(r["id"]), offerId: String(r["offer_id"]), listingId: String(r["listing_id"]), listingTitle: String(r["title"]), side: String(r["side"]) as Side,
    currentStage: String(r["current_stage"]) as Stage, completed, fellThrough, doneStages: Number(r["done"]), totalStages: STAGES.length,
    stuck: fellThrough ? { stuck: false, days: 0, blocked: false } : stuckInfo({ completed, currentStatus: String(r["current_status"]) as MilestoneStatus, enteredAt: new Date(iso(r["stage_entered_at"])!), now }),
    nextTarget: day(r["next_target"])
  };
}

async function audit(tx: Queryable, actorId: string, settlementId: string, eventType: string, payload: Record<string, unknown>) {
  await appendAuditPg(tx, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId, aggregateType: "settlement", aggregateId: settlementId,
    eventType, correlationId: randomUUID(), payload
  });
}

// ---------- start ----------

/**
 * Starts the tracker for an accepted offer. The owner or the listing's appointed agent can do it, once per offer. Stage 1 is already done
 * (the offer was accepted); the cooling-off date is an estimate from the state's business-day rule and public holidays.
 */
export async function createSettlement(db: Queryable, userId: string, offerId: string, now: Date = new Date()): Promise<Out<{ id: string }>> {
  return atomic(db, async tx => {
    const r = (await tx.query(
      `SELECT o.status, o.buyer_user_id, o.settlement_days, l.id AS listing_id, l.owner_user_id, TRIM(l.jurisdiction) AS jurisdiction,
              (SELECT e.occurred_at FROM offer_event e WHERE e.offer_id = o.id AND e.event_type = 'accepted' ORDER BY e.occurred_at DESC LIMIT 1) AS accepted_at,
              (SELECT a.agent_user_id FROM listing_agent_appointment a WHERE a.listing_id = l.id AND a.revoked_at IS NULL LIMIT 1) AS agent_id
         FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id WHERE o.id = $1::uuid FOR UPDATE OF o`, [offerId])).rows[0];
    const isOwner = r && String(r["owner_user_id"]) === userId, isAgent = r && r["agent_id"] != null && String(r["agent_id"]) === userId;
    if (!r || (!isOwner && !isAgent) || String(r["buyer_user_id"]) === String(r["owner_user_id"])) return no(404, "Offer not found.");
    if (r["status"] !== "accepted") return no(409, "A settlement can only be tracked once an offer has been accepted.");
    if ((await tx.query("SELECT 1 FROM settlement_timeline WHERE offer_id = $1::uuid", [offerId])).rows.length) return no(409, "This sale is already being tracked.");

    const state = String(r["jurisdiction"] ?? ""), accepted = localDay(new Date(iso(r["accepted_at"] ?? now)!), state);
    const rule = STATE_RULES[state]?.coolingOffBusinessDays ?? null;
    const holidays = rule ? await holidayDatesPg(tx, state, accepted, addDays(accepted, 40)) : [];
    const targets: Partial<Record<Stage, string>> = { settlement_completed: addDays(accepted, Number(r["settlement_days"])) };
    if (rule) targets.cooling_off_expires = addBusinessDays(accepted, rule, holidays);

    const id = randomUUID();
    await tx.query(
      `INSERT INTO settlement_timeline (id, offer_id, listing_id, buyer_id, seller_id, agent_id, state, current_stage, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'deposit_received',$8)`,
      [id, offerId, r["listing_id"], r["buyer_user_id"], r["owner_user_id"], r["agent_id"] ?? null, state, userId]);
    for (const stage of STAGES) {
      const first = stage === "offer_accepted";
      await tx.query(
        "INSERT INTO settlement_milestones (settlement_id, stage, target_date, actual_date, status) VALUES ($1,$2,$3,$4,$5)",
        [id, stage, first ? accepted : targets[stage] ?? null, first ? accepted : null, first ? "completed" : "pending"]);
    }
    for (const c of newChecklists()) {
      await tx.query("INSERT INTO settlement_checklists (settlement_id, milestone_stage, role, items) VALUES ($1,$2,$3,$4::jsonb)", [id, c.stage, c.role, JSON.stringify(c.items)]);
    }
    await audit(tx, userId, id, "settlement.started", { offerId, coolingOffEstimated: rule !== null });
    await postSystemNote(tx, id, "Offer accepted. This conversation is for the buyer, owner and agent to talk through the sale in one place. Use @buyer, @seller or @agent to get someone's attention.");
    return { ok: true as const, value: { id } };
  });
}

// ---------- read ----------

/** Settlements the user is part of (as buyer, owner or appointed agent), stuck ones first, then the least recently moved. */
export async function listSettlements(db: Queryable, userId: string, now: Date = new Date()): Promise<SettlementSummary[]> {
  const rows = (await db.query(`SELECT * FROM (${BASE_SQL}) s WHERE s.side IS NOT NULL ORDER BY s.completed_at IS NOT NULL, s.stage_entered_at LIMIT 200`, [userId])).rows;
  return rows.map(r => summary(r, now)).sort((a, b) => Number(a.completed) - Number(b.completed) || Number(b.stuck.stuck) - Number(a.stuck.stuck) || b.stuck.days - a.stuck.days);
}

export async function settlementView(db: Queryable, userId: string, id: string, now: Date = new Date()): Promise<Out<SettlementView>> {
  const r = (await db.query(`SELECT * FROM (${BASE_SQL} WHERE t.id = $2::uuid) s WHERE s.side IS NOT NULL`, [userId, id])).rows[0];
  if (!r) return no(404, "Settlement not found.");
  const s = summary(r, now);
  const milestones = (await db.query("SELECT stage, status, target_date, actual_date, note FROM settlement_milestones WHERE settlement_id = $1::uuid", [id])).rows
    .map(m => ({ stage: String(m["stage"]) as Stage, status: String(m["status"]) as MilestoneStatus, targetDate: day(m["target_date"]), actualDate: day(m["actual_date"]), note: m["note"] ? String(m["note"]) : null }))
    .sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
  const open = !s.completed && !s.fellThrough;
  const checklists = (await db.query("SELECT milestone_stage, role, items, completed_at FROM settlement_checklists WHERE settlement_id = $1::uuid", [id])).rows
    .map(c => {
      const stage = String(c["milestone_stage"]) as Stage, role = String(c["role"]) as ItemRole;
      const canTick = open && STAGES.indexOf(stage) <= STAGES.indexOf(s.currentStage) && mayTick(s.side, role);
      return { stage, role, completedAt: iso(c["completed_at"]), items: (c["items"] as ChecklistItem[]).map(i => ({ ...i, canTick })) };
    })
    .sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
  return { ok: true, value: { ...s, milestones, checklists, canUpdate: open && mayUpdateMilestones(s.side) } };
}

// ---------- change ----------

async function lock(tx: Queryable, userId: string, id: string) {
  return (await tx.query(
    `SELECT t.id, t.current_stage, t.completed_at, t.state, o.status AS offer_status, ${SIDE_SQL} AS side
       FROM settlement_timeline t JOIN formal_offer o ON o.id = t.offer_id WHERE t.id = $2::uuid FOR UPDATE OF t`, [userId, id])).rows[0];
}

/** Complete, block, unblock a stage or set its target date. Completing the open stage moves the sale to the next one. */
export async function updateMilestone(db: Queryable, userId: string, id: string, change: MilestoneChange, now: Date = new Date()): Promise<Out<{ currentStage: Stage; completed: boolean }>> {
  return atomic(db, async tx => {
    const t = await lock(tx, userId, id);
    if (!t || !t["side"]) return no(404, "Settlement not found.");
    const side = String(t["side"]) as Side, current = String(t["current_stage"]) as Stage, state = String(t["state"]);
    const ms = (await tx.query("SELECT stage, status, actual_date FROM settlement_milestones WHERE settlement_id = $1::uuid", [id])).rows
      .map(m => ({ stage: String(m["stage"]) as Stage, status: String(m["status"]) as MilestoneStatus, actualDate: day(m["actual_date"]) }));
    const today = localDay(now, state);
    const why = milestoneBlocker({ side, current, milestones: ms, change, today, offerStatus: String(t["offer_status"]) });
    if (why) return no(mayUpdateMilestones(side) ? 409 : 403, why);

    const sets: string[] = ["updated_at = now()"], p: unknown[] = [id, change.stage];
    const set = (col: string, v: unknown) => { p.push(v); sets.push(`${col} = $${p.length}`); };
    if (change.targetDate !== undefined) set("target_date", change.targetDate);
    if (change.note !== undefined) set("note", change.note);
    if (change.status !== undefined) {
      set("status", change.status);
      p.push(change.status === "completed" ? change.actualDate ?? today : null); sets.push(`actual_date = $${p.length}`);
      if (change.status !== "blocked" && change.note === undefined) sets.push("note = NULL");
    }
    await tx.query(`UPDATE settlement_milestones SET ${sets.join(", ")} WHERE settlement_id = $1::uuid AND stage = $2`, p);

    let completed = false, stage = current;
    if (change.status === "completed") {
      const next = nextStage(change.stage);
      if (next) { stage = next; await tx.query("UPDATE settlement_timeline SET current_stage = $2, stage_entered_at = $3, updated_at = $3 WHERE id = $1::uuid", [id, next, now]); }
      else { completed = true; await tx.query("UPDATE settlement_timeline SET completed_at = $2, updated_at = $2 WHERE id = $1::uuid", [id, now]); }
    } else {
      await tx.query("UPDATE settlement_timeline SET updated_at = $2 WHERE id = $1::uuid", [id, now]);
    }
    if (change.status === "completed") {
      await postSystemNote(tx, id, completed ? "Settlement completed. Congratulations to everyone." : STAGE_NOTE(STAGE_LABEL[change.stage], STAGE_LABEL[stage]),
        change.stage === "deposit_received" ? ["seller"] : change.stage === "cooling_off_expires" ? ["buyer"] : []);
    }
    await audit(tx, userId, id, "settlement.milestone_updated", { side, stage: change.stage, status: change.status ?? null, targetDate: change.targetDate ?? null });
    return { ok: true as const, value: { currentStage: stage, completed } };
  });
}

/** Tick or untick one checklist item. Items from future stages are refused; the solicitors' items are ticked by the owner or agent. */
export async function tickChecklistItem(db: Queryable, userId: string, id: string, c: TickChange, now: Date = new Date()): Promise<Out<{ itemsDone: number; itemsTotal: number }>> {
  return atomic(db, async tx => {
    const t = await lock(tx, userId, id);
    if (!t || !t["side"]) return no(404, "Settlement not found.");
    const side = String(t["side"]) as Side;
    if (t["completed_at"] || t["offer_status"] === "fallen_through") return no(409, "This settlement is closed.");
    if (!mayTick(side, c.role)) return no(403, "That item belongs to someone else.");
    if (STAGES.indexOf(c.stage) > STAGES.indexOf(String(t["current_stage"]) as Stage)) return no(409, "That stage has not started yet.");
    const row = (await tx.query("SELECT items FROM settlement_checklists WHERE settlement_id = $1::uuid AND milestone_stage = $2 AND role = $3 FOR UPDATE", [id, c.stage, c.role])).rows[0];
    const items = row ? (row["items"] as ChecklistItem[]) : [];
    const item = items.find(i => i.id === c.itemId);
    if (!item) return no(404, "Checklist item not found.");
    item.done = c.done; item.doneAt = c.done ? now.toISOString() : null; item.doneByRole = c.done ? side : null;
    const all = items.every(i => i.done);
    await tx.query(
      "UPDATE settlement_checklists SET items = $4::jsonb, completed_at = $5 WHERE settlement_id = $1::uuid AND milestone_stage = $2 AND role = $3",
      [id, c.stage, c.role, JSON.stringify(items), all ? now : null]);
    await audit(tx, userId, id, "settlement.checklist_ticked", { side, stage: c.stage, role: c.role, itemId: c.itemId, done: c.done });
    return { ok: true as const, value: { itemsDone: items.filter(i => i.done).length, itemsTotal: items.length } };
  });
}

// ---------- staff portfolio ----------

export interface PortfolioRow { id: string; listingTitle: string; currentStage: Stage; completed: boolean; fellThrough: boolean; stuck: Stuck; doneStages: number; totalStages: number; nextTarget: string | null; startedAt: string }
/** Every settlement for the admin dashboard, stuck first. Listing titles only: no names or contact details. */
export async function settlementPortfolio(db: Queryable, now: Date = new Date()): Promise<{ rows: PortfolioRow[]; totals: { open: number; stuck: number; completed: number; fellThrough: number }; byStage: Record<string, number> }> {
  const raw = (await db.query(`SELECT * FROM (${BASE_SQL.replace(`${SIDE_SQL} AS side`, "'staff' AS side")}) s  ORDER BY s.completed_at IS NOT NULL, s.stage_entered_at LIMIT 1000`, [])).rows;
  const rows = raw.map(r => ({ ...summary(r, now), startedAt: iso(r["stage_entered_at"])! })).map(s => ({
    id: s.id, listingTitle: s.listingTitle, currentStage: s.currentStage, completed: s.completed, fellThrough: s.fellThrough, stuck: s.stuck,
    doneStages: s.doneStages, totalStages: s.totalStages, nextTarget: s.nextTarget, startedAt: s.startedAt
  })).sort((a, b) => Number(a.completed || a.fellThrough) - Number(b.completed || b.fellThrough) || Number(b.stuck.stuck) - Number(a.stuck.stuck) || b.stuck.days - a.stuck.days);
  const live = rows.filter(r => !r.completed && !r.fellThrough), byStage: Record<string, number> = {};
  for (const r of live) byStage[r.currentStage] = (byStage[r.currentStage] ?? 0) + 1;
  return { rows, totals: { open: live.length, stuck: live.filter(r => r.stuck.stuck).length, completed: rows.filter(r => r.completed).length, fellThrough: rows.filter(r => r.fellThrough).length }, byStage };
}
