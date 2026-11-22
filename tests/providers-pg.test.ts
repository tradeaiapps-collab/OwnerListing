import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";
import { connectCredential, createPgEventStore, finishSync, lastSyncs, revokeCredential, startSync } from "../src/server/providers/store-db";

describe.skipIf(!DATABASE_URL)("provider tables on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.close(); });
  const ev = (id: string) => ({ provider: "mls" as const, eventId: id, eventType: "listing.updated", payload: { a: 1 }, bodySha256: "a".repeat(64) });

  it("stores a raw event once and only lets the processing outcome change", async () => {
    const s = createPgEventStore(t.db);
    const first = await s.record(ev("e1"));
    expect(first.inserted).toBe(true);
    expect((await s.record(ev("e1"))).inserted).toBe(false);
    await s.finish(first.id!, "processed");
    expect((await t.db.query("SELECT process_status, processed_at FROM provider_events WHERE id=$1", [first.id])).rows[0]).toMatchObject({ process_status: "processed" });
    await expect(t.db.query("UPDATE provider_events SET payload='{}'::jsonb WHERE id=$1", [first.id])).rejects.toThrow(/append-only/);
    await expect(t.db.query("DELETE FROM provider_events WHERE id=$1", [first.id])).rejects.toThrow(/append-only/);
  });
  it("logs a sync run and reports the latest per provider", async () => {
    const id = await startSync(t.db, "mls", "listings");
    await finishSync(t.db, id, { seen: 10, changed: 3 });
    const bad = await startSync(t.db, "zillow", "estimates");
    await finishSync(t.db, bad, { errorCode: "auth", errorMessage: "x".repeat(900) });
    const last = await lastSyncs(t.db);
    expect(last.find(x => x.provider === "mls")).toMatchObject({ status: "success" });
    expect(last.find(x => x.provider === "zillow")).toMatchObject({ status: "error", errorCode: "auth" });
    expect((await t.db.query("SELECT char_length(error_message) AS n FROM provider_sync_logs WHERE id=$1", [bad])).rows[0]!["n"]).toBe(500);
  });
  it("keeps one live connection per provider and holder, and revokes by clearing the secret", async () => {
    const u = await addUser(t.db, "agent");
    const a = await connectCredential(t.db, { provider: "mls", ownerUserId: u, secretSealed: "v1.a.b.c" });
    const b = await connectCredential(t.db, { provider: "mls", ownerUserId: u, secretSealed: "v1.d.e.f" });
    const rows = (await t.db.query("SELECT id, status FROM provider_credentials WHERE owner_user_id=$1 ORDER BY created_at", [u])).rows;
    expect(rows.find(r => r["id"] === a)!["status"]).toBe("revoked");
    expect(rows.find(r => r["id"] === b)!["status"]).toBe("connected");
    expect(await revokeCredential(t.db, b)).toBe(true);
    expect((await t.db.query("SELECT secret_sealed FROM provider_credentials WHERE id=$1", [b])).rows[0]!["secret_sealed"]).toBeNull();
    expect(await revokeCredential(t.db, b)).toBe(false);
    await expect(connectCredential(t.db, { provider: "mls" })).rejects.toThrow(/exactly one/);
    await expect(t.db.query("INSERT INTO provider_credentials (provider) VALUES ('mls')")).rejects.toThrow();
  });
});
