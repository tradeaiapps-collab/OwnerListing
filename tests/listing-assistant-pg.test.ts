import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertFeedbackPg, loadProfilePg, resetFeedbackPg } from "../src/server/listing-assistant-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("listing_assistant_feedback on Postgres", () => {
  let t: TestDb;
  let user: string, other: string;
  beforeAll(async () => {
    t = await createTestDb();
    user = await addUser(t.db, "owner");
    other = await addUser(t.db, "agent");
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("stores events per user, builds the profile and forgets on request", async () => {
    await insertFeedbackPg(t.db, user, [
      { kind: "tag", key: "pool", action: "accepted" }, { kind: "tag", key: "pool", action: "accepted" },
      { kind: "rewrite", key: "shorter", action: "edited", deltaPct: 25 }, { kind: "pricing", key: "market", action: "chosen" }
    ]);
    await insertFeedbackPg(t.db, other, [{ kind: "tag", key: "pool", action: "dismissed" }]);
    const p = await loadProfilePg(t.db, user);
    expect(p.tags["pool"]).toEqual({ accepted: 2, dismissed: 0 });
    expect(p.rewrite["shorter"]?.deltas).toEqual([25]);
    expect(p.pricing["market"]).toBe(1);
    expect((await loadProfilePg(t.db, other)).tags["pool"]).toEqual({ accepted: 0, dismissed: 1 });
    await resetFeedbackPg(t.db, user);
    expect(await loadProfilePg(t.db, user)).toEqual({ tags: {}, questions: {}, rewrite: {}, pricing: {} });
    expect((await loadProfilePg(t.db, other)).tags["pool"]).toBeDefined();
  });

  it("refuses free text and out-of-range values at the database", async () => {
    await expect(t.db.query("INSERT INTO listing_assistant_feedback (user_id, kind, key, action) VALUES ($1::uuid,'tag','Some Free Text!','accepted')", [user])).rejects.toThrow();
    await expect(t.db.query("INSERT INTO listing_assistant_feedback (user_id, kind, key, action, delta_pct) VALUES ($1::uuid,'rewrite','shorter','edited',999)", [user])).rejects.toThrow();
    await expect(t.db.query("INSERT INTO listing_assistant_feedback (user_id, kind, key, action) VALUES ($1::uuid,'other','pool','accepted')", [user])).rejects.toThrow();
  });
});
