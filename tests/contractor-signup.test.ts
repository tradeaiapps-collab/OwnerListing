import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTOR_HOME, VENDOR_API_PREFIXES, vendorMayCall } from "../src/domain/contractor-access";
import { activeRole, heldRoles, isUserRole, sessionTypeFor } from "../src/domain/roles";
import { roleNav } from "../src/domain/role-nav";
import type { EmailPort } from "../src/adapters/email";
import { actorFromRequestChecked } from "../src/server/auth/actor";
import { SESSION_COOKIE, signSession } from "../src/server/auth/session";
import { completeSignup, passwordSignIn, startSignup, type EmailAuthDeps } from "../src/server/email-auth";
import { activateRole } from "../src/server/user-roles-db";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const SECRET = "s".repeat(40);
const PW = "correct horse battery";
const now = Math.floor(Date.now() / 1000);

describe("contractor role and access list", () => {
  it("makes a vendor account a contractor, and nothing else can be made one", () => {
    expect(heldRoles("vendor", [])).toEqual(["vendor"]);
    expect(heldRoles("buyer", ["vendor", "owner"])).toEqual(["buyer", "owner"]);
    expect(isUserRole("vendor")).toBe(false);
    expect(sessionTypeFor("vendor")).toBe("vendor");
    expect(activeRole("vendor", undefined, ["vendor"])).toBe("vendor");
    expect(activeRole("owner", "vendor", ["vendor", "owner"])).toBe("owner");
  });
  it("lists only contractor screens for the contractor menu, with Projects kept", () => {
    const ids = roleNav("vendor").map(i => i.id);
    expect(ids).toEqual(expect.arrayContaining(["contractor-profile", "contractor-jobs", "projects"]));
    expect(roleNav("vendor").some(i => /agent|listings\/mine|offers/.test(i.href))).toBe(false);
    expect(CONTRACTOR_HOME).toBe("/contractor/profile");
  });
  it("allows contractor APIs only, including the versioned form, and refuses everything else", () => {
    for (const p of ["/api/jobs", "/api/jobs/abc/review", "/api/contractor-page", "/api/contractor-profile", "/api/v1/jobs/1", "/api/contractor/calendar", "/api/notifications"]) expect(vendorMayCall(p), p).toBe(true);
    for (const p of ["/api/listings", "/api/offers", "/api/me/offers", "/api/agent/leads", "/api/staff/me", "/api/jobsX", "/api/contractor-pagex", "/api/contractor", "/api/inspectors", "/api/jobs/../offers", "/api/jobs/%2e%2e/offers", "/api/jobs%2f..%2foffers", "/api/v2/jobs", "/api/v1", "/", "/jobs"]) expect(vendorMayCall(p), p).toBe(false);
    expect(VENDOR_API_PREFIXES.every(p => p.startsWith("/api/"))).toBe(true);
  });
});

