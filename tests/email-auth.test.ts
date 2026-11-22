import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { homeFor, normaliseEmail, passwordProblem, readSignup } from "../src/domain/email-auth";
import type { EmailPort } from "../src/adapters/email";
import { hashPassword, verifyPassword } from "../src/server/auth/password";
import { sessionFromRequestChecked } from "../src/server/auth/actor";
import { readAuthEnv, readSessionEnv } from "../src/server/auth/config";
import { SESSION_COOKIE, verifySession } from "../src/server/auth/session";
import type { Queryable } from "../src/server/db";
import { completePasswordReset, completeSignup, passwordSignIn, requestPasswordReset, startSignup, type EmailAuthDeps } from "../src/server/email-auth";
import { upsertGoogleUser } from "../src/server/users";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const state = vi.hoisted(() => ({ db: null as Queryable | null }));
vi.mock("../src/server/context", () => ({ getDb: () => state.db }));

import { POST as signupRoute } from "../app/api/auth/password/signup/route";
import { POST as verifyRoute } from "../app/api/auth/password/verify/route";
import { POST as loginRoute } from "../app/api/auth/password/login/route";

const SECRET = "s".repeat(40);
const PW = "correct horse battery";

describe("sign-up input", () => {
  const ok = { name: "  Ann   Owner ", email: " Ann@Example.COM ", password: PW, userType: "owner" };
  it("cleans the name and email and accepts buyer, owner and agent", () => {
    for (const t of ["buyer", "owner", "agent"]) {
      expect(readSignup({ ...ok, userType: t })).toEqual({ ok: true, value: { name: "Ann Owner", email: "ann@example.com", password: PW, userType: t, trade: null } });
    }
  });
  it("accepts a contractor only with a trade, and ignores a trade on any other type", () => {
    expect(readSignup({ ...ok, userType: "vendor", trade: "pest_control" })).toEqual({ ok: true, value: { name: "Ann Owner", email: "ann@example.com", password: PW, userType: "vendor", trade: "pest_control" } });
    for (const trade of [undefined, "", "plumber", "admin", 5]) expect(readSignup({ ...ok, userType: "vendor", trade }).ok).toBe(false);
    expect(readSignup({ ...ok, userType: "owner", trade: "photographer" })).toMatchObject({ ok: true, value: { userType: "owner", trade: null } });
    expect(homeFor("vendor")).toBe("/contractor/profile");
  });
  it("refuses staff and other types, bad emails, short or email-like passwords and odd names", () => {
    for (const t of ["admin", "staff", "project_owner", "investor", "", undefined]) expect(readSignup({ ...ok, userType: t }).ok).toBe(false);
    for (const e of ["", "no-at", "a@b", "a b@c.com", "x@y.com\nBcc: z@z.com"]) expect(readSignup({ ...ok, email: e }).ok).toBe(false);
    expect(readSignup({ ...ok, password: "short" }).ok).toBe(false);
    expect(readSignup({ ...ok, password: "x".repeat(129) }).ok).toBe(false);
    expect(readSignup({ ...ok, password: "ann@example.com" }).ok).toBe(false);
    for (const n of ["A", "<script>", "x".repeat(81)]) expect(readSignup({ ...ok, name: n }).ok).toBe(false);
    expect(readSignup(null).ok).toBe(false);
  });
  it("has the small helpers right", () => {
    expect(normaliseEmail("  X@Y.COM ")).toBe("x@y.com");
    expect(normaliseEmail(5)).toBeNull();
    expect(passwordProblem("0123456789")).toBeNull();
    expect(homeFor("buyer")).toBe("/buyer/saved-searches");
    expect(homeFor("owner")).toBe("/listings/new");
    expect(homeFor("agent")).toBe("/dashboard");
  });
});

describe("password hashing", () => {
  it("verifies the right password only, and fails closed on missing or malformed hashes", async () => {
    const h = await hashPassword(PW);
    expect(h).toMatch(/^scrypt\$15\$8\$3\$[\w-]+\$[\w-]+$/);
    expect(h).not.toContain(PW);
    expect(await verifyPassword(PW, h)).toBe(true);
    expect(await verifyPassword(`${PW}!`, h)).toBe(false);
    expect(await hashPassword(PW)).not.toBe(h);
    for (const bad of [null, undefined, "", "plain", "scrypt$1$1$1$a$b", h.replace("scrypt", "bcrypt"), "scrypt$30$8$3$AAAA$AAAA"]) {
      expect(await verifyPassword(PW, bad)).toBe(false);
    }
  });
});

