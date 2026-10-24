import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confirmPhoneVerification, startPhoneVerification, type PhoneDeps } from "../src/domain/phone-verification";
import { appendAuditPg, type Queryable } from "../src/server/db";
import { getBuyerVerification } from "../src/server/enquiry-db";
import { createPgPhoneRepository, hashCodeWith } from "../src/server/phone-db";
import { upsertGoogleUser } from "../src/server/users";

const url = process.env["DATABASE_URL"];

describe.skipIf(!url)("Postgres phone verification", () => {
  const pool = new pg.Pool({ connectionString: url });
  const db: Queryable = {
    async query(text, params) {
      const r = await pool.query(text, params);
      return { rows: r.rows as Record<string, unknown>[] };
    }
  };
  let deps: PhoneDeps;
  let a = "";
  let b = "";
  const phone = `04${String(Date.now()).slice(-8)}`;

  beforeAll(async () => {
    const mk = async (tag: string) => {
      const sub = `${tag}-${Date.now()}`;
      return (await upsertGoogleUser(db, { sub, email: `${sub}@example.test`, name: tag }))!.id;
    };
    a = await mk("pa");
    b = await mk("pb");
    deps = {
      phones: createPgPhoneRepository(db),
      sms: { async send() {} },
      hashCode: hashCodeWith("test-secret-test-secret-test-secret"),
      newCode: () => "654321",
      appendAudit: e => appendAuditPg(db, e),
      now: () => new Date().toISOString(),
      newId: () => crypto.randomUUID()
    };
  });
  afterAll(async () => { await pool.end(); });

  it("verifies a number, stores only a hash of the code, and flags the account", async () => {
    const actor = { userId: a, userType: "owner" as const };
    expect((await startPhoneVerification(deps, actor, phone)).ok).toBe(true);
    const stored = await db.query("SELECT code_hash FROM phone_challenge WHERE user_id = $1", [a]);
    expect(String(stored.rows[0]?.["code_hash"])).not.toContain("654321");
    expect(await confirmPhoneVerification(deps, actor, "111111")).toMatchObject({ ok: false, code: "invalid" });
    expect((await confirmPhoneVerification(deps, actor, "654321")).ok).toBe(true);
    expect((await getBuyerVerification(db, a)).phoneVerified).toBe(true);
  });

  it("does not let a second account verify the same number", async () => {
    const other = { userId: b, userType: "owner" as const };
    // Sends are limited per number, so the first account's send above still counts; one more is allowed.
    expect((await startPhoneVerification(deps, other, phone)).ok).toBe(true);
    expect(await confirmPhoneVerification(deps, other, "654321")).toMatchObject({ ok: false, code: "conflict" });
    expect((await getBuyerVerification(db, b)).phoneVerified).toBe(false);
  });
});
