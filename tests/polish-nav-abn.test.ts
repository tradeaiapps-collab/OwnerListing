import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkAbn, abnLiveState, formatAbn, parseOptionalAbn, ABN_UNVERIFIED_NOTE, type AbnLookupPort } from "../src/domain/abn";
import type { StaffActor } from "../src/domain/staff-access";
import { sectionsFor, STAFF_SECTIONS } from "../src/domain/staff-admin";
import { ABN_CHECK_RATE, runAbnCheck } from "../src/server/abn-check";
import { AdminNavView, whoFromStaffMe } from "../app/admin-nav";
import SiteNav from "../app/site-nav";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, queries: [] as { text: string; params: unknown[] }[], updated: 1 }));
vi.mock("../src/server/context", () => ({
  getActor: () => null,
  getDb: () => ({ query: async (text: string, params: unknown[] = []) => { state.queries.push({ text, params }); return { rows: /^\s*UPDATE/.test(text) ? Array(state.updated).fill({ id: "x" }) : [] }; } }),
  getStaff: async () => state.staff
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
process.env["APP_URL"] = "http://test";

import * as firmAbn from "../app/api/staff/law-firms/[id]/abn/route";

const root = path.join(__dirname, "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const VALID = "51 824 753 556";
const FIRM = "00000000-0000-4000-8000-000000000001";

describe("mobile menu (SiteNav)", () => {
  const html = renderToStaticMarkup(createElement(SiteNav, {}));
  it("renders a Menu button wired to the links with aria-expanded and aria-controls", () => {
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="site-nav-links"');
    expect(html).toContain('id="site-nav-links"');
    expect(html).toContain('class="nav-toggle"');
  });
  it("keeps the links in the page without JavaScript (collapse only applies once data-js is set)", () => {
    expect(html).toContain("Browse");
    expect(html).not.toContain("data-js");
    expect(read("app/globals.css")).toMatch(/\.site-nav\.has-menu\[data-js\] \.site-nav-links \{\s*display: none/);
  });
  it("hides the button on desktop and gives it a 44px target on phones", () => {
    const css = read("app/globals.css");
    expect(css).toContain(".site-nav .nav-toggle { display: none; }");
    expect(css).toMatch(/\.nav-toggle \{[^}]*min-height: 44px; min-width: 44px/);
  });
  it("closes on Escape and returns focus to the button", () => {
    const src = read("app/site-nav.tsx");
    expect(src).toContain('e.key === "Escape"');
    expect(src).toContain("toggleRef.current?.focus()");
  });
});

describe("admin header", () => {
  const view = (who: Parameters<typeof AdminNavView>[0]["who"]) => renderToStaticMarkup(createElement(AdminNavView, { who }));
  it("shows the role label and Sign out when signed in, and no Sign in", () => {
    const html = view(whoFromStaffMe({ staff: { id: "s", role: "support", roleLabel: "Support officer", permissions: [] } }));
    expect(html).toContain("Support officer");
    expect(html).toContain("Sign out");
    expect(html).not.toContain("Sign in");
  });
  it("falls back to the role key, then to Staff", () => {
    expect(whoFromStaffMe({ staff: { role: "support" } })).toEqual({ state: "in", role: "support" });
    expect(whoFromStaffMe({ staff: {} })).toEqual({ state: "in", role: "Staff" });
  });
  it("shows Sign in only when signed out, and neither while loading", () => {
    expect(view(whoFromStaffMe({ staff: null }))).toContain("Sign in");
    expect(view(whoFromStaffMe(null))).not.toContain("Sign out");
    const loading = view({ state: "loading" });
    expect(loading).not.toContain("Sign in");
    expect(loading).not.toContain("Sign out");
  });
});

describe("staff dashboard sections", () => {
  it("lists Pricing and plans for roles that hold pricing.manage, and hides it from others", () => {
    expect(STAFF_SECTIONS).toContainEqual({ href: "/staff/pricing", label: "Pricing and plans", permissions: ["pricing.manage"] });
    expect(sectionsFor({ id: "a", role: "super_admin" }).map(s => s.href)).toContain("/staff/pricing");
    expect(sectionsFor({ id: "b", role: "support" }).map(s => s.href)).not.toContain("/staff/pricing");
  });
  it("the audit page loads the latest entries on open", () => {
    expect(read("app/staff/audit/page.tsx")).toMatch(/useEffect\(\(\) => \{ void load\(\); \}, \[\]\)/);
  });
});

describe("ABN helpers", () => {
  it("gives live checksum feedback", () => {
    expect(abnLiveState("").state).toBe("empty");
    expect(abnLiveState("5182").state).toBe("incomplete");
    expect(abnLiveState("51 824 753 557").state).toBe("invalid");
    expect(abnLiveState("51a")).toMatchObject({ state: "invalid" });
    expect(abnLiveState(VALID)).toMatchObject({ state: "valid", abn: "51824753556" });
  });
  it("parses an optional ABN to digits only, blank clears, bad is rejected", () => {
    expect(parseOptionalAbn(VALID)).toEqual({ ok: true, abn: "51824753556" });
    expect(parseOptionalAbn("")).toEqual({ ok: true, abn: null });
    expect(parseOptionalAbn(null)).toEqual({ ok: true, abn: null });
    expect(parseOptionalAbn("51824753557").ok).toBe(false);
    expect(parseOptionalAbn(51824753556).ok).toBe(false);
    expect(formatAbn("51824753556")).toBe(VALID);
  });
});

describe("checkAbn (fails closed)", () => {
  const rec = { abn: "51824753556", active: true, entityName: "EXAMPLE PTY LTD", gstRegistered: true };
  it("says checksum valid, not verified, when no register is configured", async () => {
    const r = await checkAbn(VALID, null);
    expect(r).toMatchObject({ checksumValid: true, abn: "51824753556", verification: { status: "not_verified", note: ABN_UNVERIFIED_NOTE } });
    expect(ABN_UNVERIFIED_NOTE.toLowerCase()).toContain("checksum valid, not verified with abr yet");
  });
  it("rejects a bad checksum without calling the register", async () => {
    const port: AbnLookupPort = { lookup: vi.fn() };
    expect(await checkAbn("51824753557", port)).toMatchObject({ checksumValid: false });
    expect(port.lookup).not.toHaveBeenCalled();
  });
  it("returns the register's entity name and GST status, never a client value", async () => {
    const r = await checkAbn({ toString: () => VALID, entityName: "Evil Co" }, { lookup: async () => rec });
    expect(r.checksumValid).toBe(false);
    const ok = await checkAbn(VALID, { lookup: async () => rec });
    expect(ok).toMatchObject({ verification: { status: "verified", entityName: "EXAMPLE PTY LTD", active: true, gstRegistered: true } });
  });
  it("falls back to unverified when the register errors, and reports not found", async () => {
    expect(await checkAbn(VALID, { lookup: async () => { throw new Error("down"); } })).toMatchObject({ verification: { status: "not_verified" } });
    expect(await checkAbn(VALID, { lookup: async () => null })).toMatchObject({ verification: { status: "not_found" } });
  });
});

describe("runAbnCheck rate limit", () => {
  it("refuses past the limit and when the counter gives nothing usable", async () => {
    const port: AbnLookupPort = { lookup: vi.fn(async () => null) };
    const counts = new Map<string, number>();
    const deps = { hit: async (b: string) => { counts.set(b, (counts.get(b) ?? 0) + 1); return counts.get(b); }, port };
    for (let i = 0; i < ABN_CHECK_RATE.perPerson; i++) expect((await runAbnCheck(deps, "u1", VALID)).ok).toBe(true);
    expect(await runAbnCheck(deps, "u1", VALID)).toMatchObject({ ok: false, code: "rate_limited" });
    expect(port.lookup).toHaveBeenCalledTimes(ABN_CHECK_RATE.perPerson);
    expect(await runAbnCheck({ hit: async () => undefined, port }, "u1", VALID)).toMatchObject({ ok: false, code: "rate_limited" });
  });
  it("also limits per address, so many accounts from one IP share a budget", async () => {
    const port: AbnLookupPort = { lookup: vi.fn(async () => null) };
    const counts = new Map<string, number>();
    const deps = { hit: async (b: string) => { counts.set(b, (counts.get(b) ?? 0) + 1); return counts.get(b); }, port };
    for (let i = 0; i < ABN_CHECK_RATE.perIp; i++) expect((await runAbnCheck(deps, `user${i}`, VALID, "203.0.113.9")).ok).toBe(true);
    expect(await runAbnCheck(deps, "another", VALID, "203.0.113.9")).toMatchObject({ ok: false, code: "rate_limited" });
    expect((await runAbnCheck(deps, "another", VALID, "203.0.113.10")).ok).toBe(true);
  });
});

describe("PUT /api/staff/law-firms/[id]/abn", () => {
  const put = (body: unknown, id = FIRM) => firmAbn.PUT(
    new Request("http://test/x", { method: "PUT", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  );
  beforeEach(() => { state.staff = null; state.queries = []; state.updated = 1; });

  it("needs a signed-in staff member with trust_account.approve, before touching the database", async () => {
    expect((await put({ abn: VALID })).status).toBe(401);
    state.staff = { id: "s1", role: "support" };
    expect((await put({ abn: VALID })).status).toBe(403);
    expect(state.queries).toHaveLength(0);
  });
  it("rejects an invalid checksum server side", async () => {
    state.staff = { id: "s1", role: "super_admin" };
    const res = await put({ abn: "51 824 753 557" });
    expect(res.status).toBe(400);
    expect(state.queries).toHaveLength(0);
  });
  it("stores digits only through a bound parameter, and blank clears", async () => {
    state.staff = { id: "s1", role: "compliance" };
    expect((await put({ abn: VALID })).status).toBe(200);
    expect(state.queries[0]).toEqual({ text: expect.stringContaining("$2"), params: [FIRM, "51824753556"] });
    expect(state.queries[0]!.text).not.toContain("51824753556");
    expect((await put({ abn: "" })).status).toBe(200);
    expect(state.queries[1]!.params).toEqual([FIRM, null]);
  });
  it("404s an unknown firm and refuses extra fields", async () => {
    state.staff = { id: "s1", role: "super_admin" };
    state.updated = 0;
    expect((await put({ abn: VALID })).status).toBe(404);
    expect((await put({ abn: VALID, name: "x" })).status).toBe(400);
    expect((await put({ abn: VALID }, "not-a-uuid")).status).toBe(404);
  });
});
