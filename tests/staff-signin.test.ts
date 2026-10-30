import { beforeEach, describe, expect, it, vi } from "vitest";
import { signSession, verifySession } from "../src/server/auth/session";
import { signStaffSession, verifyStaffSession } from "../src/server/auth/staff-session";
import type { Queryable } from "../src/server/db";
import { staffFromRequest, staffSignIn } from "../src/server/staff-auth";

const state = vi.hoisted(() => ({ db: null as Queryable | null }));

vi.mock("../src/server/context", () => ({
  getActor: () => null,
  getDeps: () => null,
  getDb: () => state.db,
  getStaff: async () => null
}));

vi.mock("../src/server/auth/google", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/auth/google")>()),
  exchangeCode: async () => ({}),
  readIdentity: () => ({ sub: "google-sub-s", email: "staff@example.com", name: "Sam Staff" })
}));

import { GET as callbackGet } from "../app/api/auth/google/callback/route";
import { GET as startGet } from "../app/api/auth/google/start/route";
import { POST as logoutPost } from "../app/api/auth/logout/route";

const secret = "s".repeat(40);
const now = 1_800_000_000;
const who = { sub: "google-sub-s", email: "staff@example.com", name: "Sam Staff" };

interface Call { text: string; params: unknown[] }
/** Fake database: answers each statement by a matcher on its text, and records every call. */
function fakeDb(answer: (text: string, params: unknown[]) => Record<string, unknown>[]) {
  const calls: Call[] = [];
  const db: Queryable = {
    async query(text, params) {
      calls.push({ text, params: params ?? [] });
      return { rows: answer(text, params ?? []) };
    }
  };
  return { db, calls };
}
const audits = (calls: Call[]) => calls.filter(c => /INSERT INTO audit_event/.test(c.text));

describe("staff session cookie", () => {
  const p = { uid: "s1", exp: now + 100 };
  it("round-trips and carries no role", () => {
    const t = signStaffSession({ ...p, role: "super_admin" } as unknown as typeof p, secret);
    expect(verifyStaffSession(t, secret, now)).toEqual(p);
    expect(Buffer.from(t.split(".")[0]!, "base64url").toString()).not.toContain("super_admin");
  });
  it("rejects expired, tampered, wrong-secret and malformed tokens", () => {
    const t = signStaffSession(p, secret);
    expect(verifyStaffSession(t, secret, now + 100)).toBeNull();
    expect(verifyStaffSession(t, "t".repeat(40), now)).toBeNull();
    expect(verifyStaffSession(t, "short", now)).toBeNull();
    expect(verifyStaffSession(undefined, secret, now)).toBeNull();
    expect(verifyStaffSession("a.b.c", secret, now)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ uid: "other", exp: p.exp })).toString("base64url");
    expect(verifyStaffSession(`${forged}.${t.split(".")[1]}`, secret, now)).toBeNull();
  });
  it("is not interchangeable with a user session", () => {
    expect(verifySession(signStaffSession(p, secret), secret, now)).toBeNull();
    const user = signSession({ uid: "s1", ut: "owner", exp: now + 100 }, secret);
    expect(verifyStaffSession(user, secret, now)).toBeNull();
  });
});

const invite = { id: "i1", role: "compliance" };
const account = { id: "s1", user_type: "admin", status: "active", google_sub: who.sub };
/** Fake database answering the sign-in statements; `o` overrides what each one returns. */
const signInDb = (o: { invite?: Record<string, unknown> | null; account?: Record<string, unknown> | null; insert?: Record<string, unknown>[]; link?: Record<string, unknown>[] } = {}) =>
  fakeDb(t => {
    if (/FROM staff_invite WHERE email/.test(t)) return o.invite === null ? [] : [o.invite ?? invite];
    if (/FROM app_user WHERE email/.test(t)) return o.account === null ? [] : [o.account ?? account];
    if (/INSERT INTO app_user/.test(t)) return o.insert ?? [{ id: "s9" }];
    if (/UPDATE app_user/.test(t)) return o.link ?? [{ id: "s1" }];
    return [];
  });
const denied = (calls: Call[], reason: string) => {
  const a = audits(calls);
  expect(a).toHaveLength(1);
  expect(a[0]!.params[6]).toBe("staff.signin_denied");
  expect(JSON.parse(a[0]!.params[8] as string)).toEqual({ reason });
  expect(JSON.stringify(a[0]!.params)).not.toContain("example.com");
};

