import { PROPERTY_TYPES } from "./listing-service";
import type { LeadInput, LeadInterest } from "./ad-leads";

/**
 * Lead routing: which agent gets a new lead. Pure functions, no I/O.
 * Order: the first matching routing rule -> an agent whose profile covers the lead's postcode or suburb -> the source's default agent -> nobody (staff assign).
 * Within a rule or a service-area tie the agent with the fewest open leads wins, so work spreads evenly.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return s === "" ? null : s.slice(0, max);
};
export const LEAD_INTERESTS: readonly LeadInterest[] = ["buying", "selling", "renting"];

/** Maps what a person typed or picked ("Apartment", "Town house", "Vacant land") onto our property types, or null. */
export function cleanPropertyType(v: unknown): string | null {
  const s = (str(v, 60) ?? "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if ((PROPERTY_TYPES as readonly string[]).includes(s)) return s;
  if (/\b(apartment|unit|flat|studio)\b/.test(s)) return "unit";
  if (/town ?house|villa|duplex/.test(s)) return "townhouse";
  if (/\b(land|block|lot)\b/.test(s)) return "land";
  if (/\b(house|home|cottage|acreage|queenslander)\b/.test(s)) return "house";
  return /\b(office|retail|industrial|warehouse|hospitality)\b/.exec(s)?.[1] ?? null;
}

// ---- Rule input ----

export interface RuleInput { sourceId: string | null; position: number; label: string; postcodes: string[]; suburbs: string[]; propertyTypes: string[]; interests: LeadInterest[]; agentUserIds: string[] }
function list(v: unknown, max: number, each: (s: string) => string | null, what: string): Parsed<string[]> {
  if (v === undefined || v === null || v === "") return { ok: true, value: [] };
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!arr || arr.length > max) return bad(`${what} must be a list of at most ${max}.`);
  const out: string[] = [];
  for (const x of arr) {
    const s = typeof x === "string" ? x.trim() : "";
    if (!s) continue;
    const c = each(s);
    if (!c) return bad(`"${s.slice(0, 30)}" is not a valid entry in ${what}.`);
    if (!out.includes(c)) out.push(c);
  }
  return { ok: true, value: out };
}
export function parseRuleInput(v: unknown): Parsed<RuleInput> {
  if (!v || typeof v !== "object") return bad("Send the rule as JSON.");
  const b = v as Record<string, unknown>;
  const label = str(b["label"], 80);
  if (!label || label.length < 2) return bad("Give the rule a name of 2 to 80 characters.");
  const sourceId = b["sourceId"] === undefined || b["sourceId"] === null || b["sourceId"] === "" ? null : b["sourceId"];
  if (sourceId !== null && !isUuid(sourceId)) return bad("The form must be one of your sources.");
  const position = b["position"] === undefined ? 100 : Number(b["position"]);
  if (!Number.isInteger(position) || position < 1 || position > 10000) return bad("Order must be a whole number from 1 to 10000.");
  const postcodes = list(b["postcodes"], 200, s => (/^\d{4}$/.test(s) ? s : null), "postcodes");
  if (!postcodes.ok) return postcodes;
  const suburbs = list(b["suburbs"], 200, s => (s.length <= 100 ? s.toLowerCase() : null), "suburbs");
  if (!suburbs.ok) return suburbs;
  const types = list(b["propertyTypes"], 20, s => ((PROPERTY_TYPES as readonly string[]).includes(s.toLowerCase()) ? s.toLowerCase() : null), "property types");
  if (!types.ok) return types;
  const interests = list(b["interests"], 3, s => ((LEAD_INTERESTS as readonly string[]).includes(s.toLowerCase()) ? s.toLowerCase() : null), "interests");
  if (!interests.ok) return interests;
  const agents = list(b["agentUserIds"], 20, s => (isUuid(s) ? s.toLowerCase() : null), "agents");
  if (!agents.ok) return agents;
  if (agents.value.length === 0) return bad("Choose at least one agent.");
  if (postcodes.value.length + suburbs.value.length + types.value.length + interests.value.length === 0) return bad("Add at least one postcode, suburb, property type or interest to match on.");
  return { ok: true, value: { sourceId: sourceId as string | null, position, label, postcodes: postcodes.value, suburbs: suburbs.value, propertyTypes: types.value, interests: interests.value as LeadInterest[], agentUserIds: agents.value } };
}

