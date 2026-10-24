import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isAllowed } from "../src/config/app-mode";
import { DEFAULT_THEME, type ThemeSettings } from "../src/domain/site-theme";
import { staffCan, type StaffActor, type StaffRole } from "../src/domain/staff-access";
import { sectionsFor } from "../src/domain/staff-admin";
import { signStaffSession } from "../src/server/auth/staff-session";
import { PREVIEW_TTL_SECONDS, signPreviewToken, verifyPreviewToken } from "../src/server/theme-preview";

const state = vi.hoisted(() => ({
  staff: null as { id: string; role: string } | null,
  dbTouched: 0,
  calls: [] as { fn: string; args: unknown[] }[],
  outcome: { ok: true, version: 5, changed: [] } as Record<string, unknown>,
  asset: null as null | { contentType: string; bytes: Buffer; sha256: string },
  assetScope: "" as string,
  assetThrows: false
}));
vi.mock("../src/server/context", () => ({
  getActor: () => null,
  getDb: () => { state.dbTouched++; return { query: async () => ({ rows: [] }) }; },
  getStaff: async () => state.staff
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/site-theme-db", () => {
  const rec = (fn: string) => async (...args: unknown[]) => { state.calls.push({ fn, args: args.slice(2) }); return state.outcome; };
  return {
    loadView: async () => ({ draftVersion: 5, publishedVersion: 4, draft: DEFAULT_THEME, published: DEFAULT_THEME, versions: [] }),
    saveDraft: rec("saveDraft"), publishDraft: rec("publishDraft"), revertTo: rec("revertTo"), resetToDefaults: rec("resetToDefaults"),
    insertAsset: async (...args: unknown[]) => { state.calls.push({ fn: "insertAsset", args: args.slice(2) }); return 77; },
    loadAssetFile: async (_db: unknown, _n: string, _id: number, scope: string) => { state.assetScope = scope; if (state.assetThrows) throw new Error("down"); return state.asset; }
  };
});

import * as siteRoute from "../app/api/staff/site/route";
import * as publishRoute from "../app/api/staff/site/publish/route";
import * as revertRoute from "../app/api/staff/site/revert/route";
import * as resetRoute from "../app/api/staff/site/reset/route";
import * as previewRoute from "../app/api/staff/site/preview/route";
import * as uploadRoute from "../app/api/staff/site/asset/route";
import * as assetRoute from "../app/api/site/asset/[name]/route";
import { proxy } from "../proxy";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ROLES: StaffRole[] = ["super_admin", "compliance", "accountant", "support", "technical", "reporting", "designer"];
const ALLOWED: StaffRole[] = ["super_admin", "designer"];
const SECRET = "preview-secret-0123456789-0123456789-abcd";
const ENV_KEYS = ["APP_URL", "ADMIN_APP_URL", "APP_MODE", "THEME_PREVIEW_SECRET"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["APP_URL"] = "http://test"; delete process.env["APP_MODE"]; process.env["THEME_PREVIEW_SECRET"] = SECRET;
  state.staff = null; state.dbTouched = 0; state.calls = []; state.outcome = { ok: true, version: 5, changed: [] }; state.asset = null; state.assetThrows = false;
});
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const JSON_H = { "content-type": "application/json", origin: "http://test" };
const req = (method: string, body?: unknown, headers: Record<string, string> = JSON_H) =>
  new Request("http://test/x", { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
const as = (role: StaffRole) => { state.staff = { id: U(1), role }; };
const settings = (f?: (t: ThemeSettings) => void) => { const t = structuredClone(DEFAULT_THEME); f?.(t); return t; };

describe("permission theme.edit", () => {
  it("is held by super_admin and designer only", () => {
    for (const r of ROLES) expect(staffCan({ id: U(1), role: r }, "theme.edit"), r).toBe(ALLOWED.includes(r));
  });
  it("designer has no other permission", () => {
    const perms = ["report.sales", "pii.view_full", "pricing.manage", "staff.manage", "config.edit", "case.manage", "identity.review", "override.request", "logs.technical"] as const;
    for (const p of perms) expect(staffCan({ id: U(1), role: "designer" }, p), p).toBe(false);
  });
  it("shows the Site appearance link to those roles only", () => {
    for (const r of ROLES) expect(sectionsFor({ id: U(1), role: r }).some(s => s.href === "/staff/site"), r).toBe(ALLOWED.includes(r));
  });
});

describe("every staff site route is denied to other roles and to anonymous callers, before touching the database", () => {
  const calls: [string, () => Promise<Response>][] = [
    ["GET site", () => siteRoute.GET(req("GET", undefined, {}))],
    ["PUT site", () => siteRoute.PUT(req("PUT", { baseVersion: null, settings: settings() }))],
    ["POST publish", () => publishRoute.POST(req("POST", { version: 5 }))],
    ["POST revert", () => revertRoute.POST(req("POST", { version: 1 }))],
    ["POST reset", () => resetRoute.POST(req("POST", { baseVersion: null }))],
    ["POST preview", () => previewRoute.POST(req("POST", {}))],
    ["POST asset", () => uploadRoute.POST(req("POST", { name: "logo-light", contentType: "image/png", data: "AAAA" }))]
  ];
  for (const [name, run] of calls) {
    it(`${name}: 401 without a staff session`, async () => {
      expect((await run()).status).toBe(401);
      expect(state.dbTouched).toBe(0);
    });
    it.each(ROLES.filter(r => !ALLOWED.includes(r)))(`${name}: 403 for %s`, async role => {
      as(role);
      expect((await run()).status).toBe(403);
      expect(state.calls).toEqual([]);
      expect(state.dbTouched).toBe(0);
    });
  }
  it("state-changing calls are refused cross-origin and without JSON, even for a designer", async () => {
    as("designer");
    const body = { baseVersion: null, settings: settings() };
    expect((await siteRoute.PUT(req("PUT", body, { "content-type": "application/json", origin: "http://evil.test" }))).status).toBe(403);
    expect((await siteRoute.PUT(req("PUT", body, { "content-type": "text/plain", origin: "http://test" }))).status).toBe(403);
    expect((await siteRoute.PUT(req("PUT", body, { "content-type": "application/json" }))).status).toBe(403);
    expect((await publishRoute.POST(req("POST", { version: 5 }, { "content-type": "application/json", origin: "http://evil.test" }))).status).toBe(403);
    expect((await revertRoute.POST(req("POST", { version: 1 }, { "content-type": "application/json", origin: "http://evil.test" }))).status).toBe(403);
    expect((await previewRoute.POST(req("POST", {}, { "content-type": "application/json", origin: "http://evil.test" }))).status).toBe(403);
    expect((await uploadRoute.POST(req("POST", {}, { "content-type": "application/json", origin: "http://evil.test" }))).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
});

describe("GET and PUT /api/staff/site", () => {
  it.each(ALLOWED)("%s can read the editor data (no-store) with option lists", async role => {
    as(role);
    const r = await siteRoute.GET(req("GET", undefined, {}));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const b = await r.json();
    expect(b.defaults).toEqual(DEFAULT_THEME);
    expect(b.options.fonts.length).toBeGreaterThan(10);
    expect(b.options.nav.map((n: { id: string }) => n.id)).toContain("browse");
    expect(JSON.stringify(b.options)).not.toMatch(/googleapis/);
  });
  it("saves valid settings as a draft and passes the normalised object and base version on", async () => {
    as("designer");
    const r = await siteRoute.PUT(req("PUT", { baseVersion: 5, settings: settings(t => { t.colours.light.accent = "#0B5FD6"; t.brand.siteName = " Acme "; }) }));
    expect(r.status).toBe(200);
    const call = state.calls.find(c => c.fn === "saveDraft")!;
    expect(call.args[0]).toBe(5);
    expect((call.args[1] as ThemeSettings).colours.light.accent).toBe("#0b5fd6");
    expect((call.args[1] as ThemeSettings).brand.siteName).toBe("Acme");
  });
  const attacks: [string, (t: ThemeSettings) => void, string][] = [
    ["CSS break-out in a colour", t => { t.colours.light.bg = "red;}body{display:none"; }, "colours.light.bg"],
    ["url(javascript:) as a colour", t => { t.colours.dark.link = "url(javascript:alert(1))"; }, "colours.dark.link"],
    ["script in the site name", t => { t.brand.siteName = "<script>alert(1)</script>"; }, "brand.siteName"],
    ["javascript: footer link", t => { t.footer.links = [{ label: "x", href: "javascript:alert(1)" }]; }, "footer.links.0.href"],
    ["huge radius", t => { t.layout.radius = 1e9; }, "layout.radius"],
    ["huge font size", t => { t.typography.baseSize = Number.MAX_SAFE_INTEGER; }, "typography.baseSize"],
    ["font injection", t => { t.typography.bodyFont = "x;}body{display:none"; }, "typography.bodyFont"],
    ["low contrast", t => { t.colours.light.text = "#fafafa"; }, "colours.light.text"]
  ];
  it.each(attacks)("rejects %s with 400 and field errors; nothing is saved", async (_n, f, field) => {
    as("designer");
    const r = await siteRoute.PUT(req("PUT", { baseVersion: null, settings: settings(f) }));
    expect(r.status).toBe(400);
    expect((await r.json()).fields[field]).toBeTruthy();
    expect(state.calls).toEqual([]);
  });
  it("rejects raw CSS or HTML sent as extra fields or as the whole settings", async () => {
    as("designer");
    const extra = { ...settings(), customCss: "body{display:none}" };
    expect((await siteRoute.PUT(req("PUT", { baseVersion: null, settings: extra }))).status).toBe(400);
    expect((await siteRoute.PUT(req("PUT", { baseVersion: null, settings: "body{display:none}" }))).status).toBe(400);
    expect((await siteRoute.PUT(req("PUT", { baseVersion: null, css: "x" }))).status).toBe(400);
    expect(state.calls).toEqual([]);
  });
  it("rejects a bad base version, bad JSON and an oversize body", async () => {
    as("designer");
    for (const b of [0, -1, 1.5, "5", {}]) expect((await siteRoute.PUT(req("PUT", { baseVersion: b, settings: settings() }))).status, JSON.stringify(b)).toBe(400);
    expect((await siteRoute.PUT(req("PUT", "{not json"))).status).toBe(400);
    expect((await siteRoute.PUT(req("PUT", "[]"))).status).toBe(400);
    const big = JSON.stringify({ baseVersion: null, settings: settings(), pad: "x".repeat(70_000) });
    expect((await siteRoute.PUT(req("PUT", big))).status).toBe(413);
    expect(state.calls).toEqual([]);
  });
  it("maps a stale draft to 409", async () => {
    as("designer");
    state.outcome = { ok: false, code: "conflict", error: "The draft changed" };
    expect((await siteRoute.PUT(req("PUT", { baseVersion: 3, settings: settings() }))).status).toBe(409);
    state.outcome = { ok: false, code: "bad_asset", error: "bad" };
    expect((await siteRoute.PUT(req("PUT", { baseVersion: 3, settings: settings() }))).status).toBe(400);
  });
});

describe("publish, revert and reset", () => {
  it("publish needs the draft version; revert needs a version; reset needs the base version", async () => {
    as("super_admin");
    expect((await publishRoute.POST(req("POST", {}))).status).toBe(400);
    expect((await publishRoute.POST(req("POST", { version: "5" }))).status).toBe(400);
    expect((await publishRoute.POST(req("POST", { version: null }))).status).toBe(400);
    expect((await revertRoute.POST(req("POST", { version: -2 }))).status).toBe(400);
    expect((await resetRoute.POST(req("POST", { baseVersion: "x" }))).status).toBe(400);
    expect(state.calls).toEqual([]);
    expect((await publishRoute.POST(req("POST", { version: 5 }))).status).toBe(200);
    expect((await revertRoute.POST(req("POST", { version: 2 }))).status).toBe(200);
    expect((await resetRoute.POST(req("POST", { baseVersion: null }))).status).toBe(200);
    expect(state.calls.map(c => [c.fn, c.args[0]])).toEqual([["publishDraft", 5], ["revertTo", 2], ["resetToDefaults", null]]);
  });
  it("maps outcomes: conflict 409, unknown version 404", async () => {
    as("designer");
    state.outcome = { ok: false, code: "conflict", error: "stale" };
    expect((await publishRoute.POST(req("POST", { version: 5 }))).status).toBe(409);
    state.outcome = { ok: false, code: "not_found", error: "no" };
    expect((await revertRoute.POST(req("POST", { version: 99 }))).status).toBe(404);
  });
});

describe("preview token", () => {
  it("is issued to staff with theme.edit, verifies, and expires after 15 minutes", async () => {
    as("designer");
    const r = await previewRoute.POST(req("POST", {}));
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(r.headers.get("cache-control")).toBe("no-store");
    const token = new URL(b.url, "http://x").searchParams.get("theme_preview")!;
    expect(b.url).toMatch(/^\/\?theme_preview=/);
    const now = Math.floor(Date.now() / 1000);
    expect(verifyPreviewToken(token, SECRET, now)).toEqual({ uid: U(1) });
    expect(verifyPreviewToken(token, SECRET, now + PREVIEW_TTL_SECONDS - 5)).toEqual({ uid: U(1) });
    expect(verifyPreviewToken(token, SECRET, now + PREVIEW_TTL_SECONDS + 5)).toBeNull();
    expect(Math.abs(Date.parse(b.expiresAt) / 1000 - (now + PREVIEW_TTL_SECONDS))).toBeLessThan(5);
  });
  it("is refused when tampered, signed with another secret, expired, malformed, too long, or when the secret is too short", () => {
    const now = 1_800_000_000;
    const ok = signPreviewToken({ uid: U(1), exp: now + 60 }, SECRET);
    expect(verifyPreviewToken(ok, SECRET, now)).not.toBeNull();
    const [body, sig] = ok.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ uid: U(2), exp: now + 60 })).toString("base64url");
    expect(verifyPreviewToken(`${forged}.${sig}`, SECRET, now)).toBeNull();
    expect(verifyPreviewToken(`${body}.${sig.slice(0, -2)}AA`, SECRET, now)).toBeNull();
    expect(verifyPreviewToken(ok, "q".repeat(40), now)).toBeNull();
    expect(verifyPreviewToken(signPreviewToken({ uid: U(1), exp: now - 1 }, SECRET), SECRET, now)).toBeNull();
    expect(verifyPreviewToken(signPreviewToken({ uid: U(1), exp: now + 86_400 }, SECRET), SECRET, now)).toBeNull(); // lifetime is capped
    for (const bad of ["", "a", "a.b.c", ".", `${body}.`, "x".repeat(500)]) expect(verifyPreviewToken(bad, SECRET, now), bad).toBeNull();
    expect(verifyPreviewToken(ok, undefined, now)).toBeNull();
    expect(verifyPreviewToken(ok, "short", now)).toBeNull();
    expect(verifyPreviewToken(signPreviewToken({ uid: U(1), exp: now + 60 }, "short"), "short", now)).toBeNull();
  });
  it("a staff session cookie is not a preview token (domain separation), nor the reverse", () => {
    const now = 1_800_000_000;
    const session = signStaffSession({ uid: U(1), exp: now + 60 }, SECRET);
    expect(verifyPreviewToken(session, SECRET, now)).toBeNull();
  });
  it("fails closed without THEME_PREVIEW_SECRET, and on the admin site without APP_URL", async () => {
    as("designer");
    delete process.env["THEME_PREVIEW_SECRET"];
    expect((await previewRoute.POST(req("POST", {}))).status).toBe(503);
    process.env["THEME_PREVIEW_SECRET"] = "short";
    expect((await previewRoute.POST(req("POST", {}))).status).toBe(503);
    process.env["THEME_PREVIEW_SECRET"] = SECRET;
    process.env["APP_MODE"] = "admin"; process.env["ADMIN_APP_URL"] = "http://test"; delete process.env["APP_URL"];
    expect((await previewRoute.POST(req("POST", {}))).status).toBe(503);
    process.env["APP_URL"] = "https://www.example.com.au/ignored/path";
    const r = await previewRoute.POST(req("POST", {}));
    expect(r.status).toBe(200);
    expect((await r.json()).url).toMatch(/^https:\/\/www\.example\.com\.au\/\?theme_preview=/);
  });
});

describe("logo and favicon upload", () => {
  const png = (w = 100, h = 100) => {
    const b = Buffer.alloc(120);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return b;
  };
  const up = (name: unknown, contentType: unknown, data: Buffer | string) =>
    uploadRoute.POST(req("POST", { name, contentType, data: typeof data === "string" ? data : data.toString("base64") }));

  it("stores a valid PNG with the type found from its bytes", async () => {
    as("designer");
    const r = await up("logo-light", "image/png", png());
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: 77, contentType: "image/png", width: 100, height: 100 });
    const call = state.calls.find(c => c.fn === "insertAsset")!;
    expect(call.args[0]).toMatchObject({ name: "logo-light", contentType: "image/png", width: 100, height: 100 });
  });
  it("rejects SVG, spoofed types, oversize, bad dimensions, bad base64 and unknown slots", async () => {
    as("designer");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const type of ["image/svg+xml", "image/png"]) expect((await up("logo-light", type, svg)).status, type).toBe(400);
    expect((await up("logo-light", "image/jpeg", png())).status).toBe(400);
    expect((await up("logo-light", "text/html", png())).status).toBe(400);
    expect((await up("logo-light", "image/png", png(5000, 100))).status).toBe(400);
    expect((await up("favicon", "image/png", png(600, 600))).status).toBe(400);
    expect((await up("logo-light", "image/png", Buffer.concat([png(), Buffer.alloc(524288 - 120 + 1)]))).status).toBe(400);
    expect((await up("logo-light", "image/png", "not base64 !!!")).status).toBe(400);
    expect((await up("logo-light", "image/png", "")).status).toBe(400);
    expect((await up("logo-light", "image/png", "A".repeat(800_000))).status).toBe(413);
    expect((await up("../../x", "image/png", png())).status).toBe(400);
    expect((await up("logo-light", "image/png", Buffer.from("GIF89a" + "x".repeat(100)))).status).toBe(400);
    expect(state.calls).toEqual([]);
  });
});

