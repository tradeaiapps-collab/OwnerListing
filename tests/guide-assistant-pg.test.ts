import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_GUIDE } from "../src/domain/guide-assistant";
import { nextStep } from "../src/domain/journey";
import type { StaffActor } from "../src/domain/staff-access";
import { clearGuideCache, getLiveGuide, loadGuideView, loadLiveGuide, publishGuide, saveGuideDraft } from "../src/server/guide-assistant-db";
import { loadJourney } from "../src/server/journey";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("guide assistant and journey on Postgres", () => {
  let t: TestDb;
  let staff: StaffActor;
  beforeAll(async () => {
    t = await createTestDb();
    staff = { id: await addUser(t.db, "admin"), role: "super_admin" };
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("starts on the defaults; a save is a draft until published", async () => {
    expect(await loadLiveGuide(t.db)).toEqual(DEFAULT_GUIDE);
    const a = await saveGuideDraft(t.db, staff, null, { ...structuredClone(DEFAULT_GUIDE), greeting: "Draft greeting" });
    expect(a).toMatchObject({ ok: true });
    expect((await loadLiveGuide(t.db)).greeting).toBe(DEFAULT_GUIDE.greeting);
    const v = (a as { version: number }).version;
    expect((await loadGuideView(t.db)).draft.greeting).toBe("Draft greeting");
    expect(await publishGuide(t.db, staff, v)).toEqual({ ok: true, version: v });
    expect((await loadLiveGuide(t.db)).greeting).toBe("Draft greeting");
    clearGuideCache();
    expect((await getLiveGuide(() => t.db)).greeting).toBe("Draft greeting");
  });

  it("refuses a save or publish based on a stale version", async () => {
    const view = await loadGuideView(t.db);
    expect(await saveGuideDraft(t.db, staff, null, DEFAULT_GUIDE)).toMatchObject({ ok: false, code: "conflict" });
    const b = await saveGuideDraft(t.db, staff, view.draftVersion, { ...structuredClone(DEFAULT_GUIDE), enabled: false });
    expect(b.ok).toBe(true);
    expect(await publishGuide(t.db, staff, view.draftVersion!)).toMatchObject({ ok: false, code: "conflict" });
  });

  it("versions and publish rows are insert-only, and every change is audited", async () => {
    await expect(t.db.query(`UPDATE guide_assistant_version SET content = '{}'::jsonb`)).rejects.toThrow();
    await expect(t.db.query(`DELETE FROM guide_assistant_publish`)).rejects.toThrow();
    const r = await t.db.query(`SELECT event_type FROM audit_event WHERE aggregate_type = 'guide_assistant' ORDER BY occurred_at`);
    expect(r.rows.map(x => x["event_type"])).toEqual(expect.arrayContaining(["guide.content_saved", "guide.content_published"]));
  });

  it("the hero slot accepts up to 1.5 MB while logos keep the 512 KB cap", async () => {
    const ins = (name: string, size: number) => t.db.query(
      `INSERT INTO site_theme_asset (name, content_type, bytes, sha256, width, height, created_by) VALUES ($1,'image/png',$2,$3,2400,1200,$4)`,
      [name, Buffer.alloc(size, 1), "a".repeat(64), staff.id]);
    await expect(ins("hero", 1_500_000)).resolves.toBeDefined();
    await expect(ins("hero", 1_572_865)).rejects.toThrow();
    await expect(ins("logo-light", 600_000)).rejects.toThrow();
    await expect(ins("banner", 100)).rejects.toThrow();
  });

  it("journey facts come from the user's own rows only", async () => {
    const owner = await addUser(t.db, "owner"), other = await addUser(t.db, "owner");
    await addListing(t.db, other, { status: "published" });
    let j = await loadJourney(t.db, { userId: owner, userType: "owner" });
    expect(j!.role).toBe("owner");
    expect(nextStep(j!.steps)!.id).toBe("terms");
    expect(j!.steps.find(s => s.id === "publish")!.status).toBe("todo"); // the other owner's published listing does not count
    const mine = await addListing(t.db, owner);
    j = await loadJourney(t.db, { userId: owner, userType: "owner" });
    expect(j!.steps.find(s => s.id === "listing")!.status).toBe("done");
    expect(j!.steps.find(s => s.id === "photos")!.href).toBe(`/listings/${mine}/documents`);

    const buyer = await addUser(t.db, "buyer");
    const b = await loadJourney(t.db, { userId: buyer, userType: "buyer" });
    expect(b!.role).toBe("buyer");
    expect(nextStep(b!.steps)!.id).toBe("email");
  });
});
