import { randomUUID } from "node:crypto";
import type { AuditEvent } from "../domain/audit";
import { isSubjectType, NEXT_STATUS, type Decision, type QueueSuspension, type ReinstatePlan, type SuspensionPlan, type ItemStatus, type Severity, type SubjectType } from "../domain/moderation-queue";
import { moderateListing, setUserStatus } from "./admin-moderation-db";
import { appendAuditPg, type Queryable } from "./db";

/** Staff review queue storage. Parameterised SQL only; each decision, its history row and its audit event commit together. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 50;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : new Date(String(v)).toISOString());
const inTx = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>) => (db.transaction ? db.transaction(fn) : fn(db));

export interface QueueItemInput {
  subjectType: SubjectType; subjectId: string; subjectLabel: string; subjectOwnerId?: string | null;
  /** Which filter or report raised it, e.g. "content_filter". */
  source: string; reason: string; detail?: string | null; severity?: Severity;
}

/**
 * The flag source other filters call (content filtering, user reports, Elena). Idempotent: the same subject, source and reason
 * is one item while it is open or escalated, so a filter can raise it every time without flooding the queue.
 * Returns the item id, or null when it was already queued.
 */
export async function enqueueModerationItemPg(db: Queryable, input: QueueItemInput): Promise<string | null> {
  if (!isSubjectType(input.subjectType) || !UUID_RE.test(input.subjectId)) throw new Error("Invalid moderation subject.");
  return inTx(db, async tx => {
    const r = await tx.query(
      `INSERT INTO moderation_item (subject_type, subject_id, subject_label, subject_owner_id, source, reason, detail, severity)
       VALUES ($1, $2::uuid, $3, $4::uuid, $5, $6, $7, $8)
       ON CONFLICT (subject_type, subject_id, source, reason) WHERE status IN ('open', 'escalated') DO NOTHING
       RETURNING id`,
      [input.subjectType, input.subjectId, input.subjectLabel.slice(0, 200) || "Untitled", input.subjectOwnerId ?? null, input.source.slice(0, 60),
        input.reason.slice(0, 120), input.detail ? input.detail.slice(0, 1000) : null, input.severity ?? "medium"]
    );
    const id = r.rows[0] ? String(r.rows[0]["id"]) : null;
    if (id) await tx.query("INSERT INTO moderation_item_event (item_id, action) VALUES ($1::uuid, 'raised')", [id]);
    return id;
  });
}

export interface QueueEvent { action: string; actorId: string | null; note: string | null; at: string }
export interface QueueItem {
  id: string; subjectType: SubjectType; subjectId: string; subjectLabel: string; subjectOwnerId: string | null; source: string; reason: string;
  detail: string | null; severity: Severity; status: ItemStatus; createdAt: string; decidedAt: string | null; decisionNote: string | null;
  history: QueueEvent[];
  /** What a rejection suspended, if anything, and whether staff have since reinstated it. */
  suspended: "listing" | "account" | null; reinstated: boolean;
}
export type QueueView = "open" | "escalated" | "decided";
export interface QueueFilters { view: QueueView; subjectType?: SubjectType }

const SEV = "CASE severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END";

/** Open items: highest severity first, then oldest. Decided items: newest decision first. History is included for each item. */
export async function listQueuePg(db: Queryable, f: QueueFilters, limit = PAGE): Promise<QueueItem[]> {
  const statuses = f.view === "decided" ? ["approved", "rejected"] : [f.view];
  const r = await db.query(
    `SELECT id, subject_type, subject_id, subject_label, subject_owner_id, source, reason, detail, severity, status, created_at, decided_at, decision_note
       FROM moderation_item
      WHERE status = ANY($1::text[]) AND ($2::text IS NULL OR subject_type = $2)
      ORDER BY CASE WHEN $3 THEN decided_at END DESC NULLS LAST, CASE WHEN NOT $3 THEN ${SEV} END DESC, created_at ASC
      LIMIT $4`,
    [statuses, f.subjectType ?? null, f.view === "decided", limit]
  );
  const ids = r.rows.map(row => String(row["id"]));
  const hist = ids.length
    ? (await db.query("SELECT item_id, action, actor_id, note, created_at FROM moderation_item_event WHERE item_id = ANY($1::uuid[]) ORDER BY created_at, id", [ids])).rows
    : [];
  const rejected = r.rows.filter(row => row["status"] === "rejected").map(row => String(row["id"]));
  const sus = new Map<string, QueueSuspension>();
  if (rejected.length) {
    for (const a of (await db.query(
      `SELECT aggregate_id, payload FROM audit_event WHERE aggregate_type = 'moderation_item' AND event_type = 'moderation_item.reject' AND aggregate_id = ANY($1::text[])`, [rejected]
    )).rows) { const x = suspensionOf(a["payload"]); if (x) sus.set(String(a["aggregate_id"]), x); }
  }
  return r.rows.map(row => ({
    suspended: sus.get(String(row["id"]))?.kind ?? null,
    reinstated: hist.some(h => String(h["item_id"]) === String(row["id"]) && h["action"] === "reinstate"),
    id: String(row["id"]), subjectType: row["subject_type"] as SubjectType, subjectId: String(row["subject_id"]), subjectLabel: String(row["subject_label"]),
    subjectOwnerId: row["subject_owner_id"] ? String(row["subject_owner_id"]) : null, source: String(row["source"]), reason: String(row["reason"]),
    detail: (row["detail"] as string | null) ?? null, severity: row["severity"] as Severity, status: row["status"] as ItemStatus,
    createdAt: iso(row["created_at"])!, decidedAt: iso(row["decided_at"]), decisionNote: (row["decision_note"] as string | null) ?? null,
    history: hist.filter(h => String(h["item_id"]) === String(row["id"])).map(h => ({
      action: String(h["action"]), actorId: h["actor_id"] ? String(h["actor_id"]) : null, note: (h["note"] as string | null) ?? null, at: iso(h["created_at"])!
    }))
  }));
}

