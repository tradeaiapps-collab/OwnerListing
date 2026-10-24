import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { devLoginAllowed, devLoginSurface } from "../src/server/dev-login";
import { isAllowed } from "../src/config/app-mode";
import { proxy } from "../proxy";

const ROWS: { current: Record<string, unknown>[] } = { current: [] };
vi.mock("../src/server/context", () => ({ getDb: () => ({ query: async () => ({ rows: ROWS.current }) }), getActor: () => null, getDeps: () => null, getStaff: async () => null }));

import { POST } from "../app/api/dev/login/route";

const SECRET = "x".repeat(40);
const GOOD = { NODE_ENV: "development", DEV_LOGIN: "1", APP_URL: "http://localhost:3005", ADMIN_APP_URL: "http://localhost:3006" } as Record<string, string | undefined>;
const req = (host: string | null, url = "http://localhost:3005/dev-login", extra: Record<string, string> = {}) =>
  ({ url, headers: { get: (n: string) => (n.toLowerCase() === "host" ? host : extra[n.toLowerCase()] ?? null) } });

describe("devLoginAllowed", () => {
  it("allows only the full local combination", () => {
    expect(devLoginAllowed(req("localhost:3005"), GOOD)).toBe(true);
    expect(devLoginAllowed(req("127.0.0.1:3005", "http://127.0.0.1:3005/x"), GOOD)).toBe(true);
    expect(devLoginAllowed(req("[::1]:3005", "http://[::1]:3005/x"), GOOD)).toBe(true);
  });
  it("refuses in production", () => expect(devLoginAllowed(req("localhost:3005"), { ...GOOD, NODE_ENV: "production" })).toBe(false));
  it("refuses unless DEV_LOGIN is exactly 1", () => {
    for (const v of [undefined, "", "0", "true", "yes", "1 "]) expect(devLoginAllowed(req("localhost:3005"), { ...GOOD, DEV_LOGIN: v }), String(v)).toBe(false);
  });
  it("refuses when VERCEL is set, whatever else is true", () => {
    expect(devLoginAllowed(req("localhost:3005"), { ...GOOD, VERCEL: "1" })).toBe(false);
    expect(devLoginAllowed(req("localhost:3005"), { ...GOOD, VERCEL: "0" })).toBe(false);
  });
  it("refuses a non-local Host header even if the URL looks local", () => {
    expect(devLoginAllowed(req("www.example.com.au"), GOOD)).toBe(false);
    expect(devLoginAllowed(req("localhost.evil.com"), GOOD)).toBe(false);
    expect(devLoginAllowed(req("evil.com:80@localhost"), GOOD)).toBe(false);
    expect(devLoginAllowed(req(null), GOOD)).toBe(false);
  });
  it("refuses a non-local request URL even if the Host header looks local", () => {
    expect(devLoginAllowed(req("localhost:3005", "https://www.example.com.au/dev-login"), GOOD)).toBe(false);
    expect(devLoginAllowed(req("localhost:3005", "not a url"), GOOD)).toBe(false);
  });
  it("refuses a non-local X-Forwarded-Host", () => {
    expect(devLoginAllowed(req("localhost:3005", undefined, { "x-forwarded-host": "www.example.com.au" }), GOOD)).toBe(false);
    expect(devLoginAllowed(req("localhost:3005", undefined, { "x-forwarded-host": "localhost:3005" }), GOOD)).toBe(true);
  });
  it("refuses when APP_URL (or ADMIN_APP_URL in admin mode) is a real domain", () => {
    expect(devLoginAllowed(req("localhost:3005"), { ...GOOD, APP_URL: "https://www.example.com.au" })).toBe(false);
    expect(devLoginAllowed(req("localhost:3005"), { ...GOOD, APP_URL: undefined })).toBe(false);
    expect(devLoginAllowed(req("localhost:3006", "http://localhost:3006/x"), { ...GOOD, APP_MODE: "admin", ADMIN_APP_URL: "https://admin.example.com.au" })).toBe(false);
    expect(devLoginAllowed(req("localhost:3006", "http://localhost:3006/x"), { ...GOOD, APP_MODE: "admin" })).toBe(true);
  });
});

