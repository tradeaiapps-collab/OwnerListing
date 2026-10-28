import { beforeEach, describe, expect, it, vi } from "vitest";
import { canResetMfa, lookupEmail, mfaResetEmail, planMfaReset, type MfaResetTarget } from "../src/domain/mfa-reset";
import { isSensitivePermission, staffCan, type StaffRole } from "../src/domain/staff-access";
import { sectionsFor } from "../src/domain/staff-admin";

const state = vi.hoisted(() => ({
  staff: null as { id: string; role: string; permissions?: string[] } | null,
  target: null as Record<string, unknown> | null,
  resets: [] as { staffId: string; userId: string; reason: string }[],
  resetResult: { methodsRevoked: 2, resetAt: "2026-10-28T00:00:00.000Z" } as { methodsRevoked: number; resetAt: string } | null,
  emailConfigured: true,
  sent: [] as { to: string; subject: string; text: string }[],
  audits: [] as { eventType: string; aggregateId: string; payload: Record<string, unknown> }[]
}));
vi.mock("../src/server/context", () => ({ getStaff: async () => state.staff, getDb: () => ({ query: async () => ({ rows: [] }) }) }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string; aggregateId: string; payload: Record<string, unknown> }) => { state.audits.push(e); } }));
vi.mock("../src/server/mfa-reset-db", () => ({
  findMfaResetTarget: async (_db: unknown, by: { email?: string; id?: string }) =>
    state.target && (by.email === state.target["email"] || by.id === state.target["id"]) ? state.target : null,
  resetUserMfa: async (_db: unknown, staffId: string, userId: string, reason: string) => { state.resets.push({ staffId, userId, reason }); return state.resetResult; }
}));
vi.mock("../src/server/messaging", () => ({
  getEmailPort: async () => ({
    configured: state.emailConfigured,
    async send(m: { to: string; subject: string; text: string }) { state.sent.push(m); return { status: "sent" }; }
  })
}));

import * as route from "../app/api/staff/security/mfa-reset/route";

const ROLES: StaffRole[] = ["super_admin", "compliance", "accountant", "support", "technical", "reporting", "designer"];
const ADMIN = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const H = { "content-type": "application/json", origin: "http://test" };
const get = (email: string) => new Request(`http://test/x?email=${encodeURIComponent(email)}`, { headers: H });
const post = (body: unknown, headers: Record<string, string> = H) => new Request("http://test/x", { method: "POST", headers, body: JSON.stringify(body) });
const GOOD = { userId: OWNER, confirmEmail: "Owner@Example.com ", reason: "Lost phone, identity checked on a call" };
const target = (o: Partial<MfaResetTarget> = {}): MfaResetTarget => ({ id: OWNER, email: "owner@example.com", userType: "owner", status: "active", liveMethods: 2, ...o });

beforeEach(() => {
  process.env["APP_URL"] = "http://test"; delete process.env["APP_MODE"];
  state.staff = null; state.target = { ...target(), displayName: "Olive Owner", methods: [], recoveryCodesLeft: 10, resets: [] };
  state.resets = []; state.resetResult = { methodsRevoked: 2, resetAt: "2026-10-28T00:00:00.000Z" }; state.emailConfigured = true; state.sent = []; state.audits = [];
});

describe("user.mfa_reset permission", () => {
  it("is sensitive, held only by super_admin, and shows the screen only to them", () => {
    expect(isSensitivePermission("user.mfa_reset")).toBe(true);
    for (const r of ROLES) expect(staffCan({ id: ADMIN, role: r }, "user.mfa_reset"), r).toBe(r === "super_admin");
    expect(sectionsFor({ id: ADMIN, role: "super_admin" }).some(s => s.href === "/staff/security/mfa-reset")).toBe(true);
    expect(sectionsFor({ id: ADMIN, role: "support" }).some(s => s.href === "/staff/security/mfa-reset")).toBe(false);
  });
  it("a custom role holding the permission still cannot reset", () => {
    expect(canResetMfa({ id: ADMIN, role: "custom_helpdesk", permissions: ["user.mfa_reset"] })).toBe(false);
    expect(canResetMfa({ id: ADMIN, role: "super_admin" })).toBe(true);
  });
});

