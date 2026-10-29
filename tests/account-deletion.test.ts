import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountDeletedEmail, accountRestoredEmail, addYears, canDeleteAccounts, daysLeft, deletionWindows, offerCancelledEmail,
  planAccountDeletion, planAccountRestore, retentionStage, type DeletionTarget
} from "../src/domain/account-deletion";
import { activeHref } from "../src/domain/admin-nav";
import { describeEvent } from "../src/domain/offer-timeline";
import { isSensitivePermission, staffCan, type StaffRole } from "../src/domain/staff-access";
import { sectionsFor, STAFF_SECTIONS } from "../src/domain/staff-admin";

const state = vi.hoisted(() => ({
  staff: null as { id: string; role: string; permissions?: string[] } | null,
  target: null as Record<string, unknown> | null,
  deletes: [] as { userId: string; reason: string; now: string; restoreUntil: string }[],
  deleteResult: null as unknown,
  restores: [] as { userId: string; reason: string }[],
  restoreResult: null as unknown,
  republished: [] as string[][],
  sent: [] as { template: string; to: string; subject: string; text: string }[],
  sendOk: true,
  audits: [] as { eventType: string; aggregateId: string; payload: Record<string, unknown> }[]
}));
vi.mock("../src/server/context", () => ({ getStaff: async () => state.staff, getDb: () => ({ query: async () => ({ rows: [] }) }) }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string; aggregateId: string; payload: Record<string, unknown> }) => { state.audits.push(e); } }));
vi.mock("../src/server/account-deletion-db", () => ({
  findDeletionTarget: async (_db: unknown, by: { email?: string; id?: string }) =>
    state.target && (by.email === state.target["email"] || by.id === state.target["id"]) ? state.target : null,
  listDeletedAccounts: async () => ({ rows: [], nextCursor: null }),
  deleteAccountPg: async (_db: unknown, _s: unknown, userId: string, reason: string, now: string, w: { restoreUntil: string }) => {
    state.deletes.push({ userId, reason, now, restoreUntil: w.restoreUntil }); return state.deleteResult;
  },
  restoreAccountPg: async (_db: unknown, _s: unknown, userId: string, reason: string) => { state.restores.push({ userId, reason }); return state.restoreResult; }
}));
vi.mock("../src/server/listing-reinstate", () => ({
  republishSuspended: async (_s: unknown, ids: string[]) => { state.republished.push(ids); return { restored: 1, notRestored: [{ id: ids[1] ?? "x", title: "Unit", reasons: ["Licence expired."] }] }; }
}));
vi.mock("../src/server/messaging", () => ({
  sendNotice: async (_db: unknown, template: string, to: string, m: { subject: string; text: string }) => {
    if (state.sendOk) state.sent.push({ template, to, ...m });
    return state.sendOk;
  }
}));

import * as listRoute from "../app/api/staff/users/deleted-accounts/route";
import * as restoreRoute from "../app/api/staff/users/deleted-accounts/[id]/route";

const ROLES: StaffRole[] = ["super_admin", "compliance", "accountant", "support", "technical", "reporting", "designer"];
const ADMIN = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-10-29T00:00:00.000Z";
const H = { "content-type": "application/json", origin: "http://test" };
const get = (q = "") => new Request(`http://test/x${q}`, { headers: H });
const post = (body: unknown, headers: Record<string, string> = H) => new Request("http://test/x", { method: "POST", headers, body: JSON.stringify(body) });
const ctx = (id = OWNER) => ({ params: Promise.resolve({ id }) });
const GOOD = { userId: OWNER, confirmEmail: " Owner@Example.com", reason: "Owner asked by phone to close the account" };
const SUPER = { id: ADMIN, role: "super_admin" };
const target = (o: Partial<DeletionTarget> = {}): DeletionTarget =>
  ({ id: OWNER, email: "owner@example.com", userType: "owner", status: "active", deletedAt: null, restoreUntil: null, deactivatedAt: null, ...o });

