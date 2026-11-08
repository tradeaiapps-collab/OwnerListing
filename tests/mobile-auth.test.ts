import { describe, expect, it } from "vitest";
import { ACCESS_PREFIX, mobileBearer, newRefreshToken, parseRefreshToken, signMobileAccess, verifyMobileAccess, hashRefreshSecret, sameHash } from "../src/server/auth/mobile-token";
import { signSession, verifySession } from "../src/server/auth/session";
import { csrfGuard } from "../src/server/csrf";
import { mobileLogin, mobileRefresh } from "../src/server/mobile-auth";

const secret = "s".repeat(40);
const now = 1_800_000_000;
const sid = "22222222-2222-4222-8222-222222222222";
const uid = "11111111-1111-4111-8111-111111111111";
const access = (exp = now + 900, s = secret) => signMobileAccess({ uid, ut: "buyer", sid, exp }, s);

describe("phone access tokens", () => {
  it("round-trips a signed token and refuses a wrong key, expiry or tampering", () => {
    expect(verifyMobileAccess(access(), secret, now)).toEqual({ uid, ut: "buyer", sid, exp: now + 900 });
    expect(verifyMobileAccess(access(), "t".repeat(40), now)).toBeNull();
    expect(verifyMobileAccess(access(now), secret, now)).toBeNull();
    const [body, sig] = access().slice(ACCESS_PREFIX.length).split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ uid, ut: "owner", sid, exp: now + 900 })).toString("base64url");
    expect(verifyMobileAccess(`${ACCESS_PREFIX}${forged}.${sig}`, secret, now)).toBeNull();
    expect(verifyMobileAccess(`${ACCESS_PREFIX}${body}.${sig}x`, secret, now)).toBeNull();
    expect(verifyMobileAccess(undefined, secret, now)).toBeNull();
    expect(verifyMobileAccess(access(), "short", now)).toBeNull();
  });

  it("never accepts a web cookie as a bearer token, or a bearer token as a cookie", () => {
    const cookie = signSession({ uid, ut: "buyer", exp: now + 900 }, secret);
    expect(verifyMobileAccess(`${ACCESS_PREFIX}${cookie}`, secret, now)).toBeNull();
    expect(verifySession(access().slice(ACCESS_PREFIX.length), secret, now)).toBeNull();
  });

  it("reads only phone tokens from the Authorization header", () => {
    const req = (h?: string) => new Request("http://x", h ? { headers: { authorization: h } } : {});
    expect(mobileBearer(req(`Bearer ${access()}`))).toBe(access());
    expect(mobileBearer(req("Bearer olk_someapikeytoken.abc"))).toBeUndefined();
    expect(mobileBearer(req(`Basic ${access()}`))).toBeUndefined();
    expect(mobileBearer(req())).toBeUndefined();
  });
});

describe("refresh tokens", () => {
  it("parses its own tokens and stores only a hash", () => {
    const t = newRefreshToken(sid);
    const p = parseRefreshToken(t.token);
    expect(p?.sessionId).toBe(sid);
    expect(sameHash(t.hash, hashRefreshSecret(p!.secret))).toBe(true);
    expect(t.token).not.toContain(t.hash);
  });
  it.each([undefined, 42, "", "olr1_", `olr1_${sid}`, `olr1_${sid}_short`, `olr1_not-a-uuid-at-all-not-a-uuid-at-a_${"a".repeat(43)}`, `xxx1_${sid}_${"a".repeat(43)}`, `olr1_${sid}_${"a".repeat(43)}!`])(
    "rejects a malformed token %#", t => expect(parseRefreshToken(t)).toBeNull());
  it("compares hashes safely whatever their length", () => {
    expect(sameHash(null, "ab")).toBe(false);
    expect(sameHash("abc", "ab")).toBe(false);
  });
});

describe("csrfGuard with the phone app", () => {
  process.env["APP_URL"] = "http://test";
  process.env["SESSION_SECRET"] = secret;
  const post = (headers: Record<string, string>) => new Request("http://test/api/x", { method: "POST", headers, body: "{}" });
  const live = () => signMobileAccess({ uid, ut: "buyer", sid, exp: Math.floor(Date.now() / 1000) + 600 }, secret);

  it("lets a signed phone token through without an Origin", () => {
    expect(csrfGuard(post({ authorization: `Bearer ${live()}`, "content-type": "application/json" }))).toBeNull();
  });
  it("still checks the origin for a forged or expired token", async () => {
    expect(csrfGuard(post({ authorization: `Bearer ${ACCESS_PREFIX}abc.def`, "content-type": "application/json" }))?.status).toBe(403);
    const old = signMobileAccess({ uid, ut: "buyer", sid, exp: Math.floor(Date.now() / 1000) - 1 }, secret);
    expect(csrfGuard(post({ authorization: `Bearer ${old}`, "content-type": "application/json" }))?.status).toBe(403);
  });
  it("still requires JSON from the phone", () => {
    expect(csrfGuard(post({ authorization: `Bearer ${live()}`, "content-type": "text/plain" }))?.status).toBe(403);
  });
});

describe("phone sign-in routes", () => {
  it.each([["login", mobileLogin], ["refresh", mobileRefresh]] as const)("%s refuses anything but JSON (no cross-site form posts)", async (_n, fn) => {
    const res = await fn(new Request("http://test/api/mobile/auth/x", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }));
    expect(res.status).toBe(415);
  });
});
