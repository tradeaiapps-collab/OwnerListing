import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackEvent } from "../src/domain/listing-assistant";
import { learnFrom } from "../src/domain/listing-assistant";
import type { Comparable } from "../src/domain/price-guidance";

const state = vi.hoisted(() => ({
  actor: null as unknown, hits: 1 as number, comps: [] as Comparable[], saved: [] as FeedbackEvent[], reset: 0
}));
vi.mock("../src/server/context", () => ({
  getDb: () => ({}), getDeps: () => ({ now: () => "2026-11-05T00:00:00.000Z" }), getActor: async () => state.actor
}));
vi.mock("../src/server/offer-flow-db", () => ({ countHitPg: async () => state.hits }));
vi.mock("../src/server/price-guidance", () => ({ getComparablesSource: () => ({ id: "file", find: async () => state.comps }) }));
vi.mock("../src/server/listing-assistant-db", () => ({
  loadProfilePg: async () => learnFrom(state.saved),
  insertFeedbackPg: async (_d: unknown, _u: string, e: FeedbackEvent[]) => { state.saved.push(...e); },
  resetFeedbackPg: async () => { state.saved = []; state.reset++; }
}));
import * as plan from "../app/api/listings/assistant/route";
import * as rewrite from "../app/api/listings/assistant/rewrite/route";
import * as feedback from "../app/api/listings/assistant/feedback/route";

const post = (body: unknown, origin = "http://test") => new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
const comps = [118, 120, 122, 124].map((p, i): Comparable => ({ id: `c${i}`, transactionType: "sale", propertyType: "house", priceCents: p * 1_000_000, date: "2026-09-01T00:00:00.000Z", suburb: "Paddington", bedrooms: 3 }));

beforeEach(() => {
  process.env["APP_URL"] = "http://test";
  state.actor = { userId: "u1", userType: "owner" }; state.hits = 1; state.comps = comps; state.saved = []; state.reset = 0;
});

describe("listing assistant routes", () => {
  it("need a signed-in owner or agent, a same-site request and stay under the hourly limit", async () => {
    state.actor = null;
    expect((await plan.POST(post({ facts: { transactionType: "sale" } }))).status).toBe(401);
    state.actor = { userId: "b", userType: "buyer" };
    expect((await plan.POST(post({ facts: { transactionType: "sale" } }))).status).toBe(403);
    state.actor = { userId: "u1", userType: "agent" };
    expect((await plan.POST(post({ facts: { transactionType: "sale" } }, "http://evil"))).status).toBe(403);
    state.hits = 121;
    expect((await plan.POST(post({ facts: { transactionType: "sale" } }))).status).toBe(429);
    expect((await rewrite.POST(post({ text: "hi" }))).status).toBe(429);
    expect((await feedback.GET(new Request("http://test/x"))).status).toBe(429);
  });

  it("plan: returns guidance with a price range when there are comparables, and 400 for bad facts", async () => {
    const r = await plan.POST(post({ facts: { transactionType: "sale", propertyType: "house", suburb: "Paddington", bedrooms: 3, priceCents: 120_000_000, description: "Pool and solar." } }));
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(b.pricing).toMatchObject({ state: "ready", position: "within" });
    expect(b.tags.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(["pool", "solar"]));
    for (const bad of [{}, { transactionType: "swap" }, { transactionType: "sale", bedrooms: -1 }, { transactionType: "sale", postcode: "abc" }, { transactionType: "sale", amenities: ["moat"] }, { transactionType: "sale", description: "x".repeat(5001) }]) {
      expect((await plan.POST(post({ facts: bad }))).status).toBe(400);
    }
  });

  it("plan: no suburb means no comparables lookup and pricing says unavailable", async () => {
    const b = await (await plan.POST(post({ facts: { transactionType: "sale", propertyType: "house" } }))).json();
    expect(b.pricing.state).toBe("unavailable");
    expect(b.questions[0].id).toBe("suburb");
  });

  it("rewrite: tidies the text, validates mode and size, and nothing is stored", async () => {
    const b = await (await rewrite.POST(post({ text: "Sunny home!!! Very close to the shops. Call 0412 345 678.", mode: "better", facts: { transactionType: "sale", bedrooms: 3, bathrooms: 1, propertyType: "house" } }))).json();
    expect(b.state).toBe("ready");
    expect(b.text).not.toMatch(/0412|!/);
    expect(state.saved).toEqual([]);
    expect((await rewrite.POST(post({ text: "hi", mode: "wild" }))).status).toBe(400);
    expect((await rewrite.POST(post({ text: "x".repeat(5001) }))).status).toBe(400);
    expect((await rewrite.POST(post({}))).status).toBe(400);
  });

  it("feedback: stores fixed-vocabulary events, shows what was learned and can forget it", async () => {
    expect((await feedback.POST(post({ events: [{ kind: "tag", key: "pool", action: "accepted" }, { kind: "tag", key: "pool", action: "accepted" }] }))).status).toBe(200);
    expect(state.saved).toHaveLength(2);
    expect((await (await feedback.GET(new Request("http://test/x"))).json()).learned.join(" ")).toMatch(/Pool/);
    expect((await feedback.POST(post({ events: [{ kind: "tag", key: "free text from the author", action: "accepted" }] }))).status).toBe(400);
    expect((await feedback.POST(post({ events: [] }))).status).toBe(400);
    expect((await feedback.DELETE(new Request("http://test/x", { method: "DELETE", headers: { origin: "http://test" } }))).status).toBe(200);
    expect(state.reset).toBe(1);
    expect((await feedback.DELETE(new Request("http://test/x", { method: "DELETE", headers: { origin: "http://evil" } }))).status).toBe(403);
  });
});
