import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDraft, createInMemoryListingRepository, publishListing, type Actor, type DraftInput, type ListingServiceDeps } from "../src/domain/listing-service";
import { localDateInZone } from "../src/domain/timezone";
import { actorFromRequestChecked } from "../src/server/auth/actor";
import { SESSION_COOKIE, signSession } from "../src/server/auth/session";
import { STAFF_COOKIE, signStaffSession } from "../src/server/auth/staff-session";
import type { Queryable } from "../src/server/db";

const state = vi.hoisted(() => ({ db: null as Queryable | null }));

vi.mock("../src/server/context", () => ({
  getActor: async () => null,
  getDeps: () => null,
  getDb: () => state.db,
  getStaff: async () => null
}));

vi.mock("../src/server/auth/google", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/auth/google")>()),
  exchangeCode: async () => ({}),
  readIdentity: () => ({ sub: "google-sub-1", email: "u@example.com", name: "U" })
}));

import { GET as callbackGet } from "../app/api/auth/google/callback/route";

const secret = "s".repeat(40);
const now = 1_800_000_000;
const uid = "11111111-1111-4111-8111-111111111111";
const req = (token: string) => new Request("http://x", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
const cookieFor = (ut: "owner" | "agent" | "buyer") => signSession({ uid, ut, exp: now + 100 }, secret);

/** Fake app_user table: answers the per-request lookup the way Postgres would for the given row (or none). */
function usersDb(row: { id: string; user_type: string; status: string } | null): Queryable {
  return {
    async query(text, params = []) {
      expect(text).toMatch(/FROM app_user/);
      const [id, type] = params as [string, string];
      return { rows: row && row.id === id && row.user_type === type && row.status === "active" ? [{ id: row.id, user_type: row.user_type }] : [] };
    }
  };
}

describe("actorFromRequestChecked (session is re-checked against app_user on every request)", () => {
  it("accepts a live cookie for an active user of the same type", async () => {
    const db = usersDb({ id: uid, user_type: "owner", status: "active" });
    expect(await actorFromRequestChecked(db, req(cookieFor("owner")), secret, now)).toEqual({ userId: uid, userType: "owner" });
  });
  it.each(["suspended", "closed", "pending"])("denies a live cookie once the user is %s", async status => {
    const db = usersDb({ id: uid, user_type: "owner", status });
    expect(await actorFromRequestChecked(db, req(cookieFor("owner")), secret, now)).toBeNull();
  });
  it("denies a cookie whose type no longer matches the database", async () => {
    const db = usersDb({ id: uid, user_type: "buyer", status: "active" });
    expect(await actorFromRequestChecked(db, req(cookieFor("owner")), secret, now)).toBeNull();
    const agentDb = usersDb({ id: uid, user_type: "owner", status: "active" });
    expect(await actorFromRequestChecked(agentDb, req(cookieFor("agent")), secret, now)).toBeNull();
  });
  it("denies a cookie for a user who no longer exists", async () => {
    expect(await actorFromRequestChecked(usersDb(null), req(cookieFor("owner")), secret, now)).toBeNull();
  });
  it("denies if the database returns a row for a different user or type than the cookie claims", async () => {
    const db: Queryable = { async query() { return { rows: [{ id: "someone-else", user_type: "owner" }] }; } };
    expect(await actorFromRequestChecked(db, req(cookieFor("owner")), secret, now)).toBeNull();
  });
  it("does not query the database for a missing, forged or expired cookie", async () => {
    const db: Queryable = { async query() { throw new Error("must not be called"); } };
    expect(await actorFromRequestChecked(db, new Request("http://x"), secret, now)).toBeNull();
    expect(await actorFromRequestChecked(db, req("junk"), secret, now)).toBeNull();
    expect(await actorFromRequestChecked(db, req(signSession({ uid, ut: "owner", exp: now - 1 }, secret)), secret, now)).toBeNull();
    expect(await actorFromRequestChecked(db, req(signSession({ uid, ut: "owner", exp: now + 100 }, "t".repeat(40))), secret, now)).toBeNull();
  });
});

describe("licence expiry uses the listing state's local date", () => {
  it("localDateInZone reads the calendar date in the zone, not UTC", () => {
    expect(localDateInZone("2026-10-23T15:00:00.000Z", "Australia/Brisbane")).toBe("2026-10-24");
    expect(localDateInZone("2026-10-23T13:59:00.000Z", "Australia/Brisbane")).toBe("2026-10-23");
    expect(localDateInZone("2026-10-23T15:00:00.000Z", "Australia/Perth")).toBe("2026-10-23");
  });

  const agent: Actor = { userId: "agent-1", userType: "agent" };
  const input: DraftInput = {
    title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
    transactionType: "sale", useClass: "residential", propertyType: "house"
  };

  async function decisionAt(nowIso: string, expiresAt: string) {
    let n = 0;
    const repo = createInMemoryListingRepository();
    const deps: ListingServiceDeps = {
      repo, appendAudit: async () => {}, now: () => nowIso, newId: () => `id-${++n}`, requiredDisclosures: () => [],
      licences: async () => [{ userId: agent.userId, jurisdiction: "QLD", status: "verified", expiresAt }]
    };
    const l = await createDraft(deps, agent, input);
    const rec = (await repo.get(l.id))!;
    await repo.save({ ...rec, listingFeePaid: true, termsAccepted: true });
    const r = await publishListing(deps, agent, l.id, true);
    if (!r.ok) throw new Error("unexpected failure");
    return r.value.decision.reasons.join(" | ");
  }
  const licenceBlocked = (reasons: string) => /licen[cs]e/i.test(reasons);

  it("treats a licence expiring today (local) as still valid late on its last local day", async () => {
    // 23:59 Brisbane on 2026-10-23 (UTC+10) is 13:59Z; the licence expires 2026-10-23.
    expect(licenceBlocked(await decisionAt("2026-10-23T13:59:00.000Z", "2026-10-23"))).toBe(false);
  });
  it("treats the same licence as expired once the local day rolls over, though the UTC date is still the 23rd", async () => {
    // 00:00 Brisbane on 2026-10-24 is 14:00Z on the 23rd.
    expect(licenceBlocked(await decisionAt("2026-10-23T14:00:00.000Z", "2026-10-23"))).toBe(true);
  });
});

describe("sign-in clears the other session cookie", () => {
  beforeEach(() => {
    process.env["SESSION_SECRET"] = secret;
    process.env["GOOGLE_CLIENT_ID"] = "client";
    process.env["GOOGLE_CLIENT_SECRET"] = "client-secret";
    process.env["APP_URL"] = "https://app.example.com";
  });

  const callback = async (role: string, rows: Record<string, unknown>[]) => {
    state.db = { async query() { return { rows }; } };
    const cookies = `ol_state=s1; ol_nonce=n1; ol_verifier=v1; ol_role=${role}; ${SESSION_COOKIE}=old; ${STAFF_COOKIE}=old`;
    const res = await callbackGet(new Request("http://x/api/auth/google/callback?code=c&state=s1", { headers: { cookie: cookies } }));
    return res.headers.getSetCookie();
  };
  const find = (set: string[], name: string) => set.filter(c => c.startsWith(`${name}=`));

  it("staff sign-in sets ol_staff and expires ol_session", async () => {
    const set = await callback("staff", [{ id: "s1", role: "compliance", user_type: "admin", status: "active", google_sub: "google-sub-1" }]);
    expect(find(set, STAFF_COOKIE)[0]).toMatch(/^ol_staff=[^;]+/);
    const cleared = find(set, SESSION_COOKIE);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatch(/^ol_session=;/);
    expect(cleared[0]).toMatch(/Max-Age=0/i);
  });
  it("owner and buyer sign-in set ol_session and expire ol_staff", async () => {
    for (const role of ["owner", "buyer"]) {
      const set = await callback(role, [{ id: uid, user_type: role, status: "active" }]);
      expect(find(set, SESSION_COOKIE)[0]).toMatch(/^ol_session=[^;]+/);
      const cleared = find(set, STAFF_COOKIE);
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatch(/^ol_staff=;/);
      expect(cleared[0]).toMatch(/Max-Age=0/i);
    }
  });
  it("staff cookie helper still signs for the staff path (sanity)", () => {
    expect(signStaffSession({ uid: "s1", exp: now + 1 }, secret)).toContain(".");
  });
});