beforeEach(() => {
  process.env["APP_URL"] = "http://test"; delete process.env["APP_MODE"];
  state.staff = null;
  state.target = { ...target(), displayName: "Olive Owner", listings: 2, pendingOffers: 1, liveOffers: 1 };
  state.deletes = []; state.restores = []; state.republished = []; state.sent = []; state.audits = []; state.sendOk = true;
  state.deleteResult = {
    listings: [{ id: "l1", from: "published" }, { id: "l2", from: "draft" }], liveOffers: 1,
    cancelledOffers: [
      { offerId: "o1", listingTitle: "3 Bay St", notify: { role: "buyer", email: "buyer@example.com" } },
      { offerId: "o2", listingTitle: "3 Bay St", notify: null }
    ]
  };
  state.restoreResult = { status: "active", listings: [{ id: "l1", to: "suspended", wasPublished: true }, { id: "l2", to: "draft", wasPublished: false }] };
});

describe("who may delete", () => {
  it("only the super admin role holds user.delete, which is sensitive; a custom role holding it is still refused", () => {
    expect(isSensitivePermission("user.delete")).toBe(true);
    for (const r of ROLES) {
      expect(staffCan({ id: ADMIN, role: r }, "user.delete"), r).toBe(r === "super_admin");
      expect(canDeleteAccounts({ id: ADMIN, role: r }), r).toBe(r === "super_admin");
    }
    expect(canDeleteAccounts({ id: ADMIN, role: "custom_helpdesk", permissions: ["user.delete"] })).toBe(false);
  });
  it("the deleted accounts screen is a staff section for super admins only, and its path wins over User accounts", () => {
    expect(sectionsFor(SUPER).map(s => s.href)).toContain("/staff/users/deleted-accounts");
    expect(sectionsFor({ id: ADMIN, role: "compliance" }).map(s => s.href)).not.toContain("/staff/users/deleted-accounts");
    expect(activeHref("/staff/users/deleted-accounts", STAFF_SECTIONS)).toBe("/staff/users/deleted-accounts");
  });
});

describe("planning", () => {
  it("fixes a 30-day recovery window and a 7-year retention period at deletion", () => {
    expect(deletionWindows(NOW)).toEqual({ restoreUntil: "2026-11-28T00:00:00.000Z", retainUntil: "2033-10-29T00:00:00.000Z" });
    expect(addYears("2028-02-29T10:00:00.000Z", 7)).toBe("2035-03-01T10:00:00.000Z");
  });
  it("deletes with the typed email and a reason; refuses staff, self, already deleted or closed, and a wrong confirmation", () => {
    const ok = planAccountDeletion(SUPER, target(), { confirmEmail: "OWNER@example.com ", reason: "  Asked to close the account " }, NOW);
    expect(ok).toEqual({ action: "delete", reason: "Asked to close the account", windows: deletionWindows(NOW) });
    const status = (t: DeletionTarget, i = { confirmEmail: "owner@example.com", reason: "Asked to close the account" }, s = SUPER) =>
      (planAccountDeletion(s, t, i, NOW) as { status?: number }).status;
    expect(status(target(), undefined, { id: ADMIN, role: "compliance" })).toBe(403);
    expect(status(target({ id: ADMIN }))).toBe(403);
    expect(status(target({ userType: "admin" }))).toBe(403);
    expect(status(target({ deletedAt: NOW }))).toBe(409);
    expect(status(target({ status: "closed" }))).toBe(409);
    expect(status(target(), { confirmEmail: "other@example.com", reason: "Asked to close the account" })).toBe(400);
    expect(status(target({ email: null }), { confirmEmail: "", reason: "Asked to close the account" })).toBe(400);
    expect(status(target(), { confirmEmail: "owner@example.com", reason: "short" })).toBe(400);
    expect(status(target(), { confirmEmail: "owner@example.com", reason: "x".repeat(301) })).toBe(400);
  });
  it("restores only inside the window, never after the deletion became final", () => {
    const deleted = target({ status: "closed", deletedAt: NOW, restoreUntil: "2026-11-28T00:00:00.000Z" });
    const r = (t: DeletionTarget, now: string) => planAccountRestore(SUPER, t, { reason: "Owner called back within the window" }, now);
    expect(r(deleted, "2026-11-27T23:59:59.000Z")).toEqual({ action: "restore", reason: "Owner called back within the window" });
    expect(r(deleted, "2026-11-28T00:00:00.000Z")).toMatchObject({ action: "deny", status: 409 });
    expect(r({ ...deleted, deactivatedAt: "2026-11-28T00:00:00.000Z" }, "2026-11-01T00:00:00.000Z")).toMatchObject({ action: "deny", status: 409 });
    expect(r(target(), NOW)).toMatchObject({ action: "deny", status: 409 });
    expect(planAccountRestore({ id: ADMIN, role: "support" }, deleted, { reason: "Owner called back" }, NOW)).toMatchObject({ status: 403 });
    expect(planAccountRestore(SUPER, deleted, { reason: "short" }, NOW)).toMatchObject({ status: 400 });
  });
  it("tells where a deleted account stands and how many days are left", () => {
    const f = { restoreUntil: "2026-11-28T00:00:00.000Z", retainUntil: "2033-10-29T00:00:00.000Z", deactivatedAt: null, purgedAt: null };
    expect(retentionStage(f, NOW)).toBe("restorable");
    expect(daysLeft(f.restoreUntil, NOW)).toBe(30);
    expect(daysLeft(f.restoreUntil, "2026-11-27T12:00:00.000Z")).toBe(1);
    expect(retentionStage(f, "2026-11-28T00:00:00.000Z")).toBe("final");
    expect(retentionStage({ ...f, deactivatedAt: "2026-11-28T00:00:00.000Z" }, "2027-01-01T00:00:00.000Z")).toBe("final");
    expect(retentionStage({ ...f, deactivatedAt: "2026-11-28T00:00:00.000Z" }, "2033-10-29T00:00:00.000Z")).toBe("purge_due");
    expect(retentionStage({ ...f, deactivatedAt: "x", purgedAt: "2033-10-30T00:00:00.000Z" }, "2034-01-01T00:00:00.000Z")).toBe("purged");
  });
});

