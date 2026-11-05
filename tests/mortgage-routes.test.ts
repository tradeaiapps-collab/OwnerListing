import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ actor: null as null | { userId: string; userType: string }, refreshed: 0 }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getActor: async () => state.actor }));
vi.mock("../src/server/mortgage-rates-db", () => ({
  latestRate: async () => ({ date: "2025-08-31", ratePct: 8.52 }),
  rateHistory: async (_d: unknown, n: number) => [{ date: "2025-08-31", ratePct: 8.52 }].slice(0, n),
  refreshMortgageRates: async () => { state.refreshed++; return { stored: 3, latest: null }; }
}));
import { GET } from "../app/api/mortgage/rates/route";
import { POST } from "../app/api/internal/mortgage-rates/run/route";

const get = (q = "") => GET(new Request(`http://test/api/mortgage/rates${q}`));
const run = (secret?: string) => POST(new Request("http://test/api/internal/mortgage-rates/run", { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret } }));

describe("mortgage rate routes", () => {
  afterEach(() => { state.actor = null; state.refreshed = 0; delete process.env["MORTGAGE_RATES_CRON_SECRET"]; });
  it("shows the latest rate to anyone", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect((await r.json()).latest.ratePct).toBe(8.52);
  });
  it("keeps history to signed-in agents", async () => {
    expect((await get("?history=12")).status).toBe(401);
    state.actor = { userId: "u", userType: "owner" };
    expect((await get("?history=12")).status).toBe(403);
    state.actor = { userId: "u", userType: "agent" };
    const r = await get("?history=12");
    expect(r.status).toBe(200);
    expect((await r.json()).history).toHaveLength(1);
  });
  it("runs the refresh only with the right long secret", async () => {
    expect((await run("x")).status).toBe(503);
    process.env["MORTGAGE_RATES_CRON_SECRET"] = "m".repeat(40);
    expect((await run()).status).toBe(401);
    expect((await run("wrong")).status).toBe(401);
    expect(state.refreshed).toBe(0);
    expect((await run("m".repeat(40))).status).toBe(200);
    expect(state.refreshed).toBe(1);
  });
});