describe("devLoginSurface and the proxy allow-list", () => {
  it("public shows users, admin shows staff, all shows both", () => {
    expect(devLoginSurface("public")).toEqual({ users: true, staff: false });
    expect(devLoginSurface("admin")).toEqual({ users: false, staff: true });
    expect(devLoginSurface("all")).toEqual({ users: true, staff: true });
  });
  it("both paths pass the proxy in public and admin mode (the route itself refuses unless dev login is on)", () => {
    for (const mode of ["public", "admin", "all"] as const) for (const p of ["/dev-login", "/api/dev/login", "/dev-login/", "/DEV-LOGIN"]) expect(isAllowed(mode, p, null, undefined), `${mode} ${p}`).toBe(true);
    expect(isAllowed("admin", "/dev-login/x", null, undefined)).toBe(false);
    expect(isAllowed("admin", "/api/dev/other", null, undefined)).toBe(false);
    expect(isAllowed("public", "/staff", null, undefined)).toBe(false);
  });
  it("proxy still 404s other public pages on the admin instance", () => {
    const old = process.env["APP_MODE"];
    process.env["APP_MODE"] = "admin";
    try {
      expect(proxy(new NextRequest("http://localhost:3006/dev-login")).status).not.toBe(404);
      expect(proxy(new NextRequest("http://localhost:3006/listings")).status).toBe(404);
    } finally { if (old === undefined) delete process.env["APP_MODE"]; else process.env["APP_MODE"] = old; }
  });
});

describe("POST /api/dev/login", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["NODE_ENV", "DEV_LOGIN", "VERCEL", "APP_URL", "ADMIN_APP_URL", "APP_MODE", "SESSION_SECRET"];
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { NODE_ENV: "development", DEV_LOGIN: "1", APP_URL: "http://localhost:3005", ADMIN_APP_URL: "http://localhost:3006", APP_MODE: "public", SESSION_SECRET: SECRET });
    delete process.env["VERCEL"];
    ROWS.current = [{ id: "11111111-1111-1111-1111-111111111111", user_type: "owner", role: null }];
  });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const call = (headers: Record<string, string> = {}, body: unknown = { userId: "11111111-1111-1111-1111-111111111111" }, url = "http://localhost:3005/api/dev/login") =>
    POST(new Request(url, { method: "POST", headers: { host: new URL(url).host, origin: new URL(url).origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

  it("signs in a user and sets the normal session cookie", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("ol_session=");
    expect((await res.json()).redirect).toBe("/dashboard");
  });
  it("404 in production, without DEV_LOGIN, on Vercel, and for a non-local host", async () => {
    process.env["NODE_ENV"] = "production"; expect((await call()).status).toBe(404);
    process.env["NODE_ENV"] = "development";
    delete process.env["DEV_LOGIN"]; expect((await call()).status).toBe(404);
    process.env["DEV_LOGIN"] = "1";
    process.env["VERCEL"] = "1"; expect((await call()).status).toBe(404);
    delete process.env["VERCEL"];
    expect((await call({ host: "www.example.com.au" })).status).toBe(404);
    expect((await call({}, undefined, "https://www.example.com.au/api/dev/login")).status).toBe(404);
  });
  it("is csrf-guarded: wrong origin and non-JSON are 403", async () => {
    expect((await call({ origin: "http://evil.example" })).status).toBe(403);
    expect((await call({ "content-type": "text/plain" })).status).toBe(403);
  });
  it("public instance refuses staff accounts; admin instance refuses user accounts", async () => {
    ROWS.current = [{ id: "22222222-2222-2222-2222-222222222222", user_type: "admin", role: "support" }];
    expect((await call({}, { userId: "22222222-2222-2222-2222-222222222222" })).status).toBe(400);
    process.env["APP_MODE"] = "admin";
    const admin = "http://localhost:3006/api/dev/login";
    const ok = await call({}, { userId: "22222222-2222-2222-2222-222222222222" }, admin);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("ol_staff=");
    ROWS.current = [{ id: "11111111-1111-1111-1111-111111111111", user_type: "owner", role: null }];
    expect((await call({}, undefined, admin)).status).toBe(400);
  });
  it("rejects unknown accounts and bad ids", async () => {
    ROWS.current = [];
    expect((await call()).status).toBe(400);
    expect((await call({}, { userId: "x" })).status).toBe(400);
  });
});
