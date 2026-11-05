import { median } from "./agent-workspace";
import { maskName } from "./admin-report-builder";
import { defaultAlertSettings, type AlertSettings } from "./alert-config";
import { staffCan, type StaffActor } from "./staff-access";

/**
 * Admin-side Elena insights: a rule-based read of platform performance, agent comparison, area trends, alerts and recommendations for
 * a chosen period against the equal period before it. Counts only; no money. Agents are named only as the staff member's personal-data
 * permission allows (full name, masked name, or "Agent N"). Small samples are never ranked or flagged: every rule has a minimum.
 * Elena only suggests; nothing here changes data.
 */

export const MIN_AREA_ENQUIRIES = 5;
export const MIN_AGENT_DECIDED = 5;
export const MIN_AGENT_ENQUIRIES = 5;
export const MIN_PLATFORM_DECIDED = 10;
/** Default for how long an enquiry may wait for an agent reply; staff can change it (see alert-config.ts). */
export const UNANSWERED_HOURS = 24;

export interface PeriodCounts { listings: number; enquiries: number; offers: number; accepted: number; decided: number }
export interface AreaFact { jurisdiction: string; suburb: string; current: PeriodCounts; previous: PeriodCounts; publishedNow: number }
export interface AgentFact {
  id: string; name: string; listings: number; enquiries: number; unanswered: number;
  offers: number; accepted: number; decided: number; medianResponseMinutes?: number;
}
export interface InsightFacts { current: PeriodCounts; previous: PeriodCounts; areas: AreaFact[]; agents: AgentFact[] }

export type Severity = "high" | "medium" | "info";
export interface Trend { current: number; previous: number; changePct?: number }
export interface AgentRow {
  label: string; listings: number; enquiries: number; offers: number; unanswered: number;
  acceptanceRate?: number; medianResponseMinutes?: number; rank?: number; note: string;
}
export interface AreaRow { area: string; enquiries: Trend; offers: Trend; offersPerEnquiryPct?: number; publishedNow: number; note: string }
export interface Alert { id: string; severity: Severity; kind: "area" | "agent"; subject: string; message: string }
export interface Insights {
  summary: string;
  platform: { listings: Trend; enquiries: Trend; offers: Trend; accepted: Trend; acceptanceRate?: number; offersPerEnquiryPct?: number };
  agents: AgentRow[]; agentsNote?: string; areas: AreaRow[]; alerts: Alert[]; recommendations: string[];
  teamNote: string; basis: string;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : undefined);
export const trend = (current: number, previous: number): Trend =>
  ({ current, previous, ...(previous > 0 ? { changePct: Math.round(((current - previous) / previous) * 100) } : {}) });
const plural = (n: number, w: string) => `${n} ${n === 1 ? w : w.endsWith("y") ? `${w.slice(0, -1)}ies` : `${w}s`}`;
const titleCase = (s: string) => s.replace(/\b[a-z]/g, c => c.toUpperCase());

/** "Jane Citizen" with full permission, "Jane C." with masked, "Agent 3" with neither (numbered by position, stable for one response). */
export function agentLabel(actor: StaffActor, name: string, index: number): string {
  if (staffCan(actor, "pii.view_full")) return name;
  if (staffCan(actor, "pii.view_masked")) return maskName(name);
  return `Agent ${index + 1}`;
}

