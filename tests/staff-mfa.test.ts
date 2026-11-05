import { beforeEach, describe, expect, it, vi } from "vitest";
import { signStaffSession, verifyStaffSession } from "../src/server/auth/staff-session";
import type { Queryable } from "../src/server/db";
import { staffFromRequest, staffSessionFromRequest } from "../src/server/staff-auth";

const SECRET = "s".repeat(40);
const UID = "00000000-0000-4000-8000-000000000001";
const CASE = "00000000-0000-4000-8000-000000000100";
const nowS = () => Math.floor(Date.now() / 1000);

const state = vi.hoisted(() => ({
  mfa: { enrolled: false, revoked_at: null as number | null, reset_at: null as number | null },
  calls: [] as string[]
}));
const fakeDb: Queryable = {
  async query(text) {
    if (/FROM mfa_factor f/.test(text)) return { rows: [{ ...state.mfa }] };
    return { rows: [{ id: UID, role: "super_admin" }] };
  }
};

vi.mock("../src/server/context", () => ({ getActor: () => null, getDeps: () => null, getDb: () => fakeDb, getStaff: async () => ({ id: UID, role: "super_admin" }) }));
vi.mock("../src/server/deposit-escrow-db", () => ({
  getHolding: async () => ({ movements: [] }), cancelHolding: async () => ({ ok: true, value: {} }), recordReceipt: async () => ({ ok: true, value: {} }),
  requestRelease: async () => ({ ok: true, value: {} }),
  decideRelease: async () => { state.calls.push("decideRelease"); return { ok: true, value: { status: "approved" } }; }
}));
vi.mock("../src/server/sale-fall-through-db", () => ({
  requestCasePayout: async () => { state.calls.push("case_payout"); return { ok: true, value: { releaseId: "r" } }; },
  resolveDispute: async () => { state.calls.push("case_resolve"); return { ok: true, value: { status: "agreed" } }; },
  decideResolution: async (_d: unknown, _s: unknown, _h: unknown, _c: unknown, outcome: string) => { state.calls.push(`decide_${outcome}`); return { ok: true, value: { status: "x" } }; }
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));

import * as escrow from "../app/api/staff/escrow/[id]/route";
import * as release from "../app/api/staff/escrow/releases/[id]/route";
import * as mfaStatus from "../app/api/staff/mfa/status/route";

process.env["SESSION_SECRET"] = SECRET;
process.env["APP_URL"] = "http://test";

const cookie = (mfa?: number, exp = nowS() + 3600) => `ol_staff=${signStaffSession({ uid: UID, exp, ...(mfa !== undefined ? { mfa } : {}) }, SECRET)}`;
const post = (url: string, body: unknown, mfa?: number) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: "http://test", cookie: cookie(mfa) }, body: JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: CASE }) };

beforeEach(() => { state.mfa = { enrolled: false, revoked_at: null, reset_at: null }; state.calls = []; });

describe("staff session MFA claim", () => {
  it("round-trips the mfa time and rejects a non-numeric one", () => {
    expect(verifyStaffSession(signStaffSession({ uid: UID, exp: nowS() + 60, mfa: 5 }, SECRET), SECRET, nowS())?.mfa).toBe(5);
    expect(verifyStaffSession(signStaffSession({ uid: UID, exp: nowS() + 60 }, SECRET), SECRET, nowS())).not.toHaveProperty("mfa");
    const bad = Buffer.from(JSON.stringify({ uid: UID, exp: nowS() + 60, mfa: "x" })).toString("base64url");
    expect(verifyStaffSession(`${bad}.AAAA`, SECRET, nowS())).toBeNull();
  });
});

