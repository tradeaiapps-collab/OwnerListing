import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";
import { signStaffSession } from "../src/server/auth/staff-session";
import { staffFromRequest, staffSignIn } from "../src/server/staff-auth";
import { upsertGoogleUser } from "../src/server/users";
import { changeInvite, createInvite, listInvites } from "../src/server/staff-invite-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
const secret = "s".repeat(40);
const sub = (n: string) => ({ sub: `sub-${n}`, name: n });

describe.skipIf(!DATABASE_URL)("staff invites (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });
  beforeEach(async () => {
    // Staff history is insert-only, so isolate each test by giving it fresh addresses (see `fresh`) and by disabling nobody else.
    await db.query(`UPDATE staff_invite SET revoked_at = now() WHERE revoked_at IS NULL`);
  });

  let seq = 0;
  const fresh = () => `p${++seq}-${Math.random().toString(36).slice(2, 8)}@gmail.com`;
  const audits = async (type: string) => (await db.query(`SELECT * FROM audit_event WHERE event_type = $1`, [type])).rows;

  /** An admin who has signed in through the bootstrap path. */
  async function bootstrapAdmin(): Promise<{ actor: StaffActor; email: string }> {
    const email = fresh();
    const actor = await staffSignIn(db, { ...sub(email), email: email.toUpperCase() }, [email]);
    expect(actor?.role).toBe("super_admin");
    return { actor: actor!, email };
  }

  it("bootstrap: the listed email becomes super_admin with any Google account, and the role is read from the invite", async () => {
    const { actor } = await bootstrapAdmin();
    const req = new Request("http://x", { headers: { cookie: `ol_staff=${signStaffSession({ uid: actor.id, exp: 2_000_000_000 }, secret)}` } });
    expect(await staffFromRequest(db, req, secret, 1_900_000_000)).toEqual(actor);
    const invite = (await listInvites(db)).find(i => i.revokedAt === null)!;
    expect(invite.invitedBy).toBeNull();
    expect(invite.acceptedAt).not.toBeNull();
  });
  it("bootstrap works only while there is no active super_admin: a second listed email is refused", async () => {
    await bootstrapAdmin();
    const other = fresh();
    expect(await staffSignIn(db, { ...sub(other), email: other }, [other])).toBeNull();
    expect((await db.query(`SELECT 1 FROM staff_invite WHERE email = $1`, [other])).rows).toHaveLength(0);
  });
  it("an email that is not in the env list and has no invite is denied and nothing is created", async () => {
    const e = fresh();
    expect(await staffSignIn(db, { ...sub(e), email: e }, [fresh()])).toBeNull();
    expect((await db.query(`SELECT 1 FROM app_user WHERE email = $1`, [e])).rows).toHaveLength(0);
    expect((await audits("staff.signin_denied")).length).toBeGreaterThan(0);
  });

  it("invite -> sign-in with case and whitespace variants -> revoke -> denied, and the live session stops at once", async () => {
    const { actor: admin } = await bootstrapAdmin();
    const e = fresh();
    expect(await createInvite(db, admin, e, "support")).toMatchObject({ ok: true });
    const who = { ...sub(e), email: `  ${e.toUpperCase()}  ` };
    const member = await staffSignIn(db, who);
    expect(member?.role).toBe("support");
    const req = new Request("http://x", { headers: { cookie: `ol_staff=${signStaffSession({ uid: member!.id, exp: 2_000_000_000 }, secret)}` } });
    expect(await staffFromRequest(db, req, secret, 1_900_000_000)).toEqual(member);

    const invite = (await listInvites(db)).find(i => i.email === e && !i.revokedAt)!;
    expect(await changeInvite(db, admin, invite.id, null)).toMatchObject({ ok: true });
    expect(await staffFromRequest(db, req, secret, 1_900_000_000)).toBeNull();
    expect(await staffSignIn(db, who)).toBeNull();
  });
  it("only an exact email match signs in (sub-address, other domain, prefix/suffix tricks)", async () => {
    const { actor: admin } = await bootstrapAdmin();
    const e = fresh();
    await createInvite(db, admin, e, "reporting");
    const [local, domain] = e.split("@") as [string, string];
    for (const email of [`${local}+x@${domain}`, `${local}@${domain}.evil.com`, `x${local}@${domain}`, `${local}@googlemail.com`, `${local}.@${domain}`, `${local}@${domain} x`]) {
      expect(await staffSignIn(db, { ...sub(email), email })).toBeNull();
    }
    expect(await staffSignIn(db, { ...sub(e), email: e })).toMatchObject({ role: "reporting" });
  });
  it("a role change keeps history (old row revoked, new row inserted) and takes effect on the next request", async () => {
    const { actor: admin } = await bootstrapAdmin();
    const e = fresh();
    await createInvite(db, admin, e, "support");
    const member = (await staffSignIn(db, { ...sub(e), email: e }))!;
    const old = (await listInvites(db)).find(i => i.email === e && !i.revokedAt)!;
    expect(await changeInvite(db, admin, old.id, "accountant")).toMatchObject({ ok: true });
    const rows = (await listInvites(db)).filter(i => i.email === e);
    expect(rows.map(r => [r.role, r.revokedAt !== null]).sort()).toEqual([["accountant", false], ["support", true]]);
    const req = new Request("http://x", { headers: { cookie: `ol_staff=${signStaffSession({ uid: member.id, exp: 2_000_000_000 }, secret)}` } });
    expect((await staffFromRequest(db, req, secret, 1_900_000_000))?.role).toBe("accountant");
    const a = (await audits("staff.invite_role_changed")).at(-1)!;
    expect(JSON.stringify(a["payload"])).not.toContain(e);
  });
  it("cannot invite the same email twice while active; a revoked email can be invited again", async () => {
    const { actor: admin } = await bootstrapAdmin();
    const e = fresh();
    expect(await createInvite(db, admin, e, "support")).toMatchObject({ ok: true });
    expect(await createInvite(db, admin, e, "technical")).toMatchObject({ ok: false, status: 409 });
    const id = (await listInvites(db)).find(i => i.email === e && !i.revokedAt)!.id;
    await changeInvite(db, admin, id, null);
    expect(await createInvite(db, admin, e, "technical")).toMatchObject({ ok: true });
  });

  it("an admin cannot revoke or re-role themselves, and the attempt is audited", async () => {
    const { actor, email } = await bootstrapAdmin();
    const second = fresh();
    await createInvite(db, actor, second, "super_admin"); // two admins, so only the self rule applies
    const mine = (await listInvites(db)).find(i => i.email === email && !i.revokedAt)!;
    expect(await changeInvite(db, actor, mine.id, null)).toMatchObject({ ok: false, status: 409 });
    expect(await changeInvite(db, actor, mine.id, "support")).toMatchObject({ ok: false, status: 409 });
    expect((await listInvites(db)).find(i => i.id === mine.id)!.revokedAt).toBeNull();
    expect((await audits("staff.invite_change_refused")).some(r => (r["payload"] as { reason?: string }).reason === "self")).toBe(true);
  });
  it("the last admin cannot be revoked or demoted: the other admin goes first, then nobody can remove the one left", async () => {
    const { actor: a, email } = await bootstrapAdmin();
    const e2 = fresh();
    await createInvite(db, a, e2, "super_admin");
    const bActor = (await staffSignIn(db, { ...sub(e2), email: e2 }))!;
    const list = await listInvites(db);
    const mine = list.find(i => i.email === email && !i.revokedAt)!;
    const theirs = list.find(i => i.email === e2 && !i.revokedAt)!;
    expect(await changeInvite(db, a, theirs.id, null)).toMatchObject({ ok: true });
    // B is now revoked: a request that passed the gate earlier is refused, and A cannot touch their own invite.
    expect(await changeInvite(db, bActor, mine.id, null)).toMatchObject({ ok: false, status: 403 });
    expect(await changeInvite(db, a, mine.id, null)).toMatchObject({ ok: false, status: 409 });
    expect(await changeInvite(db, a, mine.id, "support")).toMatchObject({ ok: false, status: 409 });
    expect((await listInvites(db)).find(i => i.id === mine.id)!.revokedAt).toBeNull();
    expect((await audits("staff.invite_change_refused")).length).toBeGreaterThan(0);
  });
  it("concurrent revokes of the last two admins leave one admin", async () => {
    const { actor } = await bootstrapAdmin();
    const b = fresh();
    await createInvite(db, actor, b, "super_admin");
    const bActor = (await staffSignIn(db, { ...sub(b), email: b }))!;
    const invites = (await listInvites(db)).filter(i => i.role === "super_admin" && !i.revokedAt);
    expect(invites).toHaveLength(2);
    const [x, y] = invites as [typeof invites[0], typeof invites[0]];
    // Each admin tries to revoke the other at the same moment.
    const results = await Promise.all([changeInvite(db, actor, y.email === b ? y.id : x.id, null), changeInvite(db, bActor, x.email === b ? y.id : x.id, null)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect((await listInvites(db)).filter(i => i.role === "super_admin" && !i.revokedAt)).toHaveLength(1);
  });

  it("an existing owner account with the invited email is never converted to staff", async () => {
    const { actor: admin } = await bootstrapAdmin();
    const e = fresh();
    await db.query(`INSERT INTO app_user (email, display_name, user_type, status, google_sub) VALUES ($1, 'Owner', 'owner', 'active', $2)`, [e, `sub-${e}`]);
    await createInvite(db, admin, e, "support");
    expect(await staffSignIn(db, { ...sub(e), email: e })).toBeNull();
    expect((await db.query(`SELECT user_type FROM app_user WHERE email = $1`, [e])).rows[0]!["user_type"]).toBe("owner");
  });
  it("a suspended staff account is denied even with an active invite", async () => {
    const { actor: admin } = await bootstrapAdmin();
    const e = fresh();
    await createInvite(db, admin, e, "support");
    const member = (await staffSignIn(db, { ...sub(e), email: e }))!;
    await db.query(`UPDATE app_user SET status = 'suspended' WHERE id = $1`, [member.id]);
    expect(await staffSignIn(db, { ...sub(e), email: e })).toBeNull();
    const req = new Request("http://x", { headers: { cookie: `ol_staff=${signStaffSession({ uid: member.id, exp: 2_000_000_000 }, secret)}` } });
    expect(await staffFromRequest(db, req, secret, 1_900_000_000)).toBeNull();
  });
  it("a plain owner user id in the staff cookie gets no staff access", async () => {
    const owner = await addUser(db, "owner");
    const req = new Request("http://x", { headers: { cookie: `ol_staff=${signStaffSession({ uid: owner, exp: 2_000_000_000 }, secret)}` } });
    expect(await staffFromRequest(db, req, secret, 1_900_000_000)).toBeNull();
  });

  it("the table is insert only: no delete, no change of email or role, accepted_at and revoked_at set once", async () => {
    const { actor } = await bootstrapAdmin();
    const e = fresh();
    await createInvite(db, actor, e, "support");
    const id = (await listInvites(db)).find(i => i.email === e)!.id;
    await expect(db.query(`DELETE FROM staff_invite WHERE id = $1`, [id])).rejects.toThrow(/cannot be deleted/);
    await expect(db.query(`UPDATE staff_invite SET role = 'super_admin' WHERE id = $1`, [id])).rejects.toThrow(/cannot be changed/);
    await expect(db.query(`UPDATE staff_invite SET email = 'x@y.com' WHERE id = $1`, [id])).rejects.toThrow(/cannot be changed/);
    await db.query(`UPDATE staff_invite SET revoked_at = now() WHERE id = $1`, [id]);
    await expect(db.query(`UPDATE staff_invite SET revoked_at = NULL WHERE id = $1`, [id])).rejects.toThrow(/already revoked/);
  });
  it("the table refuses a non-normalised email", async () => {
    await expect(db.query(`INSERT INTO staff_invite (email, role) VALUES ('A@B.com', 'support')`)).rejects.toThrow(/check/i);
    await expect(db.query(`INSERT INTO staff_invite (email, role) VALUES (' a@b.com', 'support')`)).rejects.toThrow(/check/i);
    await expect(db.query(`INSERT INTO staff_invite (email, role) VALUES ('a@b.com', 'root')`)).rejects.toThrow(/check/i);
  });
  // ---- Independent review (October 2026) ----
  it("concurrent bootstrap sign-ins of several listed emails create exactly one super_admin (and one audit row, no email in it)", async () => {
    const emails = [fresh(), fresh(), fresh(), fresh()];
    const before = (await audits("staff.bootstrap_admin_created")).length;
    const results = await Promise.all(emails.map(e => staffSignIn(db, { ...sub(e), email: e }, emails)));
    expect(results.filter(r => r !== null)).toHaveLength(1);
    expect((await listInvites(db)).filter(i => i.role === "super_admin" && !i.revokedAt)).toHaveLength(1);
    const rows = await audits("staff.bootstrap_admin_created");
    expect(rows).toHaveLength(before + 1);
    expect(JSON.stringify(rows)).not.toContain("@");
  }, 30_000);
  it("an admin revoked a moment ago cannot finish a change that passed the gate earlier", async () => {
    const { actor: a } = await bootstrapAdmin();
    const b = fresh();
    const c = fresh();
    await createInvite(db, a, b, "super_admin");
    await createInvite(db, a, c, "super_admin");
    const bActor = (await staffSignIn(db, { ...sub(b), email: b }))!;
    const all = await listInvites(db);
    const idOf = (e: string) => all.find(i => i.email === e && !i.revokedAt)!.id;
    expect(await changeInvite(db, a, idOf(b), null)).toMatchObject({ ok: true });
    expect(await changeInvite(db, bActor, idOf(c), null)).toMatchObject({ ok: false, status: 403 });
    expect((await listInvites(db)).find(i => i.id === idOf(c))!.revokedAt).toBeNull();
  });
  it("a cookie from an earlier, revoked invite does not revive when the same address is invited again", async () => {
    const { actor: admin } = await bootstrapAdmin();
    const e = fresh();
    await createInvite(db, admin, e, "support");
    const member = (await staffSignIn(db, { ...sub(e), email: e }))!;
    const req = new Request("http://x", { headers: { cookie: `ol_staff=${signStaffSession({ uid: member.id, exp: 2_000_000_000 }, secret)}` } });
    expect(await staffFromRequest(db, req, secret, 1_900_000_000)).toEqual(member);
    const inv = (await listInvites(db)).find(i => i.email === e && !i.revokedAt)!;
    await changeInvite(db, admin, inv.id, null);
    await createInvite(db, admin, e, "super_admin");
    expect(await staffFromRequest(db, req, secret, 1_900_000_000)).toBeNull();
    // Someone else signing in with the reassigned address is refused (the account is bound to the first Google subject)...
    expect(await staffSignIn(db, { sub: "sub-other-person", name: "Other", email: e })).toBeNull();
    // ...and the same person signing in again gets the new role and a working session.
    expect((await staffSignIn(db, { ...sub(e), email: e }))?.role).toBe("super_admin");
    expect(await staffFromRequest(db, req, secret, 1_900_000_000)).toMatchObject({ role: "super_admin" });
  });
  it("the owner/buyer sign-in never rewrites the email of a staff account (the email is the key to its role)", async () => {
    const { actor: admin } = await bootstrapAdmin();
    const e = fresh();
    await createInvite(db, admin, e, "support");
    const member = (await staffSignIn(db, { ...sub(e), email: e }))!;
    const moved = fresh();
    expect(await upsertGoogleUser(db, { ...sub(e), email: moved })).toBeNull();
    expect((await db.query(`SELECT email::text AS email FROM app_user WHERE id = $1`, [member.id])).rows[0]!["email"]).toBe(e);
    // An ordinary owner still gets the email refreshed.
    const o = fresh();
    const owner = (await upsertGoogleUser(db, { sub: `sub-${o}`, name: "O", email: o }))!;
    const o2 = fresh();
    await upsertGoogleUser(db, { sub: `sub-${o}`, name: "O", email: o2 });
    expect((await db.query(`SELECT email::text AS email FROM app_user WHERE id = $1`, [owner.id])).rows[0]!["email"]).toBe(o2);
  });
});
