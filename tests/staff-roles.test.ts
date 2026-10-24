import { beforeEach, describe, expect, it, vi } from "vitest";
import { toCsv } from "../src/domain/reports";
import {
  evaluateOverride, isSensitivePermission, PERMISSION_AREAS, PERMISSION_CATALOGUE, staffCan, systemRolePermissions, type StaffActor, type StaffPermission
} from "../src/domain/staff-access";
import { planCaseResolve, planTrustDecision, sectionsFor, type CaseState } from "../src/domain/staff-admin";
import {
  accessReviewRows, cleanLabel, parseRoleChange, parseRoleCreate, planOutrank, planRoleAssign, planRoleChange, planRoleCreate,
  resolveRoleAccess, SYSTEM_ROLE_DEFS, type RoleDef
} from "../src/domain/staff-roles";
import { signStaffSession } from "../src/server/auth/staff-session";
import type { Queryable } from "../src/server/db";
import { staffFromRequest } from "../src/server/staff-auth";

const state = vi.hoisted(() => ({ db: null as Queryable | null, staff: null as StaffActor | null }));
vi.mock("../src/server/context", () => ({
  getActor: async () => null,
  getDeps: () => null,
  getDb: () => state.db,
  getStaff: async () => state.staff
}));

import { GET as rolesGet, POST as rolesPost } from "../app/api/staff/roles/route";
import { DELETE as roleDelete, POST as rolePost } from "../app/api/staff/roles/[key]/route";
import { GET as exportGet } from "../app/api/staff/roles/export/route";

const admin: StaffActor = { id: "a1", role: "super_admin" };
const custom = (key: string, permissions: StaffPermission[], o: Partial<RoleDef> = {}): RoleDef =>
  ({ key, label: key.replace("custom_", ""), description: "", permissions, isSystem: false, disabled: false, version: 1, ...o });
const sys = (k: string) => SYSTEM_ROLE_DEFS.find(r => r.key === k)!;
/** A custom staff manager: may manage staff but holds only a few non-sensitive permissions besides. */
const manager: StaffActor = { id: "m1", role: "custom_staff_mgr", permissions: ["staff.manage", "report.sales", "site.theme.edit", "case.manage"] };

describe("permission catalogue", () => {
  it("is the single source of truth: unique keys, every area known, labels and descriptions present", () => {
    const keys = PERMISSION_CATALOGUE.map(p => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of PERMISSION_CATALOGUE) {
      expect(PERMISSION_AREAS.map(a => a.key)).toContain(p.area);
      expect(p.label.length).toBeGreaterThan(2);
      expect(p.description.length).toBeGreaterThan(5);
    }
  });
  it("keeps every existing permission name and adds the website and messaging permissions", () => {
    const old = ["report.sales", "report.suburb", "report.financial", "report.solicitor", "report.broker", "report.buyer", "report.seller", "report.audit",
      "report.operations", "pii.view_masked", "pii.view_full", "case.manage", "trust_account.approve", "licence.verify", "ai.engine_set", "config.edit",
      "logs.technical", "dispute.read_chat", "override.request", "override.approve", "staff.manage", "pricing.manage", "identity.review"];
    const keys: string[] = PERMISSION_CATALOGUE.map(p => p.key);
    for (const k of [...old, "site.theme.edit", "site.content.edit", "site.content.publish", "messaging.settings"]) expect(keys).toContain(k);
  });
  it("flags identity review, financial reports, staff management and messaging settings as sensitive", () => {
    for (const k of ["identity.review", "report.financial", "staff.manage", "messaging.settings"]) expect(isSensitivePermission(k)).toBe(true);
    expect(isSensitivePermission("report.sales")).toBe(false);
  });
  it("built-in roles are unchanged and super admin holds everything", () => {
    expect(systemRolePermissions("super_admin")).toHaveLength(PERMISSION_CATALOGUE.length);
    expect(systemRolePermissions("technical")).toEqual(["logs.technical", "report.operations", "config.edit"]);
    expect(systemRolePermissions("custom_anything")).toEqual([]);
  });
});

