import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({
  staff: null as StaffActor | null,
  outcome: "reviewed" as string,
  calls: [] as unknown[][],
  audits: [] as string[]
}));

vi.mock("../src/server/context", () => ({ getActor: () => null, getDb: () => ({ query: async () => ({ rows: [] }) }), getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
vi.mock("../src/server/wording-flags-db", () => ({
  WORDING_FLAG_STATUSES: ["open", "cleared", "upheld"],
  listWordingFlagsPg: async (_db: unknown, status: string) => { state.calls.push(["list", status]); return []; },
  reviewWordingFlagPg: async (...a: unknown[]) => {
    state.calls.push(["review", ...a.slice(1)]);
    return state.outcome === "reviewed" ? { outcome: "reviewed", listingId: "L1" } : { outcome: state.outcome };
  }
}));

import * as list from "../app/api/staff/wording-flags/route";
import * as review from "../app/api/staff/wording-flags/[id]/route";
process.env["APP_URL"] = "http://test";

const comp: StaffActor = { id: "00000000-0000-4000-8000-000000000001", role: "compliance" };
const support: StaffActor = { id: "00000000-0000-4000-8000-000000000002", role: "support" };
const FLAG = "00000000-0000-4000-8000-000000000100";
const ctx = { params: Promise.resolve({ id: FLAG }) };
const post = (body: unknown) => review.POST(new Request("http://test/api/staff/wording-flags/x", {
  method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body)
}), ctx);
const REASON = "Registered over-55s community under the Retirement Villages Act.";

beforeEach(() => { state.staff = null; state.outcome = "reviewed"; state.calls = []; state.audits = []; });

describe("staff wording-flag routes", () => {
  it("need a staff session with wording.review (compliance has it, support does not)", async () => {
    expect((await list.GET(new Request("http://test/api/staff/wording-flags"))).status).toBe(401);
    expect((await post({ decision: "clear", reason: REASON })).status).toBe(401);
    state.staff = support;
    expect((await list.GET(new Request("http://test/api/staff/wording-flags"))).status).toBe(403);
    expect((await post({ decision: "clear", reason: REASON })).status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("lists by status (open by default), rejects an unknown status, and logs the view", async () => {
    state.staff = comp;
    expect((await list.GET(new Request("http://test/api/staff/wording-flags"))).status).toBe(200);
    expect((await list.GET(new Request("http://test/api/staff/wording-flags?status=upheld"))).status).toBe(200);
    expect((await list.GET(new Request("http://test/api/staff/wording-flags?status=deleted"))).status).toBe(400);
    expect(state.calls).toEqual([["list", "open"], ["list", "upheld"]]);
    expect(state.audits).toEqual(["staff.wording_flags_viewed", "staff.wording_flags_viewed"]);
  });

  it("needs a valid decision and a reason of at least 10 characters", async () => {
    state.staff = comp;
    expect((await post({ decision: "approve", reason: REASON })).status).toBe(400);
    expect((await post({ decision: "clear", reason: "ok" })).status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it("clears or upholds with an audit event", async () => {
    state.staff = comp;
    expect((await post({ decision: "clear", reason: REASON })).status).toBe(200);
    expect((await post({ decision: "uphold", reason: "Not an exempt arrangement." })).status).toBe(200);
    expect(state.calls).toEqual([["review", FLAG, comp.id, "clear", REASON], ["review", FLAG, comp.id, "uphold", "Not an exempt arrangement."]]);
    expect(state.audits).toEqual(["staff.wording_flag_cleared", "staff.wording_flag_upheld"]);
  });

  it("maps not found, already reviewed and own flag to 404, 409 and 403", async () => {
    state.staff = comp;
    for (const [outcome, status] of [["not_found", 404], ["already_reviewed", 409], ["own_flag", 403]] as const) {
      state.outcome = outcome;
      expect((await post({ decision: "clear", reason: REASON })).status).toBe(status);
    }
    expect(state.audits).toEqual([]);
  });
});
