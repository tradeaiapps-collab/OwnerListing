import { describe, expect, it } from "vitest";
import { createTemplate, deleteTemplate, getTemplate, listTemplates, parseContent, updateTemplate, type TemplateDeps, type TemplateRecord } from "../src/domain/listing-template";
import type { Actor } from "../src/domain/listing-service";

const act = (id: string, userType: Actor["userType"] = "agent"): Actor => ({ userId: id, userType });

/** In-memory deps: team t1 has principal p, manager m and agent a; x is an agent in no team; o is an owner. */
function world() {
  const roles: Record<string, "principal" | "manager" | "agent"> = { p: "principal", m: "manager", a: "agent" };
  let rows: TemplateRecord[] = [];
  const d: TemplateDeps = {
    now: () => new Date("2026-11-05T00:00:00Z"),
    memberships: async u => (roles[u] ? [{ teamId: "t1", teamName: "Harbour", role: roles[u]! }] : []),
    count: async u => rows.filter(r => r.createdBy === u).length,
    insert: async t => { const r = { ...t, id: `x${rows.length + 1}`, updatedAt: "2026-11-05T00:00:00.000Z" }; rows = [...rows, r]; return r; },
    get: async id => rows.find(r => r.id === id),
    list: async (u, teams) => rows.filter(r => (!r.teamId && r.createdBy === u) || (r.teamId && teams.includes(r.teamId))),
    update: async (id, t) => { rows = rows.map(r => (r.id === id ? { ...r, ...t, ...(t.teamId ? {} : { teamId: undefined }) } : r)); },
    remove: async id => { rows = rows.filter(r => r.id !== id); },
    listingContent: async (u, l) => (l === "l1" && (u === "a" || u === "o") ? { description: "Lovely", bedrooms: 3, amenities: ["pool"] } : undefined)
  };
  return d;
}
const body = { name: "Family house", category: "house", content: { description: "Spacious", bedrooms: 3, amenities: ["pool", "garage"] } };

describe("listing templates", () => {
  it("keeps only template fields and rejects bad values", () => {
    expect(parseContent({ description: "x", priceCents: 5, title: "t", address: "a", photos: ["p"], bedrooms: 2 })).toEqual({ ok: true, value: { description: "x", bedrooms: 2 } });
    expect(parseContent({ bedrooms: 99 })).toMatchObject({ ok: false, code: "invalid" });
    expect(parseContent({ amenities: ["jetpack"] })).toMatchObject({ ok: false, code: "invalid" });
    expect(parseContent({ propertyType: "castle" })).toMatchObject({ ok: false });
  });

  it("creates a personal template for an owner or agent, and only they see it", async () => {
    const d = world();
    const r = await createTemplate(d, act("o", "owner"), body);
    expect(r).toMatchObject({ ok: true, value: { scope: "personal", canEdit: true } });
    expect((await listTemplates(d, act("o", "owner"))).ok && (await listTemplates(d, act("o", "owner")) as { value: { templates: unknown[] } }).value.templates).toHaveLength(1);
    const other = await listTemplates(d, act("x"));
    expect(other.ok && other.value.templates).toHaveLength(0);
    if (r.ok) expect(await getTemplate(d, act("x"), r.value.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await createTemplate(d, act("b", "buyer"), body)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await createTemplate(d, act("o", "owner"), { ...body, name: "x" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await createTemplate(d, act("o", "owner"), { ...body, category: "castle" })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("creates from a listing without price, title or address, and refuses a listing the user cannot see", async () => {
    const d = world();
    const r = await createTemplate(d, act("a"), { name: "From l1", category: "villa", fromListingId: "l1" });
    expect(r).toMatchObject({ ok: true, value: { content: { description: "Lovely", bedrooms: 3, amenities: ["pool"] } } });
    expect(await createTemplate(d, act("x"), { name: "From l1", category: "villa", fromListingId: "l1" })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("team templates: managers create and edit, agents read only, outsiders see nothing", async () => {
    const d = world();
    expect(await createTemplate(d, act("a"), { ...body, teamId: "t1" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await createTemplate(d, act("x"), { ...body, teamId: "t1" })).toMatchObject({ ok: false, code: "not_found" });
    const t = await createTemplate(d, act("m"), { ...body, teamId: "t1" });
    if (!t.ok) throw new Error(t.message);
    expect(t.value).toMatchObject({ scope: "team", canEdit: true });
    const asAgent = await listTemplates(d, act("a"));
    expect(asAgent.ok && asAgent.value.templates).toMatchObject([{ id: t.value.id, scope: "team", canEdit: false }]);
    expect(await updateTemplate(d, act("a"), t.value.id, { name: "Hacked" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await deleteTemplate(d, act("a"), t.value.id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await getTemplate(d, act("x"), t.value.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await updateTemplate(d, act("p"), t.value.id, { name: "Renamed" })).toMatchObject({ ok: true, value: { name: "Renamed", scope: "team" } });
    expect(await deleteTemplate(d, act("p"), t.value.id)).toEqual({ ok: true, value: { deleted: true } });
  });

  it("shares and unshares; only a manager can share, only the creator can unshare a shared personal template", async () => {
    const d = world();
    const mine = await createTemplate(d, act("a"), body), boss = await createTemplate(d, act("m"), body);
    if (!mine.ok || !boss.ok) throw new Error("setup");
    expect(await updateTemplate(d, act("a"), mine.value.id, { teamId: "t1" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await updateTemplate(d, act("m"), boss.value.id, { teamId: "t1" })).toMatchObject({ ok: true, value: { scope: "team" } });
    expect(await updateTemplate(d, act("p"), boss.value.id, { teamId: null })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await updateTemplate(d, act("m"), boss.value.id, { teamId: null })).toMatchObject({ ok: true, value: { scope: "personal" } });
    expect(await updateTemplate(d, act("m"), boss.value.id, { teamId: "other" })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("filters by category and furnishing", async () => {
    const d = world();
    await createTemplate(d, act("o", "owner"), { ...body, name: "House A", furnishing: "furnished" });
    await createTemplate(d, act("o", "owner"), { ...body, name: "Villa B", category: "villa", furnishing: "unfurnished" });
    const a = await listTemplates(d, act("o", "owner"), { category: "villa" });
    expect(a.ok && a.value.templates.map(t => t.name)).toEqual(["Villa B"]);
    const b = await listTemplates(d, act("o", "owner"), { furnishing: "furnished" });
    expect(b.ok && b.value.templates.map(t => t.name)).toEqual(["House A"]);
  });
});