describe("resolving a role to access (fail closed)", () => {
  it("built-in roles always use the fixed matrix, whatever the database row says", () => {
    expect(resolveRoleAccess("s", "reporting", { exists: true, permissions: ["staff.manage"], disabled: true })).toEqual({ id: "s", role: "reporting" });
  });
  it("custom roles take their permissions from the current definition, dropping unknown keys", () => {
    expect(resolveRoleAccess("s", "custom_web", { exists: true, permissions: ["site.theme.edit", "root.all", "site.theme.edit"], disabled: false }))
      .toEqual({ id: "s", role: "custom_web", permissions: ["site.theme.edit"] });
  });
  it("a disabled custom role grants nothing; a missing or malformed role gives no staff member", () => {
    expect(resolveRoleAccess("s", "custom_web", { exists: true, permissions: ["site.theme.edit"], disabled: true })?.permissions).toEqual([]);
    expect(resolveRoleAccess("s", "custom_web", { exists: true, permissions: ["site.theme.edit"], disabled: null })?.permissions).toEqual([]);
    expect(resolveRoleAccess("s", "custom_web", { exists: false, permissions: null, disabled: null })).toBeNull();
    expect(resolveRoleAccess("s", "custom_web", null)).toBeNull();
    for (const k of ["root", "Custom_web", "custom_", "custom_x", "custom_web;drop", 5, null]) expect(resolveRoleAccess("s", k, { exists: true, permissions: ["staff.manage"], disabled: false })).toBeNull();
  });
  it("a custom actor without resolved permissions, or one named like an admin, has no extra access", () => {
    expect(staffCan({ id: "s", role: "custom_web" }, "site.theme.edit")).toBe(false);
    expect(staffCan({ id: "s", role: "custom_super_admin" }, "staff.manage")).toBe(false);
    expect(staffCan({ id: "s", role: "custom_web", permissions: [] }, "report.sales")).toBe(false);
  });
  it("a custom role with no permissions sees no staff screens", () => {
    expect(sectionsFor({ id: "s", role: "custom_empty", permissions: [] })).toEqual([]);
  });
  it("dashboard sections follow the resolved permissions", () => {
    expect(sectionsFor(manager).map(s => s.href)).toEqual(["/staff/cases", "/staff/reports", "/staff/invites", "/staff/roles"]);
    expect(sectionsFor(admin).map(s => s.href)).toContain("/staff/messaging");
    expect(sectionsFor({ id: "s", role: "custom_m", permissions: ["staff.manage"] }).map(s => s.href)).not.toContain("/staff/messaging");
  });
});

describe("permission removed mid-session takes effect on the next request", () => {
  it("staffFromRequest re-reads the role definition each time", async () => {
    let row: Record<string, unknown> = { id: "s1", role: "custom_web", role_exists: true, permissions: ["site.theme.edit", "report.sales"], disabled: false };
    const db: Queryable = { async query() { return { rows: [row] }; } };
    const secret = "s".repeat(40);
    const req = () => new Request("http://x", { headers: { cookie: `ol_staff=${signStaffSession({ uid: "s1", exp: 2_000_000_000 }, secret)}` } });
    const first = (await staffFromRequest(db, req(), secret, 1_900_000_000))!;
    expect(staffCan(first, "report.sales")).toBe(true);
    row = { ...row, permissions: ["site.theme.edit"] };
    const second = (await staffFromRequest(db, req(), secret, 1_900_000_000))!;
    expect(staffCan(second, "report.sales")).toBe(false);
    row = { ...row, disabled: true };
    expect((await staffFromRequest(db, req(), secret, 1_900_000_000))!.permissions).toEqual([]);
    row = { ...row, role_exists: false };
    expect(await staffFromRequest(db, req(), secret, 1_900_000_000)).toBeNull();
  });
});

