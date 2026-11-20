import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertComplaint } from "../src/server/contractor-ops-db";
import { decideReportPg, decideVerificationPg, listReportsPg, listVerificationsPg, submitVerificationPg } from "../src/server/contractor-trust-db";
import { accuracyPg, withBulkLockPg, bulkCountLastHourPg, complaintFactsPg, logOutcomePg, prescreenComplaintsPg, prescreenModerationPg, prescreenVerificationsPg } from "../src/server/elena-prescreen-db";
import { decideQueueItemPg, enqueueModerationItemPg, listQueuePg } from "../src/server/moderation-queue-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const TODAY = "2026-11-20";
const details = { businessName: "Bright Snaps Pty Ltd", abn: "51824753556", licenceNumber: null, licenceAuthority: null, licenceExpiry: null, insurer: "Allianz", policyNumber: "PL-88213", insuranceExpiry: "2027-09-01" };

describe.skipIf(!DATABASE_URL)("Elena staff pre-screening (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("moderation: recommends, logs once per fingerprint, groups duplicates, and records agree and override outcomes", async () => {
    const owner = await addUser(db, "owner");
    const staff = await addUser(db, "admin");
    const l1 = await addListing(db, owner, { title: "A" });
    const l2 = await addListing(db, owner, { title: "B" });
    const mk = (listingId: string, detail: string) => enqueueModerationItemPg(db, { subjectType: "listing", subjectId: listingId, subjectLabel: "x", subjectOwnerId: owner, source: "content_filter", reason: "Flagged: spam", detail, severity: "medium" });
    const a = (await mk(l1, "Lovely sunny kitchen"))!;
    const b = (await mk(l2, "Lovely sunny kitchen"))!;
    const items = await listQueuePg(db, { view: "open" });
    const first = await prescreenModerationPg(db, items);
    expect(first.get(a)).toMatchObject({ action: "approve", confidence: "high", rule: "mod.no_match", groupSize: 2 });
    expect(first.get(b)!.duplicateOf).toBeTruthy();
    const again = await prescreenModerationPg(db, items);
    expect(again.get(a)!.recommendationId).toBe(first.get(a)!.recommendationId);
    expect(Number((await db.query("SELECT count(*) AS n FROM elena_staff_recommendation WHERE queue = 'moderation'")).rows[0]!["n"])).toBe(2);

    await decideQueueItemPg(db, a, { id: staff, role: "admin" }, "approve", "open", "Looks fine to me.");
    expect(await logOutcomePg(db, { queue: "moderation", subjectId: a, staffId: staff, staffRole: "admin", staffAction: "approve" })).toBe(true);
    await decideQueueItemPg(db, b, { id: staff, role: "admin" }, "reject", "open", "Not fine at all, rejecting it.");
    await logOutcomePg(db, { queue: "moderation", subjectId: b, staffId: staff, staffRole: "admin", staffAction: "hide", viaBulk: true });
    const acc = await accuracyPg(db, 30);
    const row = acc.find(r => r.queue === "moderation" && r.rule === "mod.no_match")!;
    expect(row).toMatchObject({ total: 2, agreed: 1, overridden: 1 });
    expect(await bulkCountLastHourPg(db, staff)).toBe(1);
    const ev = await db.query("SELECT event_type FROM audit_event WHERE aggregate_type = 'elena_staff_prescreen' ORDER BY occurred_at");
    expect(ev.rows.map(r => r["event_type"]).sort()).toEqual(["elena_staff_prescreen.outcome", "elena_staff_prescreen.override"]);
  });

  it("recommendation and outcome rows are permanent", async () => {
    await expect(db.query("DELETE FROM elena_staff_recommendation")).rejects.toThrow(/permanent/);
    await expect(db.query("UPDATE elena_staff_outcome SET agreed = true")).rejects.toThrow(/permanent/);
  });

  it("an outcome with no earlier recommendation is neutral", async () => {
    const staff = await addUser(db, "admin");
    const subject = (await db.query("SELECT gen_random_uuid() AS id")).rows[0]!["id"] as string;
    await logOutcomePg(db, { queue: "verification", subjectId: subject, staffId: staff, staffRole: "admin", staffAction: "verify" });
    const r = (await db.query("SELECT agreed, recommendation_id FROM elena_staff_outcome WHERE subject_id = $1::uuid", [subject])).rows[0]!;
    expect(r["agreed"]).toBeNull();
    expect(r["recommendation_id"]).toBeNull();
  });

  it("verification: approves a complete submission, flags a reused ABN on both accounts, and re-screens after a resubmission", async () => {
    const c1 = await addUser(db, "agent");
    const c2 = await addUser(db, "agent");
    const c3 = await addUser(db, "agent");
    await db.query("UPDATE app_user SET display_name = 'Bright Snaps' WHERE id = $1", [c1]);
    await submitVerificationPg(db, c1, { ...details, abn: "51824753556" });
    await submitVerificationPg(db, c2, { ...details, businessName: "Bright Snaps Two", abn: "51824753556" });
    await submitVerificationPg(db, c3, { ...details, businessName: "Other", abn: "53004085616", insuranceExpiry: "2026-01-01" });
    const rows = await listVerificationsPg(db, "pending", TODAY);
    const s = await prescreenVerificationsPg(db, rows, TODAY);
    expect(s.get(c1)).toMatchObject({ action: "needs_info", rule: "ver.abn_duplicate" });
    expect(s.get(c2)!.rule).toBe("ver.abn_duplicate");
    expect(s.get(c3)).toMatchObject({ action: "needs_info", rule: "ver.insurance_expired", confidence: "high" });
    expect(s.get(c3)!.draft).toContain("certificate of currency");
    // c1 fixes the ABN conflict by using a different ABN: new submission, new recommendation row.
    await submitVerificationPg(db, c1, { ...details, abn: "53004085616", insuranceExpiry: "2027-09-01" });
    await db.query("DELETE FROM contractor_verification WHERE user_id = ANY($1::uuid[])", [[c2, c3]]);
    const s2 = await prescreenVerificationsPg(db, await listVerificationsPg(db, "pending", TODAY), TODAY);
    expect(s2.get(c1)).toMatchObject({ action: "approve", confidence: "high" });
    expect(s2.get(c1)!.recommendationId).not.toBe(s.get(c1)!.recommendationId);
    const staff = await addUser(db, "admin");
    expect(await decideVerificationPg(db, c1, staff, "verify", null)).toBe(true);
    expect((await prescreenVerificationsPg(db, await listVerificationsPg(db, "all", TODAY), TODAY)).size).toBe(0);
  });

  it("complaints: builds the job history and screens only open complaints", async () => {
    const owner = await addUser(db, "owner");
    const contractor = await addUser(db, "agent");
    const staff = await addUser(db, "admin");
    const listing = await addListing(db, owner, { title: "Job home" });
    const job = String((await db.query(
      "INSERT INTO job_assignment (listing_id, owner_user_id, contractor_user_id, kind, status, scheduled_time) VALUES ($1,$2,$3,'photographer','approved', now() - interval '3 days') RETURNING id", [listing, owner, contractor])).rows[0]!["id"]);
    await insertComplaint(db, job, owner, "no_show", "Never arrived.");
    const reports = await listReportsPg(db, "open");
    const mine = reports.find(r => r.contractorId === contractor)!;
    const facts = (await complaintFactsPg(db, [mine.id])).get(mine.id)!;
    expect(facts.contractor).toMatchObject({ jobsTotal: 1, upheldBefore: 0, suspended: false });
    const s = await prescreenComplaintsPg(db, reports);
    expect(s.get(mine.id)).toMatchObject({ action: "uphold", confidence: "medium", rule: "cmp.no_show_confirmed" });
    expect(s.get(mine.id)!.summary!.join(" ")).toContain("1 job");
    expect(await decideReportPg(db, mine.id, staff, "dismiss", "Contractor had a valid reason.")).toBe("ok");
    expect((await prescreenComplaintsPg(db, await listReportsPg(db, "decided"))).size).toBe(0);
  });

  it("a decision bound to the screened submission does not apply after a re-submission", async () => {
    const c = await addUser(db, "agent");
    const staff = await addUser(db, "admin");
    await submitVerificationPg(db, c, details);
    const screened = (await listVerificationsPg(db, "pending", TODAY)).find(v => v.userId === c)!;
    await new Promise(r => setTimeout(r, 15));
    await submitVerificationPg(db, c, { ...details, insurer: "Changed after the check" });
    expect(await decideVerificationPg(db, c, staff, "verify", "x", screened.submittedAt)).toBe(false);
    const now = (await listVerificationsPg(db, "pending", TODAY)).find(v => v.userId === c)!;
    expect(now.status).toBe("pending");
    expect(await decideVerificationPg(db, c, staff, "verify", "x", now.submittedAt)).toBe(true);
  });

  it("the permanent log keeps the rule in general words, never quoted text or names", async () => {
    const owner = await addUser(db, "owner");
    const l = await addListing(db, owner, { title: "Quote test" });
    const id = (await enqueueModerationItemPg(db, { subjectType: "listing", subjectId: l, subjectLabel: "x", subjectOwnerId: owner, source: "content_filter", reason: "Flagged: abuse", detail: "you stupid idiot", severity: "high" }))!;
    const s = await prescreenModerationPg(db, await listQueuePg(db, { view: "open" }));
    expect(s.get(id)!.reason).toContain("idiot");
    const stored = (await db.query("SELECT reason FROM elena_staff_recommendation WHERE subject_id = $1::uuid", [id])).rows[0]!["reason"] as string;
    expect(stored).not.toContain("idiot");
    expect(stored).toBe("Blocked abusive wording matched.");
  });

  it("bulk requests from one staff member run one at a time", async () => {
    const staff = await addUser(db, "admin");
    const order: string[] = [];
    const run = (n: string) => withBulkLockPg(db, staff, async () => { order.push(`${n}:start`); await new Promise(r => setTimeout(r, 60)); order.push(`${n}:end`); });
    await Promise.all([run("a"), run("b")]);
    expect(order[0]!.split(":")[0]).toBe(order[1]!.split(":")[0]);
    expect(order[1]!.endsWith(":end")).toBe(true);
  });
});
