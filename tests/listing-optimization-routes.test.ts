import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({
  staff: null as StaffActor | null, actor: null as unknown, listing: null as unknown, saved: [] as unknown[], audits: [] as { eventType: string; payload: Record<string, unknown> }[],
  settings: { enabled: false, minPhotos: 8, minDescriptionWords: 60, maxPriceCutPercent: 10, disabledTypes: [], updatedAt: null, updatedBy: null, updatedByName: null } as Record<string, unknown>,
  statusCalls: [] as unknown[][], statusResult: true
}));
const LID = "00000000-0000-4000-8000-000000000100";
const SID = "00000000-0000-4000-8000-000000000200";
vi.mock("../src/server/context", () => ({
  getActor: async () => state.actor, getStaff: async () => state.staff, getDb: () => ({ query: async () => ({ rows: [] }) }),
  getDeps: () => ({ now: () => "2026-11-05T00:00:00.000Z", repo: { get: async () => state.listing } })
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_d: unknown, e: { eventType: string; payload: Record<string, unknown> }) => { state.audits.push(e); } }));
vi.mock("../src/server/listing-optimization-db", () => ({
  getOptimizationSettings: async () => state.settings,
  saveOptimizationSettings: async (_d: unknown, s: unknown) => { state.saved.push(s); Object.assign(state.settings, s); },
  adoptionStats: async () => [], recentOptimizationChanges: async () => [],
  listSuggestions: async () => [{ id: SID, type: "add_photos" }],
  setSuggestionStatus: async (...a: unknown[]) => { state.statusCalls.push(a.slice(1)); return state.statusResult; }
}));
vi.mock("../src/server/listing-optimization-service", () => ({ optimizeListing: async () => [{ id: SID, type: "add_photos", status: "open" }] }));
import * as settingsRoute from "../app/api/staff/listing-optimization-settings/route";
import * as owner from "../app/api/listings/[id]/optimization/route";
process.env["APP_URL"] = "http://test";

const admin: StaffActor = { id: "00000000-0000-4000-8000-000000000001", role: "super_admin" };
const compliance: StaffActor = { id: "00000000-0000-4000-8000-000000000002", role: "compliance" };
const ctx = { params: Promise.resolve({ id: LID }) };
const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) });
const getOwner = () => owner.GET(new Request(`http://test/api/listings/${LID}/optimization`), ctx);
const answer = (body: unknown) => owner.POST(post(`http://test/api/listings/${LID}/optimization`, body), ctx);

beforeEach(() => {
  Object.assign(state, { staff: null, actor: { userId: "u1", userType: "owner" }, listing: { listing: { id: LID, ownerUserId: "u1", transactionType: "sale", propertyType: "house" } }, saved: [], audits: [], statusCalls: [], statusResult: true });
  Object.assign(state.settings, { enabled: false, minPhotos: 8, minDescriptionWords: 60, maxPriceCutPercent: 10, disabledTypes: [] });
});

describe("staff listing optimization settings", () => {
  it("need the listing_optimization.manage permission, which only a super admin holds", async () => {
    expect((await settingsRoute.GET(new Request("http://test/x"))).status).toBe(401);
    state.staff = compliance;
    expect((await settingsRoute.GET(new Request("http://test/x"))).status).toBe(403);
    expect((await settingsRoute.POST(post("http://test/x", { enabled: true }))).status).toBe(403);
    state.staff = admin;
    const ok = await settingsRoute.GET(new Request("http://test/x"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).types).toHaveLength(9);
  });
  it("saves a change and logs before and after", async () => {
    state.staff = admin;
    expect((await settingsRoute.POST(post("http://test/x", { enabled: true }))).status).toBe(200);
    expect(state.audits[0]).toMatchObject({ eventType: "staff.listing_optimization.enabled", payload: { before: { enabled: false }, after: { enabled: true } } });
    await settingsRoute.POST(post("http://test/x", { minPhotos: 12 }));
    expect(state.audits[1]!.eventType).toBe("staff.listing_optimization.updated");
  });
  it("rejects bad values without saving", async () => {
    state.staff = admin;
    for (const body of [{ minPhotos: 1 }, { maxPriceCutPercent: 50 }, { disabledTypes: ["x"] }]) expect((await settingsRoute.POST(post("http://test/x", body))).status).toBe(400);
    expect(state.saved).toEqual([]);
  });
  it("refuses a state-changing request from another origin", async () => {
    state.staff = admin;
    const r = new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.test" }, body: JSON.stringify({ enabled: true }) });
    expect((await settingsRoute.POST(r)).status).toBeGreaterThanOrEqual(400);
    expect(state.saved).toEqual([]);
  });
});

describe("GET /api/listings/[id]/optimization", () => {
  it("answers 404 while the site switch is off", async () => {
    expect((await getOwner()).status).toBe(404);
  });
  it("needs sign-in, and only the listing's owner sees it (everyone else gets 404)", async () => {
    state.settings["enabled"] = true;
    state.actor = null;
    expect((await getOwner()).status).toBe(401);
    for (const actor of [{ userId: "u2", userType: "owner" }, { userId: "u1", userType: "buyer" }, { userId: "u3", userType: "agent" }]) {
      state.actor = actor;
      expect((await getOwner()).status).toBe(404);
    }
    state.actor = { userId: "u1", userType: "owner" };
    state.listing = null;
    expect((await getOwner()).status).toBe(404);
  });
  it("returns the suggestions and the estimate note to the owner, uncached", async () => {
    state.settings["enabled"] = true;
    const res = await getOwner();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const b = await res.json();
    expect(b.suggestions).toHaveLength(1);
    expect(b.note).toMatch(/rough guides/);
  });
});

describe("POST /api/listings/[id]/optimization", () => {
  it("lets the owner mark a suggestion done or dismissed, scoped to this listing", async () => {
    state.settings["enabled"] = true;
    expect((await answer({ suggestionId: SID, status: "implemented" })).status).toBe(200);
    expect(state.statusCalls[0]).toEqual([LID, SID, "implemented", "2026-11-05T00:00:00.000Z"]);
  });
  it("refuses a bad id or status, the system-only 'outdated' status and other people's listings", async () => {
    state.settings["enabled"] = true;
    expect((await answer({ suggestionId: "nope", status: "implemented" })).status).toBe(400);
    expect((await answer({ suggestionId: SID, status: "outdated" })).status).toBe(400);
    state.actor = { userId: "u2", userType: "owner" };
    expect((await answer({ suggestionId: SID, status: "implemented" })).status).toBe(404);
    expect(state.statusCalls).toEqual([]);
  });
  it("answers 404 when no suggestion matches, and while the feature is off", async () => {
    state.settings["enabled"] = true;
    state.statusResult = false;
    expect((await answer({ suggestionId: SID, status: "dismissed" })).status).toBe(404);
    state.settings["enabled"] = false;
    expect((await answer({ suggestionId: SID, status: "dismissed" })).status).toBe(404);
  });
});