const suspensionOf = (payload: unknown): QueueSuspension | null => {
  const p = (typeof payload === "string" ? (() => { try { return JSON.parse(payload) as unknown; } catch { return null; } })() : payload) as Record<string, unknown> | null;
  if (!p) return null;
  if (p["suspended"] === "listing" && typeof p["listingId"] === "string") return { kind: "listing", listingId: p["listingId"] };
  if (p["suspended"] === "account" && typeof p["userId"] === "string") return { kind: "account", userId: p["userId"] };
  return null;
};

/** What the rejection of this item suspended (from its audit event), and whether it was already reinstated. */
export async function getSuspensionPg(db: Queryable, id: string): Promise<{ suspension: QueueSuspension | null; reinstated: boolean }> {
  if (!UUID_RE.test(id)) return { suspension: null, reinstated: false };
  const a = (await db.query(
    `SELECT payload FROM audit_event WHERE aggregate_type = 'moderation_item' AND aggregate_id = $1 AND event_type = 'moderation_item.reject' ORDER BY occurred_at DESC LIMIT 1`, [id]
  )).rows[0];
  const done = (await db.query("SELECT 1 FROM moderation_item_event WHERE item_id = $1::uuid AND action = 'reinstate' LIMIT 1", [id])).rows.length > 0;
  return { suspension: a ? suspensionOf(a["payload"]) : null, reinstated: done };
}

/** Counts per queue tab, for the badges. */
export async function queueCountsPg(db: Queryable): Promise<{ open: number; escalated: number }> {
  const r = await db.query("SELECT status, count(*)::int AS n FROM moderation_item WHERE status IN ('open', 'escalated') GROUP BY status");
  const get = (s: string) => Number(r.rows.find(x => x["status"] === s)?.["n"] ?? 0);
  return { open: get("open"), escalated: get("escalated") };
}

export async function getQueueTargetPg(db: Queryable, id: string): Promise<{ id: string; status: string; subjectOwnerId: string | null; subjectType: SubjectType; subjectId: string } | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await db.query("SELECT id, status, subject_owner_id, subject_type, subject_id FROM moderation_item WHERE id = $1::uuid", [id]);
  const row = r.rows[0];
  return row ? {
    id: String(row["id"]), status: String(row["status"]), subjectOwnerId: row["subject_owner_id"] ? String(row["subject_owner_id"]) : null,
    subjectType: row["subject_type"] as SubjectType, subjectId: String(row["subject_id"])
  } : null;
}

/**
 * Applies a decision only if the item is still in `from` (guarded UPDATE), and writes the history row and the audit event in the same
 * transaction. False when someone else decided it first.
 */
