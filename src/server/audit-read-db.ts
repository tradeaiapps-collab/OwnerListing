import { encodeCursor, redactPayload, type AuditQuery, type AuditRowOut } from "../domain/audit-query";
import type { Queryable } from "./db";

/**
 * Read-only audit search for staff. SELECT only, bound parameters only; filters are optional and combined with AND.
 * Newest first, keyset paging on (occurred_at, id). Payloads are redacted here, so no caller can forget to.
 */
export async function queryAuditPg(db: Queryable, q: AuditQuery): Promise<{ events: AuditRowOut[]; nextCursor: string | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (q.eventType) add("event_type = ?", q.eventType);
  if (q.actorId) add("actor_id = ?", q.actorId);
  if (q.aggregateType) add("aggregate_type = ?", q.aggregateType);
  if (q.aggregateId) add("aggregate_id = ?", q.aggregateId);
  if (q.from) add("occurred_at >= ?::timestamptz", q.from);
  if (q.to) add("occurred_at < ?::timestamptz", q.to);
  if (q.cursor) {
    params.push(q.cursor.t, q.cursor.id);
    where.push(`(occurred_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const res = await db.query(
    `SELECT id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, payload
       FROM audit_event ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY occurred_at DESC, id DESC LIMIT $${params.length}`,
    params
  );
  const events: AuditRowOut[] = res.rows.slice(0, q.limit).map(r => ({
    id: String(r["id"]),
    occurredAt: new Date(r["occurred_at"] as string | Date).toISOString(),
    actorType: String(r["actor_type"]), actorId: String(r["actor_id"]),
    aggregateType: String(r["aggregate_type"]), aggregateId: String(r["aggregate_id"]),
    eventType: String(r["event_type"]),
    payload: redactPayload(r["payload"])
  }));
  const last = events[events.length - 1];
  return { events, nextCursor: res.rows.length > q.limit && last ? encodeCursor({ t: last.occurredAt, id: last.id }) : null };
}
