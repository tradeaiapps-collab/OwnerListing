import type { AgentCandidate } from "./agent-matching";
import type { Jurisdiction } from "./jurisdiction";
import { hasVerifiedLicence, type AgentLicence } from "./licence";
import { postcodeJurisdiction, type LeadSlots, type Tier } from "./lead-qualifier";
import { JURISDICTION_TIME_ZONE, licenceLocalDate } from "./timezone";

/**
 * Routes a qualified lead to the best licensed agent and explains why. A lead is never routed without a place (no state, no licence
 * check), and an agent who does not take that kind of work (sale or rent, residential or commercial) is never picked.
 */

export const MAX_OPEN_LEADS = 25;
export const COMMERCIAL_TYPES = ["office", "retail", "industrial", "warehouse", "hospitality"] as const;

export interface AgentLeadStats { agentUserId: string; openLeads: number; routed: number; converted: number }
export interface LeadFacts { slots: LeadSlots; tier: Tier; score: number; jurisdiction: Jurisdiction | undefined }

export interface AgentRoute {
  agentUserId: string;
  displayName: string;
  score: number;
  /** Plain sentences for the agent and staff; they explain, they never gate. */
  reasons: string[];
  openLeads: number;
}

export type RouteOutcome = { routed: true; best: AgentRoute; alternatives: AgentRoute[] } | { routed: false; reason: "no_location" | "no_licensed_agent" | "no_agent_available" };

export function leadFacts(slots: LeadSlots, tier: Tier, score: number): LeadFacts {
  return { slots, tier, score, jurisdiction: slots.postcode ? postcodeJurisdiction(slots.postcode) : undefined };
}

export const transactionOf = (slots: LeadSlots): "sale" | "rent" => (slots.goal === "rent" || slots.goal === "lease_out" ? "rent" : "sale");
export const useClassOf = (slots: LeadSlots): "commercial" | "residential" =>
  slots.propertyType && (COMMERCIAL_TYPES as readonly string[]).includes(slots.propertyType) ? "commercial" : "residential";

/** Smoothed conversion rate for an agent: few results pull it toward the platform average so a lucky 1 from 1 does not win. */
export function smoothedRate(converted: number, routed: number, overall: number, weight = 10): number {
  return (converted + overall * weight) / (routed + weight);
}

/**
 * Points (0 to 100): area 40 (postcode 40, suburb 35), the kind of work 15 (sale or rent) and property type 10, spare lead capacity 15,
 * and track record 20 (smoothed conversion, shown as a ratio to the platform average, capped). Hot leads weigh track record at full value,
 * cold leads at half, because a cold lead needs nurturing more than a closer.
 */
export function routeLead(
  lead: LeadFacts, candidates: readonly AgentCandidate[], licences: readonly AgentLicence[], stats: readonly AgentLeadStats[], now: string,
  maxOpen: number = MAX_OPEN_LEADS
): RouteOutcome {
  const j = lead.jurisdiction;
  if (!j) return { routed: false, reason: "no_location" };
  const today = licenceLocalDate(now, j);
  if (today === undefined) return { routed: false, reason: "no_location" };
  const statBy = new Map(stats.map(s => [s.agentUserId, s]));
  const totalRouted = stats.reduce((a, s) => a + s.routed, 0);
  const overall = totalRouted > 0 ? stats.reduce((a, s) => a + s.converted, 0) / totalRouted : 0.1;
  const tx = transactionOf(lead.slots), use = useClassOf(lead.slots);
  const suburb = lead.slots.suburb?.trim().toLowerCase();
  let licensed = 0;
  const out: AgentRoute[] = [];
  for (const c of candidates) {
    const p = c.profile;
    if (!p.acceptingNew || !hasVerifiedLicence(licences, c.userId, j, today)) continue;
    licensed++;
    const st = statBy.get(c.userId) ?? { agentUserId: c.userId, openLeads: 0, routed: 0, converted: 0 };
    if (st.openLeads >= maxOpen) continue;
    if (p.transactionTypes.length > 0 && !p.transactionTypes.includes(tx)) continue;
    if (p.useClasses.length > 0 && !p.useClasses.includes(use)) continue;
    const stated = p.servicePostcodes.length > 0 || p.serviceSuburbs.length > 0;
    const pcHit = lead.slots.postcode !== undefined && p.servicePostcodes.includes(lead.slots.postcode);
    const subHit = suburb !== undefined && p.serviceSuburbs.includes(suburb);
    if (stated && !pcHit && !subHit) continue; // covers other areas only
    const reasons: string[] = [];
    let pts = 0;
    if (pcHit) { pts += 40; reasons.push(`Covers postcode ${lead.slots.postcode}`); }
    else if (subHit) { pts += 35; reasons.push(`Covers ${lead.slots.suburb}`); }
    else reasons.push("Has not listed service areas (generalist)");
    if (p.transactionTypes.includes(tx)) { pts += 15; reasons.push(tx === "sale" ? "Works in sales" : "Works in rentals"); }
    if (lead.slots.propertyType && p.propertyTypes.includes(lead.slots.propertyType)) { pts += 10; reasons.push(`Handles ${lead.slots.propertyType}s`); }
    const spare = 1 - st.openLeads / maxOpen;
    pts += Math.round(15 * spare);
    reasons.push(`${st.openLeads} open lead${st.openLeads === 1 ? "" : "s"} of ${maxOpen}`);
    if (st.routed >= 5) {
      const rate = smoothedRate(st.converted, st.routed, overall);
      const ratio = Math.min(2, rate / Math.max(overall, 0.01));
      pts += Math.round(20 * (ratio / 2) * (lead.tier === "hot" ? 1 : lead.tier === "warm" ? 0.75 : 0.5));
      reasons.push(`${st.converted} of ${st.routed} past leads converted`);
    } else {
      pts += 5; // new to leads: a small neutral credit
    }
    out.push({ agentUserId: c.userId, displayName: c.displayName, score: Math.min(100, pts), reasons, openLeads: st.openLeads });
  }
  if (licensed === 0) return { routed: false, reason: "no_licensed_agent" };
  out.sort((a, b) => b.score - a.score || a.openLeads - b.openLeads || (a.agentUserId < b.agentUserId ? -1 : 1));
  const [best, ...rest] = out;
  return best ? { routed: true, best, alternatives: rest.slice(0, 2) } : { routed: false, reason: "no_agent_available" };
}