describe("role input (injection)", () => {
  it("labels are plain short names only", () => {
    expect(cleanLabel("  Website  editor (AU) ")).toBe("Website editor (AU)");
    for (const v of ["<script>alert(1)</script>", "=HYPERLINK(\"http://evil\")", "+1", "-x", "@x", "a\u0000b", "‮evil", "a​b",
      "Robert'); DROP TABLE staff_role_def;--", "", "   ", "x".repeat(61), 5, null]) {
      expect(cleanLabel(v)).toBeNull();
    }
  });
  it("create needs a custom_ key, a clean label and known permissions", () => {
    const ok = { key: "custom_web", label: "Web", description: "Website team", permissions: ["site.theme.edit", "site.theme.edit"] };
    expect(parseRoleCreate(ok)).toEqual({ ok: true, value: { key: "custom_web", label: "Web", description: "Website team", permissions: ["site.theme.edit"] } });
    for (const key of ["super_admin", "web", "custom_A", "custom_x", "custom_web'--", `custom_${"a".repeat(41)}`]) expect(parseRoleCreate({ ...ok, key }).ok).toBe(false);
    expect(parseRoleCreate({ ...ok, permissions: ["site.theme.edit", "root.all"] }).ok).toBe(false);
    expect(parseRoleCreate({ ...ok, permissions: "staff.manage" }).ok).toBe(false);
    expect(parseRoleCreate({ ...ok, description: "<img src=x onerror=alert(1)>" }).ok).toBe(false);
    expect(parseRoleCreate({ ...ok, description: "a‮b" }).ok).toBe(false);
    expect(parseRoleCreate(null).ok).toBe(false);
  });
  it("changes need a known action and a version", () => {
    expect(parseRoleChange({ action: "delete", expectedVersion: 1 }).ok).toBe(false);
    expect(parseRoleChange({ action: "disable" }).ok).toBe(false);
    expect(parseRoleChange({ action: "disable", expectedVersion: 1.5 }).ok).toBe(false);
    expect(parseRoleChange({ action: "disable", expectedVersion: 2 })).toEqual({ ok: true, value: { action: "disable", expectedVersion: 2 } });
  });
  it("the access review CSV neutralises formula cells", () => {
    const csv = toCsv(["a"], [["=1+1"], ["@SUM(A1)"], ["ok"]]);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'@SUM(A1)");
  });
});

describe("role editing rules", () => {
  const web = custom("custom_web", ["site.theme.edit"]);
  const upd = (permissions: StaffPermission[], expectedVersion = 1) => ({ action: "update" as const, expectedVersion, input: { label: "web", description: "", permissions } });

  it("only a super admin can create or change roles, even a custom role holding staff.manage", () => {
    expect(planRoleCreate(manager, { key: "custom_new", label: "New", description: "", permissions: [] }, null)).toMatchObject({ ok: false, status: 403, reason: "not_super_admin" });
    expect(planRoleChange(manager, web, upd([]))).toMatchObject({ ok: false, status: 403, reason: "not_super_admin" });
    for (const r of ["compliance", "accountant", "support", "technical", "reporting"]) {
      expect(planRoleChange({ id: "x", role: r }, web, upd([]))).toMatchObject({ ok: false, reason: "not_super_admin" });
    }
  });
  it("a super admin creates a role and an existing key is refused", () => {
    expect(planRoleCreate(admin, { key: "custom_web", label: "Web", description: "", permissions: ["staff.manage"] }, null)).toMatchObject({ ok: true, added: ["staff.manage"] });
    expect(planRoleCreate(admin, { key: "custom_web", label: "Web", description: "", permissions: [] }, web)).toMatchObject({ ok: false, reason: "exists" });
  });
  it("built-in roles cannot be edited, disabled or deleted", () => {
    for (const action of ["disable", "enable"] as const) expect(planRoleChange(admin, sys("support"), { action, expectedVersion: 1 })).toMatchObject({ ok: false, reason: "system_role" });
    expect(planRoleChange(admin, sys("reporting"), upd(["report.sales"]))).toMatchObject({ ok: false, reason: "system_role" });
    expect(planRoleChange(admin, { ...sys("reporting"), isSystem: false }, upd([]))).toMatchObject({ ok: false, reason: "system_role" });
  });
  it("you cannot edit your own role", () => {
    const mine = custom("custom_staff_mgr", ["staff.manage"]);
    expect(planRoleChange(manager, mine, upd(["staff.manage", "identity.review"]))).toMatchObject({ ok: false, reason: "own_role" });
  });
  it("edits are diffed, a stale version is refused (concurrent edits) and an empty change is refused", () => {
    const p = planRoleChange(admin, web, upd(["site.content.edit"]));
    expect(p).toMatchObject({ ok: true, added: ["site.content.edit"], removed: ["site.theme.edit"] });
    // A second admin saving from the same page (version 1) after the first save (now version 2) is refused.
    const after = { ...web, version: 2, permissions: ["site.content.edit"] as StaffPermission[] };
    expect(planRoleChange(admin, after, upd(["site.content.publish"], 1))).toMatchObject({ ok: false, status: 409, reason: "stale" });
    expect(planRoleChange(admin, web, upd(["site.theme.edit"]))).toMatchObject({ ok: false, reason: "unchanged" });
    expect(planRoleChange(admin, null, upd([]))).toMatchObject({ ok: false, status: 404 });
  });
  it("disable and enable add a version; a disabled role cannot be assigned", () => {
    expect(planRoleChange(admin, web, { action: "disable", expectedVersion: 1 })).toMatchObject({ ok: true, next: { disabled: true, version: 2 } });
    expect(planRoleChange(admin, { ...web, disabled: true }, { action: "enable", expectedVersion: 1 })).toMatchObject({ ok: true, next: { disabled: false } });
    expect(planRoleAssign(admin, { ...web, disabled: true })).toMatchObject({ ok: false, reason: "disabled" });
  });
});

