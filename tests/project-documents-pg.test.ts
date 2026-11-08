import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POSTING, termsFrom } from "../src/domain/investment-terms";
import type { Queryable } from "../src/server/db";
import { createPgInvestmentRepository } from "../src/server/investments-db";
import { createPgProjectDocStore } from "../src/server/project-documents-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("investor project documents on Postgres", () => {
  let t: TestDb;
  let db: Queryable;
  let ownerId: string;
  const pid = "11111111-1111-4111-8111-111111111111";
  const doc = (n: number, o: Record<string, unknown> = {}) => ({
    record: { id: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`, projectId: pid, kind: "feasibility" as const, visibility: "investors" as const, title: `Doc ${n}`,
      uploadedBy: ownerId, contentType: "application/pdf", sizeBytes: 1234, uploadedAt: new Date().toISOString(), ...o },
    storageKey: `investments/${pid}/key-${n}`, sha256: "a".repeat(64)
  });

  beforeAll(async () => {
    t = await createTestDb(); db = t.db;
    ownerId = await addUser(db, "owner");
    const now = new Date().toISOString();
    await createPgInvestmentRepository(db).createProject({
      id: pid, ownerUserId: ownerId, title: "Riverside", location: "Bulimba", jurisdiction: "QLD", projectType: "renovation",
      summary: "A renovation project on a large block.", stage: "planning", fundingTargetCents: 10_000_000, minimumTicketCents: 1_000_000,
      timeline: "12 months", risks: "Construction and sale risk, can lose money.", structureDescription: "Unit trust structure", visibleTo: "wholesale_only",
      issuerName: "Riverside Pty Ltd", issuerLicenceBasis: "s708 wholesale", issuerStatement: "", issuerAuthorisedConfirmed: true,
      status: "pending_review", version: 1, terms: termsFrom({ ...DEFAULT_POSTING }), createdAt: now, updatedAt: now
    }, { id: "21111111-1111-4111-8111-111111111111", projectId: pid, fromStatus: null, toStatus: "pending_review", actorType: "owner", actorId: ownerId, reason: null, projectVersion: 1, at: now });
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("round trip, replacement chain, one replacement per version, insert-only, quota sum", async () => {
    const store = createPgProjectDocStore(db);
    const a = doc(1), b = doc(2, { supersedesId: doc(1).record.id });
    await store.addDocument(a);
    await store.addDocument(b);
    expect((await store.documentsFor(pid)).map(d => d.title)).toEqual(["Doc 1", "Doc 2"]);
    expect((await store.documentById(b.record.id))!.supersedesId).toBe(a.record.id);
    expect(await store.storedFile(a.record.id)).toEqual({ storageKey: a.storageKey, contentType: "application/pdf" });
    await expect(store.addDocument(doc(3, { supersedesId: a.record.id }))).rejects.toThrow();
    await expect(store.addDocument(doc(4, { visibility: "public" }))).rejects.toThrow();
    await expect(store.addDocument(doc(5, { contentType: "application/zip" }))).rejects.toThrow();
    await expect(db.query("UPDATE investment_project_document SET title = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM investment_project_document")).rejects.toThrow(/append-only/);
    expect(await store.bytesUploadedSince(ownerId, new Date(Date.now() - 60_000).toISOString())).toBe(2468);
  });
});
