import { describe, expect, it } from "vitest";
import { mapGoogleLead, mapMetaLead } from "../src/domain/lead-ads";
import { chooseAgent, cleanPropertyType, parseRuleInput, ruleMatches, type LeadAgent, type RoutingRule } from "../src/domain/lead-routing";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";
const agent = (userId: string, o: Partial<LeadAgent> = {}): LeadAgent => ({ userId, openLeads: 0, servicePostcodes: [], serviceSuburbs: [], propertyTypes: [], ...o });
const rule = (o: Partial<RoutingRule> = {}): RoutingRule => ({ id: "r", label: "R", sourceId: null, postcodes: [], suburbs: [], propertyTypes: [], interests: [], agentUserIds: [A], ...o });
const lead = { postcode: "4064", suburb: "Paddington", propertyType: "house", interest: "buying" as const };

describe("property type from a form answer", () => {
  it("maps what people type onto our types", () => {
    expect(cleanPropertyType("Apartment")).toBe("unit");
    expect(cleanPropertyType("Town house")).toBe("townhouse");
    expect(cleanPropertyType("Vacant land")).toBe("land");
    expect(cleanPropertyType("House")).toBe("house");
    expect(cleanPropertyType("Spaceship")).toBeNull();
  });
  it("is read from the Meta and Google answers", () => {
    const meta = mapMetaLead({ id: "1", field_data: [{ name: "email", values: ["a@b.co"] }, { name: "property_type", values: ["Apartment"] }] });
    expect(meta.ok && meta.value.propertyType).toBe("unit");
    const g = mapGoogleLead({ lead_id: "g1", user_column_data: [{ column_id: "EMAIL", string_value: "a@b.co" }, { column_id: "QUESTION_1", column_name: "Type of property", string_value: "Townhouse" }] });
    expect(g.lead.ok && g.lead.value.propertyType).toBe("townhouse");
  });
});

describe("ruleMatches", () => {
  it("needs every condition the rule sets, and ignores the ones it leaves empty", () => {
    expect(ruleMatches(rule({ postcodes: ["4064"] }), lead)).toBe(true);
    expect(ruleMatches(rule({ postcodes: ["4000"] }), lead)).toBe(false);
    expect(ruleMatches(rule({ postcodes: ["4064"], propertyTypes: ["unit"] }), lead)).toBe(false);
    expect(ruleMatches(rule({ suburbs: ["paddington"] }), lead)).toBe(true);
    expect(ruleMatches(rule({ interests: ["selling"] }), lead)).toBe(false);
    expect(ruleMatches(rule({ propertyTypes: ["house"] }), { ...lead, propertyType: null })).toBe(false);
  });
});

describe("chooseAgent", () => {
  const opts = { defaultAgentUserId: null as string | null };
  it("uses the first matching rule and the least busy agent in it", () => {
    const rules = [rule({ id: "1", postcodes: ["4000"], agentUserIds: [C] }), rule({ id: "2", label: "West", postcodes: ["4064"], agentUserIds: [A, B] })];
    const a = chooseAgent(lead, rules, [agent(A, { openLeads: 5 }), agent(B, { openLeads: 2 }), agent(C)], opts);
    expect(a).toMatchObject({ agentUserId: B, method: "rule", detail: "Rule: West" });
  });
  it("breaks a load tie by id so the result repeats", () => {
    expect(chooseAgent(lead, [rule({ postcodes: ["4064"], agentUserIds: [B, A] })], [agent(A), agent(B)], opts)?.agentUserId).toBe(A);
  });
  it("never picks an agent who is not eligible, even if a rule or the default names them", () => {
    expect(chooseAgent(lead, [rule({ postcodes: ["4064"], agentUserIds: [C] })], [agent(A)], opts)).toBeNull();
    expect(chooseAgent(lead, [], [agent(A)], { defaultAgentUserId: C })).toBeNull();
  });
  it("falls through to the service area when no rule matches, preferring postcode over suburb", () => {
    const eligible = [agent(A, { serviceSuburbs: ["paddington"] }), agent(B, { servicePostcodes: ["4064"] })];
    expect(chooseAgent(lead, [rule({ postcodes: ["9999"] })], eligible, opts)).toMatchObject({ agentUserId: B, method: "service_area" });
  });
  it("skips an area agent whose listed property types exclude the lead's, and spreads ties by load", () => {
    const eligible = [agent(A, { servicePostcodes: ["4064"], propertyTypes: ["unit"] }), agent(B, { servicePostcodes: ["4064"], openLeads: 3 }), agent(C, { servicePostcodes: ["4064"], openLeads: 1 })];
    expect(chooseAgent(lead, [], eligible, opts)?.agentUserId).toBe(C);
  });
  it("uses the default agent last, and returns null when nobody fits", () => {
    expect(chooseAgent(lead, [], [agent(A), agent(B)], { defaultAgentUserId: B })).toMatchObject({ agentUserId: B, method: "default" });
    expect(chooseAgent(lead, [], [agent(A)], opts)).toBeNull();
  });
});

describe("parseRuleInput", () => {
  const ok = { label: "West houses", postcodes: "4064, 4066", propertyTypes: ["House"], agentUserIds: [A] };
  it("accepts a rule and cleans it", () => {
    const r = parseRuleInput(ok);
    expect(r.ok && r.value).toMatchObject({ position: 100, postcodes: ["4064", "4066"], propertyTypes: ["house"], interests: [], agentUserIds: [A], sourceId: null });
  });
  it("refuses a rule with no condition, no agent, or bad entries", () => {
    expect(parseRuleInput({ ...ok, postcodes: "", propertyTypes: [] }).ok).toBe(false);
    expect(parseRuleInput({ ...ok, agentUserIds: [] }).ok).toBe(false);
    expect(parseRuleInput({ ...ok, postcodes: "40" }).ok).toBe(false);
    expect(parseRuleInput({ ...ok, propertyTypes: ["castle"] }).ok).toBe(false);
    expect(parseRuleInput({ ...ok, agentUserIds: ["x"] }).ok).toBe(false);
    expect(parseRuleInput({ ...ok, position: 0 }).ok).toBe(false);
    expect(parseRuleInput({ ...ok, interests: ["gaming"] }).ok).toBe(false);
    expect(parseRuleInput(null).ok).toBe(false);
  });
});
