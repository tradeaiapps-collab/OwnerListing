import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}) }));
vi.mock("../src/server/account-deletion-db", () => ({ runAccountRetention: async () => { state.calls++; return { finalised: 2, purged: 1 }; } }));
import { POST } from "../app/api/internal/accounts/retention/route";

const SECRET = "s".repeat(40);
const call = (secret?: string) => POST(new Request("http://test/api/internal/accounts/retention", { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret } }));

describe("account retention route", () => {
  afterEach(() => { delete process.env["ACCOUNT_RETENTION_CRON_SECRET"]; state.calls = 0; });

  it("answers 503 while ACCOUNT_RETENTION_CRON_SECRET is unset or short, and runs nothing", async () => {
    expect((await call("anything")).status).toBe(503);
    process.env["ACCOUNT_RETENTION_CRON_SECRET"] = "short";
    expect((await call("short")).status).toBe(503);
    expect(state.calls).toBe(0);
  });

  it("answers 401 for a missing or wrong secret, and runs nothing", async () => {
    process.env["ACCOUNT_RETENTION_CRON_SECRET"] = SECRET;
    expect((await call()).status).toBe(401);
    expect((await call(SECRET + "x")).status).toBe(401);
    expect(state.calls).toBe(0);
  });

  it("runs once with the right secret and answers the counts", async () => {
    process.env["ACCOUNT_RETENTION_CRON_SECRET"] = SECRET;
    const res = await call(SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: { finalised: 2, purged: 1 } });
    expect(state.calls).toBe(1);
  });
});

describe("daily schedule", () => {
  const wf = readFileSync(path.join(__dirname, "..", ".github", "workflows", "account-retention.yml"), "utf8");
  it("calls the retention route at 02:00 UTC every day with the cron secret header, and can be run by hand", () => {
    expect(wf).toContain('cron: "0 2 * * *"');
    expect(wf).toContain("workflow_dispatch:");
    expect(wf).toContain('-H "x-cron-secret: $CRON_SECRET" "$APP_URL/api/internal/accounts/retention"');
    expect(wf).toContain("--fail-with-body");
  });
});
