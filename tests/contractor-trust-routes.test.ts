import { beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  actor: null as { userId: string; userType: string } | null,
  staff: null as { id: string; role: string } | null,
  calls: [] as { fn: string; args: unknown[] }[]
}));
const rec = vi.hoisted(() => (fn: string, ret: unknown) => async (...args: unknown[]) => { S.calls.push({ fn, args }); return ret; });
vi.mock("../src/server/context", () => ({ getActor: async () => S.actor, getStaff: async () => S.staff, getDb: () => ({ query: async () => ({ rows: [] }) }) }));
vi.mock("../src/server/contractor-trust-db", () => ({
  submitVerificationPg: rec("submitVerification", true), getVerificationPg: rec("getVerification", undefined), getStandingPg: rec("getStanding", { suspended: false, reason: null, changedAt: null }),
  reviewsForContractorPg: rec("reviews", []), sendQuotePg: rec("sendQuote", "created"), decideQuotePg: rec("decideQuote", true), createReportPg: rec("createReport", "created"),
  createReviewPg: rec("createReview", "created"), replyToReviewPg: rec("reply", true), confirmUsageRightsPg: rec("rights", true), assignmentAccessPg: rec("access", undefined),
  quotesForAssignmentPg: rec("quotes", []), reviewForAssignmentPg: rec("review", undefined), publicTrustPg: rec("publicTrust", undefined),
  listVerificationsPg: rec("listVerifications", []), decideVerificationPg: rec("decideVerification", true), listReportsPg: rec("listReports", []),
  decideReportPg: rec("decideReport", "ok"), setSuspensionPg: rec("suspend", true)
}));

import * as trust from "../app/api/contractor/trust/route";
import * as quotes from "../app/api/assignments/[id]/quotes/route";
import * as report from "../app/api/assignments/[id]/report/route";
import * as review from "../app/api/assignments/[id]/review/route";
import * as rights from "../app/api/assignments/[id]/usage-rights/route";
import * as jobTrust from "../app/api/assignments/[id]/trust/route";
import * as quote from "../app/api/quotes/[id]/route";
import * as reply from "../app/api/reviews/[id]/reply/route";
import * as publicTrust from "../app/api/contractors/[id]/trust/route";
import * as sVerifs from "../app/api/staff/contractors/verifications/route";
import * as sVerif from "../app/api/staff/contractors/verifications/[id]/route";
import * as sReports from "../app/api/staff/contractors/reports/route";
import * as sReport from "../app/api/staff/contractors/reports/[id]/route";
import * as sStanding from "../app/api/staff/contractors/[id]/standing/route";

const ID = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });
const H = { "content-type": "application/json", origin: "http://test" };
const post = (body: unknown, headers: Record<string, string> = H) => new Request("http://test/x", { method: "POST", headers, body: JSON.stringify(body) });
const put = (body: unknown) => new Request("http://test/x", { method: "PUT", headers: H, body: JSON.stringify(body) });
const get = (q = "") => new Request(`http://test/x${q}`, { headers: H });
const VERIFICATION = { businessName: "Bright Snaps", abn: "51824753556", insurer: "Allianz", policyNumber: "PL-1", insuranceExpiry: "2099-01-01" };
const QUOTE = { amountCents: 45000, description: "Replace two taps and reseal the basin." };
const called = (fn: string) => S.calls.filter(c => c.fn === fn);

beforeEach(() => {
  process.env["APP_URL"] = "http://test";
  S.actor = { userId: "c1111111-1111-4111-8111-111111111111", userType: "vendor" };
  S.staff = { id: "a1111111-1111-4111-8111-111111111111", role: "compliance" };
  S.calls = [];
});

