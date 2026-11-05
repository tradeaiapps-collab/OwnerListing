import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyseDocument, ENGINE_VERSION } from "../src/domain/doc-analyst";
import { createPgAnalysisStore } from "../src/server/doc-analysis-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("document analysis (Postgres)", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("stores readings insert-only, returns the latest, counts per user and records shares once", async () => {
    const db = t.db;
    const owner = await addUser(db, "owner"), pal = await addUser(db, "agent");
    const listing = await addListing(db, owner);
    const prop = String((await db.query("INSERT INTO property (address_text, state) VALUES ('1 Test St','QLD') RETURNING id")).rows[0]!["id"]);
    const docId = String((await db.query(
      "INSERT INTO property_document (property_id, listing_id, kind, storage_key, sha256, uploaded_by, source, declared_mime, size_bytes) VALUES ($1,$2,'contract','k',$3,$4,'owner_supplied','application/pdf',10) RETURNING id",
      [prop, listing, "a".repeat(64), owner])).rows[0]!["id"]);
    const s = createPgAnalysisStore(db);
    const analysis = analyseDocument("Contract of sale. The vendor sells to the purchaser. The purchase price is $700,000. The deposit is 10%. Settlement is 14 days after contract.");
    const id = randomUUID();
    await s.insert({ id, documentId: docId, listingId: listing, requestedBy: owner, textSha256: "b".repeat(64), analysis });
    const latest = await s.latest(docId, ENGINE_VERSION);
    expect(latest?.id).toBe(id);
    expect(latest?.analysis.facts.find(f => f.label === "Price")?.value).toBe("$700,000");
    expect((await s.byId(id))?.listingId).toBe(listing);
    expect(await s.latest(docId, "other-engine")).toBeUndefined();
    expect(await s.countRecent(owner, new Date(Date.now() - 3_600_000).toISOString())).toBe(1);
    expect(await s.countRecent(pal, new Date(Date.now() - 3_600_000).toISOString())).toBe(0);
    expect(await s.addShares(id, owner, [pal])).toEqual([pal]);
    expect(await s.addShares(id, owner, [pal])).toEqual([]);
    await expect(db.query("UPDATE document_analysis SET rating = 'green' WHERE id = $1", [id])).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM document_analysis_share WHERE analysis_id = $1", [id])).rejects.toThrow(/append-only/);
  });
});
