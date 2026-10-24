import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor, StaffRole } from "../src/domain/staff-access";
import { sectionsFor } from "../src/domain/staff-admin";
import { normaliseStaffEmail, parseBootstrapEmails, parseInviteInput, planInviteChange } from "../src/domain/staff-invite";
import { readIdentity } from "../src/server/auth/google";
import type { Queryable } from "../src/server/db";

const state = vi.hoisted(() => ({ db: null as Queryable | null, staff: null as { id: string; role: string } | null }));

vi.mock("../src/server/context", () => ({
  getActor: async () => null,
  getDeps: () => null,
  getDb: () => state.db,
  getStaff: async () => state.staff
}));

import { GET as listGet, POST as invitePost } from "../app/api/staff/invites/route";
import { POST as changePost } from "../app/api/staff/invites/[id]/route";

const claims = { iss: "https://accounts.google.com", aud: "client", exp: 2_000_000_000, nonce: "n", sub: "sub1", email: "Staff@Example.com", name: "S" };
const expectOk = { clientId: "client", nonce: "n", nowSeconds: 1_900_000_000 };

describe("Google identity for staff", () => {
  it("requires email_verified=true", () => {
    expect(readIdentity({ ...claims, email_verified: true }, expectOk)?.email).toBe("Staff@Example.com");
    for (const v of [false, "true", 1, undefined, null]) expect(readIdentity({ ...claims, email_verified: v }, expectOk)).toBeNull();
  });
  it("any Google account is accepted by the identity check: no hosted-domain (hd) claim is needed or read", () => {
    expect(readIdentity({ ...claims, email: "someone@gmail.com", email_verified: true }, expectOk)?.email).toBe("someone@gmail.com");
  });
});

describe("email normalisation", () => {
  it("trims and lower-cases", () => {
    expect(normaliseStaffEmail("  Staff@Example.COM\t")).toBe("staff@example.com");
  });
  it("rejects whitespace inside, control characters, look-alike Unicode, lists and non-strings", () => {
    for (const v of ["a b@x.com", "a@x.com\u0000", "a@x.com​", "a@x.cоm", "а@x.com", "a@x.com,b@x.com", "a@@x.com", "a@x", "", "   ", 5, null, undefined, "a".repeat(250) + "@x.com"]) {
      expect(normaliseStaffEmail(v)).toBeNull();
    }
  });
  it("bootstrap list is normalised, de-duplicated and drops bad entries", () => {
    expect(parseBootstrapEmails(" A@x.com, a@X.com ,bad, ,b@y.org")).toEqual(["a@x.com", "b@y.org"]);
    expect(parseBootstrapEmails(undefined)).toEqual([]);
    expect(parseBootstrapEmails("")).toEqual([]);
  });
  it("invite input needs a valid email and a known role", () => {
    expect(parseInviteInput({ email: " X@y.com ", role: "support" })).toEqual({ ok: true, email: "x@y.com", role: "support" });
    expect(parseInviteInput({ email: "x@y.com", role: "root" }).ok).toBe(false);
    expect(parseInviteInput({ email: "nope", role: "support" }).ok).toBe(false);
    expect(parseInviteInput(null).ok).toBe(false);
  });
});

