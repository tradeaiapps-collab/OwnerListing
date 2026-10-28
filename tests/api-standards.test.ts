import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryListingRepository, type Actor, type ListingServiceDeps } from "../src/domain/listing-service";
import type { Queryable } from "../src/server/db";
import { API_ERROR_CODES, codeForStatus, toV1ErrorBody } from "../src/server/api/errors";
import { requestHash, type Claim, type IdempotencyStore, type StoredResponse } from "../src/server/api/idempotency";
import { createPgIdempotencyStore } from "../src/server/api/idempotency-db";
import { VERSION_HEADER, resolveApiPath } from "../src/server/api/version";
import { createWithApi } from "../src/server/api/with-api";
import { SESSION_COOKIE, signSession } from "../src/server/auth/session";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const state = vi.hoisted(() => ({ actor: null as Actor | null, deps: null as ListingServiceDeps | null, db: null as Queryable | null }));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDeps: () => state.deps, getDb: () => state.db }));

import { proxy } from "../proxy";
import { POST as createListing } from "../app/api/listings/route";

const root = path.join(__dirname, "..");
const routeFiles = (dir: string): string[] => readdirSync(dir).flatMap(n => {
  const p = path.join(dir, n);
  return statSync(p).isDirectory() ? routeFiles(p) : n === "route.ts" ? [p] : [];
});

describe("every API route goes through the API layer", () => {
  it("exports each HTTP method only as withApi(...)", () => {
    const files = routeFiles(path.join(root, "app", "api"));
    expect(files.length).toBeGreaterThan(100);
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/^export (async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/m.test(src)) bad.push(`${f}: bare handler export`);
      for (const m of src.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) = (.*)$/gm)) {
        if (!m[2]!.startsWith("withApi(")) bad.push(`${f}: ${m[1]} not wrapped`);
      }
      if (!/^export const (GET|POST|PUT|PATCH|DELETE) = withApi\(/m.test(src)) bad.push(`${f}: no wrapped export`);
    }
    expect(bad).toEqual([]);
  });
});

describe("API versions", () => {
  it("maps /api/v1/... to the handler path, keeps unversioned /api/... as legacy and refuses unreleased versions", () => {
    expect(resolveApiPath("/api/v1/listings/abc")).toEqual({ kind: "versioned", version: "v1", path: "/api/listings/abc" });
    expect(resolveApiPath("/api/listings")).toEqual({ kind: "legacy", path: "/api/listings" });
    expect(resolveApiPath("/api/v2/listings")).toEqual({ kind: "unsupported", requested: "v2" });
    expect(resolveApiPath("/api/v10")).toEqual({ kind: "unsupported", requested: "v10" });
    expect(resolveApiPath("/listings")).toEqual({ kind: "not_api" });
    expect(resolveApiPath("/apis/v1")).toEqual({ kind: "not_api" });
    // A path segment that only starts like a version is an ordinary legacy path.
    expect(resolveApiPath("/api/v1x/listings").kind).toBe("legacy");
  });

  describe("in the proxy", () => {
    const saved = process.env["APP_MODE"];
    afterEach(() => { if (saved === undefined) delete process.env["APP_MODE"]; else process.env["APP_MODE"] = saved; });
    const run = (p: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`https://x.example${p}`, { headers }));

    it("rewrites /api/v1 to the route and tells it the version", () => {
      process.env["APP_MODE"] = "all";
      const res = run("/api/v1/listings?limit=5");
      expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/api/listings");
      expect(new URL(res.headers.get("x-middleware-rewrite")!).search).toBe("?limit=5");
      expect(res.headers.get(`x-middleware-request-${VERSION_HEADER}`)).toBe("v1");
    });
    it("answers an unreleased version with a v1 error naming the versions that exist", async () => {
      process.env["APP_MODE"] = "all";
      const res = run("/api/v2/listings");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("unsupported_version");
      expect(body.error.details).toEqual({ supportedVersions: ["v1"] });
      expect(res.headers.get("x-correlation-id")).toBe(body.error.correlationId);
    });
    it("discards a client-sent version header on unversioned paths", () => {
      process.env["APP_MODE"] = "all";
      const res = run("/api/listings", { [VERSION_HEADER]: "v1" });
      expect(res.headers.get(`x-middleware-request-${VERSION_HEADER}`)).toBeNull();
      expect(res.headers.get("x-middleware-override-headers")).not.toContain(VERSION_HEADER);
    });
    it("applies the deployment split to the route a version maps to", () => {
      process.env["APP_MODE"] = "public";
      expect(run("/api/v1/staff/me").status).toBe(404);
      process.env["APP_MODE"] = "admin";
      expect(run("/api/v1/listings").status).toBe(404);
      expect(run("/api/v1/staff/me").headers.get("x-middleware-rewrite")).toContain("/api/staff/me");
    });
  });
});

