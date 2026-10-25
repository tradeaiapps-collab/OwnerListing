import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";
import { sectionsFor } from "../src/domain/staff-admin";
import type { IdSubmission } from "../src/domain/id-verification";

const state = vi.hoisted(() => ({
  staff: null as StaffActor | null,
  case: null as Record<string, unknown> | null,
  trust: null as Record<string, unknown> | null,
  sub: null as object | null,
  calls: [] as string[],
  track(name: string) { return (..._a: unknown[]) => { state.calls.push(name); return Promise.resolve(true); }; }
}));

vi.mock("../src/server/context", () => ({ getActor: () => null, getDb: () => ({ query: async () => ({ rows: [] }) }), getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/staff-admin-db", () => ({
  listCases: async () => [], getCase: async () => state.case, claimCase: state.track("claim"), proposeResolve: state.track("propose"), resolveCase: (...a: unknown[]) => { state.calls.push(`resolve:${JSON.stringify(a[4])}`); return Promise.resolve(true); },
  listTrustQueue: async () => [], getTrustCheckState: async () => state.trust,
  recordTrustApproval: state.track("first_approval"), finaliseTrustApproval: state.track("finalise"), rejectTrustCheck: state.track("reject_trust"),
  listIdQueue: async () => [], getIdSubmission: async () => state.sub, saveIdReview: state.track("save_id")
}));

import * as casesList from "../app/api/staff/cases/route";
import * as claim from "../app/api/staff/cases/[id]/claim/route";
import * as resolve from "../app/api/staff/cases/[id]/resolve/route";
import * as trustList from "../app/api/staff/trust-accounts/route";
import * as trustDecision from "../app/api/staff/trust-accounts/[id]/decision/route";
import * as idList from "../app/api/staff/id-review/route";
import * as idDecision from "../app/api/staff/id-review/[id]/decision/route";
process.env["APP_URL"] = "http://test";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const comp: StaffActor = { id: U(1), role: "compliance" };
const admin: StaffActor = { id: U(2), role: "super_admin" };
const admin2: StaffActor = { id: U(3), role: "super_admin" };
const support: StaffActor = { id: U(4), role: "support" };
const tech: StaffActor = { id: U(5), role: "technical" };
const CASE = U(100);
const ctx = { params: Promise.resolve({ id: CASE }) };
const post = (route: { POST: (r: Request, c: typeof ctx) => Promise<Response> }, body: unknown, headers: Record<string, string> = { "content-type": "application/json", origin: "http://test" }) =>
  route.POST(new Request("http://test/api/staff/x", { method: "POST", headers, body: JSON.stringify(body) }), ctx);
const get = (route: { GET: (r: Request) => Promise<Response> }) => route.GET(new Request("http://test/api/staff/x"));

const caseRow = (o: Record<string, unknown> = {}) => ({ id: CASE, kind: "other", status: "in_progress", assignedTo: comp.id, proposedBy: null, proposedByRole: null, proposedReason: null, ...o });
const trustRow = (o: Record<string, unknown> = {}) => ({ decision: "awaiting_human_approval", latest: true, fingerprint: "f2", lastApprovedFingerprint: null, priors: [], ...o });
const subRow = (o: Partial<IdSubmission> = {}): IdSubmission => ({
  id: CASE, userId: U(50), documentKind: "drivers_licence", documentCountry: "AU", expiryDate: "2030-01-01", selfieCapturedInApp: true,
  submittedAt: "2026-10-24T00:00:00.000Z", status: "pending", approvals: [], ...o
});
const ticks = { documentLooksGenuine: true, photoMatchesSelfie: true, nameMatchesAccount: true, notExpired: true, officialStatusCheck: "done" };
const REASON = "Checked the registry and bank letter.";

beforeEach(() => { state.staff = null; state.case = caseRow(); state.trust = trustRow(); state.sub = subRow(); state.calls = []; });

describe("dashboard sections follow permissions", () => {
  it("shows each role only what it may use", () => {
    expect(sectionsFor(comp).map(s => s.href)).toEqual(["/staff/cases", "/staff/safety", "/staff/trust-accounts", "/staff/id-review", "/staff/disclosures", "/staff/disclosures/reviews", "/staff/audit", "/staff/investments"]);
    expect(sectionsFor(support).map(s => s.href)).toEqual(["/staff/cases", "/staff/safety"]);
    expect(sectionsFor(tech)).toEqual([]);
  });
});

