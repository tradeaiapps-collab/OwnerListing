import { describe, expect, it } from "vitest";
import { activeRole, heldRoles, sessionTypeFor } from "../src/domain/roles";
import { dashboardRole } from "../src/domain/dashboard";
import { actorFromRequestChecked } from "../src/server/auth/actor";
import { SESSION_COOKIE, signSession, verifySession } from "../src/server/auth/session";
import type { Queryable } from "../src/server/db";

const secret = "s".repeat(40);
const now = 1_800_000_000;
const uid = "11111111-1111-4111-8111-111111111111";
const req = (token: string) => new Request("http://x", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
const cookie = (ut: "owner" | "agent" | "buyer", cr?: "investor") => signSession({ uid, ut, exp: now + 100, mfa: now - 10, ...(cr ? { cr } : {}) }, secret);

/** Fake app_user: mirrors the SQL (type matches primary, a held role, or buyer via investor). */
function db(row: { user_type: string; roles: string[] }): Queryable {
  return { async query(_t, params = []) {
    const [id, ut] = params as [string, string];
    const ok = id === uid && (row.user_type === ut || row.roles.includes(ut) || (ut === "buyer" && row.roles.includes("investor")));
    return { rows: ok ? [{ id: uid, user_type: row.user_type, roles: row.roles, mfa_enrolled: true, mfa_revoked_at: null }] : [] };
  } };
}

describe("role helpers", () => {
  it("holds the primary role first and drops unknown roles", () => {
    expect(heldRoles("owner", ["buyer", "owner", "admin", "buyer"])).toEqual(["owner", "buyer"]);
    expect(heldRoles("investor", [])).toEqual(["investor"]);
  });
  it("runs investor as buyer", () => { expect(sessionTypeFor("investor")).toBe("buyer"); expect(sessionTypeFor("agent")).toBe("agent"); });
  it("only trusts a cr claim the account holds and that matches the session type", () => {
    expect(activeRole("buyer", "investor", ["buyer", "investor"])).toBe("investor");
    expect(activeRole("buyer", "investor", ["buyer"])).toBe("buyer");
    expect(activeRole("owner", "investor", ["owner", "investor"])).toBe("owner");
    expect(activeRole("agent", undefined, ["owner"])).toBeNull();
  });
  it("shows the investor dashboard only for a buyer session viewing as investor", () => {
    expect(dashboardRole(false, "buyer", "investor")).toBe("investor");
    expect(dashboardRole(false, "owner", "investor")).toBe("owner");
  });
});

describe("session with several roles", () => {
  it("keeps cr only for a buyer session", () => {
    expect(verifySession(cookie("buyer", "investor"), secret, now)?.cr).toBe("investor");
    expect(verifySession(signSession({ uid, ut: "owner", cr: "investor", exp: now + 100 }, secret), secret, now)?.cr).toBeUndefined();
  });
  it("accepts every held role and refuses a role that was never activated", async () => {
    const d = db({ user_type: "buyer", roles: ["buyer", "owner"] });
    expect(await actorFromRequestChecked(d, req(cookie("buyer")), secret, now)).toEqual({ userId: uid, userType: "buyer" });
    expect(await actorFromRequestChecked(d, req(cookie("owner")), secret, now)).toEqual({ userId: uid, userType: "owner" });
    expect(await actorFromRequestChecked(d, req(cookie("agent")), secret, now)).toBeNull();
  });
  it("refuses an investor view unless the investor role is held", async () => {
    expect(await actorFromRequestChecked(db({ user_type: "buyer", roles: ["buyer"] }), req(cookie("buyer", "investor")), secret, now)).toBeNull();
    expect(await actorFromRequestChecked(db({ user_type: "buyer", roles: ["buyer", "investor"] }), req(cookie("buyer", "investor")), secret, now)).toEqual({ userId: uid, userType: "buyer" });
  });
  it("a role removed from the account stops working on the next request", async () => {
    expect(await actorFromRequestChecked(db({ user_type: "buyer", roles: ["buyer"] }), req(cookie("owner")), secret, now)).toBeNull();
  });
});