// ---- Follow-up scheduling -----------------------------------------------------------------------------------------------------------
export type FollowUpKind = "elena_checkin" | "agent_sla";
export interface FollowUpPlan { kind: FollowUpKind; dueAt: string; attempt: number }

/** Hours the agent has to make first contact. */
export const SLA_HOURS: Record<Tier, number> = { hot: 4, warm: 24, cold: 72 };
/** Elena's own check-ins: an unfinished chat is nudged after 2 hours then 2 days; a finished cold lead after 7 then 21 days. Never more than two. */
export const MAX_CHECKINS = 2;

const HOUR = 3_600_000;

/** Moves an instant into 8am to 8pm local time (messages are never sent at night). */
export function intoSendWindow(iso: string, timeZone: string): string {
  let t = new Date(iso).getTime();
  const hour = (ms: number) => Number(new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", hour12: false }).format(new Date(ms))) % 24;
  for (let i = 0; i < 48 && (hour(t) < 8 || hour(t) >= 20); i++) t += HOUR;
  return new Date(t).toISOString();
}

export function zoneFor(j: Jurisdiction | undefined): string { return j ? JURISDICTION_TIME_ZONE[j] : "Australia/Sydney"; }

export function planFollowUps(p: { tier: Tier; complete: boolean; routed: boolean; now: string; jurisdiction: Jurisdiction | undefined; checkinsSent: number }): FollowUpPlan[] {
  const now = new Date(p.now).getTime();
  const tz = zoneFor(p.jurisdiction);
  const plans: FollowUpPlan[] = [];
  if (p.routed) plans.push({ kind: "agent_sla", dueAt: new Date(now + SLA_HOURS[p.tier] * HOUR).toISOString(), attempt: 1 });
  if (p.checkinsSent < MAX_CHECKINS) {
    const attempt = p.checkinsSent + 1;
    const delay = !p.complete ? (attempt === 1 ? 2 * HOUR : 48 * HOUR) : p.tier === "cold" ? (attempt === 1 ? 7 * 24 * HOUR : 21 * 24 * HOUR) : 0;
    if (delay > 0) plans.push({ kind: "elena_checkin", dueAt: intoSendWindow(new Date(now + delay).toISOString(), tz), attempt });
  }
  return plans;
}

export function checkinText(complete: boolean, goal: string | undefined): string {
  return complete
    ? `Hi, it's Elena (AI assistant). Still thinking about ${goal === "sell" ? "selling" : goal === "rent" || goal === "lease_out" ? "renting" : "buying"}? Reply here any time and I'll update your agent. Reply STOP to end messages.`
    : "Hi, it's Elena (AI assistant). We were chatting about your property plans. Reply here whenever you are ready to carry on. Reply STOP to end messages.";
}
