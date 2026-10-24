import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_MAX_LIMIT, encodeCursor, parseAuditQuery, redactPayload } from "../src/domain/audit-query";
import type { StaffActor } from "../src/domain/staff-access";
import { queryAuditPg } from "../src/server/audit-read-db";
import type { Queryable } from "../src/server/db";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, db: null as Queryable | null }));

vi.mock("../src/server/context", () => ({
  getActor: () => null,
  getDeps: () => null,
  getDb: () => state.db,
  getStaff: async () => state.staff
}));

import * as auditRoute from "../app/api/staff/audit/route";

const ID = "11111111-1111-4111-8111-111111111111";

interface Call { text: string; params: unknown[] }
function fakeDb(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  const db: Queryable = {
    async query(text, params) {
      calls.push({ text, params: params ?? [] });
      return { rows: /^\s*SELECT/.test(text) ? rows : [] };
    }
  };
  return { db, calls };
}
const qs = (o: Record<string, string>) => new URLSearchParams(o);
const get = (o: Record<string, string> = {}) => auditRoute.GET(new Request(`http://test/api/staff/audit?${qs(o)}`));
const row = (n: number, payload: unknown = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, occurred_at: new Date(1_800_000_000_000 - n * 1000),
  actor_type: "user", actor_id: "u1", aggregate_type: "listing", aggregate_id: "l1", event_type: "listing.created", payload
});

describe("parseAuditQuery", () => {
  it("defaults the limit and accepts clean filters", () => {
    expect(parseAuditQuery(qs({}))).toEqual({ ok: true, query: { limit: 50 } });
    const r = parseAuditQuery(qs({ eventType: "offer.submitted", actorId: "u-1", from: "2026-10-01T00:00:00Z" }));
    expect(r).toEqual({ ok: true, query: { limit: 50, eventType: "offer.submitted", actorId: "u-1", from: "2026-10-01T00:00:00.000Z" } });
  });
  it("caps the limit and rejects bad limits", () => {
    expect(parseAuditQuery(qs({ limit: "99999" }))).toEqual({ ok: false, error: "Invalid limit." });
    const r = parseAuditQuery(qs({ limit: "5000" }));
    expect(r.ok && r.query.limit).toBe(AUDIT_MAX_LIMIT);
    for (const bad of ["0", "-1", "abc", "1.5"]) expect(parseAuditQuery(qs({ limit: bad })).ok).toBe(false);
  });
  it("rejects odd characters, bad dates and bad cursors", () => {
    expect(parseAuditQuery(qs({ eventType: "x' OR 1=1 --" })).ok).toBe(false);
    expect(parseAuditQuery(qs({ actorId: "a b" })).ok).toBe(false);
    expect(parseAuditQuery(qs({ from: "yesterday-ish" })).ok).toBe(false);
    expect(parseAuditQuery(qs({ cursor: "not-a-cursor" })).ok).toBe(false);
    expect(parseAuditQuery(qs({ cursor: encodeCursor({ t: "2026-10-01T00:00:00Z", id: "x" }) })).ok).toBe(false);
  });
  it("maps listingId to a listing aggregate and refuses a conflicting aggregate", () => {
    const r = parseAuditQuery(qs({ listingId: "l1" }));
    expect(r.ok && r.query).toMatchObject({ aggregateType: "listing", aggregateId: "l1" });
    expect(parseAuditQuery(qs({ listingId: "l1", aggregateType: "offer" })).ok).toBe(false);
  });
  it("round-trips a cursor", () => {
    const c = { t: "2026-10-01T00:00:00.000Z", id: ID };
    const r = parseAuditQuery(qs({ cursor: encodeCursor(c) }));
    expect(r.ok && r.query.cursor).toEqual(c);
  });
});

