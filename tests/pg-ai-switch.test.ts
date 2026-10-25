import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";
import { aiSwitchHistory, aiSwitchOn, setAiSwitch } from "../src/server/ai-switch-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("AI switch on Postgres", () => {
  let t: TestDb;
  let admin: StaffActor;
  beforeAll(async () => {
    t = await createTestDb();
    admin = { id: await addUser(t.db, "admin"), role: "super_admin" };
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("is off with no rows", async () => {
    expect(await aiSwitchOn(t.db)).toBe(false);
    expect(await aiSwitchHistory(t.db)).toEqual([]);
  });

  it("latest row wins and history is newest first", async () => {
    await setAiSwitch(t.db, admin, true, "Local PC test of the model");
    expect(await aiSwitchOn(t.db)).toBe(true);
    await setAiSwitch(t.db, admin, false, "Finished testing for today");
    expect(await aiSwitchOn(t.db)).toBe(false);
    const h = await aiSwitchHistory(t.db);
    expect(h.map(x => [x.enabled, x.reason, x.changedBy])).toEqual([[false, "Finished testing for today", admin.id], [true, "Local PC test of the model", admin.id]]);
  });

  it("history is insert-only and needs a real reason", async () => {
    await expect(t.db.query("UPDATE ai_switch_event SET enabled = true")).rejects.toThrow();
    await expect(t.db.query("DELETE FROM ai_switch_event")).rejects.toThrow();
    await expect(setAiSwitch(t.db, admin, true, "  short   ")).rejects.toThrow();
    expect((await aiSwitchHistory(t.db)).length).toBe(2);
  });

  it("a database error reads as off (fail closed)", async () => {
    const broken = { query: async () => { throw new Error("down"); } };
    expect(await aiSwitchOn(broken as never)).toBe(false);
  });
});
