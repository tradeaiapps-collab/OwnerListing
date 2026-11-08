import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: 0, appUrl: undefined as string | undefined }));
vi.mock("../src/server/agent-reports-db", () => ({ getReportDeps: () => ({}) }));
vi.mock("../src/domain/agent-reports", () => ({ runDueReports: async (_d: unknown, appUrl?: string) => { state.calls++; state.appUrl = appUrl; return { due: 2, sent: 1, notSent: 1, skipped: 0 }; } }));
import { POST } from "../app/api/internal/agent-reports/run/route";

const SECRET = "r".repeat(40);
const call = (secret?: string) => POST(new Request("http://test/api/internal/agent-reports/run", { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret } }));

describe("scheduled agent reports route", () => {
  afterEach(() => { delete process.env["AGENT_REPORT_CRON_SECRET"]; delete process.env["APP_URL"]; state.calls = 0; });
  it("fails closed while the secret is unset or short", async () => {
    expect((await call("anything")).status).toBe(503);
    process.env["AGENT_REPORT_CRON_SECRET"] = "short";
    expect((await call("short")).status).toBe(503);
    expect(state.calls).toBe(0);
  });
  it("rejects a missing or wrong secret", async () => {
    process.env["AGENT_REPORT_CRON_SECRET"] = SECRET;
    expect((await call()).status).toBe(401);
    expect((await call(SECRET + "x")).status).toBe(401);
    expect(state.calls).toBe(0);
  });
  it("runs once with the right secret and passes APP_URL for the email link", async () => {
    process.env["AGENT_REPORT_CRON_SECRET"] = SECRET; process.env["APP_URL"] = "https://own.example";
    const res = await call(SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: { due: 2, sent: 1, notSent: 1, skipped: 0 } });
    expect(state.calls).toBe(1);
    expect(state.appUrl).toBe("https://own.example");
  });
  it("has an hourly workflow that calls the route with the shared secret", () => {
    const wf = readFileSync(path.join(__dirname, "..", ".github", "workflows", "agent-reports.yml"), "utf8");
    expect(wf).toContain('cron: "5 * * * *"');
    expect(wf).toContain("/api/internal/agent-reports/run");
    expect(wf).toContain("AGENT_REPORT_CRON_SECRET");
  });
});
