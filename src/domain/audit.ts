export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorType: "user" | "service" | "system";
  actorId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  correlationId: string;
  payload: Record<string, unknown>;
}

/** Guard against accidental in-place event mutation in application code. */
export function appendAuditEvent(
  existing: readonly AuditEvent[],
  event: AuditEvent
): readonly AuditEvent[] {
  if (existing.some(e => e.id === event.id)) {
    throw new Error("Duplicate audit event id.");
  }
  return [...existing, structuredClone(event)];
}