describe("v1 error format", () => {
  const C = "corr-123456";
  it("gives every code a matching error status", () => {
    for (const [code, status] of Object.entries(API_ERROR_CODES)) {
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
    expect(codeForStatus(400)).toBe("invalid_input");
    expect(codeForStatus(401)).toBe("unauthenticated");
    expect(codeForStatus(418)).toBe("invalid_input");
    expect(codeForStatus(504)).toBe("internal");
  });
  it("turns a route's { error } into { error: { code, message, correlationId } }", () => {
    expect(toV1ErrorBody(404, { error: "Listing not found." }, C)).toEqual({ error: { code: "not_found", message: "Listing not found.", correlationId: C } });
    expect(toV1ErrorBody(403, { error: "Only the owner can accept an offer." }, C).error.code).toBe("forbidden");
  });
  it("keeps fields, reasons and nextStep, and names a missing verification step", () => {
    const b = toV1ErrorBody(400, { error: "Check the form.", fields: { email: "Enter an email." } }, C);
    expect(b.error).toEqual({ code: "invalid_input", message: "Check the form.", correlationId: C, fields: { email: "Enter an email." } });
    expect(toV1ErrorBody(422, { error: "Blocked.", reasons: ["a", "b"] }, C).error.reasons).toEqual(["a", "b"]);
    const v = toV1ErrorBody(403, { error: "Verify your mobile first.", nextStep: "verify_phone" }, C);
    expect(v.error.code).toBe("verification_required");
    expect(v.error.nextStep).toBe("verify_phone");
  });
  it("uses a route's own code when it is a known one, and files any other code and extras under details", () => {
    expect(toV1ErrorBody(403, { error: "Confirm it's you.", code: "mfa_required", nextStep: "verify_mfa" }, C).error.code).toBe("mfa_required");
    const k = toV1ErrorBody(503, { error: "Encryption key not configured.", code: "key_not_configured" }, C);
    expect(k.error.code).toBe("unavailable");
    expect(k.error.details).toEqual({ reason: "key_not_configured" });
    expect(toV1ErrorBody(409, { error: "x", outcome: "not_configured" }, C).error.details).toEqual({ outcome: "not_configured" });
  });
  it("handles plain-text and empty error bodies", () => {
    expect(toV1ErrorBody(404, "Not found", C).error).toEqual({ code: "not_found", message: "Not found", correlationId: C });
    expect(toV1ErrorBody(500, "", C).error.message).toMatch(/went wrong/);
    expect(toV1ErrorBody(503, null, C).error.code).toBe("unavailable");
  });
});

/** Behaves like the SQL store: one row per (scope, key). */
function memoryStore() {
  const rows = new Map<string, { hash: string; done?: StoredResponse }>();
  const store: IdempotencyStore = {
    async claim(scope, key, hash): Promise<Claim> {
      const k = `${scope}|${key}`;
      const r = rows.get(k);
      if (!r) { rows.set(k, { hash }); return { kind: "claimed" }; }
      if (r.hash !== hash) return { kind: "mismatch" };
      return r.done ? { kind: "replay", response: r.done } : { kind: "in_progress" };
    },
    async complete(scope, key, res) { const r = rows.get(`${scope}|${key}`); if (r) r.done = res; },
    async release(scope, key) { const r = rows.get(`${scope}|${key}`); if (r && !r.done) rows.delete(`${scope}|${key}`); }
  };
  return { store, rows };
}

describe("withApi", () => {
  const SECRET = "s".repeat(40);
  let mem: ReturnType<typeof memoryStore>;
  let calls: number;
  let n: number;
  const withApi = (store?: IdempotencyStore) => createWithApi({ store: () => store ?? mem.store, secret: () => SECRET, newId: () => `generated-${++n}`, nowSeconds: () => 1_800_000_000 });
  const req = (p: string, o: { method?: string; v1?: boolean; key?: string; body?: string; uid?: string; corr?: string } = {}) => new Request(`http://test${p}`, {
    method: o.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(o.v1 ? { [VERSION_HEADER]: "v1" } : {}),
      ...(o.key ? { "idempotency-key": o.key } : {}),
      ...(o.uid ? { cookie: `${SESSION_COOKIE}=${signSession({ uid: o.uid, ut: "owner", exp: 1_800_000_100 }, SECRET)}` } : {}),
      ...(o.corr ? { "x-correlation-id": o.corr } : {})
    },
    ...(o.method === "GET" ? {} : { body: o.body ?? "{}" })
  });
  beforeEach(() => { mem = memoryStore(); calls = 0; n = 0; });

  const created = withApi()(async (r: Request) => {
    calls++;
    const b = await r.json();
    const res = NextResponse.json({ id: `id-${calls}`, echo: b }, { status: 201, headers: { location: `/x/${calls}` } });
    res.cookies.set("ol_session", "fresh");
    return res;
  });
  const failing = withApi()(async (_r: Request) => { calls++; return NextResponse.json({ error: "Title is required.", fields: { title: "Required." } }, { status: 400 }); });

  it("leaves unversioned responses exactly as written, adding only X-Correlation-Id", async () => {
    const res = await failing(req("/api/listings"));
    expect(await res.json()).toEqual({ error: "Title is required.", fields: { title: "Required." } });
    expect(res.headers.get("x-correlation-id")).toBe("generated-1");
    expect(res.headers.get("api-version")).toBeNull();
  });
  it("answers v1 errors in the v1 format, with the version and correlation headers", async () => {
    const res = await failing(req("/api/listings", { v1: true, key: randomUUID(), corr: "client-corr-1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "invalid_input", message: "Title is required.", correlationId: "client-corr-1", fields: { title: "Required." } } });
    expect(res.headers.get("api-version")).toBe("v1");
    expect(res.headers.get("x-correlation-id")).toBe("client-corr-1");
  });
  it("ignores a malformed correlation id from the client", async () => {
    const res = await failing(req("/api/listings", { corr: "<script>" }));
    expect(res.headers.get("x-correlation-id")).toBe("generated-1");
  });
  it("requires a UUID Idempotency-Key on v1 writes, never on reads or legacy writes", async () => {
    const missing = await created(req("/api/listings", { v1: true }));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe("idempotency_key_required");
    const bad = await created(req("/api/listings", { v1: true, key: "not-a-uuid" }));
    expect((await bad.json()).error.code).toBe("idempotency_key_invalid");
    expect(calls).toBe(0);
    const read = withApi()(async (_r: Request) => { calls++; return NextResponse.json({ ok: true }); });
    expect((await read(req("/api/listings", { method: "GET", v1: true }))).status).toBe(200);
    expect((await created(req("/api/listings"))).status).toBe(201);
    expect(calls).toBe(2);
  });
  it("replays the first successful result for a repeat with the same key, without running the handler again", async () => {
    const key = randomUUID();
    const first = await created(req("/api/listings", { v1: true, key, body: '{"t":1}', uid: "u1" }));
    const again = await created(req("/api/listings", { v1: true, key, body: '{"t":1}', uid: "u1" }));
    expect(calls).toBe(1);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(await first.json());
    expect(again.headers.get("location")).toBe("/x/1");
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    // Cookies are never replayed.
    expect(first.headers.getSetCookie().length).toBe(1);
    expect(again.headers.getSetCookie()).toEqual([]);
  });
  it("honours a key on legacy writes too", async () => {
    const key = randomUUID();
    await created(req("/api/listings", { key }));
    await created(req("/api/listings", { key }));
    expect(calls).toBe(1);
  });
  it("refuses the same key for a different request, and keeps keys separate per caller", async () => {
    const key = randomUUID();
    await created(req("/api/listings", { v1: true, key, body: '{"t":1}', uid: "u1" }));
    const other = await created(req("/api/listings", { v1: true, key, body: '{"t":2}', uid: "u1" }));
    expect(other.status).toBe(422);
    expect((await other.json()).error.code).toBe("idempotency_key_reused");
    const otherPath = await created(req("/api/listings/abc", { v1: true, key, body: '{"t":1}', uid: "u1" }));
    expect(otherPath.status).toBe(422);
    const otherUser = await created(req("/api/listings", { v1: true, key, body: '{"t":1}', uid: "u2" }));
    expect(otherUser.status).toBe(201);
    expect((await otherUser.json()).id).toBe("id-2");
  });
  it("answers 409 while the first request is still running", async () => {
    let release!: () => void;
    const slow = withApi()(async (_r: Request) => { calls++; await new Promise<void>(r => { release = r; }); return NextResponse.json({ ok: true }); });
    const key = randomUUID();
    const first = slow(req("/api/x", { v1: true, key }));
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await slow(req("/api/x", { v1: true, key }));
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("idempotency_in_progress");
    expect(second.headers.get("retry-after")).toBe("1");
    release();
    expect((await first).status).toBe(200);
  });
  it("does not store a failed result, so the same key can be retried", async () => {
    const key = randomUUID();
    await failing(req("/api/listings", { v1: true, key }));
    await failing(req("/api/listings", { v1: true, key }));
    expect(calls).toBe(2);
    expect(mem.rows.size).toBe(0);
  });
  it("turns a thrown error into a v1 internal error and releases the key; legacy rethrows", async () => {
    const boom = withApi()(async (_r: Request) => { calls++; throw new Error("db down: secret detail"); });
    const key = randomUUID();
    const res = await boom(req("/api/x", { v1: true, key }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("secret detail");
    expect(mem.rows.size).toBe(0);
    await expect(boom(req("/api/x", { key: randomUUID() }))).rejects.toThrow();
  });
  it("leaves sign-in, webhooks and internal jobs out of idempotency", async () => {
    const hook = withApi()(async (_r: Request) => { calls++; return NextResponse.json({ ok: true }); });
    for (const p of ["/api/webhooks/payway", "/api/auth/logout", "/api/internal/alerts/dispatch"]) {
      expect((await hook(req(p, { v1: true }))).status).toBe(200);
    }
    expect(mem.rows.size).toBe(0);
  });
  it("hashes method, path with query, and body", () => {
    const b = new TextEncoder().encode("{}");
    expect(requestHash("post", "/a?x=1", b)).toBe(requestHash("POST", "/a?x=1", b));
    expect(requestHash("POST", "/a?x=1", b)).not.toBe(requestHash("POST", "/a?x=2", b));
    expect(requestHash("POST", "/a", b)).not.toBe(requestHash("PUT", "/a", b));
  });
});

describe.skipIf(!DATABASE_URL)("idempotency on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.close(); });
  const res: StoredResponse = { status: 201, headers: { "content-type": "application/json" }, body: '{"id":"a"}' };

  it("claims once, replays after completion, and refuses a different request", async () => {
    const s = createPgIdempotencyStore(t.db);
    const key = randomUUID();
    expect(await s.claim("user:1", key, "h".repeat(64), "POST", "/api/x")).toEqual({ kind: "claimed" });
    expect(await s.claim("user:1", key, "h".repeat(64), "POST", "/api/x")).toEqual({ kind: "in_progress" });
    expect(await s.claim("user:1", key, "g".repeat(64), "POST", "/api/x")).toEqual({ kind: "mismatch" });
    expect(await s.claim("user:2", key, "g".repeat(64), "POST", "/api/x")).toEqual({ kind: "claimed" });
    await s.complete("user:1", key, res);
    expect(await s.claim("user:1", key, "h".repeat(64), "POST", "/api/x")).toEqual({ kind: "replay", response: res });
    await s.release("user:1", key);
    expect((await s.claim("user:1", key, "h".repeat(64), "POST", "/api/x")).kind).toBe("replay");
  });
  it("frees a released key and takes over an expired one or an abandoned claim for the same request", async () => {
    const s = createPgIdempotencyStore(t.db);
    const key = randomUUID();
    await s.claim("anon:x", key, "h".repeat(64), "POST", "/api/x");
    await s.release("anon:x", key);
    expect((await s.claim("anon:x", key, "g".repeat(64), "POST", "/api/x")).kind).toBe("claimed");
    await t.db.query("UPDATE api_idempotency_key SET locked_at = now() - interval '5 minutes' WHERE idem_key = $1", [key]);
    expect((await s.claim("anon:x", key, "h".repeat(64), "POST", "/api/x")).kind).toBe("mismatch");
    expect((await s.claim("anon:x", key, "g".repeat(64), "POST", "/api/x")).kind).toBe("claimed");
    await s.complete("anon:x", key, res);
    await t.db.query("UPDATE api_idempotency_key SET expires_at = now() - interval '1 second' WHERE idem_key = $1", [key]);
    expect((await s.claim("anon:x", key, "z".repeat(64), "POST", "/api/x")).kind).toBe("claimed");
  });

  it("creates one listing for two identical v1 requests through the real route", async () => {
    state.db = t.db;
    state.actor = { userId: "owner-1", userType: "owner" };
    let n = 0;
    state.deps = { repo: createInMemoryListingRepository(), appendAudit: async () => {}, now: () => "2026-10-25T00:00:00.000Z", newId: () => `l-${++n}`, requiredDisclosures: () => [], termsCurrentFor: async () => true };
    process.env["APP_URL"] = "http://test";
    const key = randomUUID();
    const body = JSON.stringify({ title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD", transactionType: "sale", useClass: "residential", propertyType: "house" });
    const send = () => createListing(new Request("http://test/api/listings", {
      method: "POST", body, headers: { "content-type": "application/json", origin: "http://test", "idempotency-key": key, [VERSION_HEADER]: "v1" }
    }));
    const a = await send();
    const idsAfterFirst = n;
    const b = await send();
    expect(a.status, await a.clone().text()).toBeLessThan(300);
    expect(idsAfterFirst).toBeGreaterThan(0);
    // The repeat ran nothing: no new ids were taken, and the answer is the first one.
    expect(n).toBe(idsAfterFirst);
    expect(await b.json()).toEqual(await a.json());
    expect(b.headers.get("idempotent-replayed")).toBe("true");
  });
});
