import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorFromRequestChecked, sessionFromRequestChecked } from "../src/server/auth/actor";
import { SESSION_COOKIE, signSession } from "../src/server/auth/session";
import { findMfaResetTarget, resetUserMfa } from "../src/server/mfa-reset-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("staff MFA reset on Postgres", () => {
  let t: TestDb;
  const SECRET = "s".repeat(40);
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.close(); });

  const enrol = async (userId: string) => {
    await t.db.query("INSERT INTO mfa_factor (user_id, kind, phone_e164, confirmed_at) VALUES ($1, 'sms', '+61400000123', now() - interval '1 day')", [userId]);
    await t.db.query("INSERT INTO mfa_factor (user_id, kind, secret_sealed) VALUES ($1, 'totp', 'v1.sealed')", [userId]);
    await t.db.query("INSERT INTO mfa_recovery_code (user_id, code_hash) SELECT $1, md5(random()::text) || md5(random()::text) FROM generate_series(1, 10)", [userId]);
    const f = (await t.db.query("SELECT id FROM mfa_factor WHERE user_id = $1 AND kind = 'sms'", [userId])).rows[0]!["id"];
    await t.db.query("INSERT INTO mfa_sms_code (user_id, factor_id, code_hash, expires_at) VALUES ($1, $2, $3, now() + interval '5 minutes')", [userId, f, "0".repeat(64)]);
  };
  const emailOf = async (id: string) => String((await t.db.query("SELECT email::text AS e FROM app_user WHERE id = $1", [id])).rows[0]!["e"]);
  const reqAt = (uid: string, mfa: number) =>
    new Request("http://x", { headers: { cookie: `${SESSION_COOKIE}=${signSession({ uid, ut: "owner", exp: 4_000_000_000, mfa }, SECRET)}` } });

  it("shows methods with a masked phone, then resets everything in one go and signs the user out everywhere", async () => {
    const admin = await addUser(t.db, "admin");
    const owner = await addUser(t.db, "owner");
    await enrol(owner);
    const view = await findMfaResetTarget(t.db, { email: (await emailOf(owner)).toUpperCase() });
    expect(view).toMatchObject({ id: owner, userType: "owner", liveMethods: 2, recoveryCodesLeft: 10, resets: [] });
    expect(view!.methods.map(m => m.label)).toEqual(["Text message to •••• 123"]);
    expect(JSON.stringify(view)).not.toContain("+61400000123");

    const now = Math.floor(Date.now() / 1000);
    const before = reqAt(owner, now - 60);
    expect(await actorFromRequestChecked(t.db, before, SECRET, now)).not.toBeNull();

    expect(await resetUserMfa(t.db, admin, owner, "Lost phone, identity checked")).toMatchObject({ methodsRevoked: 2 });
    const live = await t.db.query("SELECT count(*)::int AS n FROM mfa_factor WHERE user_id = $1 AND revoked_at IS NULL", [owner]);
    expect(live.rows[0]!["n"]).toBe(0);
    const codes = await t.db.query("SELECT count(*)::int AS n FROM mfa_recovery_code WHERE user_id = $1 AND retired_at IS NULL", [owner]);
    expect(codes.rows[0]!["n"]).toBe(0);
    const sms = await t.db.query("SELECT count(*)::int AS n FROM mfa_sms_code WHERE user_id = $1 AND consumed_at IS NULL", [owner]);
    expect(sms.rows[0]!["n"]).toBe(0);
    const ev = await t.db.query("SELECT event FROM mfa_event_log WHERE user_id = $1", [owner]);
    expect(ev.rows.map(r => r["event"])).toEqual(["staff_reset"]);

    // The old session no longer counts; signing in again lands on set-up (required, not enrolled).
    const later = Math.floor(Date.now() / 1000) + 1;
    expect(await actorFromRequestChecked(t.db, before, SECRET, later)).toBeNull();
    const fresh = await sessionFromRequestChecked(t.db, new Request("http://x", { headers: { cookie: `${SESSION_COOKIE}=${signSession({ uid: owner, ut: "owner", exp: 4_000_000_000 }, SECRET)}` } }), SECRET, later);
    expect(fresh?.mfa).toEqual({ required: true, enrolled: false, satisfied: false });

    const after = await findMfaResetTarget(t.db, { id: owner });
    expect(after).toMatchObject({ liveMethods: 0, methods: [], recoveryCodesLeft: 0 });
    expect(after!.resets).toEqual([expect.objectContaining({ reason: "Lost phone, identity checked", methodsRevoked: 2, resetBy: await emailOf(admin) })]);
  });

  it("a second reset finds nothing to revoke; the log is append-only and needs a real reason and a different person", async () => {
    const admin = await addUser(t.db, "admin");
    const owner = await addUser(t.db, "owner");
    await enrol(owner);
    const [a, b] = await Promise.all([resetUserMfa(t.db, admin, owner, "Lost phone, first desk"), resetUserMfa(t.db, admin, owner, "Lost phone, second desk")]);
    expect([a, b].filter(x => x !== null)).toHaveLength(1);
    expect(await resetUserMfa(t.db, admin, owner, "Lost phone again later")).toBeNull();
    const n = await t.db.query("SELECT count(*)::int AS n FROM mfa_reset_log WHERE user_id = $1", [owner]);
    expect(n.rows[0]!["n"]).toBe(1);
    await expect(t.db.query("UPDATE mfa_reset_log SET reason = 'changed reason here' WHERE user_id = $1", [owner])).rejects.toThrow();
    await expect(t.db.query("DELETE FROM mfa_reset_log WHERE user_id = $1", [owner])).rejects.toThrow();
    await expect(t.db.query("INSERT INTO mfa_reset_log (user_id, reset_by, reason, methods_revoked) VALUES ($1, $2, 'short', 1)", [owner, admin])).rejects.toThrow();
    await expect(t.db.query("INSERT INTO mfa_reset_log (user_id, reset_by, reason, methods_revoked) VALUES ($1, $1, 'reset my own sign-in', 1)", [owner])).rejects.toThrow();
  });
});