describe("notices", () => {
  it("tell the account holder the deadline and what happened, and the other side only that the account closed", () => {
    const d = accountDeletedEmail("OwnerListing", "2026-11-28T00:00:00.000Z");
    expect(d.subject).toBe("Your OwnerListing account has been deleted");
    expect(d.text).toContain("before 28 November 2026");
    expect(d.text).toContain("7 years");
    expect(d.text).toContain("Accepted offers are not affected");
    expect(accountRestoredEmail("OwnerListing", "https://ownerlisting.com.au").text).toContain("sign in at https://ownerlisting.com.au");
    const b = offerCancelledEmail("OwnerListing", "buyer", "3 Bay St\r\nBcc: x@evil.test");
    expect(b.subject).not.toMatch(/[\r\n]/);
    expect(b.text).toContain("your offer has been cancelled");
    expect(offerCancelledEmail("OwnerListing", "owner", "3 Bay St").text).toContain("Your listing is not affected");
  });
  it("a system withdrawal reads as a cancellation in the offer history", () => {
    expect(describeEvent({ type: "withdrawn", actor: "system" }, "buyer")).toBe("The offer was cancelled because an account on the other side was closed");
    expect(describeEvent({ type: "withdrawn", actor: "buyer" }, "owner")).toBe("The buyer withdrew the offer");
  });
});

