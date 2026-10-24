import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { staffCan, type StaffActor } from "../src/domain/staff-access";
import { accessReviewRows } from "../src/domain/staff-roles";
import { signStaffSession } from "../src/server/auth/staff-session";
import { staffFromRequest, staffSignIn } from "../src/server/staff-auth";
import { changeInvite, createInvite, listInvites } from "../src/server/staff-invite-db";
import { changeRole, createRole, getRole, listActiveAccess, listRoles } from "../src/server/staff-roles-db";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
const secret = "s".repeat(40);

describe.skipIf(!DATABASE_URL)("staff roles (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });
  beforeEach(async () => { await db.query(`UPDATE staff_invite SET revoked_at = now() WHERE revoked_at IS NULL`); });

  let seq = 0;
  const fresh = () => `r${++seq}-${Math.random().toString(36).slice(2, 8)}@gmail.com`;
  const key = () => `custom_t${++seq}_${Math.random().toString(36).slice(2, 6)}`;
  const audits = async (type: string) => (await db.query(`SELECT * FROM audit_event WHERE event_type = $1 ORDER BY occurred_at`, [type])).rows;
  const signIn = async (email: string, bootstrap: string[] = []) => staffSignIn(db, { sub: `sub-${email}`, name: "n", email }, bootstrap);
  const fromCookie = (a: StaffActor) => staffFromRequest(db, new Request("http://x", { headers: { cookie: `ol_staff=${signStaffSession({ uid: a.id, exp: 2_000_000_000 }, secret)}` } }), secret, 1_900_000_000);

  async function admin(): Promise<StaffActor> {
    const e = fresh();
    return (await signIn(e, [e]))!;
  }
  /** A staff member holding `role`, invited by `by` and signed in. */
  async function member(by: StaffActor, role: string): Promise<StaffActor> {
    const e = fresh();
    expect(await createInvite(db, by, e, role)).toMatchObject({ ok: true });
    expect(await signIn(e)).not.toBeNull();
    return (await fromCookie((await signIn(e))!))!;
  }

  it("the migration seeds the seven built-in roles (designer from the site theme lane included) and existing invites still resolve", async () => {
    const roles = (await db.query(`SELECT role_key, is_system, version, permissions FROM staff_role_current ORDER BY role_key`)).rows;
    expect(roles.filter(r => r["is_system"]).map(r => r["role_key"])).toEqual(["accountant", "compliance", "designer", "reporting", "super_admin", "support", "technical"]);
    expect(roles.every(r => !r["is_system"] || (r["version"] === 1 && (r["permissions"] as string[]).length === 0))).toBe(true);
    const a = await admin();
    expect(await fromCookie(a)).toEqual(a);
    expect((await listRoles(db)).slice(0, 7).map(r => r.key)).toEqual(["super_admin", "compliance", "accountant", "support", "technical", "reporting", "designer"]);
  });

  it("built-in roles cannot be edited, disabled or deleted, and no role row can be updated or deleted", async () => {
    await expect(db.query(`INSERT INTO staff_role_def_version (role_key, version, label, permissions) VALUES ('support', 2, 'Support', '{staff.manage}')`)).rejects.toThrow(/built-in/);
    await expect(db.query(`DELETE FROM staff_role_def WHERE key = 'support'`)).rejects.toThrow(/cannot be changed or deleted/);
    await expect(db.query(`UPDATE staff_role_def_version SET permissions = '{staff.manage}' WHERE role_key = 'support'`)).rejects.toThrow(/cannot be changed or deleted/);
    await expect(db.query(`INSERT INTO staff_role_def (key, is_system) VALUES ('custom_fake', true)`)).rejects.toThrow(/check/i);
    await expect(db.query(`INSERT INTO staff_role_def (key, is_system) VALUES ('root', false)`)).rejects.toThrow(/check/i);
    const a = await admin();
    expect(await changeRole(db, a, "support", { action: "disable", expectedVersion: 1 })).toMatchObject({ ok: false, status: 409 });
  });

  it("an invite cannot name a role that does not exist", async () => {
    await expect(db.query(`INSERT INTO staff_invite (email, role) VALUES ('x@y.com', 'custom_missing')`)).rejects.toThrow(/foreign key/);
    const a = await admin();
    expect(await createInvite(db, a, fresh(), "custom_missing")).toMatchObject({ ok: false, status: 400 });
  });

  it("create -> invite -> sign in: permissions come from the role; edits and disabling apply to the very next request", async () => {
    const a = await admin();
    const k = key();
    expect(await createRole(db, a, { key: k, label: "Website", description: "Site team", permissions: ["theme.edit", "report.sales"] })).toEqual({ ok: true, key: k, version: 1 });
    const m = await member(a, k);
    expect(staffCan(m, "theme.edit")).toBe(true);
    expect(staffCan(m, "report.sales")).toBe(true);
    expect(staffCan(m, "staff.manage")).toBe(false);

    expect(await changeRole(db, a, k, { action: "update", expectedVersion: 1, input: { label: "Website", description: "Site team", permissions: ["theme.edit"] } })).toMatchObject({ ok: true, version: 2 });
    const now = (await fromCookie(m))!;
    expect(staffCan(now, "report.sales")).toBe(false);
    expect(staffCan(now, "theme.edit")).toBe(true);

    expect(await changeRole(db, a, k, { action: "disable", expectedVersion: 2 })).toMatchObject({ ok: true, version: 3 });
    expect((await fromCookie(m))!.permissions).toEqual([]);
    expect(await signIn((await listInvites(db)).find(i => i.role === k && !i.revokedAt)!.email)).toBeNull();
    expect(await createInvite(db, a, fresh(), k)).toMatchObject({ ok: false, status: 409 });

    expect(await changeRole(db, a, k, { action: "enable", expectedVersion: 3 })).toMatchObject({ ok: true, version: 4 });
    expect(staffCan((await fromCookie(m))!, "theme.edit")).toBe(true);

    const upd = (await audits("staff.role_updated")).find(r => (r["payload"] as { roleKey: string }).roleKey === k)!;
    expect(upd["payload"]).toMatchObject({ roleKey: k, version: 2, added: [], removed: ["report.sales"] });
    expect(JSON.stringify(upd["payload"])).not.toContain("@");
    expect((await audits("staff.role_disabled")).length).toBeGreaterThan(0);
    const versions = (await db.query(`SELECT version FROM staff_role_def_version WHERE role_key = $1 ORDER BY version`, [k])).rows.map(r => r["version"]);
    expect(versions).toEqual([1, 2, 3, 4]);
  });

  it("concurrent edits from the same version: exactly one is saved", async () => {
    const a = await admin();
    const b = await member(a, "super_admin");
    const k = key();
    await createRole(db, a, { key: k, label: "Ops", description: "", permissions: ["report.operations"] });
    const results = await Promise.all([
      changeRole(db, a, k, { action: "update", expectedVersion: 1, input: { label: "Ops", description: "", permissions: ["report.sales"] } }),
      changeRole(db, b, k, { action: "update", expectedVersion: 1, input: { label: "Ops", description: "", permissions: ["report.suburb"] } })
    ]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ status: 409 });
    expect((await getRole(db, k))!.version).toBe(2);
    await expect(db.query(`INSERT INTO staff_role_def_version (role_key, version, label) VALUES ($1, 5, 'gap')`, [k])).rejects.toThrow(/follow/);
  });

  it("a custom staff manager: no role edits, no escalation, no sensitive roles, cannot touch greater access", async () => {
    const a = await admin();
    const mgrRole = key();
    await createRole(db, a, { key: mgrRole, label: "Staff manager", description: "", permissions: ["staff.manage", "theme.edit", "report.sales"] });
    const m = await member(a, mgrRole);
    const web = key();
    await createRole(db, a, { key: web, label: "Web", description: "", permissions: ["theme.edit"] });
    const fin = key();
    await createRole(db, a, { key: fin, label: "Finance", description: "", permissions: ["report.sales", "report.financial"] });

    expect(await createRole(db, m, { key: key(), label: "Mine", description: "", permissions: ["theme.edit"] })).toMatchObject({ ok: false, status: 403 });
    expect(await changeRole(db, m, web, { action: "disable", expectedVersion: 1 })).toMatchObject({ ok: false, status: 403 });
    expect(await changeRole(db, m, mgrRole, { action: "update", expectedVersion: 1, input: { label: "Staff manager", description: "", permissions: ["staff.manage", "identity.review"] } }))
      .toMatchObject({ ok: false, status: 409 }); // own role
    expect(await createInvite(db, m, fresh(), fin)).toMatchObject({ ok: false, status: 403 }); // lacks report.financial
    expect(await createInvite(db, m, fresh(), mgrRole)).toMatchObject({ ok: false, status: 403 }); // sensitive (staff.manage)
    expect(await createInvite(db, m, fresh(), "super_admin")).toMatchObject({ ok: false, status: 403 });
    expect(await createInvite(db, m, fresh(), web)).toMatchObject({ ok: true });

    await member(a, "super_admin"); // two admins, so the last-admin rule does not decide this
    const adminInvite = (await listInvites(db)).find(i => i.role === "super_admin" && !i.revokedAt)!;
    expect(await changeInvite(db, m, adminInvite.id, null)).toMatchObject({ ok: false, status: 403 });
    const webInvite = (await listInvites(db)).find(i => i.role === web && !i.revokedAt)!;
    expect(await changeInvite(db, m, webInvite.id, fin)).toMatchObject({ ok: false, status: 403 });
    expect(await changeInvite(db, m, webInvite.id, null)).toMatchObject({ ok: true });

    const reasons = (await audits("staff.invite_change_refused")).map(r => (r["payload"] as { reason: string }).reason);
    expect(reasons).toEqual(expect.arrayContaining(["escalation", "sensitive", "outranked"]));
    expect((await audits("staff.role_change_refused")).map(r => (r["payload"] as { reason: string }).reason)).toEqual(expect.arrayContaining(["not_super_admin", "own_role"]));

    // Removing staff.manage from the manager's role stops them at once.
    expect(await changeRole(db, a, mgrRole, { action: "update", expectedVersion: 1, input: { label: "Staff manager", description: "", permissions: ["theme.edit"] } })).toMatchObject({ ok: true });
    expect(staffCan((await fromCookie(m))!, "staff.manage")).toBe(false);
    expect(await createInvite(db, m, fresh(), web)).toMatchObject({ ok: false, status: 403 });
  });

  it("a custom role with no permissions signs in with no access; the last-admin rule still holds", async () => {
    const a = await admin();
    const empty = key();
    await createRole(db, a, { key: empty, label: "Empty", description: "", permissions: [] });
    const m = await member(a, empty);
    expect(m.permissions).toEqual([]);
    const mine = (await listInvites(db)).find(i => i.role === "super_admin" && !i.revokedAt)!;
    const b = await member(a, "super_admin");
    expect(await changeInvite(db, b, mine.id, empty)).toMatchObject({ ok: true });
    const bInvite = (await listInvites(db)).find(i => i.role === "super_admin" && !i.revokedAt)!;
    const c = await member(b, empty);
    expect(await changeInvite(db, c, bInvite.id, null)).toMatchObject({ ok: false, status: 403 });
  });

  it("access review export lists each active staff member's current permissions", async () => {
    const a = await admin();
    const k = key();
    await createRole(db, a, { key: k, label: "Web", description: "", permissions: ["theme.edit"] });
    await member(a, k);
    const rows = accessReviewRows(await listActiveAccess(db), await listRoles(db));
    expect(rows.filter(r => r[2] === k).map(r => r[8])).toEqual(["theme.edit"]);
    expect(rows.filter(r => r[2] === "super_admin").length).toBeGreaterThan(20);
  });
});

// Its own database: the cap test fills the role table and role rows can never be deleted.
describe.skipIf(!DATABASE_URL)("custom role cap (Postgres)", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  it("the number of custom roles is capped so the roles list and the export stay complete", async () => {
    const e = `cap-${Math.random().toString(36).slice(2, 8)}@gmail.com`;
    const a = (await staffSignIn(t.db, { sub: `sub-${e}`, name: "n", email: e }, [e]))!;
    await t.db.query(`INSERT INTO staff_role_def (key, is_system) SELECT 'custom_cap' || g, false FROM generate_series(1, 150) g`);
    expect(await createRole(t.db, a, { key: "custom_one_more", label: "One too many", description: "", permissions: [] })).toMatchObject({ ok: false, status: 409 });
  });
});