// ---- Choosing the agent --------------------------------------------------------------------------------------------------------

export interface RoutingRule { id: string; label: string; sourceId: string | null; postcodes: string[]; suburbs: string[]; propertyTypes: string[]; interests: string[]; agentUserIds: string[] }
export interface LeadAgent {
  userId: string;
  /** Leads assigned to the agent that are not yet won or lost. */
  openLeads: number;
  /** From the agent's profile (agent-matching). Lower case suburbs. */
  servicePostcodes: string[]; serviceSuburbs: string[]; propertyTypes: string[];
}
export interface Assignment { agentUserId: string; method: "rule" | "service_area" | "default"; detail: string }

/** Whether every condition the rule sets matches (an unset condition matches anything). */
export function ruleMatches(rule: RoutingRule, lead: Pick<LeadInput, "postcode" | "suburb" | "propertyType" | "interest">): boolean {
  if (rule.postcodes.length && !(lead.postcode && rule.postcodes.includes(lead.postcode))) return false;
  if (rule.suburbs.length && !(lead.suburb && rule.suburbs.includes(lead.suburb.toLowerCase()))) return false;
  if (rule.interests.length && !(lead.interest && rule.interests.includes(lead.interest))) return false;
  if (rule.propertyTypes.length && !(lead.propertyType && rule.propertyTypes.includes(lead.propertyType))) return false;
  return true;
}

/** The least loaded of `ids` among the eligible agents; ties go to the lowest id so the result is repeatable. */
function leastLoaded(ids: readonly string[], eligible: ReadonlyMap<string, LeadAgent>): LeadAgent | undefined {
  return ids.map(i => eligible.get(i)).filter((a): a is LeadAgent => a !== undefined)
    .sort((a, b) => a.openLeads - b.openLeads || (a.userId < b.userId ? -1 : 1))[0];
}

/**
 * Picks the agent. Order: the first matching rule (rules in order, already filtered to this form or all forms) -> an agent whose profile covers the
 * lead's postcode or suburb (property type breaks ties and must agree when the agent lists types) -> the form's default agent -> nobody (staff assign).
 * `eligible` holds only active agents who are accepting new work; an agent not in it is never chosen, even when named by a rule or as default.
 */
export function chooseAgent(
  lead: Pick<LeadInput, "postcode" | "suburb" | "propertyType" | "interest">, rules: readonly RoutingRule[], eligible: readonly LeadAgent[],
  opts: { defaultAgentUserId: string | null }
): Assignment | null {
  const byId = new Map(eligible.map(a => [a.userId, a]));
  for (const rule of rules) {
    if (!ruleMatches(rule, lead)) continue;
    const a = leastLoaded(rule.agentUserIds, byId);
    if (a) return { agentUserId: a.userId, method: "rule", detail: `Rule: ${rule.label}` };
  }
  {
    const suburb = lead.suburb?.toLowerCase();
    const scored = eligible.map(a => {
      const area = lead.postcode && a.servicePostcodes.includes(lead.postcode) ? 60 : suburb && a.serviceSuburbs.includes(suburb) ? 50 : 0;
      const typeOk = a.propertyTypes.length === 0 || (!!lead.propertyType && a.propertyTypes.includes(lead.propertyType));
      return { a, score: area === 0 || !typeOk ? 0 : area + (lead.propertyType && a.propertyTypes.includes(lead.propertyType) ? 10 : 0) };
    }).filter(s => s.score > 0).sort((x, y) => y.score - x.score || x.a.openLeads - y.a.openLeads || (x.a.userId < y.a.userId ? -1 : 1));
    if (scored[0]) return { agentUserId: scored[0].a.userId, method: "service_area", detail: "Agent's service area" + (lead.propertyType ? " and property type" : "") };
  }
  const def = opts.defaultAgentUserId ? byId.get(opts.defaultAgentUserId) : undefined;
  return def ? { agentUserId: def.userId, method: "default", detail: "Form's default agent" } : null;
}
