import { beforeEach, describe, expect, it, vi } from "vitest";
import { forbiddenFor, type Action } from "../src/domain/access";
import { SESSION_COOKIE, signSession, verifySession } from "../src/server/auth/session";
import type { Queryable } from "../src/server/db";
import { upsertGoogleUser, vendorSignIn } from "../src/server/users";

const state = vi.hoisted(() => ({ db: null as Queryable | null }));

vi.mock("../src/server/context", () => ({
  getActor: () => null,
  getDeps: () => null,
  getDb: () => state.db
}));

vi.mock("../src/server/auth/google", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/auth/google")>()),
  exchangeCode: async () => ({}),
  readIdentity: () => ({ sub: "google-sub-v", email: "photog@example.com", name: "Pia Photog" })
}));

import { GET as callbackGet } from "../app/api/auth/google/callback/route";
import { GET as startGet } from "../app/api/auth/google/start/route";

const secret = "s".repeat(40);
const now = 1_800_000_000;
const who = { sub: "google-sub-v", email: "photog@example.com", name: "Pia Photog" };

interface Call { text: string; params: unknown[] }
/** Answers each query in order from `answers`, recording what was asked. */
const scripted = (answers: Record<string, unknown>[][]) => {
  const calls: Call[] = [];
  let i = 0;
  const db: Queryable = { async query(text, params) { calls.push({ text, params: params ?? [] }); return { rows: answers[i++] ?? [] }; } };
  return { db, calls };
};
const auditParams = (calls: Call[]) => JSON.stringify(calls.filter(c => /audit/i.test(c.text)).map(c => c.params));

describe("vendor session claim", () => {
  const payload = { uid: "v0000000-0000-4000-8000-000000000001", ut: "vendor" as const, exp: now + 100 };
  it("accepts a signed vendor session", () => {
    expect(verifySession(signSession(payload, secret), secret, now)).toEqual(payload);
  });
  it("still rejects staff and other types", () => {
    for (const ut of ["admin", "staff", "investor", "project_owner", "VENDOR", "", null, undefined]) {
      expect(verifySession(signSession({ ...payload, ut: ut as unknown as "vendor" }, secret), secret, now)).toBeNull();
    }
  });
  it("rejects a token whose claim was edited to or from vendor without re-signing", () => {
    for (const [from, to] of [["owner", "vendor"], ["vendor", "owner"], ["buyer", "vendor"], ["vendor", "agent"]] as const) {
      const [, sig] = signSession({ ...payload, ut: from }, secret).split(".") as [string, string];
      const forged = Buffer.from(JSON.stringify({ ...payload, ut: to })).toString("base64url");
      expect(verifySession(`${forged}.${sig}`, secret, now)).toBeNull();
    }
  });
});

describe("a vendor role is denied by default", () => {
  const actions: Action[] = ["listing.create", "listing.publish", "enquiry.handle", "offer.analyse", "offer.approve", "licence.verify", "audit.read"];
  it("fails every role-checked action", () => {
    for (const a of actions) expect(forbiddenFor({ id: "v1", role: "vendor" }, a)?.code).toBe("forbidden");
  });
});

describe("vendorSignIn", () => {
  it("signs in a known Google subject without linking or creating anything", async () => {
    const { db, calls } = scripted([[{ id: "v1" }], []]);
    expect(await vendorSignIn(db, who)).toEqual({ id: "v1" });
    expect(calls[0]!.params).toEqual([who.sub]);
    expect(calls[0]!.text).toMatch(/user_type = 'vendor'/);
    expect(calls[0]!.text).toMatch(/status = 'active'/);
    expect(calls.some(c => /INSERT INTO app_user/i.test(c.text))).toBe(false);
    expect(calls.some(c => /UPDATE app_user/i.test(c.text))).toBe(false);
    expect(auditParams(calls)).toContain("vendor.signed_in");
  });
  it("links a pre-registered vendor by verified email once, with one guarded UPDATE", async () => {
    const { db, calls } = scripted([[], [{ id: "v2" }], []]);
    expect(await vendorSignIn(db, who)).toEqual({ id: "v2" });
    const link = calls[1]!;
    expect(link.params).toEqual([who.sub, who.email]);
    expect(link.text).toMatch(/google_sub IS NULL/);
    expect(link.text).toMatch(/user_type = 'vendor'/);
    expect(link.text).toMatch(/status = 'active'/);
  });
  it("denies an unknown person, creates nothing, and audits without the email", async () => {
    const { db, calls } = scripted([[], [], []]);
    expect(await vendorSignIn(db, who)).toBeNull();
    expect(calls.some(c => /INSERT INTO app_user/i.test(c.text))).toBe(false);
    const a = auditParams(calls);
    expect(a).toContain("vendor.signin_denied");
    expect(a).not.toContain(who.email);
    expect(a).not.toContain(who.sub);
  });
});

describe("existing sign-in never lets a vendor in through the owner or buyer door", () => {
  it("upsertGoogleUser still returns null for a vendor row", async () => {
    const { db } = scripted([[{ id: "v1", user_type: "vendor", status: "active" }]]);
    expect(await upsertGoogleUser(db, who, "buyer")).toBeNull();
  });
});

describe("sign-in routes", () => {
  beforeEach(() => {
    process.env["SESSION_SECRET"] = secret;
    process.env["GOOGLE_CLIENT_ID"] = "client";
    process.env["GOOGLE_CLIENT_SECRET"] = "client-secret";
    process.env["APP_URL"] = "https://app.example.com";
  });
  const roleCookie = (res: Response) => /ol_role=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

  it("remembers vendor only for ?as=vendor", async () => {
    expect(roleCookie(await startGet(new Request("http://x/api/auth/google/start?as=vendor")))).toBe("vendor");
    for (const as of ["VENDOR", "contractor", "admin"]) {
      expect(roleCookie(await startGet(new Request(`http://x/api/auth/google/start?as=${as}`)))).toBe("owner");
    }
  });

  const callback = (roleValue: string, answers: Record<string, unknown>[][]) => {
    state.db = scripted(answers).db;
    const cookies = ["ol_state=s1", "ol_nonce=n1", "ol_verifier=v1", `ol_role=${roleValue}`].join("; ");
    return callbackGet(new Request("http://x/api/auth/google/callback?code=c&state=s1", { headers: { cookie: cookies } }));
  };

  it("signs a vendor session for a pre-registered vendor and clears the staff cookie", async () => {
    const res = await callback("vendor", [[{ id: "v1" }], []]);
    expect(res.headers.get("location")).toBe("https://app.example.com/");
    const set = res.headers.get("set-cookie") ?? "";
    const token = /ol_session=([^;]*)/.exec(set)?.[1];
    expect(SESSION_COOKIE).toBe("ol_session");
    expect(verifySession(token, secret, Math.floor(Date.now() / 1000))).toMatchObject({ uid: "v1", ut: "vendor" });
    expect(set).toMatch(/ol_staff=;/);
  });
  it("fails the login for anyone who is not a pre-registered vendor", async () => {
    const res = await callback("vendor", [[], [], []]);
    expect(res.headers.get("location")).toBe("https://app.example.com/?login=failed");
  });
});
