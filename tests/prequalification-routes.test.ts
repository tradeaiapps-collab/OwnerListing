import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/listing-service";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, actor: null as Actor | null, calls: [] as string[] }));
vi.mock("../src/server/context", () => ({
  getDb: () => ({ query: async () => ({ rows: [] }) }), getActor: async () => state.actor, getStaff: async () => state.staff,
  getDeps: () => ({ now: () => "2026-11-05T00:00:00.000Z" }), getUploadPorts: () => ({ storage: { configured: false }, scanner: { configured: false } })
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/prequalification-db", () => ({
  staffQueue: async () => { state.calls.push("queue"); return { rows: [], noPrequal: [] }; }, staffDetail: async () => undefined, documentKeyFor: async () => undefined,
  reviewPrequal: async () => { state.calls.push("review"); return { ok: true, value: { status: "verified" } }; }, bulkVerify: async () => { state.calls.push("bulk"); return { verified: 0, skipped: 0 }; },
  listForBuyer: async () => []
}));

import * as buyer from "../app/api/buyer/prequalifications/route";
import * as queue from "../app/api/staff/prequalifications/route";
import * as one from "../app/api/staff/prequalifications/[id]/route";
import * as doc from "../app/api/staff/prequalifications/[id]/document/route";
process.env["APP_URL"] = "http://test";

const ID = "00000000-0000-4000-8000-000000000001";
const H = { "content-type": "application/json", origin: "http://test" };
const ctx = { params: Promise.resolve({ id: ID }) };
const compliance: StaffActor = { id: ID, role: "compliance" };
const support: StaffActor = { id: ID, role: "support" };

describe("pre-approval routes", () => {
  beforeEach(() => { state.staff = null; state.actor = null; state.calls = []; });

  it("staff routes need a session and the review permission", async () => {
    expect((await queue.GET(new Request("http://test/api/staff/prequalifications"))).status).toBe(401);
    state.staff = support;
    expect((await queue.GET(new Request("http://test/api/staff/prequalifications"))).status).toBe(403);
    expect((await one.POST(new Request("http://test/x", { method: "POST", headers: H, body: JSON.stringify({ action: "resubmit", note: "x" }) }), ctx)).status).toBe(403);
    expect((await doc.GET(new Request("http://test/x"), ctx)).status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("staff with the permission can list, reject bad bodies and decide", async () => {
    state.staff = compliance;
    expect((await queue.GET(new Request("http://test/api/staff/prequalifications?status=pending_review"))).status).toBe(200);
    expect((await queue.GET(new Request("http://test/api/staff/prequalifications?status=bogus"))).status).toBe(400);
    const bad = await one.POST(new Request("http://test/x", { method: "POST", headers: H, body: JSON.stringify({ action: "verify", approvedCents: 5 }) }), ctx);
    expect(bad.status).toBe(400);
    const ok = await one.POST(new Request("http://test/x", { method: "POST", headers: H, body: JSON.stringify({ action: "resubmit", note: "Send page 2." }) }), ctx);
    expect(ok.status).toBe(200);
    expect((await queue.POST(new Request("http://test/x", { method: "POST", headers: H, body: JSON.stringify({ action: "verify", ids: ["nope"] }) }))).status).toBe(400);
    const cross = await one.POST(new Request("http://test/x", { method: "POST", headers: { ...H, origin: "http://evil" }, body: "{}" }), ctx);
    expect(cross.status).toBe(403);
    expect(state.calls).toEqual(["queue", "review"]);
  });

  it("buyer route is for signed-in buyers only, and refuses while storage is not configured", async () => {
    expect((await buyer.GET(new Request("http://test/x"))).status).toBe(401);
    state.actor = { userId: ID, userType: "owner" };
    expect((await buyer.GET(new Request("http://test/x"))).status).toBe(403);
    state.actor = { userId: ID, userType: "buyer" };
    expect((await buyer.GET(new Request("http://test/x"))).status).toBe(200);
    const post = await buyer.POST(new Request("http://test/x", { method: "POST", headers: { origin: "http://test" }, body: new FormData() }));
    expect(post.status).toBe(503);
  });
});