describe("staffSignIn (own Google account, admin-managed allowlist)", () => {
  it("signs in an invited email, takes the role from the invite and audits it", async () => {
    const { db, calls } = signInDb();
    expect(await staffSignIn(db, who)).toEqual({ id: "s1", role: "compliance" });
    expect(calls[0]!.params).toEqual(["staff@example.com"]);
    const a = audits(calls);
    expect(a).toHaveLength(1);
    expect(a[0]!.params[6]).toBe("staff.signed_in");
    expect(calls.some(c => /accepted_at = now\(\)/.test(c.text))).toBe(true);
  });
  it("matches after normalising case and surrounding whitespace, with bound parameters only", async () => {
    const { db, calls } = signInDb();
    expect(await staffSignIn(db, { ...who, email: "  Staff@Example.COM \n" })).toEqual({ id: "s1", role: "compliance" });
    expect(calls[0]!.params).toEqual(["staff@example.com"]);
    for (const c of calls) expect(c.text).not.toContain("example.com");
  });
  it("denies an uninvited email without creating an account", async () => {
    const { db, calls } = signInDb({ invite: null });
    expect(await staffSignIn(db, who)).toBeNull();
    expect(calls.some(c => /INSERT INTO app_user|UPDATE app_user/i.test(c.text))).toBe(false);
    denied(calls, "not_invited");
  });
  it("looks up only active (not revoked) invites", async () => {
    const { db, calls } = signInDb({ invite: null });
    await staffSignIn(db, who);
    expect(calls[0]!.text).toMatch(/revoked_at IS NULL/);
  });
  it("denies tricked addresses before touching the database", async () => {
    for (const email of ["staff@example.com\u0000", "sta ff@example.com", "staff@example.com,evil@x.com", "staff@examplе.com", "staff@example.com​", "", "nobody"]) {
      const { db, calls } = signInDb();
      expect(await staffSignIn(db, { ...who, email })).toBeNull();
      expect(calls.filter(c => !/INSERT INTO audit_event/.test(c.text))).toHaveLength(0);
    }
  });
  it("a sub-addressed email does not match the invite (exact match only)", async () => {
    const { db, calls } = signInDb({ invite: null });
    expect(await staffSignIn(db, { ...who, email: "staff+x@example.com" })).toBeNull();
    expect(calls[0]!.params).toEqual(["staff+x@example.com"]);
  });
  it("denies an invite with an unknown role", async () => {
    const { db, calls } = signInDb({ invite: { id: "i1", role: "root" } });
    expect(await staffSignIn(db, who)).toBeNull();
    denied(calls, "not_invited");
  });
  it("never converts an existing owner or buyer account, nor a suspended admin", async () => {
    for (const a of [{ ...account, user_type: "owner" }, { ...account, user_type: "buyer" }, { ...account, status: "suspended" }]) {
      const { db, calls } = signInDb({ account: a });
      expect(await staffSignIn(db, who)).toBeNull();
      expect(calls.some(c => /UPDATE app_user|INSERT INTO app_user/i.test(c.text))).toBe(false);
      denied(calls, "account_conflict");
    }
  });
  it("denies an admin account already linked to a different Google subject", async () => {
    const { db, calls } = signInDb({ account: { ...account, google_sub: "someone-else" } });
    expect(await staffSignIn(db, who)).toBeNull();
    denied(calls, "account_conflict");
  });
  it("links a not-yet-linked admin account once, and creates an admin account on first sign-in", async () => {
    const linked = signInDb({ account: { ...account, google_sub: null } });
    expect(await staffSignIn(linked.db, who)).toEqual({ id: "s1", role: "compliance" });
    expect(linked.calls.find(c => /UPDATE app_user/.test(c.text))!.text).toMatch(/google_sub IS NULL/);
    const created = signInDb({ account: null });
    expect(await staffSignIn(created.db, who)).toEqual({ id: "s9", role: "compliance" });
    expect(created.calls.find(c => /INSERT INTO app_user/.test(c.text))!.text).toMatch(/'admin', 'active'/);
  });
  it("denies when creating the account fails (subject already used by another account)", async () => {
    const { db, calls } = signInDb({ account: null, insert: [] });
    expect(await staffSignIn(db, who)).toBeNull();
    denied(calls, "account_conflict");
  });
  it("bootstrap email: only inserts a super_admin invite while no active super_admin exists", async () => {
    const { db, calls } = signInDb();
    await staffSignIn(db, who, ["staff@example.com"]);
    const ins = calls.find(c => /INSERT INTO staff_invite/.test(c.text))!;
    expect(ins.text).toMatch(/NOT EXISTS \(SELECT 1 FROM staff_invite WHERE role = 'super_admin' AND revoked_at IS NULL\)/);
    expect(ins.params).toEqual(["staff@example.com"]);
    const none = signInDb();
    await staffSignIn(none.db, who, ["other@example.com"]);
    expect(none.calls.some(c => /INSERT INTO staff_invite/.test(c.text))).toBe(false);
  });
});

