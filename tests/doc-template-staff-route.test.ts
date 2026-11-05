import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, calls: [] as string[] }));
vi.mock("../src/server/context", () => ({ getActor: () => null, getDb: () => ({}), getStaff: () => state.staff }));
vi.mock("../src/server/doc-template-db", () => ({
  loadTemplates: async () => [],
  installStarters: async () => { state.calls.push("install"); return { installed: [] }; },
  createTemplate: async () => { state.calls.push("create"); return { ok: true, id: "i" }; },
  saveVersion: async () => { state.calls.push("save"); return { ok: true, version: 2 }; },
  publishVersion: async () => { state.calls.push("publish"); return { ok: true, version: 2 }; }
}));
import * as route from "../app/api/staff/doc-templates/route";
process.env["APP_URL"] = "http://test";

const post = (body: unknown) => new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) });
const content = { fields: [], clauses: [{ id: "a", heading: "H", text: "T", explanation: "E" }] };
const only = (...permissions: StaffActor["permissions"] & string[]): StaffActor => ({ id: "s1", role: "custom_x", permissions: permissions as never });

describe("staff document template route", () => {
  beforeEach(() => { state.calls = []; state.staff = null; });

  it("blocks staff without either template permission", async () => {
    state.staff = only("report.sales");
    expect((await route.GET(new Request("http://test/x"))).status).toBe(403);
    expect((await route.POST(post({ action: "install_starters" }))).status).toBe(403);
  });

  it("keeps editing and publishing apart: an editor cannot publish, a publisher cannot edit", async () => {
    state.staff = only("doc_template.edit");
    expect((await route.POST(post({ action: "publish", templateId: "t", version: 2 }))).status).toBe(403);
    expect((await route.POST(post({ action: "save_version", templateId: "t", baseVersion: 1, content }))).status).toBe(200);
    state.staff = only("doc_template.publish");
    expect((await route.POST(post({ action: "save_version", templateId: "t", baseVersion: 1, content }))).status).toBe(403);
    expect((await route.POST(post({ action: "install_starters" }))).status).toBe(403);
    expect((await route.POST(post({ action: "publish", templateId: "t", version: 2 }))).status).toBe(200);
    expect(state.calls).toEqual(["save", "publish"]);
  });

  it("validates content before saving and rejects unknown actions", async () => {
    state.staff = only("doc_template.edit");
    const bad = await route.POST(post({ action: "save_version", templateId: "t", baseVersion: 1, content: { fields: [], clauses: [{ id: "a", heading: "H", text: "{{x}}", explanation: "E" }] } }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { problems: string[] }).problems[0]).toContain("{{x}}");
    expect((await route.POST(post({ action: "save_version", templateId: "t", baseVersion: "1", content }))).status).toBe(400);
    expect((await route.POST(post({ action: "nope" }))).status).toBe(400);
    expect(state.calls).toEqual([]);
  });
});
