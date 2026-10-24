import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ID_CLAIM_TTL_MS, ID_IMAGE_CONSENT_VERSION } from "../src/domain/id-image";
import { reviewSubmission } from "../src/domain/id-verification";
import { claimIdSubmission, runIdImageRetention, submitIdImages, viewIdImage, type IdImageDeps } from "../src/server/id-image";
import { createPgIdImageStore } from "../src/server/id-image-db";
import { getIdSubmission, saveIdReview } from "../src/server/staff-admin-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";
import { KEY, RETENTION_SECRET, jpegWithExif, memStorage, scanner } from "./helpers/id-image-fakes";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("ID images on Postgres", () => {
  let t: TestDb;
  let d: IdImageDeps;
  let storage: ReturnType<typeof memStorage>;
  let buyer: string, rev1: string, rev2: string;
  const fields = { consent: "true", consentVersion: ID_IMAGE_CONSENT_VERSION, documentKind: "drivers_licence", documentCountry: "AU", expiryDate: "2030-01-01", selfieSource: "camera" };
  const files = () => ({ front: jpegWithExif(), back: jpegWithExif(), selfie: jpegWithExif() });

  beforeAll(async () => {
    t = await createTestDb();
    buyer = await addUser(t.db, "buyer");
    rev1 = await addUser(t.db, "admin");
    rev2 = await addUser(t.db, "admin");
    await t.db.query("UPDATE app_user SET staff_role = 'compliance' WHERE id = ANY($1::uuid[])", [[rev1, rev2]]);
    await t.db.query("INSERT INTO buyer_verification (user_id, email_verified_at, phone_verified_at) VALUES ($1, now(), now())", [buyer]);
    storage = memStorage();
    d = { store: createPgIdImageStore(t.db), storage: storage.port, scanner: scanner(), key: KEY, retentionSecret: RETENTION_SECRET };
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  let id: string;
  it("stores a pending submission with keys, hashes and types; a second one is refused (one pending per buyer)", async () => {
    expect((await submitIdImages(d, buyer, "203.0.113.9", async () => ({ fields, files: files() }))).ok).toBe(true);
    const r = (await t.db.query("SELECT * FROM id_submission WHERE user_id = $1", [buyer])).rows;
    expect(r).toHaveLength(1);
    id = String(r[0]!["id"]);
    expect(r[0]).toMatchObject({ status: "pending", front_mime: "image/jpeg", consent_version: ID_IMAGE_CONSENT_VERSION });
    expect(String(r[0]!["front_image_key"])).toMatch(/^id\/[0-9a-f]{32}\/[0-9a-f]{32}$/);
    expect(await submitIdImages(d, buyer, "203.0.113.9", async () => ({ fields, files: files() }))).toMatchObject({ ok: false, code: "conflict" });
    const forced = await d.store.insertSubmission({ id: "c0000000-0000-4000-8000-0000000000ff", userId: buyer, documentKind: "passport", documentCountry: "AU", expiryDate: "2030-01-01", selfieCapturedInApp: true, consentVersion: "v", images: {} });
    expect(forced).toBe(false);
    expect((await t.db.query("SELECT count(*)::int AS n FROM id_image_consent WHERE user_id = $1", [buyer])).rows[0]!["n"]).toBe(1);
  });
  it("claim is exclusive and own-check is refused in SQL; every view is audited in id_review_access", async () => {
    expect(await d.store.claim(id, buyer, ID_CLAIM_TTL_MS)).toBe(false);
    expect((await claimIdSubmission(d, rev1, id, ID_CLAIM_TTL_MS)).ok).toBe(true);
    expect(await d.store.claim(id, rev2, ID_CLAIM_TTL_MS)).toBe(false);
    expect((await viewIdImage(d, rev2, id, "front")).ok).toBe(false);
    expect((await viewIdImage(d, rev1, id, "front")).ok).toBe(true);
    const views = (await t.db.query("SELECT staff_user_id, purpose FROM id_review_access WHERE submission_id = $1", [id])).rows;
    expect(views).toEqual(expect.arrayContaining([{ staff_user_id: rev1, purpose: "view:front" }, { staff_user_id: rev1, purpose: "shown:front" }]));
    expect(views).toHaveLength(2);
    expect((await d.store.viewedParts(id, rev1, new Date(Date.now() - 60_000).toISOString()))).toEqual(["front"]);
  });
  it("approval marks the buyer verified with the manual method and ends the claim", async () => {
    const before = (await getIdSubmission(t.db, id))!;
    const ticks = { documentLooksGenuine: true, photoMatchesSelfie: true, nameMatchesAccount: true, notExpired: true, officialStatusCheck: "done" as const };
    const after = reviewSubmission(before, { id: rev1, role: "compliance" }, "approve", ticks, new Date().toISOString());
    const asRev2 = reviewSubmission(before, { id: rev2, role: "compliance" }, "approve", ticks, new Date().toISOString());
    const rejectByRev2 = reviewSubmission(before, { id: rev2, role: "compliance" }, "reject", ticks, new Date().toISOString());
    // Re-checked at write time: no approval without the live claim, no decision on a check someone else holds.
    expect(await saveIdReview(t.db, before, asRev2, { staffId: rev2, claimTtlMs: ID_CLAIM_TTL_MS })).toBe(false);
    expect(await saveIdReview(t.db, before, rejectByRev2, { staffId: rev2, claimTtlMs: ID_CLAIM_TTL_MS })).toBe(false);
    await t.db.query("UPDATE id_submission SET assigned_at = now() - interval '31 minutes' WHERE id = $1", [id]);
    expect(await saveIdReview(t.db, before, after, { staffId: rev1, claimTtlMs: ID_CLAIM_TTL_MS })).toBe(false);
    await t.db.query("UPDATE id_submission SET assigned_at = now() WHERE id = $1", [id]);
    expect(await saveIdReview(t.db, before, after, { staffId: rev1, claimTtlMs: ID_CLAIM_TTL_MS })).toBe(true);
    const v = (await t.db.query("SELECT id_verified_at IS NOT NULL AS ok, id_method FROM buyer_verification WHERE user_id = $1", [buyer])).rows[0];
    expect(v).toEqual({ ok: true, id_method: "manual_review" });
    expect((await t.db.query("SELECT assigned_reviewer FROM id_submission WHERE id = $1", [id])).rows[0]).toEqual({ assigned_reviewer: null });
  });
  it("retention deletes images after 7 days, clears keys and hashes, and the logs cannot be changed", async () => {
    expect(await runIdImageRetention(d, new Date().toISOString())).toEqual({ deleted: 0, failed: 0 });
    await t.db.query("UPDATE id_submission SET decided_at = now() - interval '8 days' WHERE id = $1", [id]);
    expect(await runIdImageRetention(d, new Date().toISOString())).toEqual({ deleted: 1, failed: 0 });
    expect(storage.objects.size).toBe(0);
    const r = (await t.db.query("SELECT front_image_key, back_image_key, selfie_key, front_sha256, images_deleted_at IS NOT NULL AS gone FROM id_submission WHERE id = $1", [id])).rows[0];
    expect(r).toEqual({ front_image_key: null, back_image_key: null, selfie_key: null, front_sha256: null, gone: true });
    await expect(t.db.query("UPDATE id_submission SET front_image_key = 'id/a/b' WHERE id = $1", [id])).rejects.toThrow();
    await expect(t.db.query("UPDATE id_submission_log SET event = 'claimed'")).rejects.toThrow();
    await expect(t.db.query("DELETE FROM id_image_consent")).rejects.toThrow();
    const events = (await t.db.query("SELECT event FROM id_submission_log WHERE submission_id = $1 ORDER BY occurred_at", [id])).rows.map(x => x["event"]);
    expect(events).toEqual(["submitted", "claimed", "images_deleted"]);
    expect(await runIdImageRetention(d, new Date().toISOString())).toEqual({ deleted: 0, failed: 0 });
  });
});
