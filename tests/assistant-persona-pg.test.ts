import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";
import { choosePersona, clearPersonaCache, getLivePersona, loadLivePersona, loadPersonaView } from "../src/server/assistant-persona-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("assistant persona on Postgres", () => {
  let t: TestDb;
  let staff: StaffActor;
  beforeAll(async () => {
    t = await createTestDb();
    staff = { id: await addUser(t.db, "admin"), role: "super_admin" };
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("is Elena until staff choose another, and the latest choice is live", async () => {
    expect(await loadLivePersona(t.db)).toBe("elena");
    expect(await loadPersonaView(t.db)).toEqual({ current: "elena", history: [] });
    expect(await choosePersona(t.db, staff, "sofia")).toEqual({ changed: true });
    expect(await choosePersona(t.db, staff, "sofia")).toEqual({ changed: false });
    expect(await choosePersona(t.db, staff, "noor")).toEqual({ changed: true });
    expect(await loadLivePersona(t.db)).toBe("noor");
    const view = await loadPersonaView(t.db);
    expect(view.history.map(h => h.persona)).toEqual(["noor", "sofia"]);
    clearPersonaCache();
    expect(await getLivePersona(() => t.db)).toBe("noor");
  });

  it("choices are insert-only, limited to the five ids, and audited", async () => {
    await expect(t.db.query(`UPDATE assistant_persona_choice SET persona = 'maya'`)).rejects.toThrow();
    await expect(t.db.query(`DELETE FROM assistant_persona_choice`)).rejects.toThrow();
    await expect(t.db.query(`INSERT INTO assistant_persona_choice (persona, chosen_by) VALUES ('lucy', $1)`, [staff.id])).rejects.toThrow();
    const r = await t.db.query(`SELECT event_type, payload FROM audit_event WHERE aggregate_type = 'assistant_persona' ORDER BY occurred_at`);
    expect(r.rows.map(x => x["event_type"])).toEqual(["assistant.persona_changed", "assistant.persona_changed"]);
  });

  it("falls back to Elena when the database is unreachable", async () => {
    clearPersonaCache();
    expect(await getLivePersona(() => { throw new Error("down"); })).toBe("elena");
    clearPersonaCache();
  });
});
