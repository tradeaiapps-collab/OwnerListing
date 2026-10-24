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

describe("staffSignIn", () => {
  it("signs in a known Google subject and audits it", async () => {
    const { db, calls } = fakeDb(t => (/SELECT id, staff_role/.test(t) ? [{ id: "s1", staff_role: "compliance" }] : []));
    expect(await staffSignIn(db, who)).toEqual({ id: "s1", role: "compliance" });
    expect(calls[0]!.params).toEqual([who.sub]);
    const a = audits(calls);
    expect(a).toHaveLength(1);
    expect(a[0]!.params[3]).toBe("s1");
    expect(a[0]!.params[6]).toBe("staff.signed_in");
  });
  it("links a pre-provisioned account by email once, with bound parameters only", async () => {
    const { db, calls } = fakeDb(t => (/UPDATE app_user/.test(t) ? [{ id: "s2", staff_role: "support" }] : []));
    expect(await staffSignIn(db, who)).toEqual({ id: "s2", role: "support" });
    const link = calls.find(c => /UPDATE app_user/.test(c.text))!;
    expect(link.params).toEqual([who.sub, who.email]);
    expect(link.text).toMatch(/google_sub IS NULL/);
    expect(link.text).toMatch(/staff_role IS NOT NULL/);
    expect(link.text).not.toContain(who.email);
    expect(link.text).not.toMatch(/INSERT INTO app_user/i);
  });
  it("never creates an account: an unknown person is denied and the denial is audited without their email", async () => {
    const { db, calls } = fakeDb(() => []);
    expect(await staffSignIn(db, who)).toBeNull();
    expect(calls.some(c => /INSERT INTO app_user/i.test(c.text))).toBe(false);
    const a = audits(calls);
    expect(a).toHaveLength(1);
    expect(a[0]!.params[6]).toBe("staff.signin_denied");
    expect(JSON.stringify(a[0]!.params)).not.toContain(who.email);
  });
  it("denies a row whose staff_role is not a known role", async () => {
    const { db } = fakeDb(t => (/SELECT id, staff_role/.test(t) ? [{ id: "s3", staff_role: "root" }] : []));
    expect(await staffSignIn(db, who)).toBeNull();
  });
  it("only matches active admin-type accounts", async () => {
    const { db, calls } = fakeDb(() => []);
    await staffSignIn(db, who);
    for (const c of calls.filter(x => /app_user/.test(x.text))) {
      expect(c.text).toMatch(/user_type = 'admin'/);
      expect(c.text).toMatch(/status = 'active'/);
    }
  });
});

describe("staffFromRequest (role read per request)", () => {
  const reqWith = (token: string) => new Request("http://x/api/staff/me", { headers: { cookie: `ol_staff=${token}` } });
  const token = signStaffSession({ uid: "s1", exp: now + 100 }, secret);

  it("returns the role the database holds now, so a change takes effect at once", async () => {
    let role = "reporting";
    const { db } = fakeDb(() => [{ id: "s1", staff_role: role }]);
    expect(await staffFromRequest(db, reqWith(token), secret, now)).toEqual({ id: "s1", role: "reporting" });
    role = "super_admin";
    expect(await staffFromRequest(db, reqWith(token), secret, now)).toEqual({ id: "s1", role: "super_admin" });
  });
  it("returns null once the account is no longer active staff", async () => {
    const { db } = fakeDb(() => []);
    expect(await staffFromRequest(db, reqWith(token), secret, now)).toBeNull();
  });
  it("returns null without querying for a missing, forged or expired cookie", async () => {
    const { db, calls } = fakeDb(() => [{ id: "s1", staff_role: "super_admin" }]);
    expect(await staffFromRequest(db, new Request("http://x"), secret, now)).toBeNull();
    expect(await staffFromRequest(db, reqWith("a.b"), secret, now)).toBeNull();
    expect(await staffFromRequest(db, reqWith(token), secret, now + 1000)).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it("a user session cookie in the staff slot gives no staff access", async () => {
    const { db, calls } = fakeDb(() => [{ id: "s1", staff_role: "super_admin" }]);
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
    for (const as of ["STAFF", "admin", "super_admin", "agent", ""]) {
      expect(roleCookie(await startGet(new Request(`http://x/api/auth/google/start?as=${as}`)))).toBe("owner");
    }
  });

  const callback = (answer: (t: string) => Record<string, unknown>[]) => {
    const f = fakeDb(answer);
    state.db = f.db;
    const cookies = "ol_state=s1; ol_nonce=n1; ol_verifier=v1; ol_role=staff";
    return callbackGet(new Request("http://x/api/auth/google/callback?code=c&state=s1", { headers: { cookie: cookies } })).then(res => ({ res, ...f }));
  };

  it("sets only the staff cookie (no user session) for a provisioned staff member", async () => {
    const { res } = await callback(t => (/SELECT id, staff_role/.test(t) ? [{ id: "s1", staff_role: "compliance" }] : []));
    const set = res.headers.get("set-cookie") ?? "";
    expect(res.headers.get("location")).toBe("https://app.example.com/");
    expect(set).toMatch(/ol_staff=[^;]+/);
    expect(set).not.toMatch(/ol_session=[^;]/);
    const token = /ol_staff=([^;]+)/.exec(set)![1]!;
    expect(verifyStaffSession(token, secret, Math.floor(Date.now() / 1000))?.uid).toBe("s1");
  });
  it("fails the login for anyone who is not provisioned staff, and creates nothing", async () => {
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