describe("staffFromRequest with two-step sign-in", () => {
  const req = (mfa?: number, exp?: number) => new Request("http://x", { headers: { cookie: cookie(mfa, exp) } });
  it("staff who have not enrolled sign in as before (MFA is optional)", async () => {
    expect(await staffFromRequest(fakeDb, req(), SECRET, nowS())).toEqual({ id: UID, role: "super_admin" });
  });
  it("an enrolled member is signed out until the second step is passed", async () => {
    state.mfa.enrolled = true;
    expect(await staffFromRequest(fakeDb, req(), SECRET, nowS())).toBeNull();
    expect(await staffFromRequest(fakeDb, req(nowS() - 10), SECRET, nowS())).toEqual({ id: UID, role: "super_admin" });
    const s = await staffSessionFromRequest(fakeDb, req(), SECRET, nowS());
    expect(s?.mfa).toEqual({ enrolled: true, satisfied: false });
  });
  it("removing a method ends sessions that passed before it", async () => {
    state.mfa = { enrolled: true, revoked_at: nowS() - 5, reset_at: null };
    expect(await staffFromRequest(fakeDb, req(nowS() - 60), SECRET, nowS())).toBeNull();
    expect(await staffFromRequest(fakeDb, req(nowS() - 1), SECRET, nowS())).not.toBeNull();
  });
  it("a staff reset refuses any session issued at or before it", async () => {
    state.mfa = { enrolled: false, revoked_at: nowS() - 5, reset_at: nowS() - 5 };
    const issued = nowS() - 100;
    expect(await staffFromRequest(fakeDb, req(undefined, issued + 4 * 60 * 60), SECRET, nowS())).toBeNull();
    expect(await staffFromRequest(fakeDb, req(undefined, nowS() + 4 * 60 * 60), SECRET, nowS())).not.toBeNull();
  });
});

describe("sensitive staff actions need a recent MFA check", () => {
  const sensitive: [string, () => Promise<Response>, string][] = [
    ["case_resolve", () => escrow.POST(post("http://test/x", { action: "case_resolve", caseId: CASE, source: "agreement", reference: "R1", refundCents: 0, releaseCents: 0, reason: "Agreed by both sides" }), ctx), "case_resolve"],
    ["case_payout", () => escrow.POST(post("http://test/x", { action: "case_payout", caseId: CASE }), ctx), "case_payout"],
    ["case_resolve_decide approve", () => escrow.POST(post("http://test/x", { action: "case_resolve_decide", caseId: CASE, outcome: "approve", reason: "Looks right to me" }), ctx), "decide_approve"],
    ["release approve", () => release.POST(post("http://test/x", { outcome: "approve", reason: "Checked the paperwork" }), ctx), "decideRelease"]
  ];
  for (const [name, run] of sensitive) {
    it(`${name}: refused with enroll_mfa when not enrolled`, async () => {
      const r = await run();
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ code: "mfa_required", nextStep: "enroll_mfa" });
      expect(state.calls).toEqual([]);
    });
  }
  it("enrolled but stale: 403 verify_mfa, nothing runs", async () => {
    state.mfa.enrolled = true;
    const r = await escrow.POST(post("http://test/x", { action: "case_payout", caseId: CASE }, nowS() - 16 * 60), ctx);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: "mfa_required", nextStep: "verify_mfa" });
    expect(state.calls).toEqual([]);
  });
  it("a check within 15 minutes lets every gated action through", async () => {
    state.mfa.enrolled = true;
    const fresh = nowS() - 60;
    expect((await escrow.POST(post("http://test/x", { action: "case_payout", caseId: CASE }, fresh), ctx)).status).toBe(200);
    expect((await escrow.POST(post("http://test/x", { action: "case_resolve_decide", caseId: CASE, outcome: "approve", reason: "Looks right to me" }, fresh), ctx)).status).toBe(200);
    expect((await release.POST(post("http://test/x", { outcome: "approve", reason: "Checked the paperwork" }, fresh), ctx)).status).toBe(200);
    expect(state.calls).toEqual(["case_payout", "decide_approve", "decideRelease"]);
  });
  it("a check removed since (method revoked) no longer counts", async () => {
    state.mfa = { enrolled: false, revoked_at: nowS() - 5, reset_at: null };
    const r = await release.POST(post("http://test/x", { outcome: "approve", reason: "Checked the paperwork" }, nowS() - 60), ctx);
    expect(r.status).toBe(403);
    expect(state.calls).toEqual([]);
  });
  it("rejecting a proposal or a release needs no check", async () => {
    expect((await escrow.POST(post("http://test/x", { action: "case_resolve_decide", caseId: CASE, outcome: "reject", reason: "Not agreed yet" }), ctx)).status).toBe(200);
    expect((await release.POST(post("http://test/x", { outcome: "reject", reason: "Not ready to pay" }), ctx)).status).toBe(200);
  });
  it("the staff MFA status route works for staff and answers 401 without a staff session", async () => {
    expect((await mfaStatus.GET(new Request("http://test/api/staff/mfa/status"))).status).toBe(401);
  });
});