describe("auth settings", () => {
  const base = { SESSION_SECRET: SECRET, APP_URL: "https://app.example.com/" };
  it("lets sessions (and email sign-in) work without Google keys, but never without a secret", () => {
    expect(readSessionEnv(base)).toEqual({ secret: SECRET, appUrl: "https://app.example.com", secureCookies: true });
    expect(readAuthEnv(base)).toBeNull();
    expect(readAuthEnv({ ...base, GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s" })?.google.redirectUri).toBe("https://app.example.com/api/auth/google/callback");
    expect(readSessionEnv({ ...base, SESSION_SECRET: "short" })).toBeNull();
    expect(readSessionEnv({ SESSION_SECRET: SECRET })).toBeNull();
  });
});

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("email sign-up, sign-in and reset on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.close(); });

  const sent: { to: string; subject: string; text: string }[] = [];
  const email: EmailPort = { configured: true, async send(m) { sent.push(m); return { status: "sent" }; } };
  const deps = (over: Partial<EmailAuthDeps> = {}): EmailAuthDeps => ({ db: t.db, email, secret: SECRET, appUrl: "https://app.example.com", brand: "OwnerListing", ...over });
  const linkIn = (text: string) => /https:\/\/app\.example\.com\/\S+token=([\w%-]+)/.exec(text)?.[1];
  let n = 0;
  const fresh = () => `person${++n}.${Date.now()}@example.com`;
  beforeEach(() => { sent.length = 0; });

  it("refuses an offensive or contact-detail display name and stores nothing", async () => {
    for (const name of ["Big Fucking Idiot", "Call 0412 345 678", "jo@example.com"]) {
      const addr = fresh();
      expect(await startSignup(deps(), { name, email: addr, password: PW, userType: "buyer" }, "1.1.1.3")).toMatchObject({ ok: false, code: "invalid" });
      expect((await t.db.query("SELECT 1 FROM email_auth_token WHERE email = $1", [addr])).rows).toHaveLength(0);
    }
    expect(sent).toHaveLength(0);
  });

  it("creates the account only when the emailed link is used, once", async () => {
    const addr = fresh();
    expect(await startSignup(deps(), { name: "Ann Agent", email: addr.toUpperCase(), password: PW, userType: "agent" }, "1.1.1.1")).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(addr);
    expect(sent[0]!.text).not.toContain(PW);
    expect((await t.db.query("SELECT 1 FROM app_user WHERE email = $1", [addr])).rows).toHaveLength(0);
    const stored = (await t.db.query("SELECT token_hash, password_hash FROM email_auth_token WHERE email = $1", [addr])).rows[0]!;
    const token = decodeURIComponent(linkIn(sent[0]!.text)!);
    expect(stored["token_hash"]).not.toContain(token);
    expect(String(stored["password_hash"])).toMatch(/^scrypt\$/);

    const r = await completeSignup(deps(), token);
    expect(r).toMatchObject({ ok: true, user: { userType: "agent" } });
    const row = (await t.db.query("SELECT display_name, user_type, status, google_sub FROM app_user WHERE email = $1", [addr])).rows[0];
    expect(row).toEqual({ display_name: "Ann Agent", user_type: "agent", status: "active", google_sub: null });
    expect(await completeSignup(deps(), token)).toMatchObject({ ok: false, code: "link_invalid" });
    expect(await completeSignup(deps(), "x".repeat(43))).toMatchObject({ ok: false, code: "link_invalid" });
  });

  it("tells the inbox of an existing account instead, and answers the caller the same way", async () => {
    const addr = fresh();
    await startSignup(deps(), { name: "First", email: addr, password: PW, userType: "buyer" }, "1.1.1.2");
    await completeSignup(deps(), decodeURIComponent(linkIn(sent[0]!.text)!));
    sent.length = 0;
    expect(await startSignup(deps(), { name: "Second", email: addr, password: "another password", userType: "owner" }, "1.1.1.2")).toEqual({ ok: true });
    expect(sent[0]!.text).toContain("already has one");
    expect(sent[0]!.text).not.toContain("token=");
    expect((await t.db.query("SELECT user_type FROM app_user WHERE email = $1", [addr])).rows).toEqual([{ user_type: "buyer" }]);
  });

  it("refuses an expired link and a second account for an address taken in the meantime", async () => {
    const addr = fresh();
    await startSignup(deps(), { name: "Late", email: addr, password: PW, userType: "owner" }, "1.1.1.3");
    const a = decodeURIComponent(linkIn(sent[0]!.text)!);
    expect(await completeSignup(deps({ now: () => new Date(Date.now() + 25 * 3600_000) }), a)).toMatchObject({ ok: false, code: "link_invalid" });
    await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1, 'Other', 'owner', 'active')", [addr]);
    expect(await completeSignup(deps(), a)).toMatchObject({ ok: false, code: "account_exists" });
  });

  it("fails closed when email cannot be sent, and hands the link to the console only when asked (local development)", async () => {
    const off: EmailPort = { configured: false, async send() { return { status: "not_configured" }; } };
    const body = { name: "Dev", email: fresh(), password: PW, userType: "buyer" };
    expect(await startSignup(deps({ email: off }), body, "1.1.1.4")).toMatchObject({ ok: false, code: "not_configured" });
    const links: string[] = [];
    expect(await startSignup(deps({ email: off, devLink: (_p, l) => links.push(l) }), body, "1.1.1.4")).toEqual({ ok: true });
    expect(links[0]).toMatch(/\/signup\/verify\?token=/);
  });

  it("signs in with the right password only, with one message for every failure", async () => {
    const addr = fresh();
    await startSignup(deps(), { name: "Bea", email: addr, password: PW, userType: "buyer" }, "2.2.2.1");
    const made = await completeSignup(deps(), decodeURIComponent(linkIn(sent[0]!.text)!));
    const ok = await passwordSignIn(deps(), { email: ` ${addr.toUpperCase()} `, password: PW }, "2.2.2.1");
    expect(ok).toEqual({ ok: true, user: made.ok ? made.user : null });
    const wrong = await passwordSignIn(deps(), { email: addr, password: "wrong password!" }, "2.2.2.1");
    const nobody = await passwordSignIn(deps(), { email: fresh(), password: PW }, "2.2.2.1");
    expect(wrong).toEqual(nobody);
    expect(wrong).toMatchObject({ ok: false, code: "bad_credentials", message: "Email or password is incorrect." });
    // Google-only, suspended and staff accounts have no password sign-in.
    const google = fresh();
    await t.db.query("INSERT INTO app_user (email, display_name, user_type, status, google_sub) VALUES ($1, 'G', 'owner', 'active', $2)", [google, `sub-${google}`]);
    expect(await passwordSignIn(deps(), { email: google, password: PW }, "2.2.2.1")).toMatchObject({ code: "bad_credentials" });
    const hash = await hashPassword(PW);
    for (const [type, status] of [["admin", "active"], ["project_owner", "active"], ["vendor", "suspended"], ["owner", "suspended"]]) {
      const e = fresh();
      await t.db.query("INSERT INTO app_user (email, display_name, user_type, status, password_hash) VALUES ($1, 'X', $2, $3, $4)", [e, type, status, hash]);
      expect(await passwordSignIn(deps(), { email: e, password: PW }, "2.2.2.1")).toMatchObject({ code: "bad_credentials" });
    }
  });

  it("limits guesses per address", async () => {
    const addr = fresh();
    const codes: string[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await passwordSignIn(deps(), { email: addr, password: "wrong password!" }, `3.3.3.${i}`);
      codes.push(r.ok ? "ok" : r.code);
    }
    expect(codes.slice(0, 8).every(c => c === "bad_credentials")).toBe(true);
    expect(codes[8]).toBe("rate_limited");
  });

  it("alerts the admins once when an address first goes over the limit, and at most once per window", async () => {
    const locked: string[] = [];
    const at = new Date("2031-03-03T03:01:00Z");
    const d = deps({ onLockout: e => locked.push(e), now: () => at });
    const [a, b] = [fresh(), fresh()];
    for (const addr of [a, b]) for (let i = 0; i < 11; i++) await passwordSignIn(d, { email: addr, password: "wrong password!" }, `7.7.${i}.1`);
    expect(locked).toEqual([a]);
  });

  it("resets the password with a one-time link and signs the account out everywhere", async () => {
    const addr = fresh();
    await startSignup(deps(), { name: "Reset Me", email: addr, password: PW, userType: "owner" }, "4.4.4.1");
    const made = await completeSignup(deps(), decodeURIComponent(linkIn(sent[0]!.text)!));
    if (!made.ok) throw new Error("sign-up failed");
    const issued = Math.floor(Date.now() / 1000) - 5;
    const { signSession, SESSION_TTL_SECONDS } = await import("../src/server/auth/session");
    const cookie = `${SESSION_COOKIE}=${signSession({ uid: made.user.id, ut: "owner", exp: issued + SESSION_TTL_SECONDS }, SECRET)}`;
    const req = () => new Request("http://x", { headers: { cookie } });
    expect(await sessionFromRequestChecked(t.db, req(), SECRET, issued + 1)).not.toBeNull();

    sent.length = 0;
    expect(await requestPasswordReset(deps(), { email: fresh() }, "4.4.4.1")).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
    expect(await requestPasswordReset(deps(), { email: addr }, "4.4.4.1")).toEqual({ ok: true });
    const token = decodeURIComponent(linkIn(sent[0]!.text)!);
    expect(await completePasswordReset(deps(), { token, password: "short" })).toMatchObject({ code: "invalid" });
    expect(await completePasswordReset(deps(), { token, password: addr })).toMatchObject({ code: "invalid" });
    expect(await completePasswordReset(deps(), { token, password: "a brand new password" })).toEqual({ ok: true });
    expect(await completePasswordReset(deps(), { token, password: "and another one" })).toMatchObject({ code: "link_invalid" });

    expect(await sessionFromRequestChecked(t.db, req(), SECRET, Math.floor(Date.now() / 1000) + 1)).toBeNull();
    expect(await passwordSignIn(deps(), { email: addr, password: PW }, "4.4.4.2")).toMatchObject({ code: "bad_credentials" });
    expect(await passwordSignIn(deps(), { email: addr, password: "a brand new password" }, "4.4.4.2")).toMatchObject({ ok: true });
  });

  it("links Google to an email account with the same address, keeping its type, and creates Google agents on request", async () => {
    const addr = fresh();
    await startSignup(deps(), { name: "Link Me", email: addr, password: PW, userType: "buyer" }, "5.5.5.1");
    const made = await completeSignup(deps(), decodeURIComponent(linkIn(sent[0]!.text)!));
    const g = await upsertGoogleUser(t.db, { sub: `sub-${addr}`, email: addr, name: "Link Me" }, "owner");
    expect(g).toEqual(made.ok ? made.user : null);
    expect((await t.db.query("SELECT google_sub FROM app_user WHERE email = $1", [addr])).rows[0]!["google_sub"]).toBe(`sub-${addr}`);
    expect(await upsertGoogleUser(t.db, { sub: `sub-${addr}`, email: addr, name: "Link Me" }, "agent")).toEqual(g);

    // An account that already has another Google identity, or a staff account, is never taken over.
    expect(await upsertGoogleUser(t.db, { sub: `other-${addr}`, email: addr, name: "Intruder" }, "owner")).toBeNull();
    const staff = fresh();
    await t.db.query("INSERT INTO app_user (email, display_name, user_type, status, password_hash) VALUES ($1, 'S', 'admin', 'active', 'x')", [staff]);
    expect(await upsertGoogleUser(t.db, { sub: `sub-${staff}`, email: staff, name: "S" }, "owner")).toBeNull();

    const agent = fresh();
    expect(await upsertGoogleUser(t.db, { sub: `sub-${agent}`, email: agent, name: "Agent" }, "agent")).toMatchObject({ userType: "agent" });
  });

  describe("routes", () => {
    beforeEach(() => {
      state.db = t.db;
      process.env["SESSION_SECRET"] = SECRET;
      process.env["APP_URL"] = "http://localhost:3004";
      delete process.env["SMTP_HOST"];
    });
    const post = (route: (r: Request) => Promise<Response>, body: unknown, origin = "http://localhost:3004") =>
      route(new Request("http://localhost:3004/api/x", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));

    it("signs up through the console link locally, then owners go to the second step and buyers straight in", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      for (const [userType, expected] of [["owner", "/mfa?next=%2Flistings%2Fnew"], ["buyer", "/buyer/saved-searches"]] as const) {
        warn.mockClear();
        const addr = fresh();
        const s = await post(signupRoute, { name: "Route Test", email: addr, password: PW, userType });
        expect(s.status).toBe(202);
        const link = String(warn.mock.calls.find(c => String(c[0]).includes("signup link"))?.[0]);
        const token = decodeURIComponent(/token=([\w%-]+)/.exec(link)![1]!);
        const v = await post(verifyRoute, { token });
        expect(v.status).toBe(200);
        expect(((await v.json()) as { redirect: string }).redirect).toBe(expected);
        const session = /ol_session=([^;]*)/.exec(v.headers.get("set-cookie") ?? "")?.[1];
        expect(verifySession(session, SECRET, Math.floor(Date.now() / 1000))?.ut).toBe(userType);
        expect(verifySession(session, SECRET, Math.floor(Date.now() / 1000))?.mfa).toBeUndefined();

        const l = await post(loginRoute, { email: addr, password: PW, next: "/settings" });
        expect(((await l.json()) as { redirect: string }).redirect).toBe(userType === "owner" ? "/mfa?next=%2Fsettings" : "/settings");
        const bad = await post(loginRoute, { email: addr, password: "nope nope nope" });
        expect(bad.status).toBe(401);
        expect(bad.headers.get("set-cookie")).toBeNull();
      }
      warn.mockRestore();
    });

    it("drops an off-site return path and refuses a cross-site request", async () => {
      expect((await post(loginRoute, { email: "a@b.com", password: PW }, "https://evil.example")).status).toBe(403);
      expect((await post(signupRoute, { name: "X Y", email: fresh(), password: PW, userType: "owner" }, "https://evil.example")).status).toBe(403);
    });
  });
});
