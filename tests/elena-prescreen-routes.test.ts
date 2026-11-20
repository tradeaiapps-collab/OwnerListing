import { beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  staff: null as { id: string; role: string } | null, used: 0, logOk: true, outcomes: [] as unknown[], decided: [] as unknown[][], verified: [] as unknown[][],
  target: { id: "", status: "open", subjectOwnerId: null as string | null, subjectType: "message", subjectId: "" },
  rec: { action: "approve", confidence: "high" as string, rule: "mod.no_match", reason: "no match" }
}));
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ME = "a1111111-1111-4111-8111-111111111111";
vi.mock("../src/server/context", () => ({ getStaff: async () => S.staff, getDb: () => ({}) }));
vi.mock("../src/server/moderation-queue-db", () => ({
  listQueuePg: async () => [{ id: A, status: "open", createdAt: "2026-01-01", subjectOwnerId: null }, { id: B, status: "open", createdAt: "2026-01-02", subjectOwnerId: ME }],
  getQueueTargetPg: async (_d: unknown, id: string) => ({ ...S.target, id, subjectOwnerId: id === B ? ME : null }),
  decideQueueItemPg: async (...a: unknown[]) => { S.decided.push(a); return true; }
}));
vi.mock("../src/server/contractor-trust-db", () => ({
  listVerificationsPg: async () => [{ userId: A, status: "pending", submittedAt: "2026-11-20T01:02:03.456Z" }],
  decideVerificationPg: async (...a: unknown[]) => { S.verified.push(a); return true; }
}));
vi.mock("../src/server/elena-prescreen-db", () => ({
  bulkCountLastHourPg: async () => S.used,
  logOutcomePg: async (_d: unknown, o: unknown) => { S.outcomes.push(o); return S.logOk; },
  withBulkLockPg: async (_d: unknown, _id: string, fn: () => Promise<unknown>) => fn(),
  prescreenModerationPg: async (_d: unknown, items: { id: string }[]) => new Map(items.map(i => [i.id, { ...S.rec, recommendationId: "r" }])),
  prescreenVerificationsPg: async () => new Map([[A, { ...S.rec, rule: "ver.complete", recommendationId: "r" }]]),
  accuracyPg: async () => [{ queue: "moderation", rule: "mod.no_match", confidence: "high", total: 3, agreed: 2, overridden: 1, neutral: 0 }]
}));

import * as bulk from "../app/api/staff/elena-prescreen/bulk/route";
import * as accuracy from "../app/api/staff/elena-prescreen/accuracy/route";

const H = { "content-type": "application/json", origin: "http://test" };
const post = (body: unknown) => new Request("http://test/x", { method: "POST", headers: H, body: JSON.stringify(body) });
const OK = { queue: "moderation", ids: [A], confirm: true };

beforeEach(() => {
  process.env["APP_URL"] = "http://test";
  S.staff = { id: ME, role: "support" }; S.used = 0; S.logOk = true; S.outcomes = []; S.decided = []; S.verified = [];
  S.rec = { action: "approve", confidence: "high", rule: "mod.no_match", reason: "no match" };
});

describe("Elena bulk confirm", () => {
  it("needs a signed-in staff member with the queue's permission", async () => {
    S.staff = null;
    expect((await bulk.POST(post(OK))).status).toBe(401);
    S.staff = { id: ME, role: "accountant" };
    expect((await bulk.POST(post(OK))).status).toBe(403);
    // Support can review moderation but cannot verify contractors.
    S.staff = { id: ME, role: "support" };
    expect((await bulk.POST(post({ ...OK, queue: "verification" }))).status).toBe(403);
  });
  it("is off unless staff confirm, and validates ids and the cap", async () => {
    expect((await bulk.POST(post({ ...OK, confirm: false }))).status).toBe(400);
    expect((await bulk.POST(post({ ...OK, ids: [] }))).status).toBe(400);
    expect((await bulk.POST(post({ ...OK, ids: ["nope"] }))).status).toBe(400);
    expect((await bulk.POST(post({ ...OK, ids: Array.from({ length: 26 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) }))).status).toBe(400);
    expect((await bulk.POST(post({ ...OK, queue: "complaint" }))).status).toBe(400);
  });
  it("enforces the hourly cap", async () => {
    S.used = 100;
    expect((await bulk.POST(post(OK))).status).toBe(429);
    expect(S.decided).toHaveLength(0);
  });
  it("approves a high-confidence item with the standard decision and logs a bulk outcome", async () => {
    const r = await bulk.POST(post(OK));
    expect(r.status).toBe(200);
    expect((await r.json()).applied).toBe(1);
    expect(S.decided[0]!.slice(2, 5)).toEqual([S.staff, "approve", "open"]);
    expect(String(S.decided[0]![5])).toContain("Confirmed Elena's recommendation (mod.no_match)");
    expect(S.outcomes[0]).toMatchObject({ queue: "moderation", subjectId: A, staffAction: "approve", viaBulk: true });
  });
  it("skips anything that is not a high-confidence approval, whatever the client claims", async () => {
    S.rec = { action: "approve", confidence: "medium", rule: "x", reason: "y" };
    let body = await (await bulk.POST(post(OK))).json();
    expect(body.applied).toBe(0);
    S.rec = { action: "hide", confidence: "high", rule: "x", reason: "y" };
    body = await (await bulk.POST(post(OK))).json();
    expect(body.results[0].ok).toBe(false);
    expect(S.decided).toHaveLength(0);
  });
  it("never lets staff bulk-approve their own content", async () => {
    const body = await (await bulk.POST(post({ ...OK, ids: [B] }))).json();
    expect(body.results[0]).toMatchObject({ ok: false, message: "You cannot review your own content." });
    expect(S.decided).toHaveLength(0);
  });
  it("verifies through the same decision, as a compliance role", async () => {
    S.staff = { id: ME, role: "compliance" };
    const body = await (await bulk.POST(post({ queue: "verification", ids: [A], confirm: true }))).json();
    expect(body.applied).toBe(1);
    expect(S.verified[0]!.slice(1, 4)).toEqual([A, ME, "verify"]);
    // The decision is bound to the submission that was screened, so a re-submission in between cannot be approved unseen.
    expect(S.verified[0]![5]).toBe("2026-11-20T01:02:03.456Z");
    expect(S.outcomes[0]).toMatchObject({ queue: "verification", staffAction: "verify", viaBulk: true });
  });
  it("stops, and says so, when an outcome cannot be logged", async () => {
    S.logOk = false;
    const body = await (await bulk.POST(post({ ...OK, ids: [A, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"] }))).json();
    expect(S.decided).toHaveLength(1);
    expect(body.results.at(-1)).toMatchObject({ ok: false });
  });
  it("reports ids that are not open", async () => {
    const body = await (await bulk.POST(post({ ...OK, ids: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"] }))).json();
    expect(body.results[0]).toMatchObject({ ok: false, message: "Not an open item." });
  });
});

describe("Elena accuracy report", () => {
  it("is for senior reviewers only", async () => {
    const get = () => accuracy.GET(new Request("http://test/x?days=7", { headers: H }));
    S.staff = null; expect((await get()).status).toBe(401);
    S.staff = { id: ME, role: "support" }; expect((await get()).status).toBe(403);
    S.staff = { id: ME, role: "compliance" };
    const r = await get();
    expect(r.status).toBe(200);
    expect((await r.json()).rules[0]).toMatchObject({ rule: "mod.no_match", agreed: 2 });
  });
});
