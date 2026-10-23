import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../src/server/auth/actor";
import { readAuthEnv } from "../src/server/auth/config";
import { buildAuthUrl, exchangeCode, pkceChallenge, readIdentity, type GoogleConfig } from "../src/server/auth/google";
import { SESSION_COOKIE, readCookie, signSession, verifySession } from "../src/server/auth/session";

const secret = "s".repeat(40);
const now = 1_800_000_000;
const payload = { uid: "11111111-1111-1111-1111-111111111111", ut: "owner" as const, exp: now + 100 };

describe("session", () => {
  it("round-trips a valid session", () => {
    expect(verifySession(signSession(payload, secret), secret, now)).toEqual(payload);
  });
  it("rejects expired, tampered, wrong-secret, malformed and short-secret sessions", () => {
    const t = signSession(payload, secret);
    expect(verifySession(t, secret, now + 100)).toBeNull();
    const [body, sig] = t.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...payload, uid: "other" })).toString("base64url");
    expect(verifySession(`${forged}.${sig}`, secret, now)).toBeNull();
    expect(verifySession(`${body}.x`, secret, now)).toBeNull();
    expect(verifySession(t, "t".repeat(40), now)).toBeNull();
    expect(verifySession("nodot", secret, now)).toBeNull();
    expect(verifySession(undefined, secret, now)).toBeNull();
    expect(verifySession(signSession(payload, "short"), "short", now)).toBeNull();
  });
  it("rejects a role that is not owner or agent", () => {
    const t = signSession({ ...payload, ut: "admin" as unknown as "owner" }, secret);
    expect(verifySession(t, secret, now)).toBeNull();
  });
});

describe("actorFromRequest", () => {
  const req = (cookie?: string) => new Request("http://x", cookie ? { headers: { cookie } } : {});
  it("returns the actor for a valid cookie and null otherwise", () => {
    const t = signSession(payload, secret);
    expect(actorFromRequest(req(`a=b; ${SESSION_COOKIE}=${t}`), secret, now)).toEqual({ userId: payload.uid, userType: "owner" });
    expect(actorFromRequest(req(), secret, now)).toBeNull();
    expect(actorFromRequest(req(`${SESSION_COOKIE}=junk`), secret, now)).toBeNull();
  });
  it("ignores the old dev headers", () => {
    const r = new Request("http://x", { headers: { "x-dev-user-id": "u1", "x-dev-user-type": "owner" } });
    expect(actorFromRequest(r, secret, now)).toBeNull();
  });
  it("reads cookies by exact name", () => {
    expect(readCookie(req("xol_session=1; ol_session=2"), "ol_session")).toBe("2");
  });
});

describe("google", () => {
  const cfg: GoogleConfig = { clientId: "cid", clientSecret: "sec", redirectUri: "https://app.test/api/auth/google/callback" };
  const claims = { iss: "https://accounts.google.com", aud: "cid", exp: now + 60, nonce: "n1", sub: "g-1", email: "a@b.co", email_verified: true, name: "Ann" };
  const expectOk = { clientId: "cid", nonce: "n1", nowSeconds: now };

  it("builds an auth URL with state, nonce and an S256 PKCE challenge, and never the secret", () => {
    const u = new URL(buildAuthUrl(cfg, { state: "st", nonce: "n1", verifier: "ver" }));
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("nonce")).toBe("n1");
    expect(u.searchParams.get("code_challenge")).toBe(pkceChallenge("ver"));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.toString()).not.toContain("sec");
  });
  it("accepts good claims", () => {
    expect(readIdentity(claims, expectOk)).toEqual({ sub: "g-1", email: "a@b.co", name: "Ann" });
  });
  it("rejects wrong issuer, audience, nonce, expiry, unverified email and missing subject", () => {
    for (const bad of [
      { iss: "https://evil.test" }, { aud: "other" }, { nonce: "n2" }, { exp: now - 1 },
      { email_verified: false }, { sub: "" }, { email: "" }
    ]) {
      expect(readIdentity({ ...claims, ...bad }, expectOk)).toBeNull();
    }
  });
  it("exchanges a code via the token endpoint and decodes the ID token", async () => {
    const idToken = `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
    let sent = "";
    const fakeFetch = (async (_u: unknown, init?: RequestInit) => {
      sent = String(init?.body);
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
    }) as typeof fetch;
    expect(await exchangeCode(cfg, "code1", "ver", fakeFetch)).toEqual(claims);
    expect(sent).toContain("code_verifier=ver");
    const failing = (async () => new Response("no", { status: 400 })) as typeof fetch;
    expect(await exchangeCode(cfg, "code1", "ver", failing)).toBeNull();
  });
});

describe("readAuthEnv", () => {
  const full = { SESSION_SECRET: secret, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", APP_URL: "https://app.test/" };
  it("builds config, derives the redirect URI and secure cookies from https", () => {
    const c = readAuthEnv(full);
    expect(c?.google.redirectUri).toBe("https://app.test/api/auth/google/callback");
    expect(c?.secureCookies).toBe(true);
    expect(readAuthEnv({ ...full, APP_URL: "http://localhost:3004" })?.secureCookies).toBe(false);
  });
  it("fails closed when anything is missing or the secret is short", () => {
    expect(readAuthEnv({ ...full, GOOGLE_CLIENT_ID: undefined })).toBeNull();
    expect(readAuthEnv({ ...full, SESSION_SECRET: "short" })).toBeNull();
    expect(readAuthEnv({})).toBeNull();
  });
});
