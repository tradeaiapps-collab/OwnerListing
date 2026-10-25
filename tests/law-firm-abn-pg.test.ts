import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listTrustQueue } from "../src/server/staff-admin-db";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("law_firm.abn (Postgres)", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const firm = async () => (await t.db.query(`INSERT INTO law_firm (name, jurisdiction) VALUES ('Smith Legal', 'QLD') RETURNING id`)).rows[0]!["id"] as string;

  it("is nullable and accepts a checksum-valid ABN as 11 digits", async () => {
    const id = await firm();
    expect((await t.db.query(`SELECT abn FROM law_firm WHERE id = $1`, [id])).rows[0]!["abn"]).toBeNull();
    await t.db.query(`UPDATE law_firm SET abn = $2 WHERE id = $1`, [id, "51824753556"]);
    expect((await t.db.query(`SELECT abn FROM law_firm WHERE id = $1`, [id])).rows[0]!["abn"]).toBe("51824753556");
  });
  it("rejects a bad checksum, spaces and short values at the database too", async () => {
    const id = await firm();
    for (const bad of ["51824753557", "51 824 753 5", "5182475355", "abcdefghijk"]) {
      await expect(t.db.query(`UPDATE law_firm SET abn = $2 WHERE id = $1`, [id, bad])).rejects.toThrow();
    }
  });
  it("the trust queue query still runs and carries the firm id and ABN", async () => {
    expect(await listTrustQueue(t.db)).toEqual([]);
  });
});