describe("planMfaReset", () => {
  const admin = { id: ADMIN, role: "super_admin" };
  it("needs the typed email and a 10 to 300 character reason", () => {
    expect(planMfaReset(admin, target(), GOOD)).toEqual({ action: "reset", reason: GOOD.reason });
    expect(planMfaReset(admin, target(), { ...GOOD, confirmEmail: "other@example.com" })).toMatchObject({ action: "deny", status: 400 });
    expect(planMfaReset(admin, target(), { ...GOOD, confirmEmail: undefined })).toMatchObject({ action: "deny", status: 400 });
    expect(planMfaReset(admin, target(), { ...GOOD, reason: "lost" })).toMatchObject({ action: "deny", status: 400 });
    expect(planMfaReset(admin, target(), { ...GOOD, reason: "x".repeat(301) })).toMatchObject({ action: "deny", status: 400 });
  });
  it("refuses other roles, your own account, staff accounts and an account with nothing to reset", () => {
    expect(planMfaReset({ id: ADMIN, role: "support" }, target(), GOOD)).toMatchObject({ status: 403 });
    expect(planMfaReset(admin, target({ id: ADMIN }), GOOD)).toMatchObject({ status: 403 });
    expect(planMfaReset(admin, target({ userType: "admin" }), GOOD)).toMatchObject({ status: 403 });
    expect(planMfaReset(admin, target({ liveMethods: 0 }), GOOD)).toMatchObject({ status: 409 });
  });
  it("normalises lookup emails and rejects anything else", () => {
    expect(lookupEmail("  A@B.co ")).toBe("a@b.co");
    for (const bad of ["", "nope", "a@b", 7, null, `${"a".repeat(250)}@b.co`]) expect(lookupEmail(bad)).toBeUndefined();
  });
  it("the email names the brand, has no link to click and says what to do next", () => {
    const m = mfaResetEmail("OwnerListing", "https://ownerlisting.com.au");
    expect(m.subject).toContain("OwnerListing");
    expect(m.text).toContain("sign in at https://ownerlisting.com.au");
    expect(m.text).toContain("set up a new phone");
    expect(m.text).toContain("did not ask for this");
  });
});

describe("/api/staff/security/mfa-reset", () => {
  it("signed out = 401; every other role = 403; a custom role holding the permission = 403", async () => {
    expect((await route.GET(get("owner@example.com"))).status).toBe(401);
    for (const r of ROLES.filter(x => x !== "super_admin")) {
      state.staff = { id: ADMIN, role: r };
      expect((await route.GET(get("owner@example.com"))).status, r).toBe(403);
      expect((await route.POST(post(GOOD))).status, r).toBe(403);
    }
    state.staff = { id: ADMIN, role: "custom_helpdesk", permissions: ["user.mfa_reset"] };
    expect((await route.POST(post(GOOD))).status).toBe(403);
    expect(state.resets).toEqual([]);
  });
  it("CSRF: a cross-origin POST is refused before anything changes", async () => {
    state.staff = { id: ADMIN, role: "super_admin" };
    expect((await route.POST(post(GOOD, { "content-type": "application/json", origin: "http://evil" }))).status).toBe(403);
    expect(state.resets).toEqual([]);
    expect(state.audits).toEqual([]);
  });
  it("looks up by email, audits the lookup, and answers 400 or 404 for a bad or unknown email", async () => {
    state.staff = { id: ADMIN, role: "super_admin" };
    const r = await route.GET(get(" OWNER@example.com"));
    expect(r.status).toBe(200);
    expect((await r.json()).user).toMatchObject({ id: OWNER, email: "owner@example.com", liveMethods: 2 });
    expect(state.audits.map(a => a.eventType)).toEqual(["mfa.reset_lookup"]);
    expect((await route.GET(get("not-an-email"))).status).toBe(400);
    expect((await route.GET(get("nobody@example.com"))).status).toBe(404);
    expect(state.audits.map(a => a.eventType)).toEqual(["mfa.reset_lookup", "mfa.reset_lookup_miss"]);
    expect(JSON.stringify(state.audits)).not.toContain("nobody@example.com");
  });
  it("resets with confirmation, emails the user and audits who, why and whether the email went", async () => {
    state.staff = { id: ADMIN, role: "super_admin" };
    const r = await route.POST(post(GOOD));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, methodsRevoked: 2, emailSent: true });
    expect(state.resets).toEqual([{ staffId: ADMIN, userId: OWNER, reason: GOOD.reason }]);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.to).toBe("owner@example.com");
    expect(state.audits).toEqual([expect.objectContaining({
      eventType: "mfa.reset_by_staff", aggregateId: OWNER, payload: { role: "super_admin", reason: GOOD.reason, methodsRevoked: 2, emailSent: true }
    })]);
  });
  it("still resets when email is not configured, and says so", async () => {
    state.staff = { id: ADMIN, role: "super_admin" }; state.emailConfigured = false;
    expect(await (await route.POST(post(GOOD))).json()).toMatchObject({ ok: true, emailSent: false });
    expect(state.sent).toEqual([]);
    expect(state.audits[0]!.payload["emailSent"]).toBe(false);
  });
  it("refuses a wrong confirmation, a bad id, an unknown account and a reset that lost the race", async () => {
    state.staff = { id: ADMIN, role: "super_admin" };
    expect((await route.POST(post({ ...GOOD, confirmEmail: "x@example.com" }))).status).toBe(400);
    expect((await route.POST(post({ ...GOOD, userId: "nope" }))).status).toBe(404);
    expect((await route.POST(post({ ...GOOD, userId: "00000000-0000-4000-8000-000000000009" }))).status).toBe(404);
    expect(state.resets).toEqual([]);
    state.resetResult = null;
    expect((await route.POST(post(GOOD))).status).toBe(409);
    expect(state.sent).toEqual([]);
    expect(state.audits).toEqual([]);
  });
});
