import type { AuditEvent } from "./audit";

/**
 * Persistence port for audit events. The PostgreSQL adapter implements this with
 * the SQL below. Inserts only: the database role used by the app must have no
 * UPDATE or DELETE on audit_event (see db/003_audit_append_only.sql).
 */
export interface AuditRepository {
  append(event: AuditEvent): Promise<void>;
  listForAggregate(aggregateType: string, aggregateId: string): Promise<AuditEvent[]>;
}

export const AUDIT_INSERT_SQL = `
INSERT INTO audit_event
  (id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

export const AUDIT_LIST_SQL = `
SELECT id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload
FROM audit_event
WHERE aggregate_type = $1 AND aggregate_id = $2
ORDER BY occurred_at, id`;