describe("assigning roles (no escalation)", () => {
  it("nobody can give a role holding a permission they lack", () => {
    expect(planRoleAssign(manager, custom("custom_x", ["report.sales", "report.audit"]))).toMatchObject({ ok: false, status: 403, reason: "escalation" });
    expect(planRoleAssign(manager, sys("technical"))).toMatchObject({ ok: false, reason: "escalation" });
    expect(planRoleAssign(manager, custom("custom_web", ["site.theme.edit"]))).toEqual({ ok: true });
  });
  it("sensitive roles and super admin need a super admin, even when the manager holds the permission", () => {
    expect(planRoleAssign(manager, custom("custom_mgr2", ["staff.manage"]))).toMatchObject({ ok: false, reason: "sensitive" });
    expect(planRoleAssign(manager, sys("super_admin"))).toMatchObject({ ok: false });
    expect(planRoleAssign(admin, sys("super_admin"))).toEqual({ ok: true });
    expect(planRoleAssign(admin, custom("custom_id", ["identity.review"]))).toEqual({ ok: true });
  });
  it("an unknown role cannot be assigned and a custom role with no permissions can", () => {
    expect(planRoleAssign(admin, null)).toMatchObject({ ok: false, status: 400 });
    expect(planRoleAssign(manager, custom("custom_empty", []))).toEqual({ ok: true });
  });
  it("a lesser admin cannot change or revoke someone with more access", () => {
    expect(planOutrank(manager, sys("super_admin"))).toMatchObject({ ok: false, reason: "outranked" });
    expect(planOutrank(manager, sys("compliance"))).toMatchObject({ ok: false, reason: "outranked" });
    expect(planOutrank(manager, custom("custom_web", ["site.theme.edit"]))).toEqual({ ok: true });
    expect(planOutrank(admin, sys("super_admin"))).toEqual({ ok: true });
  });
});

describe("two-person rules hold for custom roles", () => {
  const all = PERMISSION_CATALOGUE.map(p => p.key);
  const big: StaffActor = { id: "c1", role: "custom_everything", permissions: all };
  const other: StaffActor = { id: "c2", role: "custom_everything", permissions: all };
  it("a custom role with every permission still needs a different approver, for every override", () => {
    expect(evaluateOverride(big, { target: "listing", reason: "a clear reason here" })).toMatchObject({ allowed: false, requiresSecondApprover: true });
    expect(evaluateOverride(big, { target: "trust_account", reason: "a clear reason here" }, big)).toMatchObject({ allowed: false });
    expect(evaluateOverride(big, { target: "trust_account", reason: "a clear reason here" }, other)).toMatchObject({ allowed: true, requiresSecondApprover: true });
    expect(evaluateOverride(big, { target: "audit_event", reason: "a clear reason here" }, other).allowed).toBe(false);
  });
  it("trust approvals need two different people whatever the role", () => {
    const c = { decision: "awaiting_human_approval", latest: true, fingerprint: "f", lastApprovedFingerprint: null, priors: [{ staffId: "c1", outcome: "approve" as const }] };
    expect(planTrustDecision(big, c, "approve", "a clear reason here")).toMatchObject({ action: "deny", status: 403 });
    expect(planTrustDecision(other, c, "approve", "a clear reason here")).toEqual({ action: "approve" });
    expect(planTrustDecision({ id: "c3", role: "custom_x", permissions: [] }, c, "approve", "a clear reason here")).toMatchObject({ action: "deny", status: 403 });
  });
  it("a proposer whose override.request was removed cannot have the override confirmed", () => {
    const c: CaseState = { kind: "trust_account_verification", status: "in_progress", assignedTo: "c1", proposedBy: "c1", proposedByRole: "custom_everything", proposedReason: "a clear reason here", proposedByPermissions: [] };
    expect(planCaseResolve(other, c, "confirming this override")).toMatchObject({ action: "deny", status: 403 });
    const ok = planCaseResolve(other, { ...c, proposedByPermissions: all }, "confirming this override");
    expect(ok).toMatchObject({ action: "resolve" });
  });
});