export function buildInsights(actor: StaffActor, facts: InsightFacts, config: AlertSettings = defaultAlertSettings()): Insights {
  const { current: c, previous: p } = facts;
  const platformRate = c.decided >= MIN_PLATFORM_DECIDED ? pct(c.accepted, c.decided) : undefined;
  const platformFunnel = pct(c.offers, c.enquiries);

  // Agents: ranked by acceptance rate only when the sample is big enough; response time and unanswered are compared with the median of agents.
  const ordered = [...facts.agents].sort((a, b) => a.id.localeCompare(b.id));
  const respMedian = median(ordered.filter(a => a.enquiries >= MIN_AGENT_ENQUIRIES && a.medianResponseMinutes !== undefined).map(a => a.medianResponseMinutes!));
  const alerts: Alert[] = [];
  const rows: (AgentRow & { sort: number })[] = ordered.map((a, i) => {
    const label = agentLabel(actor, a.name, i);
    const rate = a.decided >= MIN_AGENT_DECIDED ? pct(a.accepted, a.decided) : undefined;
    const notes: string[] = [];
    if (rate === undefined) notes.push(`fewer than ${MIN_AGENT_DECIDED} decided offers, so no rate`);
    if (config.agent_acceptance_gap.enabled && platformRate !== undefined && rate !== undefined && rate <= platformRate - config.agent_acceptance_gap.threshold) {
      notes.push(`acceptance ${platformRate - rate} points under the platform`);
      alerts.push({ id: `agent-rate-${a.id}`, severity: "medium", kind: "agent", subject: label,
        message: `${label}: ${rate}% of decided offers accepted against ${platformRate}% across the platform (${plural(a.decided, "decided offer")}).` });
    }
    if (config.agent_slow_reply.enabled && a.enquiries >= MIN_AGENT_ENQUIRIES && a.medianResponseMinutes !== undefined && respMedian !== undefined && respMedian > 0 && a.medianResponseMinutes >= respMedian * config.agent_slow_reply.threshold) {
      notes.push(`replies take ${config.agent_slow_reply.threshold} times the usual time or more`);
      alerts.push({ id: `agent-resp-${a.id}`, severity: "medium", kind: "agent", subject: label,
        message: `${label}: first replies take a median of ${a.medianResponseMinutes} minutes; agents with enough enquiries have a median of ${respMedian}.` });
    }
    if (config.agent_unanswered.enabled && a.unanswered >= 3) {
      const hours = config.agent_unanswered.threshold;
      notes.push(`${a.unanswered} enquiries unanswered after ${hours} hours`);
      alerts.push({ id: `agent-unanswered-${a.id}`, severity: "high", kind: "agent", subject: label,
        message: `${label}: ${plural(a.unanswered, "enquiry")} with no agent reply after ${hours} hours.` });
    }
    return {
      label, listings: a.listings, enquiries: a.enquiries, offers: a.offers, unanswered: a.unanswered,
      ...(rate !== undefined ? { acceptanceRate: rate } : {}), ...(a.medianResponseMinutes !== undefined ? { medianResponseMinutes: a.medianResponseMinutes } : {}),
      note: notes.join("; "), sort: rate ?? -1
    };
  });
  const ranked = rows.filter(r => r.acceptanceRate !== undefined).sort((a, b) => b.sort - a.sort || a.label.localeCompare(b.label));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  const agents: AgentRow[] = [...ranked, ...rows.filter(r => r.acceptanceRate === undefined).sort((a, b) => b.enquiries - a.enquiries || a.label.localeCompare(b.label))]
    .map(({ sort: _s, ...r }) => r);
  const agentsNote = ranked.length < 3 ? "Fewer than 3 agents have enough decided offers to rank, so treat comparisons as rough." : undefined;

  // Areas: busiest first. Flags need a real sample, and are phrased as a question for a human, not a verdict.
  const areas: AreaRow[] = [...facts.areas].sort((a, b) => b.current.enquiries - a.current.enquiries || a.suburb.localeCompare(b.suburb)).slice(0, 25).map(a => {
    const name = `${titleCase(a.suburb)} ${a.jurisdiction}`;
    const rate = pct(a.current.offers, a.current.enquiries);
    const notes: string[] = [];
    if (config.area_conversion.enabled && a.current.enquiries >= MIN_AREA_ENQUIRIES && platformFunnel !== undefined && c.enquiries >= 20 && rate !== undefined && rate * 100 <= platformFunnel * config.area_conversion.threshold) {
      notes.push("few enquiries turn into offers");
      alerts.push({ id: `area-conv-${a.jurisdiction}-${a.suburb}`, severity: "medium", kind: "area", subject: name,
        message: `${name}: ${plural(a.current.enquiries, "enquiry")} but ${plural(a.current.offers, "offer")} (${rate}% of enquiries) against ${platformFunnel}% platform-wide. Check pricing and listing quality.` });
    }
    if (config.area_enquiry_drop.enabled && a.previous.enquiries >= MIN_AREA_ENQUIRIES && a.current.enquiries * 100 <= a.previous.enquiries * (100 - config.area_enquiry_drop.threshold)) {
      const drop = Math.round((1 - a.current.enquiries / a.previous.enquiries) * 100);
      notes.push(`enquiries down ${drop}%`);
      alerts.push({ id: `area-drop-${a.jurisdiction}-${a.suburb}`, severity: drop >= 60 ? "high" : "medium", kind: "area", subject: name,
        message: `${name}: enquiries fell ${drop}% (${a.previous.enquiries} to ${a.current.enquiries}) against the previous period.` });
    }
    if (config.area_quiet.enabled && a.publishedNow >= config.area_quiet.threshold && a.current.enquiries === 0) {
      notes.push("live listings, no enquiries");
      alerts.push({ id: `area-quiet-${a.jurisdiction}-${a.suburb}`, severity: "high", kind: "area", subject: name,
        message: `${name}: ${plural(a.publishedNow, "live listing")} and no enquiries this period.` });
    }
    return { area: name, enquiries: trend(a.current.enquiries, a.previous.enquiries), offers: trend(a.current.offers, a.previous.offers),
      ...(rate !== undefined ? { offersPerEnquiryPct: rate } : {}), publishedNow: a.publishedNow, note: notes.join("; ") };
  });
  // Quiet areas (zero enquiries) are not in the top-25 slice by enquiries, so check every area for that rule.
  for (const a of facts.areas) {
    const name = `${titleCase(a.suburb)} ${a.jurisdiction}`;
    const id = `area-quiet-${a.jurisdiction}-${a.suburb}`;
    if (config.area_quiet.enabled && a.publishedNow >= config.area_quiet.threshold && a.current.enquiries === 0 && !alerts.some(x => x.id === id)) {
      alerts.push({ id, severity: "high", kind: "area", subject: name, message: `${name}: ${plural(a.publishedNow, "live listing")} and no enquiries this period.` });
    }
  }
  const rank: Record<Severity, number> = { high: 0, medium: 1, info: 2 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id));

  const recommendations: string[] = [];
  if (alerts.some(a => a.kind === "agent" && a.id.startsWith("agent-unanswered"))) recommendations.push("Follow up with agents who have enquiries waiting more than a day; a quick reply is the cheapest way to keep buyers.");
  if (alerts.some(a => a.id.startsWith("agent-resp"))) recommendations.push("Share reply-time targets with the slower agents and pair them with a faster peer for a fortnight.");
  if (alerts.some(a => a.id.startsWith("agent-rate"))) recommendations.push("Review the offers an under-performing agent's owners rejected; the pattern is often pricing guidance rather than effort.");
  if (alerts.some(a => a.id.startsWith("area-conv"))) recommendations.push("For areas where enquiries do not become offers, ask owners to review price guides, photos and descriptions.");
  if (alerts.some(a => a.id.startsWith("area-drop"))) recommendations.push("For areas with falling enquiries, check seasonal effects first, then consider a local marketing push or a featured-listing offer.");
  if (alerts.some(a => a.id.startsWith("area-quiet"))) recommendations.push("Listings with no enquiries after going live may have a visibility problem: check publish status, photos and address accuracy.");
  const grew = areas.filter(a => a.enquiries.changePct !== undefined && a.enquiries.changePct >= 50 && a.enquiries.current >= MIN_AREA_ENQUIRIES);
  if (grew.length > 0) recommendations.push(`Demand is rising in ${grew.slice(0, 3).map(a => a.area).join(", ")}; consider recruiting or assigning more agents there.`);
  if (recommendations.length === 0) recommendations.push(c.enquiries === 0 ? "No enquiries in this period; widen the date range to see trends." : "Nothing stands out this period. Keep an eye on the weekly trend.");

  const dir = (t: Trend) => (t.changePct === undefined ? "" : t.changePct === 0 ? ", unchanged" : t.changePct > 0 ? `, up ${t.changePct}%` : `, down ${-t.changePct}%`);
  const e = trend(c.enquiries, p.enquiries), o = trend(c.offers, p.offers);
  const high = alerts.filter(a => a.severity === "high").length;
  const summary = `${plural(c.enquiries, "enquiry")}${dir(e)} and ${plural(c.offers, "offer")}${dir(o)} against the previous period. ` +
    (alerts.length === 0 ? "No alerts." : `${plural(alerts.length, "alert")}${high > 0 ? `, ${high} high` : ""}.`);

  return {
    summary,
    platform: { listings: trend(c.listings, p.listings), enquiries: e, offers: o, accepted: trend(c.accepted, p.accepted),
      ...(platformRate !== undefined ? { acceptanceRate: platformRate } : {}), ...(platformFunnel !== undefined ? { offersPerEnquiryPct: platformFunnel } : {}) },
    agents, ...(agentsNote ? { agentsNote } : {}), areas, alerts, recommendations,
    teamNote: "Teams are not part of the platform yet, so agents are compared individually. Team views arrive with team management.",
    basis: `Rule-based and self-hosted, from platform counts only. Agents are compared on offers decided (min ${MIN_AGENT_DECIDED}); areas need ${MIN_AREA_ENQUIRIES}+ enquiries to be flagged.`
  };
}
