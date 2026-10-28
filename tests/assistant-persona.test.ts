import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERSONA_ID, isPersonaId, PERSONA_IDS, PERSONAS, personaById, personaIntro, personaLabel } from "../src/domain/assistant-persona";
import type { StaffRole } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({
  staff: null as null | { id: string; role: string; permissions?: string[] },
  current: "elena" as string,
  chosen: [] as string[]
}));
vi.mock("../src/server/context", () => ({ getActor: () => null, getDb: () => ({ query: async () => ({ rows: [] }) }), getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/assistant-persona-db", () => ({
  loadPersonaView: async () => ({ current: state.current, history: [] }),
  choosePersona: async (_db: unknown, _s: unknown, p: string) => { state.chosen.push(p); const changed = p !== state.current; state.current = p; return { changed }; }
}));

import * as route from "../app/api/staff/assistant/persona/route";

const ORIGIN = "http://test";
const ROLES: StaffRole[] = ["super_admin", "compliance", "accountant", "support", "technical", "reporting", "designer"];
const req = (method: string, body?: unknown) =>
  new Request(`${ORIGIN}/api/staff/assistant/persona`, { method, headers: { "content-type": "application/json", origin: ORIGIN }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(() => { process.env["APP_URL"] = ORIGIN; state.staff = null; state.current = "elena"; state.chosen = []; });

describe("assistant personas", () => {
  it("has the five personas, Elena by default", () => {
    expect(PERSONAS.map(p => p.id)).toEqual([...PERSONA_IDS]);
    expect(DEFAULT_PERSONA_ID).toBe("elena");
    expect(personaById(undefined).id).toBe("elena");
    expect(personaById("maya").name).toBe("Maya");
    expect(personaById("<script>").id).toBe("elena");
    expect(isPersonaId("noor")).toBe(true);
    expect(isPersonaId("NOOR")).toBe(false);
  });
  it("every image the site points at ships in public/", () => {
    for (const p of PERSONAS) for (const src of [p.portrait, p.icon, p.greeter].filter((s): s is string => s !== null)) {
      expect(existsSync(join(process.cwd(), "public", src))).toBe(true);
    }
  });
  it("always labels her as an AI assistant, never as an agent", () => {
    for (const p of PERSONAS) {
      expect(personaLabel(p)).toBe(`${p.name} · AI assistant`);
      expect(personaIntro(p, "OwnerListing")).toMatch(/AI assistant.*not a licensed agent/);
    }
  });
});

describe("staff /api/staff/assistant/persona", () => {
  it("needs a signed-in staff member", async () => {
    expect((await route.GET(req("GET"))).status).toBe(401);
    expect((await route.PUT(req("PUT", { persona: "maya" }))).status).toBe(401);
  });

  it("only roles with site.content.publish can change it; built-in that is super admin only", async () => {
    for (const role of ROLES) {
      state.staff = { id: "s1", role };
      const r = await route.PUT(req("PUT", { persona: "maya" }));
      expect([role, r.status]).toEqual([role, role === "super_admin" ? 200 : 403]);
    }
    expect(state.chosen).toEqual(["maya"]);
  });

  it("a content editor can see the choice but not change it", async () => {
    state.staff = { id: "s1", role: "custom_editor", permissions: ["site.content.edit"] };
    const g = await route.GET(req("GET"));
    expect(g.status).toBe(200);
    const body = await g.json();
    expect(body).toMatchObject({ current: "elena", canChange: false });
    expect(body.personas).toHaveLength(5);
    expect((await route.PUT(req("PUT", { persona: "sofia" }))).status).toBe(403);
    expect(state.chosen).toEqual([]);
  });

  it("roles without either website permission cannot even see it", async () => {
    state.staff = { id: "s1", role: "designer" };
    expect((await route.GET(req("GET"))).status).toBe(403);
    state.staff = { id: "s1", role: "compliance" };
    expect((await route.GET(req("GET"))).status).toBe(403);
  });

  it("a custom role given site.content.publish can change it", async () => {
    state.staff = { id: "s1", role: "custom_publisher", permissions: ["site.content.publish"] };
    expect((await route.GET(req("GET"))).status).toBe(200);
    const r = await route.PUT(req("PUT", { persona: "noor" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ current: "noor", canChange: true });
  });

  it("accepts only one of the five ids", async () => {
    state.staff = { id: "s1", role: "super_admin" };
    for (const persona of ["", "Elena", "lucy", 3, null, "/assistant/elena-icon.png"]) {
      expect((await route.PUT(req("PUT", { persona }))).status).toBe(400);
    }
    expect(state.chosen).toEqual([]);
  });

  it("rejects a cross-site request", async () => {
    state.staff = { id: "s1", role: "super_admin" };
    const r = await route.PUT(new Request(`${ORIGIN}/api/staff/assistant/persona`, { method: "PUT", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ persona: "maya" }) }));
    expect(r.status).toBe(403);
    expect(state.chosen).toEqual([]);
  });
});