describe("access review rows", () => {
  it("one row per staff member and permission; disabled and unknown roles show no access", () => {
    const roles = [...SYSTEM_ROLE_DEFS, custom("custom_web", ["site.theme.edit", "report.sales"]), custom("custom_off", ["report.sales"], { disabled: true })];
    const rows = accessReviewRows([
      { inviteId: "i1", email: "a@x.com", role: "custom_web", acceptedAt: null },
      { inviteId: "i2", email: "b@x.com", role: "custom_off", acceptedAt: "2026-10-25T00:00:00.000Z" },
      { inviteId: "i3", email: "c@x.com", role: "custom_gone", acceptedAt: null }
    ], roles);
    expect(rows.filter(r => r[0] === "i1").map(r => r[8])).toEqual(["report.sales", "site.theme.edit"]);
    expect(rows.filter(r => r[0] === "i2")).toEqual([["i2", "b@x.com", "custom_off", "off", "custom", 1, "disabled (no access)", "2026-10-25T00:00:00.000Z", "", "", ""]]);
    expect(rows.find(r => r[0] === "i3")?.[6]).toBe("unknown (no access)");
  });
});

describe("role routes", () => {
  const origin = "https://app.example.com";
  const calls: string[] = [];
  beforeEach(() => {
    process.env["APP_URL"] = origin;
    calls.length = 0;
    state.staff = admin;
    state.db = { async query(text) { calls.push(text); return { rows: [] }; } };
  });
  const req = (url: string, method: string, body?: unknown, headers: Record<string, string> = { origin, "content-type": "application/json" }) =>
    new Request(`http://x${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const ctx = (key: string) => ({ params: Promise.resolve({ key }) });
  const createBody = { key: "custom_web", label: "Web", permissions: ["site.theme.edit"] };

  it("signed out: 401; staff without staff.manage: 403; nothing is queried", async () => {
    state.staff = null;
    expect((await rolesGet(req("/api/staff/roles", "GET"))).status).toBe(401);
    for (const role of ["compliance", "accountant", "support", "technical", "reporting"]) {
      state.staff = { id: "n", role };
      expect((await rolesGet(req("/api/staff/roles", "GET"))).status).toBe(403);
      expect((await rolesPost(req("/api/staff/roles", "POST", createBody))).status).toBe(403);
      expect((await rolePost(req("/api/staff/roles/custom_web", "POST", { action: "disable", expectedVersion: 1 }), ctx("custom_web"))).status).toBe(403);
      expect((await exportGet(req("/api/staff/roles/export", "GET"))).status).toBe(403);
    }
    state.staff = { id: "n", role: "custom_web", permissions: ["site.theme.edit"] };
    expect((await rolesGet(req("/api/staff/roles", "GET"))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it("cross-origin posts are refused before anything else", async () => {
    expect((await rolesPost(req("/api/staff/roles", "POST", createBody, { origin: "https://evil.example", "content-type": "application/json" }))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it("bad input is 400, a bad key is 404, delete is 405, all before any query", async () => {
    expect((await rolesPost(req("/api/staff/roles", "POST", { ...createBody, label: "<b>x</b>" }))).status).toBe(400);
    expect((await rolesPost(req("/api/staff/roles", "POST", { ...createBody, key: "super_admin" }))).status).toBe(400);
    expect((await rolePost(req("/api/staff/roles/x", "POST", { action: "disable", expectedVersion: 1 }), ctx("root"))).status).toBe(404);
    expect((await rolePost(req("/api/staff/roles/custom_web", "POST", { action: "delete", expectedVersion: 1 }), ctx("custom_web"))).status).toBe(400);
    expect((await roleDelete(req("/api/staff/roles/super_admin", "DELETE"))).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  /** Fake database for the role writes: the acting staff member as `actorRow`, the roles in `roles`. */
  function writeDb(actorRow: Record<string, unknown> | null, roles: Record<string, Record<string, unknown>> = {}) {
    const writes: { text: string; params: unknown[] }[] = [];
    state.db = {
      async query(text, params = []) {
        calls.push(text);
        if (/FROM app_user u JOIN staff_invite/.test(text)) return { rows: actorRow ? [actorRow] : [] };
        if (/FROM staff_role_current WHERE role_key = \$1/.test(text)) { const r = roles[String(params[0])]; return { rows: r ? [r] : [] }; }
        if (/^\s*INSERT/.test(text)) writes.push({ text, params });
        if (/INSERT INTO staff_role_def /.test(text)) return { rows: [{ key: params[0] }] };
        return { rows: [] };
      }
    };
    return writes;
  }
  const auditTypes = (w: { text: string; params: unknown[] }[]) => w.filter(x => /audit_event/.test(x.text)).map(x => x.params.find(p => typeof p === "string" && p.startsWith("staff.")));

  it("a custom staff manager is refused role edits under the lock, and the refusal is audited", async () => {
    state.staff = manager;
    const writes = writeDb({ id: "m1", role: "custom_staff_mgr", role_exists: true, permissions: manager.permissions, disabled: false });
    expect((await rolesPost(req("/api/staff/roles", "POST", createBody))).status).toBe(403);
    expect(auditTypes(writes)).toEqual(["staff.role_change_refused"]);
    expect(writes.some(w => /staff_role_def/.test(w.text))).toBe(false);
  });
  it("an actor demoted after the gate is refused under the lock", async () => {
    const writes = writeDb(null);
    expect((await rolesPost(req("/api/staff/roles", "POST", createBody))).status).toBe(403);
    expect(writes).toHaveLength(0);
  });
  it("a super admin creates a role: version 1 plus an audit row with the permissions and no personal data", async () => {
    const writes = writeDb({ id: "a1", role: "super_admin", role_exists: true, permissions: [], disabled: false });
    const res = await rolesPost(req("/api/staff/roles", "POST", { ...createBody, permissions: ["site.theme.edit", "staff.manage"] }));
    expect(res.status).toBe(201);
    expect(writes.map(w => /INSERT INTO (\w+)/.exec(w.text)?.[1])).toEqual(["staff_role_def", "staff_role_def_version", "audit_event"]);
    const payload = JSON.parse(writes[2]!.params.find(p => typeof p === "string" && p.startsWith("{")) as string);
    expect(payload).toEqual({ role: "super_admin", roleKey: "custom_web", version: 1, added: ["staff.manage", "site.theme.edit"], sensitive: ["staff.manage"] });
  });
  it("editing a built-in role through the API is refused and audited", async () => {
    const writes = writeDb({ id: "a1", role: "super_admin", role_exists: true, permissions: [], disabled: false }, { support: { role_key: "support", version: 1, label: "Support", permissions: [], disabled: false } });
    const res = await rolePost(req("/api/staff/roles/support", "POST", { action: "disable", expectedVersion: 1 }), ctx("support"));
    expect(res.status).toBe(409);
    expect(auditTypes(writes)).toEqual(["staff.role_change_refused"]);
  });
  it("an edit writes the next version and audits the permission diff", async () => {
    const writes = writeDb({ id: "a1", role: "super_admin", role_exists: true, permissions: [], disabled: false },
      { custom_web: { role_key: "custom_web", version: 3, label: "Web", description: "", permissions: ["site.theme.edit"], disabled: false } });
    const res = await rolePost(req("/api/staff/roles/custom_web", "POST", { action: "update", expectedVersion: 3, label: "Web", permissions: ["site.content.edit"] }), ctx("custom_web"));
    expect(res.status).toBe(200);
    expect(writes[0]!.params.slice(0, 2)).toEqual(["custom_web", 4]);
    const payload = JSON.parse(writes[1]!.params.find(p => typeof p === "string" && p.startsWith("{")) as string);
    expect(payload).toMatchObject({ roleKey: "custom_web", version: 4, previousVersion: 3, added: ["site.content.edit"], removed: ["site.theme.edit"], labelChanged: false });
  });
});
