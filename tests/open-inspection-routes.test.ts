import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getActor: async () => null }));
vi.mock("../src/server/open-inspection-notify", () => ({ runOpenInspectionReminders: async () => { state.calls++; return { day: 2, hour: 1 }; } }));
import { POST } from "../app/api/internal/open-inspections/reminders/route";
import { GET as slots } from "../app/api/listings/[id]/open-slots/route";
import { GET as mine, POST as book } from "../app/api/open-inspections/route";
import { GET as agentCal, POST as agentAct } from "../app/api/agent/open-inspections/route";
import { GET as times, POST as addTime } from "../app/api/listings/[id]/open-times/route";

const SECRET = "o".repeat(40);
const call = (secret?: string) => POST(new Request("http://test/api/internal/open-inspections/reminders", { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret } }));

describe("open inspection reminder route", () => {
  afterEach(() => { delete process.env["OPEN_INSPECTION_CRON_SECRET"]; state.calls = 0; });
  it("fails closed while the secret is unset or short, and rejects a wrong secret", async () => {
    expect((await call("anything")).status).toBe(503);
    process.env["OPEN_INSPECTION_CRON_SECRET"] = "short";
    expect((await call("short")).status).toBe(503);
    process.env["OPEN_INSPECTION_CRON_SECRET"] = SECRET;
    expect((await call()).status).toBe(401);
    expect((await call(SECRET + "x")).status).toBe(401);
    expect(state.calls).toBe(0);
  });
  it("runs once with the right secret", async () => {
    process.env["OPEN_INSPECTION_CRON_SECRET"] = SECRET;
    const res = await call(SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ day: 2, hour: 1 });
    expect(state.calls).toBe(1);
  });
});

describe("open inspection routes need a sign-in", () => {
  const ctx = { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) };
  const post = (url: string) => new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: "http://test", host: "test" }, body: "{}" });
  it("answers 401 to every signed-in route and 404 to a slot lookup with a bad id", async () => {
    expect((await mine(new Request("http://test/api/open-inspections"))).status).toBe(401);
    expect((await agentCal(new Request("http://test/api/agent/open-inspections"))).status).toBe(401);
    expect((await times(new Request("http://test/x"), ctx)).status).toBe(401);
    for (const r of [await book(post("http://test/api/open-inspections")), await agentAct(post("http://test/api/agent/open-inspections")), await addTime(post("http://test/x"), ctx)]) expect([401, 403]).toContain(r.status);
    expect((await slots(new Request("http://test/x"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
  });
});
