import { afterEach, describe, expect, it, vi } from "vitest";
import * as cron from "../app/api/internal/elena-learning/run/route";
import * as feedback from "../app/api/elena/feedback/route";
import * as overall from "../app/api/elena/feedback/overall/route";
import * as staff from "../app/api/staff/elena-training/route";

vi.mock("../src/server/context", () => ({
  getDb: () => ({ query: async () => ({ rows: [] }) }), getDeps: () => ({ now: () => "2026-11-05T00:00:00.000Z" }),
  getActor: async () => null, getStaff: async () => null
}));

vi.mock("../src/server/csrf", () => ({ csrfGuard: () => null }));

const call = (secret?: string, body: unknown = { job: "weekly" }) =>
  cron.POST(new Request("http://test/api/internal/elena-learning/run", { method: "POST", headers: secret ? { "x-cron-secret": secret } : {}, body: JSON.stringify(body) }));
afterEach(() => { delete process.env["ELENA_LEARNING_CRON_SECRET"]; });

describe("Elena learning routes", () => {
  it("the job fails closed without a long secret and rejects a wrong or missing one", async () => {
    expect((await call("x")).status).toBe(503);
    process.env["ELENA_LEARNING_CRON_SECRET"] = "short";
    expect((await call("short")).status).toBe(503);
    process.env["ELENA_LEARNING_CRON_SECRET"] = "s".repeat(40);
    expect((await call()).status).toBe(401);
    expect((await call("wrong")).status).toBe(401);
  });
  it("the job needs a known job name", async () => {
    process.env["ELENA_LEARNING_CRON_SECRET"] = "s".repeat(40);
    expect((await call("s".repeat(40), { job: "daily" })).status).toBe(400);
  });
  it("feedback and the dashboard need a signed-in person", async () => {
    const post = (body: unknown) => new Request("http://test/api/elena/feedback", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) });
    expect((await feedback.POST(post({ suggestionId: "x", helpful: "yes" }))).status).toBe(401);
    expect((await overall.POST(post({ kind: "settlement", subjectId: "x", helpful: "yes" }))).status).toBe(401);
    expect((await staff.GET(new Request("http://test/api/staff/elena-training", { headers: { origin: "http://test" } }))).status).toBe(401);
  });
});