describe.skipIf(!DATABASE_URL)("contractor sign-up and sign-in (Postgres)", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.close(); });
  const sent: { to: string; text: string }[] = [];
  const email: EmailPort = { configured: true, async send(m) { sent.push(m); return { status: "sent" }; } };
  const deps = (): EmailAuthDeps => ({ db: t.db, email, secret: SECRET, appUrl: "https://app.example.com", brand: "OwnerListing" });
  let n = 0;
  const fresh = () => `trade${++n}.${Date.now()}@example.com`;
  const tokenOf = (text: string) => decodeURIComponent(/token=([\w%-]+)/.exec(text)![1]!);
  const req = (uid: string, ut: "vendor" | "owner", path: string) =>
    new Request(`http://x${path}`, { headers: { cookie: `${SESSION_COOKIE}=${signSession({ uid, ut, exp: now + 100, mfa: now }, SECRET)}` } });

  it("creates a contractor with a page and the chosen trade only after the emailed link, then signs in with the password", async () => {
    const addr = fresh();
    expect(await startSignup(deps(), { name: "Pat Pest", email: addr, password: PW, userType: "vendor", trade: "pest_control" }, "9.9.9.1")).toEqual({ ok: true });
    expect((await t.db.query("SELECT 1 FROM app_user WHERE email = $1", [addr])).rows).toHaveLength(0);
    const r = await completeSignup(deps(), tokenOf(sent.at(-1)!.text));
    expect(r).toMatchObject({ ok: true, user: { userType: "vendor" } });
    const id = r.ok ? r.user.id : "";
    const u = (await t.db.query("SELECT user_type, status, roles, active_role FROM app_user WHERE id = $1", [id])).rows[0]!;
    expect(u).toMatchObject({ user_type: "vendor", status: "active", roles: [], active_role: null });
    expect((await t.db.query("SELECT is_public, contractor_no FROM contractor_page WHERE user_id = $1", [id])).rows[0]).toMatchObject({ is_public: false });
    expect((await t.db.query("SELECT kind, service_postcodes FROM contractor_profile WHERE user_id = $1", [id])).rows).toEqual([{ kind: "pest_control", service_postcodes: [] }]);
    expect(await passwordSignIn(deps(), { email: addr, password: PW }, "9.9.9.1")).toMatchObject({ ok: true, user: { id, userType: "vendor" } });
    expect(await passwordSignIn(deps(), { email: addr, password: "wrong password!" }, "9.9.9.1")).toMatchObject({ ok: false, code: "bad_credentials" });
  });

  it("refuses a contractor sign-up without a valid trade and never stores a trade for other accounts", async () => {
    const a = fresh();
    expect(await startSignup(deps(), { name: "No Trade", email: a, password: PW, userType: "vendor" }, "9.9.9.2")).toMatchObject({ ok: false, code: "invalid" });
    await startSignup(deps(), { name: "Ann Owner", email: a, password: PW, userType: "owner", trade: "photographer" }, "9.9.9.2");
    expect((await t.db.query("SELECT trade FROM email_auth_token WHERE email = $1", [a])).rows).toEqual([{ trade: null }]);
    await expect(t.db.query("INSERT INTO email_auth_token (purpose, email, display_name, user_type, password_hash, token_hash, expires_at, trade) VALUES ('signup', $1, 'x', 'owner', 'h', $2, now() + interval '1 hour', 'other')", [fresh(), "a".repeat(64)])).rejects.toThrow();
  });

  it("runs a contractor session on contractor APIs only, and an owner session is unaffected", async () => {
    const addr = fresh();
    await startSignup(deps(), { name: "Pia Photo", email: addr, password: PW, userType: "vendor", trade: "photographer" }, "9.9.9.3");
    const r = await completeSignup(deps(), tokenOf(sent.at(-1)!.text));
    const id = r.ok ? r.user.id : "";
    for (const p of ["/api/jobs", "/api/contractor-page", "/api/v1/contractor-profile"]) expect(await actorFromRequestChecked(t.db, req(id, "vendor", p), SECRET, now), p).toEqual({ userId: id, userType: "vendor" });
    for (const p of ["/api/listings", "/api/offers", "/api/me/offers", "/api/agent/leads", "/api/documents/1"]) expect(await actorFromRequestChecked(t.db, req(id, "vendor", p), SECRET, now), p).toBeNull();
    // A contractor cannot add the owner role (or any other) to the account, and a forged owner cookie is refused.
    expect(await activateRole(t.db, id, "owner")).toBeNull();
    expect(await actorFromRequestChecked(t.db, req(id, "owner", "/api/listings"), SECRET, now)).toBeNull();
    const o = (await t.db.query("INSERT INTO app_user (email, display_name, user_type, status, roles) VALUES ($1, 'O', 'owner', 'active', ARRAY['owner']) RETURNING id", [fresh()])).rows[0]!["id"] as string;
    expect(await actorFromRequestChecked(t.db, req(o, "owner", "/api/listings"), SECRET, now)).toEqual({ userId: o, userType: "owner" });
  });

  it("does not let a suspended contractor sign in or keep a session", async () => {
    const addr = fresh();
    await startSignup(deps(), { name: "Sue Spend", email: addr, password: PW, userType: "vendor", trade: "other" }, "9.9.9.4");
    const r = await completeSignup(deps(), tokenOf(sent.at(-1)!.text));
    const id = r.ok ? r.user.id : "";
    await t.db.query("UPDATE app_user SET status = 'suspended' WHERE id = $1", [id]);
    expect(await passwordSignIn(deps(), { email: addr, password: PW }, "9.9.9.4")).toMatchObject({ ok: false, code: "bad_credentials" });
    expect(await actorFromRequestChecked(t.db, req(id, "vendor", "/api/jobs"), SECRET, now)).toBeNull();
  });
});