describe("planInviteChange", () => {
  const admin: StaffActor = { id: "a1", role: "super_admin" };
  const target = { id: "i1", email: "x@y.com", role: "support" as StaffRole };
  it("allows an admin to revoke or re-role someone else", () => {
    expect(planInviteChange(admin, target, false, 2, null).ok).toBe(true);
    expect(planInviteChange(admin, target, false, 2, "reporting").ok).toBe(true);
  });
  it("refuses every non-admin role", () => {
    for (const role of ["compliance", "accountant", "support", "technical", "reporting"] as StaffRole[]) {
      expect(planInviteChange({ id: "n", role }, target, false, 2, null)).toMatchObject({ ok: false, status: 403 });
    }
  });
  it("refuses changing your own access, including your own role", () => {
    expect(planInviteChange(admin, { ...target, role: "super_admin" }, true, 3, null)).toMatchObject({ ok: false, reason: "self" });
    expect(planInviteChange(admin, { ...target, role: "super_admin" }, true, 3, "support")).toMatchObject({ ok: false, reason: "self" });
  });
  it("refuses removing or demoting the last admin", () => {
    const last = { ...target, role: "super_admin" as StaffRole };
    expect(planInviteChange(admin, last, false, 1, null)).toMatchObject({ ok: false, reason: "last_admin" });
    expect(planInviteChange(admin, last, false, 1, "support")).toMatchObject({ ok: false, reason: "last_admin" });
    expect(planInviteChange(admin, last, false, 2, null).ok).toBe(true);
  });
  it("is a 404 for a missing or already revoked invite", () => {
    expect(planInviteChange(admin, null, false, 2, null)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("staff access page is shown to admins only", () => {
  it("lists /staff/invites only for roles with staff.manage", () => {
    expect(sectionsFor({ id: "a", role: "super_admin" }).map(s => s.href)).toContain("/staff/invites");
    for (const role of ["compliance", "accountant", "support", "technical", "reporting"] as StaffRole[]) {
      expect(sectionsFor({ id: "a", role }).map(s => s.href)).not.toContain("/staff/invites");
    }
  });
});

describe("invite routes", () => {
  const origin = "https://app.example.com";
  const id = "11111111-1111-4111-8111-111111111111";
  const calls: string[] = [];
  beforeEach(() => {
    process.env["APP_URL"] = origin;
    calls.length = 0;
    state.staff = { id: "a1", role: "super_admin" };
    state.db = { async query(text) { calls.push(text); return { rows: [] }; } };
  });
  const post = (body: unknown, headers: Record<string, string> = { origin, "content-type": "application/json" }) =>
    new Request("http://x/api/staff/invites", { method: "POST", headers, body: JSON.stringify(body) });
  const ctx = { params: Promise.resolve({ id }) };

  it("signed-out callers get 401 and nothing is queried", async () => {
    state.staff = null;
    expect((await invitePost(post({ email: "x@y.com", role: "support" }))).status).toBe(401);
    expect((await listGet(new Request("http://x/api/staff/invites"))).status).toBe(401);
    expect((await changePost(post({ action: "revoke" }), ctx)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it("non-admin staff cannot invite, list, revoke or change a role", async () => {
    for (const role of ["compliance", "accountant", "support", "technical", "reporting"]) {
      state.staff = { id: "n1", role };
      expect((await invitePost(post({ email: "x@y.com", role: "super_admin" }))).status).toBe(403);
      expect((await listGet(new Request("http://x/api/staff/invites"))).status).toBe(403);
      expect((await changePost(post({ action: "revoke" }), ctx)).status).toBe(403);
      expect((await changePost(post({ action: "set_role", role: "super_admin" }), ctx)).status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });
  it("csrfGuard: a cross-origin or non-JSON post is refused before anything else", async () => {
    expect((await invitePost(post({ email: "x@y.com", role: "support" }, { origin: "https://evil.example", "content-type": "application/json" }))).status).toBe(403);
    expect((await invitePost(post({ email: "x@y.com", role: "support" }, { origin, "content-type": "text/plain" }))).status).toBe(403);
    expect((await invitePost(post({ email: "x@y.com", role: "support" }, { "content-type": "application/json" }))).status).toBe(403);
    expect((await changePost(post({ action: "revoke" }, { origin: "https://evil.example", "content-type": "application/json" }), ctx)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it("rejects bad input with 400 and a bad id with 404", async () => {
    expect((await invitePost(post({ email: "not an email", role: "support" }))).status).toBe(400);
    expect((await invitePost(post({ email: "x@y.com", role: "root" }))).status).toBe(400);
    expect((await changePost(post({ action: "delete" }), ctx)).status).toBe(400);
    expect((await changePost(post({ action: "set_role", role: "root" }), ctx)).status).toBe(400);
    expect((await changePost(post({ action: "revoke" }), { params: Promise.resolve({ id: "not-a-uuid" }) })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
