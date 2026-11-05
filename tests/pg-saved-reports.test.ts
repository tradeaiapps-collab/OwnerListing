import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "../src/adapters/email";
import { loadReport } from "../src/server/admin-report-builder-db";
import type { Queryable } from "../src/server/db";
import { nextRunAfter, type ReportDefinition } from "../src/domain/saved-reports";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const mail = vi.hoisted(() => ({ configured: true, sent: [] as EmailMessage[], status: "sent" as "sent" | "failed" }));
vi.mock("../src/server/messaging", () => ({
  getEmailPort: async () => ({ configured: mail.configured, send: async (m: EmailMessage) => { mail.sent.push(m); return { status: mail.status }; } })
}));
import { archiveReport, claimSchedule, createReport, dueSchedules, getReport, listReports, listRuns, recordRun, setSchedule } from "../src/server/saved-reports-db";
import { runDueReports } from "../src/server/saved-reports-run";

const def = (o: Partial<ReportDefinition> = {}): ReportDefinition => ({ name: "Weekly sales", dimension: "category", measures: ["listingsCreated", "enquiries", "offers"], period: "last_30_days", compare: true, shared: false, ...o });
const SCHED = { frequency: "daily" as const, weekday: 1, dayOfMonth: 1, hour: 7 };
const NOW = "2026-11-05T03:00:00.000Z";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("saved and scheduled reports (Postgres)", () => {
  let t: TestDb; let db: Queryable;
  let staffId: string, staffEmail: string, otherId: string;
  beforeAll(async () => {
    t = await createTestDb(); db = t.db;
    const owner = await addUser(db, "owner"), buyer = await addUser(db, "buyer");
    staffId = await addUser(db, "admin"); otherId = await addUser(db, "admin");
    staffEmail = String((await db.query("SELECT lower(email::text) AS e FROM app_user WHERE id = $1", [staffId])).rows[0]!["e"]);
    await db.query("INSERT INTO staff_invite (email, role, accepted_at) VALUES ($1, 'super_admin', now())", [staffEmail]);
    const house = await addListing(db, owner, { status: "published", property_type: "house", created_at: "2026-10-20T00:00:00Z" });
    await db.query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1, $2, '2026-10-21T00:00:00Z')", [house, buyer]);
    const older = await addUser(db, "buyer");
    await db.query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1, $2, '2026-08-21T00:00:00Z')", [house, older]);
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("counts enquiries started in the period per group", async () => {
    const rows = await loadReport(db, { range: { from: "2026-10-01", to: "2026-10-31", bucket: "month" }, dimension: "category" });
    expect(rows).toEqual([expect.objectContaining({ key: "house", enquiries: 1, listingsCreated: 1 })]);
    const earlier = await loadReport(db, { range: { from: "2026-08-01", to: "2026-08-31", bucket: "month" }, dimension: "category" });
    expect(earlier).toEqual([expect.objectContaining({ key: "house", enquiries: 1, listingsCreated: 0 })]);
  });

  it("saves, lists (own and shared only), schedules, and archives", async () => {
    const id = (await createReport(db, staffId, def(), { s: SCHED, nextRunAt: nextRunAfter(SCHED, NOW) }))!;
    const sharedId = (await createReport(db, staffId, def({ name: "Shared one", shared: true }), null))!;
    expect((await listReports(db, staffId)).map(r => r.id).sort()).toEqual([id, sharedId].sort());
    expect((await listReports(db, otherId)).map(r => r.id)).toEqual([sharedId]);
    const row = (await getReport(db, id))!;
    expect(row.definition).toMatchObject({ name: "Weekly sales", measures: ["listingsCreated", "enquiries", "offers"] });
    expect(row.schedule).toMatchObject({ frequency: "daily", hour: 7, enabled: true, nextRunAt: "2026-11-05T21:00:00.000Z" });
    expect(await archiveReport(db, id, otherId)).toBe(false);
    expect(await archiveReport(db, id, staffId)).toBe(true);
    expect(await getReport(db, id)).toBeNull();
    expect((await db.query("SELECT 1 FROM report_schedule WHERE report_id = $1", [id])).rows).toHaveLength(0);
    await archiveReport(db, sharedId, staffId);
  });

  it("keeps at most 60 snapshots per report, newest first", async () => {
    const id = (await createReport(db, staffId, def({ name: "History" }), null))!;
    const result = { name: "x", range: { from: "2026-10-01", to: "2026-10-31" } } as never;
    for (let i = 0; i < 62; i++) await recordRun(db, id, "manual", staffId, result, { headline: "h", points: [] });
    expect(await listRuns(db, id)).toHaveLength(60);
    await archiveReport(db, id, staffId);
  });

  it("a due schedule is claimed by one caller only", async () => {
    const id = (await createReport(db, staffId, def({ name: "Claim" }), null))!;
    await setSchedule(db, id, SCHED, "2026-11-05T00:00:00.000Z");
    const [d] = (await dueSchedules(db, NOW, 10)).filter(x => x.reportId === id);
    expect(d).toBeDefined();
    expect(await claimSchedule(db, d!, "2026-11-05T21:00:00.000Z")).toBe(true);
    expect(await claimSchedule(db, d!, "2026-11-05T21:00:00.000Z")).toBe(false);
    await archiveReport(db, id, staffId);
  });

  describe("runDueReports", () => {
    const fresh = async (name: string, owner = staffId, d: Partial<ReportDefinition> = {}) => {
      const id = (await createReport(db, owner, def({ name, ...d }), null))!;
      await setSchedule(db, id, SCHED, "2026-11-05T00:00:00.000Z");
      return id;
    };
    const status = async (id: string) => (await db.query("SELECT last_status, enabled, next_run_at FROM report_schedule WHERE report_id = $1", [id])).rows[0]!;

    it("runs a due report as its owner, stores a snapshot, emails the owner only, and sets the next run", async () => {
      mail.sent.length = 0; mail.configured = true; mail.status = "sent";
      const id = await fresh("Emailed");
      const counts = await runDueReports(db, NOW, { APP_URL: "https://admin.example.test" });
      expect(counts).toMatchObject({ sent: 1, failed: 0 });
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]!.to).toBe(staffEmail);
      expect(mail.sent[0]!.subject).toBe("Emailed: 2026-10-07 to 2026-11-05");
      expect(mail.sent[0]!.text).toContain("Elena's summary:");
      expect(mail.sent[0]!.text).toContain(`https://admin.example.test/staff/report-builder?report=${id}`);
      expect(await listRuns(db, id)).toHaveLength(1);
      expect(await status(id)).toMatchObject({ last_status: "sent", enabled: true, next_run_at: new Date("2026-11-05T21:00:00.000Z") });
      // Running again at the same moment does nothing: the schedule has moved on.
      mail.sent.length = 0;
      expect((await runDueReports(db, NOW, {})).due).toBe(0);
      expect(mail.sent).toHaveLength(0);
      expect((await db.query("SELECT payload FROM audit_event WHERE event_type = 'job.scheduled_reports_run' ORDER BY occurred_at")).rows.length).toBeGreaterThan(0);
      await archiveReport(db, id, staffId);
    });

    it("records the run but reports not_configured when email is not set up, and failed when sending fails", async () => {
      mail.configured = false;
      const a = await fresh("No email");
      expect(await runDueReports(db, NOW, {})).toMatchObject({ notConfigured: 1 });
      expect((await status(a)).last_status).toBe("not_configured");
      expect(await listRuns(db, a)).toHaveLength(1);
      mail.configured = true; mail.status = "failed";
      const b = await fresh("Bad email");
      expect(await runDueReports(db, NOW, {})).toMatchObject({ failed: 1 });
      expect((await status(b)).last_status).toBe("failed");
      await archiveReport(db, a, staffId); await archiveReport(db, b, staffId);
    });

    it("switches off the schedule of an owner who is no longer staff, and sends nothing", async () => {
      mail.sent.length = 0; mail.configured = true; mail.status = "sent";
      const id = await fresh("Former staff", otherId);
      expect(await runDueReports(db, NOW, {})).toMatchObject({ skipped: 1, sent: 0 });
      expect(await status(id)).toMatchObject({ last_status: "owner_no_access", enabled: false });
      expect(mail.sent).toHaveLength(0);
      expect(await listRuns(db, id)).toHaveLength(0);
      await archiveReport(db, id, otherId);
    });

    it("does not run a schedule whose report was archived", async () => {
      mail.sent.length = 0;
      const id = await fresh("Archived");
      await db.query("UPDATE saved_report SET archived_at = now() WHERE id = $1", [id]);
      expect((await runDueReports(db, NOW, {})).due).toBe(0);
      expect(mail.sent).toHaveLength(0);
    });
  });
});
