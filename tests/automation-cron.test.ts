import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}) }));
vi.mock("../src/server/automation-db", () => ({ runDueAutomations: async () => { state.calls++; return { processed: 3 }; } }));
vi.mock("../src/server/elena-jobs-db", () => ({ runDueElenaJobs: async () => ({ created: 1, acted: 2, invited: 0 }) }));
vi.mock("../src/server/elena-scheduling-db", () => ({ runDueSchedulingMessages: async () => ({ expired: 1, suggested: 2 }) }));
vi.mock("../src/server/elena-rentals-db", () => ({ runDueRentals: async () => ({ repairs: 1, reminders: 2, summaries: 0 }) }));
import { POST } from "../app/api/internal/automations/run/route";

const SECRET = "a".repeat(40);
const call = (secret?: string) => POST(new Request("http://test/api/internal/automations/run", { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret } }));

describe("automation run route", () => {
  afterEach(() => { delete process.env["AUTOMATION_CRON_SECRET"]; state.calls = 0; });
  it("fails closed while the secret is unset or short", async () => {
    expect((await call("x")).status).toBe(503);
    process.env["AUTOMATION_CRON_SECRET"] = "short";
    expect((await call("short")).status).toBe(503);
    expect(state.calls).toBe(0);
  });
  it("rejects a missing or wrong secret and runs once with the right one", async () => {
    process.env["AUTOMATION_CRON_SECRET"] = SECRET;
    expect((await call()).status).toBe(401);
    expect((await call(SECRET + "x")).status).toBe(401);
    expect(state.calls).toBe(0);
    const ok = await call(SECRET);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ processed: 3, scheduling: { expired: 1, suggested: 2 }, elenaJobs: { created: 1, acted: 2, invited: 0 }, rentals: { repairs: 1, reminders: 2, summaries: 0 } });
  });
  it("has a scheduled workflow that calls the route with the shared secret", () => {
    const wf = readFileSync(path.join(__dirname, "..", ".github", "workflows", "automation-runs.yml"), "utf8");
    expect(wf).toContain("*/10 * * * *");
    expect(wf).toContain("/api/internal/automations/run");
    expect(wf).toContain("AUTOMATION_CRON_SECRET");
  });
});
