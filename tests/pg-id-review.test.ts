import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reviewId, submitId, type FileStore, type IdDeps } from "../src/domain/id-review-service";
import { appendAuditPg, type Queryable } from "../src/server/db";
import { getBuyerVerification } from "../src/server/enquiry-db";
import { createPgIdRepository, staffFor } from "../src/server/id-db";
import { upsertGoogleUser } from "../src/server/users";

const url = process.env["DATABASE_URL"];
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const OK = { documentLooksGenuine: true, photoMatchesSelfie: true, nameMatchesAccount: true, notExpired: true } as const;

describe.skipIf(!url)("Postgres ID review", () => {
  const pool = new pg.Pool({ connectionString: url });
  const db: Queryable = {
    async query(text, params) {
      const r = await pool.query(text, params);
      return { rows: r.rows as Record<string, unknown>[] };
    }
  };
  const blobs = new Map<string, Uint8Array>();
  const files: FileStore = { async put(k, b) { blobs.set(k, b); }, async get(k) { return blobs.get(k); }, async delete(k) { blobs.delete(k); } };
  let deps: IdDeps;
  let buyer = "", a = "", b = "", plain = "";

  beforeAll(async () => {
    const mk = async (tag: string) => {
      const sub = `${tag}-${Date.now()}`;
      return (await upsertGoogleUser(db, { sub, email: `${sub}@example.test`, name: tag }))!.id;
    };
    [buyer, a, b, plain] = [await mk("ib"), await mk("ia"), await mk("ic"), await mk("id")];
    await db.query("UPDATE app_user SET staff_role = 'compliance' WHERE id = ANY($1::uuid[])", [[a, b]]);
    deps = {
      ids: createPgIdRepository(db), files, staffFor: id => staffFor(db, id),
      appendAudit: e => appendAuditPg(db, e), now: () => new Date().toISOString(), newId: () => crypto.randomUUID()
    };
  });
  afterAll(async () => { await pool.end(); });

  const input = { documentKind: "passport", documentCountry: "NZ", expiryDate: "2035-01-01", front: JPEG, selfie: JPEG, selfieCapturedInApp: true } as const;

  it("takes two different reviewers for an overseas passport, then verifies the account", async () => {
    const sub = await submitId(deps, { userId: buyer, userType: "owner" }, input);
    expect(sub.ok).toBe(true);
    const id = sub.ok ? sub.value.id : "";
    expect(await submitId(deps, { userId: buyer, userType: "owner" }, input)).toMatchObject({ ok: false, code: "conflict" });
    expect(await reviewId(deps, { userId: plain, userType: "owner" }, id, "approve", OK)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await reviewId(deps, { userId: a, userType: "owner" }, id, "approve", OK)).toMatchObject({ ok: true, value: { status: "pending" } });
    expect((await getBuyerVerification(db, buyer)).idVerified).toBe(false);
    expect(await reviewId(deps, { userId: b, userType: "owner" }, id, "approve", OK)).toMatchObject({ ok: true, value: { status: "approved" } });
    expect((await getBuyerVerification(db, buyer)).idVerified).toBe(true);
    const decisions = await db.query("SELECT count(*) AS n FROM id_review_decision WHERE submission_id = $1", [id]);
    expect(Number(decisions.rows[0]?.["n"])).toBe(2);
  });

  it("the decision log cannot be edited", async () => {
    await expect(db.query("UPDATE id_review_decision SET outcome = 'reject'")).rejects.toThrow();
  });
});