describe("no staff session", () => {
  it("is refused on every route", async () => {
    for (const r of [await get(casesList), await get(trustList), await get(idList),
      await post(claim, {}), await post(resolve, { reason: REASON }), await post(trustDecision, { outcome: "approve", reason: REASON }), await post(idDecision, { outcome: "reject", reason: REASON })]) {
      expect(r.status).toBe(401);
    }
    expect(state.calls).toEqual([]);
  });
});

describe("wrong permission", () => {
  it("refuses roles without the permission", async () => {
    state.staff = tech;
    expect((await get(casesList)).status).toBe(403);
    expect((await post(claim, {})).status).toBe(403);
    state.staff = support;
    expect((await get(trustList)).status).toBe(403);
    expect((await post(trustDecision, { outcome: "approve", reason: REASON })).status).toBe(403);
    expect((await get(idList)).status).toBe(403);
    expect((await post(idDecision, { outcome: "reject", reason: REASON })).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
  it("refuses cross-origin and non-JSON state changes before anything else", async () => {
    state.staff = comp;
    expect((await post(claim, {}, { "content-type": "application/json", origin: "http://evil" })).status).toBe(403);
    expect((await post(claim, {}, { origin: "http://test" })).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
});

describe("admin cases", () => {
  it("claims a case", async () => {
    state.staff = comp; state.case = caseRow({ assignedTo: null, status: "open" });
    expect((await post(claim, {})).status).toBe(200);
    expect(state.calls).toEqual(["claim"]);
  });
  it("refuses a case claimed by someone else", async () => {
    state.staff = comp; state.case = caseRow({ assignedTo: support.id });
    expect((await post(claim, {})).status).toBe(409);
  });
  it("requires a reason, and the claim", async () => {
    state.staff = comp;
    for (const reason of [undefined, "", "short", "         "]) expect((await post(resolve, { reason })).status).toBe(400);
    state.case = caseRow({ assignedTo: null });
    expect((await post(resolve, { reason: REASON })).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
  it("resolves an ordinary case without an override", async () => {
    state.staff = comp;
    expect((await post(resolve, { reason: REASON })).status).toBe(200);
    expect(state.calls).toEqual(["resolve:null"]);
  });
  it("closes identity cases only through the identity queue", async () => {
    state.staff = comp; state.case = caseRow({ kind: "identity_verification" });
    expect((await post(resolve, { reason: REASON })).status).toBe(409);
  });
  it("safety gates: the first person only proposes, even a super admin", async () => {
    for (const s of [comp, admin]) {
      state.staff = s; state.calls = []; state.case = caseRow({ kind: "trust_account_verification", assignedTo: s.id });
      expect((await post(resolve, { reason: REASON })).status).toBe(202);
      expect(state.calls).toEqual(["propose"]);
    }
  });
  it("safety gates: the proposer cannot confirm their own override", async () => {
    state.staff = admin; state.case = caseRow({ kind: "licence_verification", assignedTo: admin.id, proposedBy: admin.id, proposedByRole: "super_admin", proposedReason: REASON });
    expect((await post(resolve, { reason: REASON })).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
  it("safety gates: a second person without override.approve cannot confirm", async () => {
    state.staff = { id: U(9), role: "compliance" };
    state.case = caseRow({ kind: "licence_verification", assignedTo: admin.id, proposedBy: admin.id, proposedByRole: "super_admin", proposedReason: REASON });
    expect((await post(resolve, { reason: REASON })).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
  it("safety gates: a different authorised person completes it and the override is logged", async () => {
    state.staff = admin2;
    state.case = caseRow({ kind: "trust_account_verification", assignedTo: comp.id, proposedBy: comp.id, proposedByRole: "compliance", proposedReason: REASON });
    expect((await post(resolve, { reason: "Agreed after checking." })).status).toBe(200);
    expect(state.calls).toEqual([`resolve:${JSON.stringify({ actorId: comp.id, approverId: admin2.id, reason: REASON, target: "trust_account" })}`]);
  });
  it("safety gates: a proposer who is no longer staff blocks the override", async () => {
    state.staff = admin2;
    state.case = caseRow({ kind: "trust_account_verification", proposedBy: comp.id, proposedByRole: null, proposedReason: REASON });
    expect((await post(resolve, { reason: REASON })).status).toBe(409);
  });
});

describe("trust account approvals", () => {
  it("requires an outcome and a reason", async () => {
    state.staff = comp;
    expect((await post(trustDecision, { outcome: "maybe", reason: REASON })).status).toBe(400);
    for (const reason of [undefined, "", "too short"]) expect((await post(trustDecision, { outcome: "approve", reason })).status).toBe(400);
    expect(state.calls).toEqual([]);
  });
  it("new or changed details: the first approval is only recorded", async () => {
    state.staff = comp;
    const r = await post(trustDecision, { outcome: "approve", reason: REASON });
    expect(await r.json()).toMatchObject({ outcome: "first_approval", pendingSecondPerson: true });
    expect(state.calls).toEqual(["first_approval"]);
  });
  it("the same person cannot approve twice", async () => {
    state.staff = comp; state.trust = trustRow({ priors: [{ staffId: comp.id, outcome: "approve" }] });
    expect((await post(trustDecision, { outcome: "approve", reason: REASON })).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
  it("a different second person finalises", async () => {
    state.staff = admin; state.trust = trustRow({ priors: [{ staffId: comp.id, outcome: "approve" }] });
    expect((await post(trustDecision, { outcome: "approve", reason: REASON })).status).toBe(200);
    expect(state.calls).toEqual(["finalise"]);
  });
  it("unchanged details of a previously approved account need one person", async () => {
    state.staff = comp; state.trust = trustRow({ lastApprovedFingerprint: "f2" });
    expect((await post(trustDecision, { outcome: "approve", reason: REASON })).status).toBe(200);
    expect(state.calls).toEqual(["finalise"]);
  });
  it("one rejection is final, with a reason", async () => {
    state.staff = comp;
    expect((await post(trustDecision, { outcome: "reject", reason: REASON })).status).toBe(200);
    expect(state.calls).toEqual(["reject_trust"]);
    state.calls = []; state.trust = trustRow({ priors: [{ staffId: admin.id, outcome: "reject" }] });
    expect((await post(trustDecision, { outcome: "approve", reason: REASON })).status).toBe(409);
    expect(state.calls).toEqual([]);
  });
  it("refuses a check that is superseded or not waiting", async () => {
    state.staff = comp;
    for (const t of [trustRow({ latest: false }), trustRow({ decision: "approved" })]) {
      state.trust = t;
      expect((await post(trustDecision, { outcome: "approve", reason: REASON })).status).toBe(409);
    }
  });
});

describe("identity review", () => {
  it("lists the queue without images and says images are unavailable", async () => {
    state.staff = comp;
    expect(await (await get(idList)).json()).toMatchObject({ submissions: [], imagesAvailable: false });
  });
  it("a reviewer cannot review their own check", async () => {
    state.staff = comp; state.sub = subRow({ userId: comp.id });
    for (const outcome of ["approve", "reject", "needs_more"]) expect((await post(idDecision, { outcome, reason: REASON, checklist: ticks })).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
  it("requires an outcome and a reason", async () => {
    state.staff = comp;
    expect((await post(idDecision, { outcome: "nope", reason: REASON })).status).toBe(400);
    expect((await post(idDecision, { outcome: "reject" })).status).toBe(400);
    expect((await post(idDecision, { outcome: "reject", reason: "short" })).status).toBe(400);
    expect(state.calls).toEqual([]);
  });
  it("blocks approval while images are unavailable, even with every tick (fails closed)", async () => {
    state.staff = admin;
    const r = await post(idDecision, { outcome: "approve", reason: REASON, checklist: ticks });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/images are unavailable/i);
    expect(state.calls).toEqual([]);
  });
  it("still lets a reviewer reject or ask for more", async () => {
    state.staff = comp;
    expect((await post(idDecision, { outcome: "reject", reason: REASON })).status).toBe(200);
    expect((await post(idDecision, { outcome: "needs_more", reason: REASON })).status).toBe(200);
    expect(state.calls).toEqual(["save_id", "save_id"]);
  });
  it("refuses a submission that is no longer pending", async () => {
    state.staff = comp; state.sub = subRow({ status: "approved" });
    expect((await post(idDecision, { outcome: "reject", reason: REASON })).status).toBe(409);
  });
});