describe("redactPayload", () => {
  it("removes sensitive keys and email-shaped text at any depth", () => {
    const out = JSON.stringify(redactPayload({
      role: "support", email: "a@b.com", tokenHash: "abc", nested: { phone: "0400", note: "mail bob@x.org now", ok: 1 },
      list: [{ fullName: "Jo" }, "c@d.io"]
    }));
    for (const leak of ["a@b.com", "abc", "0400", "bob@x.org", "Jo", "c@d.io"]) expect(out).not.toContain(leak);
    expect(out).toContain("support");
    expect(out).toContain("\"ok\":1");
  });
  it("keeps harmless values", () => {
    expect(redactPayload({ returned: 3, paged: false, reason: "not_staff" })).toEqual({ returned: 3, paged: false, reason: "not_staff" });
  });
});

describe("queryAuditPg", () => {
  it("is a bound-parameter SELECT with no string-built values and newest-first ordering", async () => {
    const { db, calls } = fakeDb();
    await queryAuditPg(db, { limit: 10, eventType: "x.y", actorId: "u1", aggregateType: "listing", aggregateId: "l1", from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z", cursor: { t: "2026-10-01T12:00:00.000Z", id: ID } });
    const c = calls[0]!;
    expect(c.text).toMatch(/^\s*SELECT/);
    expect(c.text).toContain("ORDER BY occurred_at DESC, id DESC");
    for (const v of ["x.y", "u1", "l1", ID]) expect(c.text).not.toContain(v);
    expect(c.params).toEqual(["x.y", "u1", "listing", "l1", "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-10-01T12:00:00.000Z", ID, 11]);
  });
  it("returns a cursor only when more rows exist, and redacts payloads", async () => {
    const rows = [row(1, { email: "a@b.com" }), row(2), row(3)];
    const { db } = fakeDb(rows);
    const more = await queryAuditPg(db, { limit: 2 });
    expect(more.events).toHaveLength(2);
    expect(more.nextCursor).not.toBeNull();
    expect(JSON.stringify(more)).not.toContain("a@b.com");
    const done = await queryAuditPg(fakeDb(rows.slice(0, 2)).db, { limit: 2 });
    expect(done.nextCursor).toBeNull();
  });
});

describe("GET /api/staff/audit", () => {
  beforeEach(() => { state.staff = null; state.db = fakeDb([row(1)]).db; });

  it("returns 401 when no staff is signed in, without touching the database", async () => {
    const { db, calls } = fakeDb();
    state.db = db;
    expect((await get()).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it("returns 403 for roles without report.audit, without touching the database", async () => {
    for (const role of ["accountant", "support", "technical", "reporting"] as const) {
      const { db, calls } = fakeDb();
      state.db = db;
      state.staff = { id: "s1", role };
      expect((await get()).status).toBe(403);
      expect(calls).toHaveLength(0);
    }
  });
  it("returns 400 for invalid filters, before any query", async () => {
    const { db, calls } = fakeDb();
    state.db = db;
    state.staff = { id: "s1", role: "compliance" };
    expect((await get({ eventType: "bad value;" })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it("lets super_admin and compliance read, and audits each view", async () => {
    for (const role of ["super_admin", "compliance"] as const) {
      const { db, calls } = fakeDb([row(1, { email: "a@b.com" })]);
      state.db = db;
      state.staff = { id: "s1", role };
      const res = await get({ eventType: "listing.created" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.events).toHaveLength(1);
      expect(JSON.stringify(body)).not.toContain("a@b.com");
      const writes = calls.filter(c => /INSERT INTO audit_event/.test(c.text));
      expect(writes).toHaveLength(1);
      expect(writes[0]!.params[3]).toBe("s1");
      expect(writes[0]!.params[6]).toBe("staff.audit_viewed");
      expect(String(writes[0]!.params[8])).toContain("listing.created");
    }
  });
  it("has no write or delete handlers, and never issues UPDATE or DELETE", async () => {
    expect(Object.keys(auditRoute).sort()).toEqual(["GET"]);
    const { db, calls } = fakeDb([row(1)]);
    state.db = db;
    state.staff = { id: "s1", role: "super_admin" };
    await get();
    expect(calls.some(c => /\b(UPDATE|DELETE|TRUNCATE|DROP)\b/i.test(c.text))).toBe(false);
  });
});
