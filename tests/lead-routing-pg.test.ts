import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSourceInput, type LeadInput } from "../src/domain/lead-ads";
import { parseRuleInput } from "../src/domain/lead-routing";
import { createSource, getSource, ingestLead, listLeads, setAgentLeadStatus, assignLead } from "../src/server/lead-db";
import { createRule, listRules, setRule } from "../src/server/lead-routing-db";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
const NOW = "2026-11-05T00:00:00.000Z";
const lead = (o: Partial<LeadInput> = {}): LeadInput => ({
  externalId: randomUUID(), name: "Jo Smith", email: `${randomUUID()}@lead.test`, phone: "+61412345678", interest: "buying", suburb: "Paddington", postcode: "4064",
  propertyType: "house", campaignRef: "Spring", adRef: "A1", isTest: false, ...o
});

describe.skipIf(!DATABASE_URL)("lead routing on PostgreSQL", () => {
  let t: TestDb;
  let staff: string, west: string, east: string, busy: string, owner: string;
  const user = async (type: string, status = "active") => String((await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,$2,$3,$4) RETURNING id", [`${randomUUID()}@t.au`, `${type} user`, type, status])).rows[0]!["id"]);
  const profile = (id: string, o: { postcodes?: string[]; types?: string[]; accepting?: boolean } = {}) =>
    t.db.query("INSERT INTO agent_profile (user_id, accepting_new, service_postcodes, property_types) VALUES ($1,$2,$3::text[],$4::text[])", [id, o.accepting ?? true, o.postcodes ?? [], o.types ?? []]);
  const source = async (defaultAgentId?: string) => {
    const p = parseSourceInput({ provider: "meta", label: "Page", accountRef: String(Math.floor(1e10 + Math.random() * 9e9)), ...(defaultAgentId ? { defaultAgentId } : {}) });
    if (!p.ok) throw new Error(p.error);
    const r = await createSource(t.db, staff, p.value, NOW);
    if (!r.ok) throw new Error(r.error);
    return (await getSource(t.db, r.id))!;
  };
  const rule = async (o: Record<string, unknown>) => {
    const p = parseRuleInput({ label: "Rule", ...o });
    if (!p.ok) throw new Error(p.error);
    const r = await createRule(t.db, staff, p.value, NOW);
    if (!r.ok) throw new Error(r.error);
    return r.id;
  };
  const assigned = async (id: string) => (await t.db.query("SELECT assigned_agent_id, assignment_method, assignment_detail, property_type FROM lead WHERE id = $1", [id])).rows[0]!;

  beforeAll(async () => {
    t = await createTestDb();
    staff = await user("owner"); owner = await user("owner");
    west = await user("agent"); east = await user("agent"); busy = await user("agent");
    await profile(west, { postcodes: ["4064"] });
    await profile(east, { postcodes: ["4000"], types: ["unit"] });
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("a rule beats the service area; the lead keeps its property type and why it was routed", async () => {
    const id = await rule({ label: "Houses to east", propertyTypes: ["house"], postcodes: ["4064"], agentUserIds: [east] });
    const src = await source();
    const r = await ingestLead(t.db, src, lead(), NOW, {});
    expect(await assigned(r.leadId)).toMatchObject({ assigned_agent_id: east, assignment_method: "rule", assignment_detail: "Rule: Houses to east", property_type: "house" });
    await setRule(t.db, staff, id, "disable", NOW);
    const r2 = await ingestLead(t.db, src, lead(), NOW, {});
    expect(await assigned(r2.leadId)).toMatchObject({ assigned_agent_id: west, assignment_method: "service_area" });
    expect(await setRule(t.db, staff, id, "delete", NOW)).toBe(true);
    expect(await setRule(t.db, staff, randomUUID(), "delete", NOW)).toBe(false);
  });

  it("spreads leads across a rule's agents by open leads", async () => {
    await rule({ label: "Pair", suburbs: ["Teneriffe"], agentUserIds: [east, west] });
    const src = await source();
    const got: string[] = [];
    for (let i = 0; i < 4; i++) got.push(String((await assigned((await ingestLead(t.db, src, lead({ suburb: "Teneriffe", postcode: "4005" }), NOW, {})).leadId))["assigned_agent_id"]));
    expect(got.filter(g => g === east).length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(got.filter(g => g === east).length - got.filter(g => g === west).length)).toBeLessThanOrEqual(2);
  });

  it("falls back to the default agent, then leaves a lead unassigned; test leads are never routed", async () => {
    const withDefault = await source(busy);
    await profile(busy, {});
    expect(await assigned((await ingestLead(t.db, withDefault, lead({ suburb: "Nowhere", postcode: "6000" }), NOW, {})).leadId)).toMatchObject({ assigned_agent_id: busy, assignment_method: "default" });
    const none = await source();
    expect((await assigned((await ingestLead(t.db, none, lead({ suburb: "Nowhere", postcode: "6001" }), NOW, {})).leadId))["assigned_agent_id"]).toBeNull();
    expect((await assigned((await ingestLead(t.db, none, lead({ isTest: true }), NOW, {})).leadId))["assigned_agent_id"]).toBeNull();
  });

  it("skips agents who stopped taking new work or are suspended", async () => {
    const away = await user("agent"); await profile(away, { postcodes: ["4101"], accepting: false });
    const susp = await user("agent", "suspended"); await profile(susp, { postcodes: ["4101"] });
    const r = await ingestLead(t.db, await source(), lead({ postcode: "4101", suburb: "South Brisbane" }), NOW, {});
    expect((await assigned(r.leadId))["assigned_agent_id"]).toBeNull();
  });

  it("refuses a rule that names a non-agent, and a repeat delivery does not route twice", async () => {
    const p = parseRuleInput({ label: "Bad", postcodes: ["4064"], agentUserIds: [owner] });
    expect(p.ok && await createRule(t.db, staff, p.value, NOW)).toEqual({ ok: false, error: "Every agent named must be an active agent account." });
    const src = await source(); const l = lead();
    expect((await ingestLead(t.db, src, l, NOW, {})).created).toBe(true);
    expect((await ingestLead(t.db, src, l, NOW, {})).created).toBe(false);
    expect((await listRules(t.db)).every(r => r.agentUserIds.length >= 1)).toBe(true);
  });

  it("an agent sees and updates only their own, non-test leads; manual assignment is recorded", async () => {
    const src = await source(); await profile(await user("agent"), {});
    const mine = (await ingestLead(t.db, src, lead({ postcode: "4064" }), NOW, {})).leadId;
    const theirs = (await ingestLead(t.db, src, lead({ postcode: "4000", propertyType: "unit" }), NOW, {})).leadId;
    const ids = (await listLeads(t.db, { agentId: west, excludeTests: true })).leads.map(l => l.id);
    expect(ids).toContain(mine); expect(ids).not.toContain(theirs);
    expect(await setAgentLeadStatus(t.db, west, theirs, "contacted", null, NOW)).toEqual({ ok: false, error: "Lead not found." });
    expect(await setAgentLeadStatus(t.db, west, mine, "lost", null, NOW)).toEqual({ ok: false, error: "Say why the lead was lost." });
    expect(await setAgentLeadStatus(t.db, west, mine, "contacted", null, NOW)).toEqual({ ok: true });
    await assignLead(t.db, staff, mine, east, NOW, {});
    expect(await assigned(mine)).toMatchObject({ assigned_agent_id: east, assignment_method: "manual" });
  });
});