describe("contractor routes", () => {
  it("need a signed-in user, and writes need the same-origin check", async () => {
    S.actor = null;
    for (const r of [await trust.GET(get()), await trust.PUT(put(VERIFICATION)), await quotes.POST(post(QUOTE), ctx()), await report.POST(post({}), ctx()), await quote.POST(post({ action: "accept" }), ctx()), await jobTrust.GET(get(), ctx())]) expect(r.status).toBe(401);
    S.actor = { userId: "c1111111-1111-4111-8111-111111111111", userType: "vendor" };
    expect((await quotes.POST(post(QUOTE, { "content-type": "application/json", origin: "http://evil" }), ctx())).status).toBeGreaterThanOrEqual(400);
    expect(called("sendQuote")).toHaveLength(0);
  });
  it("contractor-only actions refuse owners and buyers", async () => {
    for (const userType of ["owner", "buyer"]) {
      S.actor = { userId: "o1111111-1111-4111-8111-111111111111", userType };
      expect((await trust.PUT(put(VERIFICATION))).status).toBe(403);
      expect((await quotes.POST(post(QUOTE), ctx())).status).toBe(403);
      expect((await rights.POST(post({ confirm: true }), ctx())).status).toBe(403);
      expect((await reply.POST(post({ reply: "Thanks" }), ctx())).status).toBe(403);
    }
    expect(S.calls.filter(c => ["submitVerification", "sendQuote", "rights", "reply"].includes(c.fn))).toHaveLength(0);
  });
  it("uses the session user id, never one from the body, and checks ids", async () => {
    expect((await trust.PUT(put({ ...VERIFICATION, userId: OTHER }))).status).toBe(200);
    expect(called("submitVerification")[0]!.args[1]).toBe(S.actor!.userId);
    expect((await quotes.POST(post({ ...QUOTE, contractorId: OTHER }), ctx())).status).toBe(201);
    expect(called("sendQuote")[0]!.args.slice(1, 3)).toEqual([S.actor!.userId, ID]);
    expect((await quotes.POST(post(QUOTE), ctx("not-a-uuid"))).status).toBe(404);
    expect((await publicTrust.GET(get(), ctx("nope"))).status).toBe(404);
  });
  it("validates verification, quote and review input", async () => {
    expect((await trust.PUT(put({ ...VERIFICATION, abn: "11111111111" }))).status).toBe(400);
    expect((await trust.PUT(put({ ...VERIFICATION, insuranceExpiry: "2020-01-01" }))).status).toBe(400);
    expect((await quotes.POST(post({ amountCents: -5, description: "Replace two taps." }), ctx())).status).toBe(400);
    S.actor = { userId: "o1111111-1111-4111-8111-111111111111", userType: "owner" };
    expect((await review.POST(post({ rating: 9 }), ctx())).status).toBe(400);
    expect((await report.POST(post({ kind: "bad", detail: "A long enough description." }), ctx())).status).toBe(400);
  });
  it("refuses contact details and abuse in quotes, reviews and replies, but lets a report carry a phone number to staff", async () => {
    expect((await quotes.POST(post({ amountCents: 1000, description: "Call me on 0412 345 678 to pay me directly." }), ctx())).status).toBe(400);
    expect((await reply.POST(post({ reply: "Ring 0412 345 678 for a discount" }), ctx())).status).toBe(400);
    S.actor = { userId: "o1111111-1111-4111-8111-111111111111", userType: "owner" };
    expect((await review.POST(post({ rating: 3, comment: "Email bob@example.com for work" }), ctx())).status).toBe(400);
    expect((await report.POST(post({ kind: "no_show", detail: "He never came; his number is 0412 345 678." }), ctx())).status).toBe(201);
    expect(called("sendQuote")).toHaveLength(0);
  });
  it("maps database refusals to the right status", async () => {
    S.actor = { userId: "o1111111-1111-4111-8111-111111111111", userType: "owner" };
    expect((await review.POST(post({ rating: 5 }), ctx())).status).toBe(201);
    expect((await quote.POST(post({ action: "explode" }), ctx())).status).toBe(400);
    expect((await quote.POST(post({ action: "accept" }), ctx())).status).toBe(200);
    expect(called("decideQuote")[0]!.args.slice(1)).toEqual([S.actor.userId, ID, "accept"]);
    expect((await jobTrust.GET(get(), ctx())).status).toBe(404);
  });
});

describe("staff routes", () => {
  it("need staff with the right permission", async () => {
    S.staff = null;
    expect((await sVerifs.GET(get())).status).toBe(401);
    S.staff = { id: "a1111111-1111-4111-8111-111111111111", role: "support" };
    expect((await sVerifs.GET(get())).status).toBe(403);
    expect((await sVerif.POST(post({ action: "verify" }), ctx())).status).toBe(403);
    S.staff = { id: "a1111111-1111-4111-8111-111111111111", role: "accountant" };
    expect((await sReports.GET(get())).status).toBe(403);
    expect((await sReport.POST(post({ action: "dismiss", note: "n" }), ctx())).status).toBe(403);
    expect((await sStanding.POST(post({ action: "suspend", note: "n" }), ctx())).status).toBe(403);
    expect(S.calls.filter(c => ["decideVerification", "decideReport", "suspend"].includes(c.fn))).toHaveLength(0);
  });
  it("decisions need a note and use the staff id from the session", async () => {
    S.staff = { id: "a1111111-1111-4111-8111-111111111111", role: "support" };
    expect((await sReport.POST(post({ action: "uphold_and_suspend" }), ctx())).status).toBe(400);
    expect((await sReport.POST(post({ action: "uphold_and_suspend", note: "Confirmed no-show.", staffId: OTHER }), ctx())).status).toBe(200);
    expect(called("decideReport")[0]!.args.slice(1)).toEqual([ID, S.staff.id, "uphold_and_suspend", "Confirmed no-show."]);
    expect((await sStanding.POST(post({ action: "reinstate", note: "Cleared." }), ctx())).status).toBe(200);
    expect(called("suspend")[0]!.args.slice(1)).toEqual([S.staff.id, ID, false, "Cleared."]);
    S.staff = { id: "a1111111-1111-4111-8111-111111111111", role: "compliance" };
    expect((await sVerif.POST(post({ action: "reject" }), ctx())).status).toBe(400);
    expect((await sVerif.POST(post({ action: "verify" }), ctx())).status).toBe(200);
  });
});
