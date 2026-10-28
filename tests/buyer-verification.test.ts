import { beforeEach, describe, expect, it, vi } from "vitest";
import { verificationSteps } from "../src/domain/buyer";
import type { Actor } from "../src/domain/listing-service";
import { safeNext } from "../src/server/auth/safe-next";
import type { Queryable } from "../src/server/db";

const state = vi.hoisted(() => ({ actor: null as Actor | null, db: null as Queryable | null }));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => state.db, getDeps: () => null }));
vi.mock("../src/server/auth/google", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/auth/google")>()),
  exchangeCode: async () => ({}),
  readIdentity: () => ({ sub: "g1", email: "buyer@example.com", name: "Bea Buyer" })
}));

import { GET as callbackGet } from "../app/api/auth/google/callback/route";
import { GET as startGet } from "../app/api/auth/google/start/route";
import { GET as verificationGet } from "../app/api/buyer/verification/route";

const buyer: Actor = { userId: "b0000000-0000-4000-8000-000000000001", userType: "buyer" };

describe("verificationSteps", () => {
  it("marks finished steps done, the next current and the rest waiting", () => {
    const s = (emailVerified: boolean, phoneVerified: boolean, idVerified: boolean) =>
      verificationSteps({ emailVerified, phoneVerified, idVerified }).map(x => x.status);
    expect(s(false, false, false)).toEqual(["current", "waiting", "waiting"]);
    expect(s(true, false, false)).toEqual(["done", "current", "waiting"]);
    expect(s(true, true, false)).toEqual(["done", "done", "current"]);
    expect(s(true, true, true)).toEqual(["done", "done", "done"]);
  });
});

describe("GET /api/buyer/verification", () => {
  const req = () => new Request("http://test/api/buyer/verification");
  beforeEach(() => { state.actor = null; state.db = { async query() { return { rows: [] }; } }; });

  it("denies signed-out callers (401) and non-buyers (403) without touching the database", async () => {
    let queried = false;
    state.db = { async query() { queried = true; return { rows: [] }; } };
    expect((await verificationGet(req())).status).toBe(401);
    for (const userType of ["owner", "agent", "admin", "vendor"]) {
      state.actor = { userId: "u1", userType } as unknown as Actor;
      expect((await verificationGet(req())).status).toBe(403);
    }
    expect(queried).toBe(false);
  });
  it("returns step status only, reading the signed-in buyer's own row", async () => {
    const seen: unknown[][] = [];
    state.actor = buyer;
    state.db = { async query(_t, p) { seen.push(p ?? []); return { rows: [{ email: true, phone: false, id: true, phone_number: "0400000000" }] }; } };
    const res = await verificationGet(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      steps: [{ step: "verify_email", status: "done" }, { step: "verify_phone", status: "current" }, { step: "verify_id", status: "waiting" }],
      next: "verify_phone"
    });
    expect(seen).toEqual([[buyer.userId]]);
  });
  it("treats a missing row as nothing verified", async () => {
    state.actor = buyer;
    expect((await (await verificationGet(req())).json()).next).toBe("verify_email");
  });
});

describe("safe return path", () => {
  const bad = [
    "//evil.com", "https://evil.com", "http://evil.com/x", "/\\evil.com", "\\\\evil.com", "/\\/evil.com", "javascript:alert(1)",
    "/javascript:alert(1)", "%2F%2Fevil.com", "/%2Fevil.com", "/%5Cevil.com", "/%2f/evil.com", "/%252F%252Fevil.com",
    "evil.com", "offers/new", "", "/ /evil.com", "/\tevil.com", "/\n//evil.com", "data:text/html,x", "/a;b", "/a#frag", "///evil.com"
  ];
  it("rejects open-redirect attempts", () => {
    for (const v of bad) expect(safeNext(v), v).toBeUndefined();
    expect(safeNext(null)).toBeUndefined();
  });
  it("accepts same-site relative paths", () => {
    for (const v of ["/", "/offers/new?listing=0b1c2d3e-aaaa-4bbb-8ccc-1234567890ab", "/buyer/verification"]) expect(safeNext(v)).toBe(v);
  });

  const env = () => {
    process.env["SESSION_SECRET"] = "s".repeat(40);
    process.env["GOOGLE_CLIENT_ID"] = "client";
    process.env["GOOGLE_CLIENT_SECRET"] = "client-secret";
    process.env["APP_URL"] = "https://app.example.com";
  };
  const nextCookie = (res: Response) => /ol_next=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

  it("start stores only a safe next value", async () => {
    env();
    const path = "/offers/new?listing=abc-123";
    expect(decodeURIComponent(nextCookie(await startGet(new Request(`http://x/api/auth/google/start?as=buyer&next=${encodeURIComponent(path)}`)))!)).toBe(path);
    for (const v of bad) {
      expect(nextCookie(await startGet(new Request(`http://x/api/auth/google/start?as=buyer&next=${encodeURIComponent(v)}`))), v).toBeUndefined();
    }
    expect(nextCookie(await startGet(new Request("http://x/api/auth/google/start?as=buyer")))).toBeUndefined();
  });

  const callback = async (nextValue: string | undefined) => {
    env();
    state.db = { async query(t) { return { rows: /FROM mfa_factor/.test(t) ? [] : [{ id: "u9", user_type: "buyer", status: "active" }] }; } };
    const cookies = ["ol_state=s1", "ol_nonce=n1", "ol_verifier=v1", "ol_role=buyer", ...(nextValue === undefined ? [] : [`ol_next=${nextValue}`])].join("; ");
    return callbackGet(new Request("http://x/api/auth/google/callback?code=c&state=s1", { headers: { cookie: cookies } }));
  };
  it("callback returns the buyer to the safe path and falls back for tampered cookies", async () => {
    const target = "https://app.example.com/offers/new?listing=abc-123";
    expect((await callback("/offers/new?listing=abc-123")).headers.get("location")).toBe(target);
    expect((await callback(encodeURIComponent("/offers/new?listing=abc-123"))).headers.get("location")).toBe(target);
    for (const v of bad) {
      expect((await callback(encodeURIComponent(v))).headers.get("location"), v).toBe("https://app.example.com/buyer/saved-searches");
      if (!/[\s;#]/.test(v)) expect((await callback(v)).headers.get("location"), v).toBe("https://app.example.com/buyer/saved-searches");
    }
    expect((await callback(undefined)).headers.get("location")).toBe("https://app.example.com/buyer/saved-searches");
  });
});