describe("staffFromRequest (role read per request)", () => {
  const reqWith = (token: string) => new Request("http://x/api/staff/me", { headers: { cookie: `ol_staff=${token}` } });
  const token = signStaffSession({ uid: "s1", exp: now + 100 }, secret);

  it("returns the role the active invite holds now, so a change takes effect at once", async () => {
    let role = "reporting";
    const { db, calls } = fakeDb(() => [{ id: "s1", role }]);
    expect(await staffFromRequest(db, reqWith(token), secret, now)).toEqual({ id: "s1", role: "reporting" });
    role = "super_admin";
    expect(await staffFromRequest(db, reqWith(token), secret, now)).toEqual({ id: "s1", role: "super_admin" });
    expect(calls[0]!.text).toMatch(/revoked_at IS NULL/);
    expect(calls[0]!.text).toMatch(/user_type = 'admin' AND u.status = 'active'/);
  });
  it("returns null once the invite is revoked or the account is no longer active", async () => {
    const { db } = fakeDb(() => []);
    expect(await staffFromRequest(db, reqWith(token), secret, now)).toBeNull();
  });
  it("returns null for an unknown role", async () => {
    const { db } = fakeDb(() => [{ id: "s1", role: "root" }]);
    expect(await staffFromRequest(db, reqWith(token), secret, now)).toBeNull();
  });
  it("returns null without querying for a missing, forged or expired cookie", async () => {
    const { db, calls } = fakeDb(() => [{ id: "s1", role: "super_admin" }]);
    expect(await staffFromRequest(db, new Request("http://x"), secret, now)).toBeNull();
    expect(await staffFromRequest(db, reqWith("a.b"), secret, now)).toBeNull();
    expect(await staffFromRequest(db, reqWith(token), secret, now + 1000)).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it("a user session cookie in the staff slot gives no staff access", async () => {
    const { db, calls } = fakeDb(() => [{ id: "s1", role: "super_admin" }]);
    const user = signSession({ uid: "s1", ut: "owner", exp: now + 100 }, secret);
    expect(await staffFromRequest(db, reqWith(user), secret, now)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("sign-in routes for staff", () => {
  beforeEach(() => {
    process.env["SESSION_SECRET"] = secret;
    process.env["GOOGLE_CLIENT_ID"] = "client";
    process.env["GOOGLE_CLIENT_SECRET"] = "client-secret";
    process.env["APP_URL"] = "https://app.example.com";
  });
  const roleCookie = (res: Response) => /ol_role=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

  it("remembers staff only for ?as=staff", async () => {
    expect(roleCookie(await startGet(new Request("http://x/api/auth/google/start?as=staff")))).toBe("staff");
    for (const as of ["STAFF", "admin", "super_admin", ""]) {
      expect(roleCookie(await startGet(new Request(`http://x/api/auth/google/start?as=${as}`)))).toBe("owner");
    }
  });

  const callback = (answer: (t: string) => Record<string, unknown>[]) => {
    const f = fakeDb(answer);
    state.db = f.db;
    const cookies = "ol_state=s1; ol_nonce=n1; ol_verifier=v1; ol_role=staff";
    return callbackGet(new Request("http://x/api/auth/google/callback?code=c&state=s1", { headers: { cookie: cookies } })).then(res => ({ res, ...f }));
  };

  it("sets only the staff cookie (no user session) for a invited staff member", async () => {
    const { res } = await callback(t => (/FROM staff_invite WHERE email/.test(t) ? [invite] : /FROM app_user WHERE email/.test(t) ? [account] : []));
    const set = res.headers.get("set-cookie") ?? "";
    expect(res.headers.get("location")).toBe("https://app.example.com/");
    expect(set).toMatch(/ol_staff=[^;]+/);
    expect(set).not.toMatch(/ol_session=[^;]/);
    const token = /ol_staff=([^;]+)/.exec(set)![1]!;
    expect(verifyStaffSession(token, secret, Math.floor(Date.now() / 1000))?.uid).toBe("s1");
  });
  it("fails the login (generic) for anyone without an active invite, and creates nothing", async () => {
    const { res, calls } = await callback(() => []);
    expect(res.headers.get("location")).toBe("https://app.example.com/?login=failed");
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/ol_staff=[^;]/);
    expect(calls.some(c => /INSERT INTO app_user/i.test(c.text))).toBe(false);
  });
  it("logout clears the staff cookie too", async () => {
    const set = (await logoutPost(new Request("https://app.example.com/api/auth/logout", { method: "POST", headers: { origin: "https://app.example.com" } }))).headers.get("set-cookie") ?? "";
    expect(set).toMatch(/ol_staff=;/);
    expect(set).toMatch(/ol_session=;/);
  });
});
