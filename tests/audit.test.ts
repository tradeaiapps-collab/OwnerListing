import { describe, expect, it } from "vitest";
import { appendAuditEvent, type AuditEvent } from "../src/domain/audit";

const event: AuditEvent = {
  id: "evt-1",
  occurredAt: "2026-10-21T00:00:00.000Z",
  actorType: "user",
  actorId: "user-1",
  aggregateType: "listing",
  aggregateId: "lst-1",
  eventType: "listing.created",
  correlationId: "req-1",
  payload: { status: "draft" }
};

describe("appendAuditEvent", () => {
  it("returns a new event sequence without mutating the original", () => {
    const original: readonly AuditEvent[] = [];
    const result = appendAuditEvent(original, event);
    expect(original).toHaveLength(0);
    expect(result).toHaveLength(1);
  });

  it("rejects duplicate event ids", () => {
    expect(() => appendAuditEvent([event], event)).toThrow(/Duplicate/);
  });
});