describe("/api/staff/users/deleted-accounts", () => {
  it("signed out = 401; every other role = 403; a custom role holding the permission = 403; cross-origin POST refused", async () => {
    expect((await listRoute.GET(get())).status).toBe(401);
    for (const r of ROLES.filter(x => x !== "super_admin")) {
      state.staff = { id: ADMIN, role: r };
      expect((await listRoute.GET(get())).status, r).toBe(403);
      expect((await listRoute.POST(post(GOOD))).status, r).toBe(403);
      expect((await restoreRoute.POST(post({ reason: "Owner called back in time" }), ctx())).status, r).toBe(403);
    }
    state.staff = { id: ADMIN, role: "custom_helpdesk", permissions: ["user.delete"] };
    expect((await listRoute.POST(post(GOOD))).status).toBe(403);
    state.staff = SUPER;
    expect((await listRoute.POST(post(GOOD, { "content-type": "application/json", origin: "http://evil" }))).status).toBe(403);
    expect(state.deletes).toEqual([]);
  });
  it("lists deleted accounts, and looks one up by email with an audited lookup (misses audited without the address)", async () => {
    state.staff = SUPER;
    expect(await (await listRoute.GET(get())).json()).toMatchObject({ accounts: [], nextCursor: null });
    const r = await listRoute.GET(get("?email=OWNER@example.com"));
    expect((await r.json()).user).toMatchObject({ id: OWNER, listings: 2, pendingOffers: 1, liveOffers: 1 });
    expect((await listRoute.GET(get("?email=nope"))).status).toBe(400);
    expect((await listRoute.GET(get("?email=nobody@example.com"))).status).toBe(404);
    expect(state.audits.map(a => a.eventType)).toEqual(["user.deletion_lookup", "user.deletion_lookup_miss"]);
    expect(JSON.stringify(state.audits)).not.toContain("nobody@example.com");
  });
  it("deletes, emails the account holder and each other side still on the platform, and audits the notices", async () => {
    state.staff = SUPER;
    const r = await listRoute.POST(post(GOOD));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, listingsArchived: 2, offersCancelled: 2, counterpartiesNotified: 1, liveOffersKept: 1, accountEmailSent: true });
    expect(state.deletes).toEqual([expect.objectContaining({ userId: OWNER, reason: GOOD.reason })]);
    expect(state.sent.map(s => [s.template, s.to])).toEqual([["account_deleted", "owner@example.com"], ["offer_cancelled_account_closed", "buyer@example.com"]]);
    expect(state.audits).toEqual([expect.objectContaining({ eventType: "user.deletion_notices", payload: { role: "super_admin", accountEmailSent: true, counterpartiesNotified: 1, counterparties: 2 } })]);
  });
  it("still deletes when email fails; refuses a wrong confirmation, a bad or unknown id, and a deletion that lost the race", async () => {
    state.staff = SUPER; state.sendOk = false;
    expect(await (await listRoute.POST(post(GOOD))).json()).toMatchObject({ ok: true, accountEmailSent: false, counterpartiesNotified: 0 });
    state.deletes = [];
    expect((await listRoute.POST(post({ ...GOOD, confirmEmail: "x@example.com" }))).status).toBe(400);
    expect((await listRoute.POST(post({ ...GOOD, userId: "nope" }))).status).toBe(404);
    expect((await listRoute.POST(post({ ...GOOD, userId: "00000000-0000-4000-8000-000000000009" }))).status).toBe(404);
    expect(state.deletes).toEqual([]);
    state.deleteResult = null;
    expect((await listRoute.POST(post(GOOD))).status).toBe(409);
  });
  it("restores inside the window: re-runs the publish gate for listings that were live, and emails the account holder", async () => {
    state.staff = SUPER;
    state.target = { ...target({ status: "closed", deletedAt: NOW, restoreUntil: new Date(Date.now() + 86_400_000).toISOString() }), listings: 0, pendingOffers: 0, liveOffers: 0 };
    const r = await restoreRoute.POST(post({ reason: "Owner called back within the window" }), ctx());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, status: "active", listingsBack: 2, listingsLive: 1, emailSent: true });
    expect(state.republished).toEqual([["l1"]]);
    expect(state.sent.map(s => s.template)).toEqual(["account_restored"]);
    expect(state.audits.map(a => a.eventType)).toEqual(["user.restore_notice"]);
  });
  it("refuses a restore after the window, for a live account, for a bad id, and when it lost the race", async () => {
    state.staff = SUPER;
    state.target = { ...target({ status: "closed", deletedAt: NOW, restoreUntil: "2026-01-01T00:00:00.000Z" }) };
    expect((await restoreRoute.POST(post({ reason: "Owner called back late" }), ctx())).status).toBe(409);
    state.target = { ...target() };
    expect((await restoreRoute.POST(post({ reason: "Owner called back late" }), ctx())).status).toBe(409);
    expect((await restoreRoute.POST(post({ reason: "Owner called back late" }), ctx("nope"))).status).toBe(404);
    expect(state.restores).toEqual([]);
    state.target = { ...target({ status: "closed", deletedAt: NOW, restoreUntil: new Date(Date.now() + 86_400_000).toISOString() }) };
    state.restoreResult = null;
    expect((await restoreRoute.POST(post({ reason: "Owner called back in time" }), ctx())).status).toBe(409);
    expect(state.sent).toEqual([]);
  });
});
