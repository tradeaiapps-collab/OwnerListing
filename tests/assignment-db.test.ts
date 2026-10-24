import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../src/domain/audit";

vi.mock("../src/server/context", () => ({ getDb: () => ({}) }));

import * as sql from "../src/server/assignment-db";

const audit: AuditEvent = {
  id: "a0000000-0000-4000-8000-000000000001", occurredAt: "2026-10-24T00:00:00.000Z", actorType: "user",
  actorId: "22222222-2222-4222-8222-222222222222", aggregateType: "job_assignment",
  aggregateId: "11111111-1111-4111-8111-111111111111", eventType: "assignment.accepted", correlationId: "c1", payload: { to: "approved" }
};

function fakeDb(rows: Record<string, unknown>[] = []) {
  const calls: { text: string; params: unknown[] }[] = [];
  return { calls, query: async (text: string, params: unknown[] = []) => { calls.push({ text, params }); return { rows }; } };
}

describe("assignment SQL", () => {
  const statements = [sql.GET_LISTING_SQL, sql.FIND_BY_ID_SQL, sql.FIND_BY_EMAIL_SQL, sql.GET_ASSIGNMENT_SQL,
    sql.INSERT_PROPOSED_SQL, sql.TRANSITION_SQL, sql.LIST_FOR_USER_SQL];

  it("never deletes and never interpolates values: only $n placeholders", () => {
    for (const s of statements) {
      expect(s).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
      expect(s).not.toContain("${");
      expect(s).not.toContain("'' +");
    }
  });

  it("every write also inserts its audit row in the same statement", () => {
    expect(sql.INSERT_PROPOSED_SQL).toContain("INSERT INTO audit_event");
    expect(sql.TRANSITION_SQL).toContain("INSERT INTO audit_event");
  });

  it("transition binds actor, side and statuses as parameters and reports whether a row moved", async () => {
    const moved = fakeDb([{ aggregate_id: "x" }]);
    const ok = await sql.createPgAssignmentRepository(moved).transition(
      { id: audit.aggregateId, actorId: audit.actorId, side: "contractor", from: ["proposed"], to: "approved" }, audit
    );
    expect(ok).toBe(true);
    expect(moved.calls[0]?.params.slice(0, 5)).toEqual([audit.aggregateId, audit.actorId, "contractor", ["proposed"], "approved"]);

    const raced = await sql.createPgAssignmentRepository(fakeDb([])).transition(
      { id: audit.aggregateId, actorId: audit.actorId, side: "owner", from: ["proposed"], to: "cancelled" }, audit
    );
    expect(raced).toBe(false);
  });

  it("insertProposed takes the owner id from the assignment row it was given", async () => {
    const db = fakeDb([{ aggregate_id: "x" }]);
    const a = { id: "b0000000-0000-4000-8000-000000000002", listingId: "55555555-5555-4555-8555-555555555555",
      ownerUserId: audit.actorId, contractorUserId: "33333333-3333-4333-8333-333333333333", kind: "photographer" as const, status: "proposed" as const };
    expect(await sql.createPgAssignmentRepository(db).insertProposed(a, audit)).toBe(true);
    expect(db.calls[0]?.params.slice(0, 5)).toEqual([a.id, a.listingId, a.ownerUserId, a.contractorUserId, "photographer"]);
  });
});
