import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ due: 0, pushes: 0, staff: null as null | { id: string; role: string }, conn: null as unknown }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getStaff: async () => state.staff, getActor: async () => null, getDeps: () => ({}) }));
vi.mock("../src/server/property-feed-db", () => ({
  runDueFeeds: async () => { state.due++; return [{ connectionId: "c1", status: "ok", created: 2, updated: 1, events: 3, error: null }]; },
  connectionForPush: async (_db: unknown, _id: string, token: string) => (token === "good-token" ? state.conn : null),
  importPushedReaxml: async () => { state.pushes++; return { status: "ok", fetched: 1, created: 1, updated: 0, unchanged: 0, skipped: 0, rejected: 0 }; },
  listConnections: async () => [], createConnection: async () => ({ ok: true, id: "x", pushToken: null })
}));
import { POST as runPost } from "../app/api/internal/feeds/run/route";
import { POST as pushPost } from "../app/api/feeds/reaxml/[id]/route";
import { GET as staffGet } from "../app/api/staff/feeds/route";

const SECRET = "f".repeat(40);
const run = (secret?: string) => runPost(new Request("http://test/api/internal/feeds/run", { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret } }));
const push = (token: string, body = "<propertyList/>", headers: Record<string, string> = {}) =>
  pushPost(new Request("http://test/api/feeds/reaxml/c1", { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers }, body }), { params: Promise.resolve({ id: "c1" }) });

describe("feed worker route", () => {
  afterEach(() => { delete process.env["FEED_CRON_SECRET"]; state.due = 0; });
  it("fails closed without a long secret, refuses a wrong one, and runs with the right one", async () => {
    expect((await run("x")).status).toBe(503);
    process.env["FEED_CRON_SECRET"] = SECRET;
    expect((await run()).status).toBe(401);
    expect((await run(SECRET + "x")).status).toBe(401);
    expect(state.due).toBe(0);
    const res = await run(SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [{ connectionId: "c1", status: "ok", created: 2, updated: 1, events: 3, error: null }] });
  });
});

describe("CRM push route", () => {
  afterEach(() => { state.pushes = 0; state.conn = null; });
  it("answers the same 401 for a wrong token or unknown connection and imports nothing", async () => {
    state.conn = { id: "c1" };
    expect((await push("bad")).status).toBe(401);
    state.conn = null;
    expect((await push("good-token")).status).toBe(401);
    expect(state.pushes).toBe(0);
  });
  it("imports with the right token and refuses oversized bodies", async () => {
    state.conn = { id: "c1" };
    const ok = await push("good-token");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, created: 1 });
    expect((await push("good-token", "x", { "content-length": String(25 * 1024 * 1024) })).status).toBe(413);
    // A chunked upload has no content-length: the body is still cut off at 20 MB.
    const big = new ReadableStream({ start(c) { for (let i = 0; i < 21; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); } });
    const chunked = await pushPost(new Request("http://test/api/feeds/reaxml/c1", { method: "POST", headers: { authorization: "Bearer good-token" }, body: big, duplex: "half" } as RequestInit), { params: Promise.resolve({ id: "c1" }) });
    expect(chunked.status).toBe(413);
    expect(state.pushes).toBe(1);
  });
});

describe("staff feeds route", () => {
  afterEach(() => { state.staff = null; });
  it("needs staff with feeds.manage", async () => {
    expect((await staffGet(new Request("http://test/api/staff/feeds"))).status).toBe(401);
    state.staff = { id: "s1", role: "support" };
    expect((await staffGet(new Request("http://test/api/staff/feeds"))).status).toBe(403);
    state.staff = { id: "s1", role: "super_admin" };
    const r = await staffGet(new Request("http://test/api/staff/feeds"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ connections: [], domainConfigured: false });
  });
});

describe("hourly schedule", () => {
  const wf = readFileSync(path.join(__dirname, "..", ".github", "workflows", "property-feeds.yml"), "utf8");
  it("calls the worker hourly with the cron secret header and can be run by hand", () => {
    expect(wf).toContain('cron: "20 * * * *"');
    expect(wf).toContain("workflow_dispatch:");
    expect(wf).toContain('-H "x-cron-secret: $CRON_SECRET" "$APP_URL/api/internal/feeds/run"');
    expect(wf).toContain("permissions: {}");
  });
});
