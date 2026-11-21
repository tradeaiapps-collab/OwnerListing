import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDiligenceStore } from "../src/server/elena-diligence-db";
import { DEFAULT_POSTING, termsFrom } from "../src/domain/investment-terms";
import { createPgInvestmentRepository } from "../src/server/investments-db";
import type { Queryable } from "../src/server/db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("Elena due-diligence table on Postgres", () => {
  let t: TestDb, db: Queryable, owner: string;
  const U = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
  const summary = { engineVersion: 1, generatedAt: "2026-11-21T00:00:00.000Z", headline: "h", documents: [], missing: [], risks: [], inconsistencies: [], notRead: [] };
  beforeAll(async () => { t = await createTestDb(); db = t.db; owner = await addUser(db, "owner"); }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("keeps one draft, publishes once, and a published summary can never change or be deleted", async () => {
    // Guard and constraints are exercised on a scratch table with the same trigger and checks (no project row needed).
    await db.query("CREATE TABLE dd_probe (LIKE elena_project_diligence INCLUDING DEFAULTS INCLUDING CONSTRAINTS)");
    await db.query("CREATE TRIGGER g BEFORE UPDATE OR DELETE ON dd_probe FOR EACH ROW EXECUTE FUNCTION elena_project_diligence_guard()");
    await db.query("INSERT INTO dd_probe (id, project_id, summary, engine_version, created_by_user) VALUES ($1, $2, $3::jsonb, 1, $4)", [U(1), U(9), JSON.stringify(summary), owner]);
    await db.query("UPDATE dd_probe SET developer_note = 'draft edit' WHERE id = $1", [U(1)]);
    await expect(db.query("DELETE FROM dd_probe WHERE id = $1", [U(1)])).rejects.toThrow(/never deleted/);
    await expect(db.query("UPDATE dd_probe SET status = 'published' WHERE id = $1", [U(1)])).rejects.toThrow();
    await db.query("UPDATE dd_probe SET status = 'published', approved_by = $2, approved_at = now() WHERE id = $1", [U(1), owner]);
    await expect(db.query("UPDATE dd_probe SET developer_note = 'late' WHERE id = $1", [U(1)])).rejects.toThrow(/cannot be changed/);
    await expect(db.query("DELETE FROM dd_probe WHERE id = $1", [U(1)])).rejects.toThrow(/never deleted/);
    await db.query("DROP TABLE dd_probe");
  });

  it("the real table has the one-draft index and the approver check", async () => {
    const idx = (await db.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'elena_project_diligence_one_draft'")).rows;
    expect(String(idx[0]?.["indexdef"])).toMatch(/UNIQUE.*WHERE \(status = 'draft'/);
    const c = (await db.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'elena_project_diligence'::regclass AND contype = 'c'")).rows.map(r => String(r["d"])).join(" ");
    expect(c).toMatch(/approved_by IS NOT NULL/);
    expect(typeof createPgDiligenceStore(db).saveDraft).toBe("function");
  });

  it("store round trip: draft, rewrite keeps one row, note, publish once, then a new draft", async () => {
    const repo = createPgInvestmentRepository(db);
    const pid = "cccccccc-cccc-4ccc-8ccc-000000000001";
    const now = new Date().toISOString();
    await repo.createProject({
      id: pid, ownerUserId: owner, title: "Riverside", location: "Bulimba", jurisdiction: "QLD", projectType: "renovation", summary: "A renovation project on a large block.", stage: "planning",
      fundingTargetCents: 10_000_000, minimumTicketCents: 1_000_000, timeline: "12 months", risks: "Construction and sale risk, can lose money.", structureDescription: "Unit trust structure",
      visibleTo: "wholesale_only", issuerName: "Riverside Pty Ltd", issuerLicenceBasis: "s708 wholesale", issuerStatement: "", issuerAuthorisedConfirmed: true,
      status: "pending_review", version: 1, terms: termsFrom(DEFAULT_POSTING), createdAt: now, updatedAt: now
    }, { id: "dddddddd-dddd-4ddd-8ddd-000000000001", projectId: pid, fromStatus: null, toStatus: "pending_review", actorType: "owner", actorId: owner, reason: null, projectVersion: 1, at: now });
    const store = createPgDiligenceStore(db);
    const base = { id: U(20), projectId: pid, status: "draft" as const, summary, developerNote: "", sourceKeys: ["x:1"], engineVersion: 1, createdByUser: owner, createdAt: now, updatedAt: now };
    expect((await store.saveDraft(base)).summary.headline).toBe("h");
    expect((await store.saveDraft({ ...base, summary: { ...summary, headline: "second" }, sourceKeys: ["x:2"] })).summary.headline).toBe("second");
    expect(await store.listFor(pid, true)).toHaveLength(1);
    expect(await store.listFor(pid, false)).toHaveLength(0);
    expect(await store.setNote(U(20), "A note", now)).toBe(true);
    expect(await store.publish(U(20), owner, now)).toBe(true);
    expect(await store.publish(U(20), owner, now)).toBe(false);
    expect(await store.setNote(U(20), "late", now)).toBe(false);
    expect((await store.listFor(pid, false))[0]).toMatchObject({ status: "published", developerNote: "A note", sourceKeys: ["x:2"], approvedBy: owner });
    await store.saveDraft({ ...base, id: U(21) });
    await expect(store.saveDraft({ ...base, id: U(22) })).rejects.toThrow(/one_draft|duplicate/);
    expect((await store.listFor(pid, true)).map(r => r.status)).toEqual(expect.arrayContaining(["draft", "published"]));
  });
});
