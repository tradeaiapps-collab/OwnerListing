import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorFromRequestChecked, sessionFromRequestChecked } from "../src/server/auth/actor";
import { createMobileSession, markMobileMfaPassed, refreshMobileSession, signOutMobileSession } from "../src/server/auth/mobile-session-db";
import { SESSION_COOKIE, signSession } from "../src/server/auth/session";
import { activeTargetsPg, registerDevicePg } from "../src/server/push-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const secret = "m".repeat(40);
const DAY = 24 * 60 * 60;
const nowS = () => Math.floor(Date.now() / 1000);
const bearer = (token: string, cookie?: string) => new Request("http://x", { headers: { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) } });

describe.skipIf(!DATABASE_URL)("phone app sessions (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  const start = async (type: "buyer" | "owner" | "agent" = "buyer") => {
    const id = await addUser(db, type);
    const tokens = await createMobileSession(db, { id, userType: type }, { label: "John's iPhone", platform: "ios" }, secret, nowS());
    return { id, tokens };
  };

  it("signs a buyer in with the bearer token and stores no refresh secret", async () => {
    const { id, tokens } = await start();
    expect(await actorFromRequestChecked(db, bearer(tokens.accessToken), secret, nowS())).toEqual({ userId: id, userType: "buyer" });
    const row = (await db.query("SELECT refresh_hash, device_label, platform FROM mobile_session WHERE id = $1", [tokens.sessionId])).rows[0]!;
    expect(tokens.refreshToken).not.toContain(String(row["refresh_hash"]));
    expect(row).toMatchObject({ device_label: "John's iPhone", platform: "ios" });
  });

  it("ignores the cookie when a bearer token is sent", async () => {
    const { id } = await start();
    const cookie = `${SESSION_COOKIE}=${signSession({ uid: id, ut: "buyer", exp: nowS() + 600 }, secret)}`;
    expect(await actorFromRequestChecked(db, bearer("olm1.forged.token", cookie), secret, nowS())).toBeNull();
  });

  it("holds an owner at the second step until this phone passes it", async () => {
    const { id, tokens } = await start("owner");
    const req = bearer(tokens.accessToken);
    expect(await actorFromRequestChecked(db, req, secret, nowS())).toBeNull();
    const s = await sessionFromRequestChecked(db, req, secret, nowS());
    expect(s?.mfa).toEqual({ required: true, enrolled: false, satisfied: false });
    expect(s?.payload.sid).toBe(tokens.sessionId);
    expect(await markMobileMfaPassed(db, tokens.sessionId, "33333333-3333-4333-8333-333333333333")).toBe(false); // someone else's session
    expect(await markMobileMfaPassed(db, tokens.sessionId, id)).toBe(true);
    expect(await actorFromRequestChecked(db, req, secret, nowS())).toEqual({ userId: id, userType: "owner" });
  });

  it("rotates the refresh token and revokes the session when an old one comes back", async () => {
    const { id, tokens } = await start();
    const r1 = await refreshMobileSession(db, tokens.refreshToken, secret, nowS());
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.tokens.refreshToken).not.toBe(tokens.refreshToken);
    expect(await actorFromRequestChecked(db, bearer(r1.tokens.accessToken), secret, nowS())).toEqual({ userId: id, userType: "buyer" });
    expect(await refreshMobileSession(db, tokens.refreshToken, secret, nowS())).toEqual({ ok: false, reason: "reuse" });
    expect(await refreshMobileSession(db, r1.tokens.refreshToken, secret, nowS())).toEqual({ ok: false, reason: "invalid" });
    expect(await actorFromRequestChecked(db, bearer(r1.tokens.accessToken), secret, nowS())).toBeNull();
  });

  it("refuses unknown, malformed and guessed refresh tokens", async () => {
    const { tokens } = await start();
    expect((await refreshMobileSession(db, "junk", secret, nowS())).ok).toBe(false);
    const guessed = `${tokens.refreshToken.slice(0, -1)}${tokens.refreshToken.endsWith("A") ? "B" : "A"}`;
    expect(await refreshMobileSession(db, guessed, secret, nowS())).toEqual({ ok: false, reason: "invalid" });
    expect((await refreshMobileSession(db, tokens.refreshToken, secret, nowS())).ok).toBe(true);
  });

  it("ends the session after 30 idle days", async () => {
    const { tokens } = await start();
    expect(await refreshMobileSession(db, tokens.refreshToken, secret, nowS() + 31 * DAY)).toEqual({ ok: false, reason: "expired" });
  });

  it("signs the phone out", async () => {
    const { id, tokens } = await start();
    await signOutMobileSession(db, tokens.sessionId, id);
    expect(await actorFromRequestChecked(db, bearer(tokens.accessToken), secret, nowS())).toBeNull();
    expect(await refreshMobileSession(db, tokens.refreshToken, secret, nowS())).toEqual({ ok: false, reason: "invalid" });
  });

  it("ends the session when the account is suspended or the password is reset", async () => {
    const a = await start();
    await db.query("UPDATE app_user SET status = 'suspended' WHERE id = $1", [a.id]);
    expect(await actorFromRequestChecked(db, bearer(a.tokens.accessToken), secret, nowS())).toBeNull();
    expect(await refreshMobileSession(db, a.tokens.refreshToken, secret, nowS())).toEqual({ ok: false, reason: "account" });

    const b = await start();
    await db.query("UPDATE app_user SET password_changed_at = now() + interval '1 second' WHERE id = $1", [b.id]);
    expect(await actorFromRequestChecked(db, bearer(b.tokens.accessToken), secret, nowS())).toBeNull();
    expect(await refreshMobileSession(db, b.tokens.refreshToken, secret, nowS())).toEqual({ ok: false, reason: "account" });
  });

  it("revokes the session when any older refresh token comes back, not only the last one", async () => {
    const { tokens } = await start();
    const r1 = await refreshMobileSession(db, tokens.refreshToken, secret, nowS());
    if (!r1.ok) throw new Error("refresh 1");
    const r2 = await refreshMobileSession(db, r1.tokens.refreshToken, secret, nowS());
    if (!r2.ok) throw new Error("refresh 2");
    expect(await refreshMobileSession(db, tokens.refreshToken, secret, nowS())).toEqual({ ok: false, reason: "reuse" });
    expect(await refreshMobileSession(db, r2.tokens.refreshToken, secret, nowS())).toEqual({ ok: false, reason: "invalid" });
  });

  it("stops pushing to a phone once its session ends", async () => {
    const phone = (n: string) => ({ platform: "android" as const, token: `fcm-token-${"m".repeat(30)}${n}`, p256dh: null, authSecret: null, label: null });
    const a = await start();
    const dev = await registerDevicePg(db, a.id, phone("a"), a.tokens.sessionId);
    expect((await activeTargetsPg(db, a.id)).map(t => t.id)).toEqual([dev]);
    await signOutMobileSession(db, a.tokens.sessionId, a.id);
    expect(await activeTargetsPg(db, a.id)).toEqual([]);

    const b = await start();
    const devB = await registerDevicePg(db, b.id, phone("b"), b.tokens.sessionId);
    expect((await activeTargetsPg(db, b.id)).map(t => t.id)).toEqual([devB]);
    await db.query("UPDATE app_user SET password_changed_at = now() + interval '1 second' WHERE id = $1", [b.id]);
    expect(await activeTargetsPg(db, b.id)).toEqual([]);
  });
});