describe("public asset route /api/site/asset/<name>", () => {
  const call = (path: string, headers: Record<string, string> = {}) => {
    const name = path.split("?")[0]!.split("/").pop()!;
    return assetRoute.GET(new Request(`http://test${path}`, { headers }), { params: Promise.resolve({ name }) });
  };
  beforeEach(() => { state.asset = { contentType: "image/png", bytes: Buffer.from([1, 2, 3]), sha256: "ab".repeat(32) }; });

  it("serves a published image with a fixed type, nosniff, a sandbox CSP and a one-year immutable cache", async () => {
    const r = await call("/api/site/asset/logo-light?v=12");
    expect(r.status).toBe(200);
    expect(state.assetScope).toBe("published");
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(r.headers.get("etag")).toBe(`"${"ab".repeat(32)}"`);
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3]);
  });
  it("answers 304 to a matching ETag", async () => {
    const r = await call("/api/site/asset/logo-light?v=12", { "if-none-match": `"${"ab".repeat(32)}"` });
    expect(r.status).toBe(304);
  });
  it("404 for unknown names, a missing or non-numeric version, or an image the published version does not use", async () => {
    expect((await call("/api/site/asset/evil?v=1")).status).toBe(404);
    expect((await call("/api/site/asset/logo-light")).status).toBe(404);
    for (const v of ["abc", "0", "-1", "1.5", "1e3", "01", "9".repeat(20), "1;DROP"]) expect((await call(`/api/site/asset/logo-light?v=${encodeURIComponent(v)}`)).status, v).toBe(404);
    state.asset = null;
    expect((await call("/api/site/asset/logo-light?v=999")).status).toBe(404);
  });
  it("a draft image is served only with a valid preview token, and never cached", async () => {
    const tok = signPreviewToken({ uid: U(1), exp: Math.floor(Date.now() / 1000) + 300 }, SECRET);
    const r = await call(`/api/site/asset/logo-light?v=12&theme_preview=${encodeURIComponent(tok)}`);
    expect(state.assetScope).toBe("draft");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    await call("/api/site/asset/logo-light?v=12&theme_preview=garbage");
    expect(state.assetScope).toBe("published");
    const expired = signPreviewToken({ uid: U(1), exp: Math.floor(Date.now() / 1000) - 5 }, SECRET);
    await call(`/api/site/asset/logo-light?v=12&theme_preview=${encodeURIComponent(expired)}`);
    expect(state.assetScope).toBe("published");
  });
  it("503 (not cached) when the database is down", async () => {
    state.assetThrows = true;
    const r = await call("/api/site/asset/logo-light?v=12");
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("deployment split and the preview header", () => {
  it("the admin site serves the read-only image route; no other public route", () => {
    for (const n of ["logo-light", "logo-dark", "favicon"]) expect(isAllowed("admin", `/api/site/asset/${n}`, null, undefined)).toBe(true);
    expect(isAllowed("admin", "/api/site/asset/../../listings", null, undefined)).toBe(false);
    expect(isAllowed("admin", "/api/site/asset/other", null, undefined)).toBe(false);
    expect(isAllowed("admin", "/api/site/asset/%6cogo-light", null, undefined)).toBe(true);
    expect(isAllowed("public", "/api/site/asset/logo-light", null, undefined)).toBe(true);
    expect(isAllowed("public", "/api/staff/site", null, undefined)).toBe(false);
    expect(isAllowed("public", "/staff/site", null, undefined)).toBe(false);
    expect(isAllowed("admin", "/staff/site", null, undefined)).toBe(true);
    expect(isAllowed("admin", "/api/staff/site/publish", null, undefined)).toBe(true);
  });
  it("proxy drops a client-sent x-theme-preview header and forwards only a shape-valid token", () => {
    const res = (url: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`https://x.example${url}`, { headers }));
    const fwd = (r: Response) => r.headers.get("x-middleware-request-x-theme-preview");
    expect(fwd(res("/", { "x-theme-preview": "spoofed.value" }))).toBeNull();
    expect(fwd(res("/?theme_preview=abc.def"))).toBe("abc.def");
    expect(fwd(res("/?theme_preview=" + encodeURIComponent("a b<script>")))).toBeNull();
    expect(fwd(res("/?theme_preview=" + "a".repeat(401)))).toBeNull();
    expect(fwd(res("/", { cookie: "ol_theme_preview=abc.def" }))).toBe("abc.def");
    const withQuery = res("/?theme_preview=abc.def");
    expect(withQuery.headers.get("cache-control")).toBe("private, no-store");
    expect(withQuery.headers.get("set-cookie")).toMatch(/ol_theme_preview=abc\.def;.*HttpOnly/i);
    expect(res("/").headers.get("set-cookie")).toBeNull();
  });
});
