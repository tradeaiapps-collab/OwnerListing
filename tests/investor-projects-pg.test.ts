import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { INVESTMENT_DISCLOSURE } from "../src/config/investment-disclosure";
import type { StaffActor } from "../src/domain/staff-access";
import type { Queryable } from "../src/server/db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const state = vi.hoisted(() => ({ db: null as unknown as Queryable, staff: null as StaffActor | null }));
vi.mock("../src/server/context", () => ({ getActor: async () => null, getDb: () => state.db, getStaff: async () => state.staff }));

import * as settingsRoute from "../app/api/staff/investments/settings/route";
import * as postingRoute from "../app/api/staff/investments/posting/route";
import { createPgInvestmentRepository, loadPosting, readModuleState } from "../src/server/investments-db";
import { DEFAULT_POSTING, termsFrom } from "../src/domain/investment-terms";

const H = { "content-type": "application/json", origin: "http://test" };
const post = (route: { POST: (r: Request) => Promise<Response> }, body: unknown) => route.POST(new Request("http://test/x", { method: "POST", headers: H, body: JSON.stringify(body) }));
const ON = { enabled: true, counselConfirmed: true, disclosureVersion: INVESTMENT_DISCLOSURE.version };

describe.skipIf(!DATABASE_URL)("investor projects on Postgres", () => {
  let t: TestDb;
  let db: Queryable;
  let admin: StaffActor;
  let ownerId: string;
  let investorId: string;
  const saved = process.env["APP_URL"];

  beforeAll(async () => {
    t = await createTestDb(); db = t.db; state.db = db;
    admin = { id: await addUser(db, "admin"), role: "super_admin" };
    ownerId = await addUser(db, "owner");
    investorId = await addUser(db, "buyer");
    process.env["APP_URL"] = "http://test";
  }, 60_000);
  afterAll(async () => { process.env["APP_URL"] = saved; await t?.close(); });

  it("is off by default; env key alone or database key alone keeps it off; both turn it on; off again at once", async () => {
    expect(await readModuleState({}, () => db)).toEqual({ envOn: false, dbOn: false, live: false });
    expect(await readModuleState({ INVESTMENT_MODULE_ENABLED: "true" }, () => db)).toEqual({ envOn: true, dbOn: false, live: false });
    state.staff = { id: admin.id, role: "compliance" };
    expect((await post(settingsRoute, ON)).status).toBe(403);
    state.staff = admin;
    expect((await post(settingsRoute, { ...ON, counselConfirmed: false })).status).toBe(400);
    expect((await post(settingsRoute, ON)).status).toBe(200);
    expect(await readModuleState({ INVESTMENT_MODULE_ENABLED: "false" }, () => db)).toMatchObject({ dbOn: false, live: false });
    expect(await readModuleState({ INVESTMENT_MODULE_ENABLED: "true" }, () => db)).toMatchObject({ live: true });
    expect((await post(settingsRoute, { enabled: false })).status).toBe(200);
    expect(await readModuleState({ INVESTMENT_MODULE_ENABLED: "true" }, () => db)).toMatchObject({ live: false });
    const h = await db.query("SELECT enabled, counsel_confirmed, disclosure_version FROM investment_setting_history ORDER BY changed_at");
    expect(h.rows).toEqual([
      { enabled: true, counsel_confirmed: true, disclosure_version: INVESTMENT_DISCLOSURE.version },
      { enabled: false, counsel_confirmed: false, disclosure_version: INVESTMENT_DISCLOSURE.version }
    ]);
    const a = await db.query("SELECT event_type FROM audit_event WHERE aggregate_type = 'investment_settings' ORDER BY occurred_at");
    expect(a.rows.map(r => r["event_type"])).toEqual(["investment.module_enabled", "investment.module_disabled"]);
  });

  it("a database error reads as off (fail closed)", async () => {
    const broken: Queryable = { query: async () => { throw new Error("down"); } };
    expect(await readModuleState({ INVESTMENT_MODULE_ENABLED: "true" }, () => broken)).toMatchObject({ live: false });
  });

  it("the database refuses switching on without counsel confirmation, and history tables are insert-only", async () => {
    await expect(db.query("INSERT INTO investment_setting_history (enabled, counsel_confirmed, disclosure_version, changed_by) VALUES (true, false, 'v', $1)", [admin.id])).rejects.toThrow();
    await expect(db.query("UPDATE investment_setting_history SET enabled = true")).rejects.toThrow(/insert-only/);
    await expect(db.query("DELETE FROM investment_setting_history")).rejects.toThrow(/insert-only/);
    await expect(db.query("TRUNCATE investment_setting_history")).rejects.toThrow(/insert-only/);
  });

  it("posting settings: defaults, validated save with history, audited", async () => {
    expect(await loadPosting(db)).toEqual(DEFAULT_POSTING);
    expect((await post(postingRoute, { ...DEFAULT_POSTING, commissionBps: 5000 })).status).toBe(400);
    const r = await post(postingRoute, { ...DEFAULT_POSTING, commissionBps: 250 });
    expect(r.status).toBe(200);
    expect((await r.json()).posterText).toMatch(/2\.5%/);
    expect((await loadPosting(db)).commissionBps).toBe(250);
    await expect(db.query("DELETE FROM investment_posting_setting_history")).rejects.toThrow(/insert-only/);
  });

  it("repository round trip: terms stored, version check, contract and fee ledgers insert-only", async () => {
    const repo = createPgInvestmentRepository(db);
    const id = "11111111-1111-4111-8111-111111111111";
    const now = new Date().toISOString();
    const p = {
      id, ownerUserId: ownerId, title: "Riverside", location: "Bulimba", jurisdiction: "QLD" as const, projectType: "renovation" as const,
      summary: "A renovation project on a large block.", stage: "planning" as const, fundingTargetCents: 100_000_00, minimumTicketCents: 10_000_00,
      timeline: "12 months", risks: "Construction and sale risk, can lose money.", structureDescription: "Unit trust structure", visibleTo: "wholesale_only" as const,
      issuerName: "Riverside Pty Ltd", issuerLicenceBasis: "s708 wholesale", issuerStatement: "", issuerAuthorisedConfirmed: true as const,
      status: "pending_review" as const, version: 1, terms: termsFrom({ ...DEFAULT_POSTING, commissionBps: 250 }), createdAt: now, updatedAt: now
    };
    await repo.createProject(p, { id: "21111111-1111-4111-8111-111111111111", projectId: id, fromStatus: null, toStatus: "pending_review", actorType: "owner", actorId: ownerId, reason: null, projectVersion: 1, at: now });
    expect((await repo.getProject(id))!.terms).toEqual(p.terms);
    expect(await repo.updateProject({ ...p, title: "Riverside 2", terms: termsFrom({ ...DEFAULT_POSTING, model: "upfront_fee", upfrontFeeCents: 100 }) }, 1,
      { id: "31111111-1111-4111-8111-111111111111", projectId: id, fromStatus: "pending_review", toStatus: "pending_review", actorType: "owner", actorId: ownerId, reason: null, projectVersion: 2, at: now })).toBe(true);
    const after = (await repo.getProject(id))!;
    expect(after).toMatchObject({ title: "Riverside 2", version: 2 });
    expect(after.terms).toEqual(p.terms);
    expect(await repo.updateProject(p, 1, { id: "41111111-1111-4111-8111-111111111111", projectId: id, fromStatus: "pending_review", toStatus: "pending_review", actorType: "owner", actorId: ownerId, reason: null, projectVersion: 2, at: now })).toBe(false);

    const iid = "51111111-1111-4111-8111-111111111111";
    await repo.addInterest({ id: iid, projectId: id, investorUserId: investorId, amountMinCents: 100, amountMaxCents: 200, createdAt: now, contractStatus: "none" },
      { id: "61111111-1111-4111-8111-111111111111", interestId: iid, senderUserId: investorId, body: "Hello", sentAt: now });
    await expect(db.query("UPDATE investment_message SET body = 'x'")).rejects.toThrow(/insert-only/);
    await expect(db.query("DELETE FROM investment_message")).rejects.toThrow(/insert-only/);
    expect(await repo.changeContract({ id: "71111111-1111-4111-8111-111111111111", interestId: iid, fromStatus: "none", toStatus: "submitted", actorType: "investor", actorId: investorId, reason: null, at: now },
      { id: "81111111-1111-4111-8111-111111111111", interestId: iid, uploadedBy: investorId, storageKey: "investments/abc/def", sha256: "a".repeat(64), sizeBytes: 10, uploadedAt: now })).toBe(true);
    expect(await repo.changeContract({ id: "91111111-1111-4111-8111-111111111111", interestId: iid, fromStatus: "none", toStatus: "submitted", actorType: "investor", actorId: investorId, reason: null, at: now })).toBe(false);
    expect(await repo.changeContract({ id: "a1111111-1111-4111-8111-111111111111", interestId: iid, fromStatus: "submitted", toStatus: "returned", actorType: "staff", actorId: admin.id, reason: "Signed by both parties.", at: now }, undefined,
      { fee: { id: "b1111111-1111-4111-8111-111111111111", interestId: iid, projectId: id, ownerUserId: ownerId, amountCents: 2500, status: "due", createdAt: now },
        change: { id: "c1111111-1111-4111-8111-111111111111", feeId: "b1111111-1111-4111-8111-111111111111", fromStatus: null, toStatus: "due", actorId: admin.id, reason: "Signed by both parties.", at: now } })).toBe(true);
    expect((await repo.getInterest(iid))!.contractStatus).toBe("returned");
    expect(await repo.changeFee({ id: "d1111111-1111-4111-8111-111111111111", feeId: "b1111111-1111-4111-8111-111111111111", fromStatus: "due", toStatus: "paid", actorId: admin.id, reason: "Bank transfer in.", at: now })).toBe(true);
    expect(await repo.changeFee({ id: "e1111111-1111-4111-8111-111111111111", feeId: "b1111111-1111-4111-8111-111111111111", fromStatus: "due", toStatus: "waived", actorId: admin.id, reason: "Bank transfer in.", at: now })).toBe(false);
    // Posting terms and fee amounts cannot be altered retroactively, even by direct SQL; projects and fees are never deleted.
    await expect(db.query("UPDATE investment_project SET commission_bps = 0")).rejects.toThrow(/fixed when posted/);
    await expect(db.query("UPDATE investment_project SET model2_disclosure = 'after_fee'")).rejects.toThrow();
    await expect(db.query("UPDATE investment_project SET upfront_fee_status = 'paid'")).rejects.toThrow(/fixed when posted/);
    await expect(db.query("UPDATE investment_fee SET amount_cents = 1")).rejects.toThrow(/fixed/);
    await expect(db.query("UPDATE investment_fee SET status = 'due'")).rejects.toThrow(/final/);
    await expect(db.query("DELETE FROM investment_project")).rejects.toThrow(/insert-only/);
    await expect(db.query("DELETE FROM investment_fee")).rejects.toThrow(/insert-only/);
    for (const tbl of ["investment_contract_file", "investment_contract_history", "investment_fee_history", "investment_project_status_history"]) {
      await expect(db.query(`DELETE FROM ${tbl}`)).rejects.toThrow(/insert-only/);
    }
    const c = await repo.counts();
    expect(c).toMatchObject({ pending_review: 1, interests: 1, contractsSubmitted: 0, feesDue: 0 });
    const threads = await repo.threadsFor(ownerId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.role).toBe("owner");
  });
});