export async function decideQueueItemPg(
  db: Queryable, id: string, staff: { id: string; role: string }, decision: Decision, from: "open" | "escalated", note: string,
  extra: Record<string, unknown> = {}
): Promise<boolean> {
  const to = NEXT_STATUS[decision];
  const final = to === "approved" || to === "rejected";
  return inTx(db, async tx => {
    const r = await tx.query(
      `UPDATE moderation_item SET status = $3, decided_by = CASE WHEN $4 THEN $2::uuid ELSE decided_by END,
         decided_at = CASE WHEN $4 THEN now() ELSE decided_at END, decision_note = $5
       WHERE id = $1::uuid AND status = $6 RETURNING subject_type, subject_id`,
      [id, staff.id, to, final, note, from]
    );
    const row = r.rows[0];
    if (!row) return false;
    await tx.query("INSERT INTO moderation_item_event (item_id, actor_id, action, note) VALUES ($1::uuid, $2::uuid, $3, $4)", [id, staff.id, decision, note]);
    const event: AuditEvent = {
      id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: staff.id, aggregateType: "moderation_item", aggregateId: id,
      eventType: `moderation_item.${decision}`, correlationId: randomUUID(),
      payload: { role: staff.role, from, to, subjectType: String(row["subject_type"]), subjectId: String(row["subject_id"]), reason: note, ...extra }
    };
    await appendAuditPg(tx, event);
    return true;
  });
}

export class SuspensionConflict extends Error {}

/**
 * Rejects an item and suspends its listing or account in ONE transaction: the decision, the suspension and every audit event commit
 * together, or none does. False when someone else decided the item first. Throws SuspensionConflict (nothing is changed) when the
 * listing or account is no longer in the state the staff member saw.
 */
export async function rejectAndSuspendPg(
  db: Queryable, id: string, staff: { id: string; role: string }, from: "open" | "escalated", note: string, plan: Exclude<SuspensionPlan, { action: "deny" }>
): Promise<{ decided: boolean; listingsSuspended: number }> {
  return inTx(db, async tx => {
    const extra = plan.kind === "listing" ? { suspended: "listing", listingId: plan.listingId }
      : plan.kind === "account" ? { suspended: "account", userId: plan.userId, listings: plan.withListings ? "suspended" : "kept" } : {};
    if (!(await decideQueueItemPg(tx, id, staff, "reject", from, note, extra))) return { decided: false, listingsSuspended: 0 };
    if (plan.kind === "listing") {
      const now = new Date().toISOString();
      const ok = await moderateListing(tx, plan.listingId, "published", "suspended", {
        id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "listing", aggregateId: plan.listingId,
        eventType: "listing.suspended", correlationId: randomUUID(),
        payload: { from: "published", to: "suspended", role: staff.role, action: "suspend", reason: note, moderation: true, moderationItem: id }
      });
      if (!ok) throw new SuspensionConflict();
      return { decided: true, listingsSuspended: 1 };
    }
    if (plan.kind === "account") {
      const done = await setUserStatus(tx, staff, plan.userId, plan.from, "suspended", note, { suspendListings: plan.withListings });
      if (!done) throw new SuspensionConflict();
      return { decided: true, listingsSuspended: done.listingIds.length };
    }
    return { decided: true, listingsSuspended: 0 };
  });
}

/**
 * Lifts the suspension a rejection made, in ONE transaction with its history row and audit events. `listingEvent` is the already-built
 * listing audit event (the route ran the publish gate). False when it was already reinstated. Throws SuspensionConflict (nothing changed)
 * when the listing or account is no longer in the state the staff member saw. Listings suspended with an account are restored by the caller afterwards.
 */
export async function reinstateQueueItemPg(
  db: Queryable, id: string, staff: { id: string; role: string }, plan: Exclude<ReinstatePlan, { action: "deny" }>, listingEvent?: AuditEvent
): Promise<boolean> {
  return inTx(db, async tx => {
    const locked = (await tx.query("SELECT status FROM moderation_item WHERE id = $1::uuid FOR UPDATE", [id])).rows[0];
    if (!locked || locked["status"] !== "rejected") throw new SuspensionConflict();
    if ((await tx.query("SELECT 1 FROM moderation_item_event WHERE item_id = $1::uuid AND action = 'reinstate'", [id])).rows.length > 0) return false;
    if (plan.kind === "listing") {
      if (!listingEvent || !(await moderateListing(tx, plan.listingId, "suspended", "published", listingEvent))) throw new SuspensionConflict();
    } else if (!(await setUserStatus(tx, staff, plan.userId, plan.from, "active", plan.reason))) throw new SuspensionConflict();
    await tx.query("INSERT INTO moderation_item_event (item_id, actor_id, action, note) VALUES ($1::uuid, $2::uuid, 'reinstate', $3)", [id, staff.id, plan.reason]);
    await appendAuditPg(tx, {
      id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: staff.id, aggregateType: "moderation_item", aggregateId: id,
      eventType: "moderation_item.reinstated", correlationId: randomUUID(),
      payload: { role: staff.role, reinstated: plan.kind, ...(plan.kind === "listing" ? { listingId: plan.listingId } : { userId: plan.userId }), reason: plan.reason }
    });
    return true;
  });
}
