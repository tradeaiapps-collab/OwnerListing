import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appOriginFor, isAllowed, normalizePath, readAppMode } from "../src/config/app-mode";
import { readAuthEnv } from "../src/server/auth/config";
import { csrfGuard } from "../src/server/csrf";
import { config as proxyConfig, proxy } from "../proxy";
import { staffFromRequest } from "../src/server/staff-auth";
import { NextRequest } from "next/server";

vi.mock("../src/server/context", () => ({ getActor: () => null, getDeps: () => null, getDb: () => ({ query: async () => ({ rows: [{ id: "s1", staff_role: "compliance" }] }) }), getStaff: async () => null }));
vi.mock("../src/server/staff-auth", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/staff-auth")>()),
  staffSignIn: async () => ({ id: "s1", role: "compliance" })
}));
vi.mock("../src/server/auth/google", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/auth/google")>()),
  exchangeCode: async () => ({}),
  readIdentity: () => ({ sub: "g", email: "s@example.com", name: "S" })
}));

import { GET as callbackGet } from "../app/api/auth/google/callback/route";
import { GET as startGet } from "../app/api/auth/google/start/route";

const PUBLIC = "https://www.example.com";
const ADMIN = "https://admin.example.com";
const saved: Record<string, string | undefined> = {};
const KEYS = ["APP_MODE", "APP_URL", "ADMIN_APP_URL", "NODE_ENV", "SESSION_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const setMode = (m: string | undefined) => { if (m === undefined) delete process.env["APP_MODE"]; else process.env["APP_MODE"] = m; };
const hit = (path: string, init: { cookie?: string; method?: string } = {}) =>
  proxy(new NextRequest(`https://x.example${path}`, { method: init.method ?? "GET", headers: init.cookie ? { cookie: init.cookie } : {} }));

const STAFF = ["/staff", "/staff/cases", "/api/staff/me", "/api/staff/audit"];
const PUBLIC_ROUTES = ["/", "/listings", "/listings/1/offers", "/buyer/saved-searches", "/plans", "/terms", "/api/listings", "/api/buyer/verification/options", "/api/webhooks/payway", "/api/auth/me", "/api/internal/alerts/run"];

describe("readAppMode", () => {
  it("defaults to all in development, public in production, public for unknown values", () => {
    expect(readAppMode({})).toBe("all");
    expect(readAppMode({ NODE_ENV: "production" })).toBe("public");
    expect(readAppMode({ APP_MODE: "ADMIN" })).toBe("admin");
    expect(readAppMode({ APP_MODE: "all", NODE_ENV: "production" })).toBe("all");
    expect(readAppMode({ APP_MODE: "adimn" })).toBe("public");
  });
});

describe("proxy in each mode", () => {
  it("public: staff pages, staff APIs and staff sign-in answer 404; public routes pass", () => {
    setMode("public");
    for (const p of STAFF) expect(hit(p).status).toBe(404);
    expect(hit("/api/auth/google/start?as=staff").status).toBe(404);
    expect(hit("/api/auth/google/callback?code=c", { cookie: "ol_role=staff" }).status).toBe(404);
    for (const p of [...PUBLIC_ROUTES, "/api/auth/google/start", "/api/auth/google/start?as=buyer", "/api/health", "/_next/static/a.js"]) {
      expect(hit(p).status, p).not.toBe(404);
    }
    expect(hit("/api/auth/google/callback?code=c", { cookie: "ol_role=owner" }).status).not.toBe(404);
  });
  it("admin: every public, buyer and owner route answers 404; staff, staff sign-in, logout, health and assets pass", () => {
    setMode("admin");
    for (const p of PUBLIC_ROUTES.filter(p => p !== "/")) expect(hit(p).status, p).toBe(404);
    expect(hit("/api/auth/google/start").status).toBe(404);
    expect(hit("/api/auth/google/start?as=buyer").status).toBe(404);
    expect(hit("/api/auth/google/callback?code=c", { cookie: "ol_role=owner" }).status).toBe(404);
    for (const p of [...STAFF, "/api/auth/google/start?as=staff", "/api/health", "/_next/static/a.js", "/favicon.ico"]) expect(hit(p).status, p).not.toBe(404);
    expect(hit("/api/auth/google/callback?code=c", { cookie: "ol_role=staff" }).status).not.toBe(404);
    expect(hit("/api/auth/logout", { method: "POST" }).status).not.toBe(404);
  });
  it("admin: the home page redirects to /staff", () => {
    setMode("admin");
    const r = hit("/");
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("https://x.example/staff");
  });
  it("all: nothing is blocked", () => {
    setMode("all");
    for (const p of [...STAFF, ...PUBLIC_ROUTES]) expect(isAllowed("all", p, null, undefined)).toBe(true);
    expect(hit("/staff").status).not.toBe(404);
  });
  it("a path trick does not reach staff in public mode", () => {
    setMode("public");
    for (const p of ["/staff/", "/api/staff", "/staff/x/y"]) expect(hit(p).status).toBe(404);
  });
});

describe("csrf origin per mode", () => {
  const post = (origin: string) => new Request("https://x.example/api/staff/pricing", { method: "POST", headers: { origin, "content-type": "application/json" } });
  beforeEach(() => { process.env["APP_URL"] = PUBLIC; process.env["ADMIN_APP_URL"] = ADMIN; });

  it("public and all trust APP_URL only", () => {
    for (const m of ["public", "all"]) {
      setMode(m);
      expect(csrfGuard(post(PUBLIC))).toBeNull();
      expect(csrfGuard(post(ADMIN))?.status).toBe(403);
    }
  });
  it("admin trusts ADMIN_APP_URL only, never the public origin", () => {
    setMode("admin");
    expect(csrfGuard(post(ADMIN))).toBeNull();
    expect(csrfGuard(post(PUBLIC))?.status).toBe(403);
  });
  it("admin fails closed when ADMIN_APP_URL is unset or invalid, even though APP_URL is set", () => {
    setMode("admin");
    delete process.env["ADMIN_APP_URL"];
    expect(csrfGuard(post(PUBLIC))?.status).toBe(403);
    expect(csrfGuard(post(ADMIN))?.status).toBe(403);
    process.env["ADMIN_APP_URL"] = "not a url";
    expect(csrfGuard(post(ADMIN))?.status).toBe(403);
  });
  it("origin helper", () => {
    expect(appOriginFor("admin", { ADMIN_APP_URL: `${ADMIN}/x/`, APP_URL: PUBLIC })).toBe(ADMIN);
    expect(appOriginFor("public", { ADMIN_APP_URL: ADMIN })).toBeNull();
  });
});

describe("sign-in settings per mode", () => {
  const env = { SESSION_SECRET: "s".repeat(40), GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "x", APP_URL: PUBLIC };
  it("admin uses ADMIN_APP_URL for the redirect URI and fails closed without it", () => {
    expect(readAuthEnv({ ...env, APP_MODE: "admin" })).toBeNull();
    const a = readAuthEnv({ ...env, APP_MODE: "admin", ADMIN_APP_URL: ADMIN })!;
    expect(a.google.redirectUri).toBe(`${ADMIN}/api/auth/google/callback`);
    expect(a.secureCookies).toBe(true);
    expect(readAuthEnv({ ...env, APP_MODE: "public", ADMIN_APP_URL: ADMIN })!.google.redirectUri).toBe(`${PUBLIC}/api/auth/google/callback`);
  });
});

describe("staff session cookie is host-only", () => {
  it("sign-in sets ol_staff with no Domain attribute (so it is never sent to the public host)", async () => {
    Object.assign(process.env, { APP_MODE: "admin", ADMIN_APP_URL: ADMIN, SESSION_SECRET: "s".repeat(40), GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "x" });
    const start = await startGet(new Request(`${ADMIN}/api/auth/google/start?as=staff`));
    expect(start.headers.get("location")).toContain(encodeURIComponent(`${ADMIN}/api/auth/google/callback`));
    expect(start.headers.get("set-cookie") ?? "").not.toMatch(/domain=/i);
    const res = await callbackGet(new Request(`${ADMIN}/api/auth/google/callback?code=c&state=s1`, { headers: { cookie: "ol_state=s1; ol_nonce=n1; ol_verifier=v1; ol_role=staff" } }));
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/ol_staff=[^;]+/);
    expect(set).not.toMatch(/domain=/i);
  });
  it("no cookie is set with a domain option anywhere in app/ or src/", () => {
    const root = path.join(__dirname, "..");
    const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : []; });
    const bad = [...walk(path.join(root, "app")), ...walk(path.join(root, "src"))].filter(f => /cookies\.set\([^)]*\bdomain\s*:|[;,]\s*Domain=/i.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});

describe("path tricks cannot bypass the split (review of #78)", () => {
  const TRICKS = ["/%73taff", "/%73taff/cases", "//staff", "///staff/x", "/staff//cases", "/api/%73taff/me", "/api//staff/me", "/%2573taff", "/%2fstaff", "/Staff", "/STAFF/Cases",
    "/api/Staff/me", "/staff;x=1", "/a/../staff", "/%2e%2e/staff", "/staff%5Ccases", "/\\staff", "/api/staff/", "/staff%00", "/%zz"];
  it("public: every variant of a staff path answers 404", () => {
    setMode("public");
    for (const p of TRICKS) expect(hit(p).status, p).toBe(404);
  });
  it("public: encoded and slashed staff sign-in variants answer 404", () => {
    setMode("public");
    for (const p of ["/api/auth/google/start/?as=staff", "//api/auth/google/start?as=staff", "/api/auth/google/%73tart?as=staff", "/API/auth/google/start?as=staff"]) expect(hit(p).status, p).toBe(404);
    expect(hit("/api/auth/google/callback/?code=c", { cookie: "ol_role=staff" }).status).toBe(404);
    expect(hit("/api/auth/google//callback?code=c", { cookie: "ol_role=staff" }).status).toBe(404);
  });
  it("duplicate ol_role cookies are read the way the route reads them", () => {
    setMode("public");
    // The route (readCookie) takes the first ol_role; the proxy now uses the same reader, so they cannot disagree.
    expect(hit("/api/auth/google/callback?code=c", { cookie: "ol_role=staff; ol_role=owner" }).status).toBe(404);
    setMode("admin");
    expect(hit("/api/auth/google/callback?code=c", { cookie: "ol_role=owner; ol_role=staff" }).status).toBe(404);
  });
  it("admin: encoded public paths answer 404, encoded staff paths still work", () => {
    setMode("admin");
    for (const p of ["/%6cistings", "//listings", "/api//listings", "/api/%77ebhooks/payway", "/_next/data/b/listings.json", "/_next/webpack-hmr"]) expect(hit(p).status, p).toBe(404);
    for (const p of ["/%73taff", "//staff/cases"]) expect(hit(p).status, p).not.toBe(404);
  });
  it("public: /_next/data is not exempt; static assets and health still pass", () => {
    setMode("public");
    expect(hit("/_next/data/b/staff.json").status).toBe(404);
    // A traversal out of /_next/static is resolved before the static exemption is checked.
    expect(isAllowed("admin", "/_next/static/..%2flistings", null, undefined)).toBe(false);
    expect(isAllowed("public", "/_next/static/..%2f..%2fstaff", null, undefined)).toBe(false);
    for (const p of ["/_next/static/chunks/a.js", "/_next/image", "/api/health", "/favicon.ico"]) expect(hit(p).status, p).not.toBe(404);
  });
  it("other methods are covered too", () => {
    setMode("public");
    for (const method of ["HEAD", "OPTIONS", "POST", "PUT", "DELETE"]) expect(hit("/api/staff/pricing", { method }).status, method).toBe(404);
    setMode("admin");
    for (const method of ["HEAD", "OPTIONS", "POST"]) expect(hit("/api/listings", { method }).status, method).toBe(404);
  });
  it("a typo, blank or odd APP_MODE in production is public", () => {
    for (const v of ["", " ", "Admn", "true", "1", "publc"]) expect(readAppMode({ APP_MODE: v, NODE_ENV: "production" }), JSON.stringify(v)).toBe("public");
  });
  it("normalizePath", () => {
    expect(normalizePath("/%73taff/")).toBe("/staff");
    expect(normalizePath("//a///b/./c/../d")).toBe("/a/b/d");
    expect(normalizePath("/x%00")).toBeNull();
    expect(normalizePath("/%E0%A4%A")).toBeNull();
    expect(normalizePath("/%25252573")).toBeNull();
  });
  it("the proxy matcher covers every path", () => {
    expect(JSON.stringify(proxyConfig.matcher)).toBe('["/:path*"]');
  });
});

describe("staff cookie is not honoured on a public deployment", () => {
  it("staffFromRequest returns null in public mode before touching the database", async () => {
    setMode("public");
    const db = { query: async () => { throw new Error("must not be called"); } };
    expect(await staffFromRequest(db as never, new Request("https://x.example/", { headers: { cookie: "ol_staff=anything" } }), "s".repeat(40), 0)).toBeNull();
  });
});
