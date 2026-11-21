import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgProfileStore } from "../src/server/elena-investor-match-db";
import type { Queryable } from "../src/server/db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("Elena investor profile on Postgres", () => {
  let t: TestDb, db: Queryable, user: string, other: string;
  beforeAll(async () => { t = await createTestDb(); db = t.db; user = await addUser(db, "buyer"); other = await addUser(db, "buyer"); }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("saves, reads back, updates and deletes one row per investor, telling anywhere from not asked yet", async () => {
    const s = createPgProfileStore(db);
    expect(await s.get(user)).toBeUndefined();
    await s.save(user, { budgetMaxCents: 5_000_000, risk: "cautious", suburbs: [] }, "2026-11-21T00:00:00Z");
    expect(await s.get(user)).toEqual({ budgetMaxCents: 5_000_000, risk: "cautious", suburbs: [] });
    await s.save(user, { budgetMaxCents: 5_000_000, risk: "growth", jurisdictions: [], suburbs: ["Bulimba"], timeframe: "flexible" }, "2026-11-21T01:00:00Z");
    expect(await s.get(user)).toEqual({ budgetMaxCents: 5_000_000, risk: "growth", jurisdictions: [], suburbs: ["Bulimba"], timeframe: "flexible" });
    expect(await s.get(other)).toBeUndefined();
    expect((await db.query("SELECT count(*)::int AS n FROM elena_investor_profile")).rows[0]!["n"]).toBe(1);
    await s.remove(user);
    expect(await s.get(user)).toBeUndefined();
  });
  it("the database refuses bad values", async () => {
    await expect(db.query("INSERT INTO elena_investor_profile (user_id, risk) VALUES ($1, 'reckless')", [user])).rejects.toThrow();
    await expect(db.query("INSERT INTO elena_investor_profile (user_id, budget_max_cents) VALUES ($1, 5)", [user])).rejects.toThrow();
    await expect(db.query("INSERT INTO elena_investor_profile (user_id, suburbs) VALUES ($1, ARRAY['a','b','c','d','e','f'])", [user])).rejects.toThrow();
  });
});
