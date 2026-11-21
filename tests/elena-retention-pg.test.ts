import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRetentionSettings, previewRetention, recentRetentionRuns, runRetentionPurge, runScheduledRetention, saveRetentionSettings, validRetentionDays } from "../src/server/elena-retention-db";
import { runAutomationTick } from "../src/server/staff-automation-run";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const NOW = "2026-11-21T00:00:00.000Z";
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();

describe("retention period", () => {
  it("accepts 90 to 3650 whole days only", () => {
    expect([89, 90, 365, 3650, 3651, 1.5, "365", NaN].map(validRetentionDays)).toEqual([false, true, true, true, false, false, false, false]);
  });
});

describe.skipIf(!DATABASE_URL)("applicant data retention (Postgres)", () => {
  let t: TestDb, staff: string, owner: string, buyer: string, listing: string;
  beforeAll(async () => {
    t = await createTestDb();
    staff = await addUser(t.db, "admin"); owner = await addUser(t.db, "owner"); buyer = await addUser(t.db, "buyer");
    listing = await addListing(t.db, owner);
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  async function application(age: number, status = "declined") {
    const u = await addUser(t.db, "buyer");
    const r = await t.db.query(
      `INSERT INTO rental_application (listing_id, applicant_user_id, status, weekly_income_cents, rental_history_months, references_count, move_in_date, note, decided_at, updated_at)
       VALUES ($1,$2,$3,200000,24,2,'2026-12-01','Two kids and a cat',$4,$4) RETURNING id`, [listing, u, status, daysAgo(age)]);
    return String(r.rows[0]!["id"]);
  }
  async function enquiryAction(age: number) {
    const u = await addUser(t.db, "buyer");
    const e = await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2) RETURNING id", [listing, u]);
    const r = await t.db.query(
      "INSERT INTO elena_enquiry_action (enquiry_id, listing_id, owner_user_id, buyer_user_id, kind, topics, body, status, created_at) VALUES ($1,$2,$3,$4,'reply','{price,rent}','Draft answer',$5,$6) RETURNING id",
      [e.rows[0]!["id"], listing, owner, u, "discarded", daysAgo(age)]);
    return String(r.rows[0]!["id"]);
  }
  const app = async (id: string) => (await t.db.query("SELECT weekly_income_cents, rental_history_months, references_count, move_in_date, note, status, purged_at FROM rental_application WHERE id = $1", [id])).rows[0]!;

  it("is off by default with a 365 day period, and saving is audited", async () => {
    expect(await getRetentionSettings(t.db)).toEqual({ enabled: false, retentionDays: 365, lastRunAt: null });
    await saveRetentionSettings(t.db, staff, { enabled: false, retentionDays: 180 });
    expect((await getRetentionSettings(t.db)).retentionDays).toBe(180);
    const a = await t.db.query("SELECT payload FROM audit_event WHERE event_type = 'elena_retention.settings_changed'");
    expect(a.rows).toHaveLength(1);
  });

  it("previews, then scrubs only records older than the period and leaves rows and statuses in place", async () => {
    const old = await application(400), recent = await application(30), openOld = await application(500, "submitted");
    const oldAct = await enquiryAction(400), newAct = await enquiryAction(10);
    expect(await previewRetention(t.db, NOW, 365)).toEqual({ applications: 2, enquiryActions: 1 });
    const counts = await runRetentionPurge(t.db, NOW, 365, { trigger: "staff", staffId: staff });
    expect(counts).toEqual({ applications: 2, enquiryActions: 1 });
    const o = await app(old);
    expect([o["weekly_income_cents"], o["rental_history_months"], o["references_count"], o["move_in_date"], o["note"]]).toEqual([null, null, null, null, null]);
    expect(o["status"]).toBe("declined"); expect(o["purged_at"]).not.toBeNull();
    expect((await app(openOld))["note"]).toBeNull();
    const r = await app(recent);
    expect(r["note"]).toBe("Two kids and a cat"); expect(r["purged_at"]).toBeNull();
    const acts = (await t.db.query("SELECT id, body, topics, purged_at FROM elena_enquiry_action WHERE id = ANY($1::uuid[])", [[oldAct, newAct]])).rows;
    expect(acts.find(x => x["id"] === oldAct)).toMatchObject({ body: null, topics: [] });
    expect(acts.find(x => x["id"] === newAct)).toMatchObject({ body: "Draft answer", purged_at: null });
  });

  it("is repeatable: a second run scrubs nothing, and every run is recorded and audited with counts only", async () => {
    expect(await runRetentionPurge(t.db, new Date(Date.parse(NOW) + 1000).toISOString(), 365, { trigger: "staff", staffId: staff })).toEqual({ applications: 0, enquiryActions: 0 });
    const runs = await recentRetentionRuns(t.db);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ trigger: "staff", retentionDays: 365, applications: 0 });
    const a = (await t.db.query("SELECT payload FROM audit_event WHERE event_type = 'elena_retention.purged' ORDER BY occurred_at")).rows;
    expect(a).toHaveLength(2);
    expect(JSON.stringify(a)).not.toMatch(/Two kids|Draft answer/);
    await expect(t.db.query("UPDATE elena_retention_run SET retention_days = 1")).rejects.toThrow();
  });

  it("the schedule does nothing while off, runs once a day when on, and rides the automation tick", async () => {
    const day = (n: number) => new Date(Date.parse(NOW) + n * 3_600_000).toISOString();
    await application(800);
    expect(await runScheduledRetention(t.db, day(1))).toBeNull();
    await saveRetentionSettings(t.db, staff, { enabled: true, retentionDays: 365 });
    const tick = await runAutomationTick(t.db, day(25), {});
    expect(tick.retention).toMatchObject({ applications: 1 });
    expect(tick.errors).not.toContain("retention");
    await application(900);
    expect(await runScheduledRetention(t.db, day(26))).toBeNull(); // already ran within a day
    expect((await runScheduledRetention(t.db, day(50)))).toMatchObject({ applications: 1 });
    expect((await recentRetentionRuns(t.db))[0]!.trigger).toBe("schedule");
  });

  it("rejects an invalid period", async () => {
    await expect(runRetentionPurge(t.db, NOW, 30, { trigger: "schedule" })).rejects.toThrow();
    void buyer; void randomUUID;
  });
});
