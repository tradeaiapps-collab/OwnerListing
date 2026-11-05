import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizeCron, cronStatus, rotateCronSecret, setCronEnabled } from "../src/server/cron-secret-db";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("cron secrets on PostgreSQL", () => {
  let t: TestDb;
  let staff: string;
  beforeAll(async () => {
    t = await createTestDb();
    staff = String((await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,$2,$3,$4) RETURNING id", [`${randomUUID()}@t.au`, "Staff", "owner", "active"])).rows[0]!["id"]);
  });
  afterAll(async () => { await t?.close(); });

  it("rotates, authorises, pauses and records the last call", async () => {
    expect((await cronStatus(t.db, "automations", {})).source).toBe("none");
    const secret = await rotateCronSecret(t.db, "automations", staff);
    expect(await authorizeCron(t.db, "automations", secret, {})).toEqual({ ok: true });
    expect(await authorizeCron(t.db, "automations", "x".repeat(64), {})).toMatchObject({ status: 401 });
    const s = await cronStatus(t.db, "automations", {});
    expect(s).toMatchObject({ source: "database", active: true, last4: secret.slice(-4) });
    expect(s.lastCalledAt).toBeTruthy();
    const stored = String((await t.db.query("SELECT secret_hash FROM cron_secret_setting WHERE job = 'automations'")).rows[0]!["secret_hash"]);
    expect(stored).not.toContain(secret);
    await setCronEnabled(t.db, "automations", staff, false);
    expect(await authorizeCron(t.db, "automations", secret, {})).toMatchObject({ status: 503 });
    expect((await cronStatus(t.db, "automations", {})).active).toBe(false);
  });
});
