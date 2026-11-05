import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

type Row = { job: string; secret_hash: string | null; secret_last4: string | null; enabled: boolean; rotated_at: string | null; last_called_at: string | null };
const state = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), staff: null as unknown, audits: [] as string[], fail: false }));
const fakeDb = {
  query: async (sql: string, p: unknown[] = []) => {
    if (state.fail) throw new Error("db down");
    const job = String(p[0]);
    if (/^\s*SELECT/.test(sql)) return { rows: state.rows.has(job) ? [state.rows.get(job)!] : [] };
    const cur = state.rows.get(job) ?? { job, secret_hash: null, secret_last4: null, enabled: true, rotated_at: null, last_called_at: null } as Row;
    if (/INSERT INTO cron_secret_setting \(job, secret_hash/.test(sql)) state.rows.set(job, { ...cur, secret_hash: p[1], secret_last4: p[2], rotated_at: new Date().toISOString() });
    else if (/INSERT INTO cron_secret_setting \(job, enabled/.test(sql)) state.rows.set(job, { ...cur, enabled: p[1] });
    else if (/UPDATE cron_secret_setting SET last_called_at/.test(sql)) { if (state.rows.has(job)) state.rows.set(job, { ...cur, last_called_at: new Date().toISOString() }); }
    return { rows: [] };
  }
};
vi.mock("../src/server/context", () => ({ getDb: () => fakeDb, getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_d: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
import { authorizeCron, generateCronSecret } from "../src/server/cron-secret-db";
import * as route from "../app/api/staff/cron-secrets/route";
import * as cron from "../app/api/internal/automations/run/route";

vi.mock("../src/server/automation-db", () => ({ runDueAutomations: async () => ({ processed: 1 }) }));

const actor = (permissions: string[]) => ({ id: "11111111-1111-4111-8111-111111111111", role: "x", permissions, email: "a@b.c" }) as unknown as StaffActor;
const ENV = "e".repeat(40);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const reset = () => { state.rows.clear(); state.staff = null; state.audits = []; state.fail = false; delete process.env["AUTOMATION_CRON_SECRET"]; };

describe("authorizeCron", () => {
  it("generates 64-character hex secrets that differ each time", () => {
    const a = generateCronSecret(), b = generateCronSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
  it("fails closed with nothing set, or when the database is down and the variable is short", async () => {
    reset();
    expect(await authorizeCron(fakeDb, "automations", "x", {})).toMatchObject({ ok: false, status: 503 });
    state.fail = true;
    expect(await authorizeCron(fakeDb, "automations", "short", { AUTOMATION_CRON_SECRET: "short" })).toMatchObject({ ok: false, status: 503 });
  });
  it("uses the environment variable as a fallback", async () => {
    reset();
    const env = { AUTOMATION_CRON_SECRET: ENV };
    expect(await authorizeCron(fakeDb, "automations", ENV, env)).toEqual({ ok: true });
    expect(await authorizeCron(fakeDb, "automations", ENV + "x", env)).toMatchObject({ status: 401 });
    expect(await authorizeCron(fakeDb, "automations", null, env)).toMatchObject({ status: 401 });
    state.fail = true;
    expect(await authorizeCron(fakeDb, "automations", ENV, env)).toEqual({ ok: true });
  });
  it("a stored secret takes precedence over the variable", async () => {
    reset();
    const secret = "s".repeat(64);
    state.rows.set("automations", { secret_hash: sha(secret), secret_last4: "ssss", enabled: true, rotated_at: null, last_called_at: null });
    const env = { AUTOMATION_CRON_SECRET: ENV };
    expect(await authorizeCron(fakeDb, "automations", secret, env)).toEqual({ ok: true });
    expect(await authorizeCron(fakeDb, "automations", ENV, env)).toMatchObject({ status: 401 });
    expect(await authorizeCron(fakeDb, "automations", "", env)).toMatchObject({ status: 401 });
    expect(state.rows.get("automations")!["last_called_at"]).toBeTruthy();
  });
  it("switching a job off refuses even the right secret, and never opens it up", async () => {
    reset();
    const secret = "s".repeat(64);
    state.rows.set("automations", { secret_hash: sha(secret), secret_last4: "ssss", enabled: false, rotated_at: null, last_called_at: null });
    expect(await authorizeCron(fakeDb, "automations", secret, { AUTOMATION_CRON_SECRET: ENV })).toMatchObject({ ok: false, status: 503 });
    state.rows.set("automations", { secret_hash: null, secret_last4: null, enabled: false, rotated_at: null, last_called_at: null });
    expect(await authorizeCron(fakeDb, "automations", ENV, { AUTOMATION_CRON_SECRET: ENV })).toMatchObject({ status: 503 });
  });
});

describe("/api/staff/cron-secrets", () => {
  vi.stubEnv("APP_URL", "http://x");
  const post = (body: unknown) => route.POST(new Request("http://x/api/staff/cron-secrets", { method: "POST", headers: { "content-type": "application/json", origin: "http://x" }, body: JSON.stringify(body) }));
  it("needs sign-in and config.edit", async () => {
    reset();
    expect((await post({ job: "automations", action: "rotate" })).status).toBe(401);
    expect((await route.GET(new Request("http://x/api/staff/cron-secrets"))).status).toBe(401);
    state.staff = actor(["report.sales"]);
    expect((await post({ job: "automations", action: "rotate" })).status).toBe(403);
    expect((await route.GET(new Request("http://x/api/staff/cron-secrets"))).status).toBe(403);
    expect(state.rows.size).toBe(0);
  });
  it("rejects unknown jobs and actions", async () => {
    reset(); state.staff = actor(["config.edit"]);
    expect((await post({ job: "nope", action: "rotate" })).status).toBe(400);
    expect((await post({ job: "automations", action: "show" })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
  });
  it("rotates once, stores only the hash, never lists the secret, and the cron route follows it", async () => {
    reset(); state.staff = actor(["config.edit"]);
    const res = await post({ job: "automations", action: "rotate" });
    const body = await res.json() as { secret: string; jobs: { job: string; source: string; last4: string; active: boolean }[] };
    expect(res.status).toBe(200);
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(state.rows.get("automations")!["secret_hash"]).toBe(sha(body.secret));
    expect(JSON.stringify(state.rows)).not.toContain(body.secret);
    const listed = await (await route.GET(new Request("http://x/api/staff/cron-secrets"))).text();
    expect(listed).not.toContain(body.secret);
    expect(JSON.parse(listed).jobs.find((j: { job: string }) => j.job === "automations")).toMatchObject({ source: "database", last4: body.secret.slice(-4), active: true });
    const call = (s: string) => cron.POST(new Request("http://x/api/internal/automations/run", { method: "POST", headers: { "x-cron-secret": s } }));
    expect((await call(body.secret)).status).toBe(200);
    const old = body.secret;
    const again = await (await post({ job: "automations", action: "rotate" })).json() as { secret: string };
    expect((await call(old)).status).toBe(401);
    expect((await call(again.secret)).status).toBe(200);
    expect(state.audits).toEqual(["staff.cron_secret.rotated", "staff.cron_secret.rotated"]);
  });
  it("pauses and resumes a job", async () => {
    reset(); state.staff = actor(["config.edit"]);
    const { secret } = await (await post({ job: "automations", action: "rotate" })).json() as { secret: string };
    const call = () => cron.POST(new Request("http://x/api/internal/automations/run", { method: "POST", headers: { "x-cron-secret": secret } }));
    const off = await (await post({ job: "automations", action: "disable" })).json() as { jobs: { job: string; enabled: boolean; active: boolean }[] };
    expect(off.jobs.find(j => j.job === "automations")).toMatchObject({ enabled: false, active: false });
    expect((await call()).status).toBe(503);
    await post({ job: "automations", action: "enable" });
    expect((await call()).status).toBe(200);
    expect(state.audits).toContain("staff.cron_secret.disabled");
  });
});
