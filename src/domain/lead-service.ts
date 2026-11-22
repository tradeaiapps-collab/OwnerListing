import type { AiEnginePort } from "./ai-engine";
import type { AgentCandidate } from "./agent-matching";
import type { AuditEvent } from "./audit";
import { learnConfig, type LabelledLead, type LearnedConfig, type LeadResult } from "./lead-learning";
import {
  DEFAULT_CONFIG, INTRO, extractWithAi, newLeadState, nextTurn, scoreLead, type LeadScore, type LeadSlots, type LeadState, type QualifierConfig, type Tier
} from "./lead-qualifier";
import {
  checkinText, leadFacts, planFollowUps, routeLead, type AgentLeadStats, type AgentRoute, type FollowUpPlan, type RouteOutcome, MAX_CHECKINS
} from "./lead-routing";
import type { AgentLicence } from "./licence";
import type { Actor, Result } from "./listing-service";
import type { Jurisdiction } from "./jurisdiction";

export type LeadChannel = "chat" | "sms" | "email";
export const NEW_LEADS_PER_ORIGIN_PER_HOUR = 10;
export const MAX_NOTES_PER_LEAD = 50;
/** A routed lead that writes again within this window is added to the agent's file; after it, a new conversation starts. */
export const REOPEN_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Assignment {
  agentUserId: string; assignedAt: string; assignedBy: "elena" | "staff"; agentScore: number; reasons: string[]; alternatives: AgentRoute[];
  slaDueAt: string; firstContactAt?: string | undefined; result?: LeadResult | undefined; resultAt?: string | undefined; resultNote?: string | undefined;
}
export interface LeadRecord {
  id: string; channel: LeadChannel; externalId: string; state: LeadState; score: LeadScore; configVersion: number; consentContact: boolean;
  routedAt?: string | undefined; checkinsSent: number; createdAt: string; updatedAt: string; assignment?: Assignment | undefined;
}
export interface LeadNote { id: string; authorType: "elena" | "agent" | "staff"; authorUserId?: string | undefined; body: string; createdAt: string }
export interface LeadTurn { direction: "in" | "out"; body: string; createdAt: string }
export interface FollowUpRow { id: string; leadId: string; kind: FollowUpPlan["kind"]; attempt: number; dueAt: string }

export interface LeadRepository {
  findLatest(channel: LeadChannel, externalId: string): Promise<LeadRecord | undefined>;
  get(id: string): Promise<LeadRecord | undefined>;
  countCreatedByOrigin(originHash: string, sinceIso: string): Promise<number>;
  /** Inserts or updates the lead and appends the turns, notes and follow-ups in one transaction. */
  save(lead: LeadRecord, extra: { originHash?: string | undefined; turns?: LeadTurn[]; notes?: LeadNote[]; followUps?: { id: string; plan: FollowUpPlan }[]; audit?: AuditEvent }): Promise<void>;
  assign(leadId: string, a: Assignment, audit: AuditEvent): Promise<void>;
  setFirstContact(leadId: string, at: string): Promise<void>;
  setResult(leadId: string, result: LeadResult, note: string | undefined, at: string, audit: AuditEvent): Promise<void>;
  addNote(leadId: string, note: LeadNote): Promise<boolean>;
  notes(leadId: string): Promise<LeadNote[]>;
  turns(leadId: string): Promise<LeadTurn[]>;
  listForAgent(agentUserId: string): Promise<LeadRecord[]>;
  /** Leads not assigned to any agent, newest first: complete or asked for a person, plus cold ones. */
  listUnrouted(limit: number): Promise<LeadRecord[]>;
  activeConfig(): Promise<QualifierConfig>;
  saveConfig(c: QualifierConfig, byUserId: string, audit: AuditEvent): Promise<void>;
  activateConfig(version: number, byUserId: string, at: string, audit: AuditEvent): Promise<boolean>;
  labelled(): Promise<LabelledLead[]>;
  candidates(jurisdiction: Jurisdiction): Promise<AgentCandidate[]>;
  verifiedLicences(): Promise<AgentLicence[]>;
  agentStats(): Promise<AgentLeadStats[]>;
  dueFollowUps(now: string, limit: number): Promise<FollowUpRow[]>;
  markFollowUp(id: string, status: "sent" | "skipped" | "failed", at: string): Promise<void>;
  /** Open leads silent for `hours`: closed as abandoned (remembering the last question). Returns them for follow-up planning. */
  abandonIdle(now: string, hours: number): Promise<LeadRecord[]>;
}

export interface LeadDeps {
  repo: LeadRepository;
  engine?: AiEnginePort;
  now: () => string;
  newId: () => string;
}

export interface ConverseInput { channel: LeadChannel; externalId: string; text: string; originHash?: string | undefined; phone?: string; email?: string }
export interface ConverseOutput { leadId: string; reply: string; status: LeadState["status"]; tier: Tier; score: number; routed: boolean; agentFirstName?: string }

const audit = (d: LeadDeps, actorType: AuditEvent["actorType"], actorId: string, aggregateId: string, eventType: string, payload: Record<string, unknown>): AuditEvent =>
  ({ id: d.newId(), occurredAt: d.now(), actorType, actorId, aggregateType: "lead", aggregateId, eventType, correlationId: d.newId(), payload } as unknown as AuditEvent);
// d.now is a function; keep the audit builder honest:
const auditEvent = (d: LeadDeps, actorType: AuditEvent["actorType"], actorId: string, aggregateId: string, eventType: string, payload: Record<string, unknown>): AuditEvent =>
  ({ ...audit(d, actorType, actorId, aggregateId, eventType, payload), occurredAt: d.now() });

const firstName = (n: string) => n.split(/\s+/)[0] ?? n;
const area = (s: LeadSlots) => [s.suburb, s.postcode].filter(Boolean).join(" ");

/** The note an agent reads first: what the lead wants, in order of importance. Never contains the lead's contact details. */
export function leadSummary(slots: LeadSlots, score: LeadScore): string {
  const bits = score.factors.filter(f => f.points > 0 || f.note.endsWith("given")).map(f => f.note);
  return `${score.tier.toUpperCase()} lead, score ${score.score}/100. ${slots.goal ?? "goal unknown"} in ${area(slots) || "unknown area"}. ${bits.join(". ")}.`;
}

/**
 * One inbound message from a prospect on any channel. Finds or opens the lead, runs Elena's next turn, and when the lead is ready scores it and
 * (for warm and hot leads, or anyone who asks for a person) routes it to the best licensed agent. Nobody is told an agent's contact details.
 */
export async function converse(d: LeadDeps, input: ConverseInput): Promise<Result<ConverseOutput>> {
  const text = input.text.trim();
  if (text.length === 0 || text.length > 2000) return { ok: false, code: "invalid", message: "Send a message of up to 2000 characters." };
  const now = d.now();
  const config = await d.repo.activeConfig();
  let lead = await d.repo.findLatest(input.channel, input.externalId);
  const fresh = !lead || lead.state.status === "opted_out" ? undefined : lead;
  if (lead?.state.status === "opted_out") {
    // Silence: they asked not to be contacted. No reply, nothing stored.
    return { ok: true, value: { leadId: lead.id, reply: "", status: "opted_out", tier: lead.score.tier, score: lead.score.score, routed: false } };
  }
  const ageDays = fresh ? (Date.parse(now) - Date.parse(fresh.updatedAt)) / 86_400_000 : 0;
  if (fresh && fresh.routedAt && ageDays <= REOPEN_DAYS) {
    // Already with an agent: the message goes on their file, and Elena only acknowledges it.
    const notes = await d.repo.notes(fresh.id);
    const note: LeadNote[] = notes.length < MAX_NOTES_PER_LEAD ? [{ id: d.newId(), authorType: "elena", body: `Lead wrote: ${text.slice(0, 500)}`, createdAt: now }] : [];
    const reply = "Thanks, I've added that to your agent's file. They'll be in touch.";
    await d.repo.save({ ...fresh, updatedAt: now }, { turns: [{ direction: "in", body: text, createdAt: now }, { direction: "out", body: reply, createdAt: now }], notes: note });
    return { ok: true, value: { leadId: fresh.id, reply, status: fresh.state.status, tier: fresh.score.tier, score: fresh.score.score, routed: true } };
  }
  if (!fresh || fresh.routedAt) {
    if (input.originHash && (await d.repo.countCreatedByOrigin(input.originHash, new Date(Date.parse(now) - 3_600_000).toISOString())) >= NEW_LEADS_PER_ORIGIN_PER_HOUR) {
      return { ok: false, code: "rate_limited", message: "Too many new conversations. Try again later." };
    }
    const seed: LeadSlots = { ...(input.phone ? { phone: input.phone } : {}), ...(input.email ? { email: input.email } : {}) };
    if (input.channel === "sms") seed.phone = input.externalId;
    if (input.channel === "email") seed.email = input.externalId;
    lead = {
      id: d.newId(), channel: input.channel, externalId: input.externalId, state: newLeadState(seed), score: scoreLead(seed, config.weights), configVersion: config.version,
      consentContact: input.channel !== "chat", checkinsSent: 0, createdAt: now, updatedAt: now
    };
  } else {
    // An unfinished or cold lead coming back: carry on from the answers already given.
    lead = fresh.state.status === "open" ? fresh : { ...fresh, state: { ...fresh.state, status: "open", turns: 0, asked: {}, skipped: [] } };
  }

  const first = lead.state.turns === 0;
  const rulesPeek = lead.state.lastAsked;
  const ai = d.engine && rulesPeek ? await extractWithAi(d.engine, text) : {};
  const turn = nextTurn(lead.state, text, config, ai);
  let record: LeadRecord = {
    ...lead, state: turn.state, score: turn.score, configVersion: lead.configVersion || config.version, updatedAt: now,
    consentContact: lead.consentContact || turn.state.slots.phone !== undefined || turn.state.slots.email !== undefined
  };
  let reply = (first ? `${INTRO} ` : "") + turn.reply;
  const notes: LeadNote[] = [];
  let followUps: { id: string; plan: FollowUpPlan }[] = [];
  let routed = false;
  let agentName: string | undefined;

  if (turn.state.status === "opted_out") {
    reply = turn.reply;
  } else if (turn.readyToRoute) {
    const wantsPerson = turn.state.status === "handoff_requested";
    const facts = leadFacts(turn.state.slots, turn.score.tier, turn.score.score);
    let outcome: RouteOutcome = { routed: false, reason: "no_location" };
    if (wantsPerson || turn.score.tier !== "cold") {
      outcome = facts.jurisdiction
        ? routeLead(facts, await d.repo.candidates(facts.jurisdiction), await d.repo.verifiedLicences(), await d.repo.agentStats(), now)
        : outcome;
    }
    const summary = leadSummary(turn.state.slots, turn.score);
    if (outcome.routed) {
      routed = true;
      agentName = outcome.best.displayName;
      const sla = new Date(Date.parse(now) + (turn.score.tier === "hot" ? 4 : turn.score.tier === "warm" ? 24 : 72) * 3_600_000).toISOString();
      record = { ...record, routedAt: now, state: { ...record.state, status: turn.state.status === "open" ? "complete" : turn.state.status } };
      const a: Assignment = {
        agentUserId: outcome.best.agentUserId, assignedAt: now, assignedBy: "elena", agentScore: outcome.best.score, reasons: outcome.best.reasons,
        alternatives: outcome.alternatives, slaDueAt: sla
      };
      record.assignment = a;
      notes.push({ id: d.newId(), authorType: "elena", body: summary, createdAt: now });
      followUps = planFollowUps({ tier: turn.score.tier, complete: true, routed: true, now, jurisdiction: facts.jurisdiction, checkinsSent: record.checkinsSent })
        .filter(p => p.kind === "agent_sla").map(plan => ({ id: d.newId(), plan }));
      reply = `${turn.reply} I've passed your details to ${firstName(agentName)}, a licensed agent${facts.slots.suburb ? ` for ${facts.slots.suburb}` : ""}. They'll contact you${turn.score.tier === "hot" ? " shortly" : " soon"}. You can keep writing here and I'll add it to their file.`;
    } else {
      record = { ...record, state: { ...record.state, status: turn.state.status === "open" ? "complete" : turn.state.status } };
      notes.push({ id: d.newId(), authorType: "elena", body: `${summary} Not routed: ${wantsPerson || turn.score.tier !== "cold" ? (outcome.routed === false ? outcome.reason : "") : "cold lead, nurture only"}.`, createdAt: now });
      if (turn.score.tier === "cold" && !wantsPerson) {
        followUps = planFollowUps({ tier: "cold", complete: true, routed: false, now, jurisdiction: facts.jurisdiction, checkinsSent: record.checkinsSent })
          .filter(p => record.channel !== "chat" && record.consentContact || p.kind === "agent_sla").map(plan => ({ id: d.newId(), plan }));
        reply = `${turn.reply} There's no rush. Message me whenever you're ready and I'll find the right agent.`;
      } else {
        reply = `${turn.reply} I'll have a team member find the right agent and follow up with you.`;
      }
    }
  }

  await d.repo.save(record, {
    originHash: input.originHash,
    turns: [{ direction: "in", body: text, createdAt: now }, { direction: "out", body: reply.slice(0, 1000), createdAt: now }],
    notes, followUps,
    audit: auditEvent(d, "system", "elena", record.id, routed ? "lead.routed" : "lead.turn", { tier: record.score.tier, score: record.score.score, channel: record.channel, routed })
  });
  if (record.assignment) await d.repo.assign(record.id, record.assignment, auditEvent(d, "system", "elena", record.id, "lead.assigned", { agentUserId: record.assignment.agentUserId, score: record.assignment.agentScore }));
  return { ok: true, value: { leadId: record.id, reply, status: record.state.status, tier: record.score.tier, score: record.score.score, routed, ...(agentName ? { agentFirstName: firstName(agentName) } : {}) } };
}

/** A carrier STOP or an unsubscribe: marks the sender's latest lead opted out so Elena never writes first again. Creates nothing. */
export async function optOutLead(d: LeadDeps, channel: LeadChannel, externalId: string): Promise<boolean> {
  const l = await d.repo.findLatest(channel, externalId);
  if (!l || l.state.status === "opted_out") return false;
  await d.repo.save({ ...l, state: { ...l.state, status: "opted_out" }, updatedAt: d.now() }, { audit: auditEvent(d, "system", "elena", l.id, "lead.opted_out", { channel }) });
  return true;
}

// ---- Agent and staff actions ------------------------------------------------------------------------------------------------------------
const notFound = { ok: false, code: "not_found", message: "Not found." } as const;
const forbidden = { ok: false, code: "forbidden", message: "Only agent accounts have leads." } as const;

export interface AgentLeadView {
  id: string; channel: LeadChannel; tier: Tier; score: number; status: LeadState["status"]; slots: LeadSlots; factors: LeadScore["factors"];
  reasons: string[]; assignedAt: string; slaDueAt: string; slaOverdue: boolean; firstContactAt?: string | undefined; result?: LeadResult | undefined; notes: LeadNote[]; transcript: LeadTurn[];
}

const view = (l: LeadRecord, notes: LeadNote[], transcript: LeadTurn[], now: string): AgentLeadView => {
  const a = l.assignment as Assignment;
  return {
    id: l.id, channel: l.channel, tier: l.score.tier, score: l.score.score, status: l.state.status, slots: l.state.slots, factors: l.score.factors, reasons: a.reasons,
    assignedAt: a.assignedAt, slaDueAt: a.slaDueAt, slaOverdue: a.firstContactAt === undefined && a.slaDueAt < now, firstContactAt: a.firstContactAt, result: a.result, notes, transcript
  };
};

export async function agentLeads(d: LeadDeps, actor: Actor): Promise<Result<AgentLeadView[]>> {
  if (actor.userType !== "agent") return forbidden;
  const now = d.now();
  return { ok: true, value: (await d.repo.listForAgent(actor.userId)).map(l => view(l, [], [], now)) };
}

async function ownLead(d: LeadDeps, actor: Actor, id: string): Promise<LeadRecord | undefined> {
  if (actor.userType !== "agent" || !UUID.test(id)) return undefined;
  const l = await d.repo.get(id);
  return l?.assignment?.agentUserId === actor.userId ? l : undefined;
}

export async function agentLeadDetail(d: LeadDeps, actor: Actor, id: string): Promise<Result<AgentLeadView>> {
  const l = await ownLead(d, actor, id);
  return l ? { ok: true, value: view(l, await d.repo.notes(id), await d.repo.turns(id), d.now()) } : notFound;
}

export async function agentLogContact(d: LeadDeps, actor: Actor, id: string): Promise<Result<{ firstContactAt: string }>> {
  const l = await ownLead(d, actor, id);
  if (!l) return notFound;
  const at = l.assignment?.firstContactAt ?? d.now();
  if (!l.assignment?.firstContactAt) await d.repo.setFirstContact(id, at);
  return { ok: true, value: { firstContactAt: at } };
}

export async function agentAddNote(d: LeadDeps, actor: Actor, id: string, body: unknown): Promise<Result<LeadNote>> {
  const l = await ownLead(d, actor, id);
  if (!l) return notFound;
  if (typeof body !== "string" || body.trim().length === 0 || body.length > 2000) return { ok: false, code: "invalid", message: "A note is 1 to 2000 characters." };
  const note: LeadNote = { id: d.newId(), authorType: "agent", authorUserId: actor.userId, body: body.trim(), createdAt: d.now() };
  if (!(await d.repo.addNote(id, note))) return { ok: false, code: "conflict", message: "This lead has reached its note limit." };
  return { ok: true, value: note };
}

export async function agentSetResult(d: LeadDeps, actor: Actor, id: string, input: unknown): Promise<Result<{ result: LeadResult }>> {
  const l = await ownLead(d, actor, id);
  if (!l) return notFound;
  const o = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const result = o["result"];
  if (result !== "converted" && result !== "lost" && result !== "unresponsive") return { ok: false, code: "invalid", message: "Result must be converted, lost or unresponsive." };
  const note = typeof o["note"] === "string" ? o["note"].trim().slice(0, 500) || undefined : undefined;
  if (l.assignment?.result) return { ok: false, code: "conflict", message: "A result is already recorded. Ask staff to correct it." };
  await d.repo.setResult(id, result, note, d.now(), auditEvent(d, "user", actor.userId, id, "lead.result", { result }));
  return { ok: true, value: { result } };
}

/** Staff: leads Elena did not route (no licensed agent, no area, cold, or asked for a person). */
export const unroutedLeads = (d: LeadDeps, limit = 100) => d.repo.listUnrouted(Math.min(Math.max(limit, 1), 200));

export async function staffAssign(d: LeadDeps, staffId: string, id: string, agentUserId: unknown): Promise<Result<Assignment>> {
  if (!UUID.test(id) || typeof agentUserId !== "string" || !UUID.test(agentUserId)) return { ok: false, code: "invalid", message: "Send a lead id and an agent id." };
  const l = await d.repo.get(id);
  if (!l) return notFound;
  const facts = leadFacts(l.state.slots, l.score.tier, l.score.score);
  if (!facts.jurisdiction) return { ok: false, code: "conflict", message: "The lead has no postcode yet, so a licence cannot be checked." };
  const now = d.now();
  const cands = await d.repo.candidates(facts.jurisdiction);
  const hit = cands.find(c => c.userId === agentUserId);
  const lic = await d.repo.verifiedLicences();
  if (!hit || !lic.some(x => x.userId === agentUserId && x.jurisdiction === facts.jurisdiction && x.status === "verified" && (x.expiresAt === undefined || x.expiresAt >= now.slice(0, 10)))) {
    return { ok: false, code: "conflict", message: "That agent is not licensed and available in the lead's state." };
  }
  const a: Assignment = {
    agentUserId, assignedAt: now, assignedBy: "staff", agentScore: 0, reasons: ["Assigned by staff"], alternatives: [],
    slaDueAt: new Date(Date.parse(now) + (l.score.tier === "hot" ? 4 : l.score.tier === "warm" ? 24 : 72) * 3_600_000).toISOString()
  };
  await d.repo.assign(id, a, auditEvent(d, "user", staffId, id, "lead.assigned", { agentUserId, by: "staff" }));
  await d.repo.save({ ...l, routedAt: l.routedAt ?? now, assignment: a, updatedAt: now },
    { notes: [{ id: d.newId(), authorType: "staff", authorUserId: staffId, body: leadSummary(l.state.slots, l.score), createdAt: now }] });
  return { ok: true, value: a };
}

/** Staff: propose a new config from past results. It is saved inactive; activating it is a separate, deliberate step. */
export async function proposeConfig(d: LeadDeps, staffId: string): Promise<Result<LearnedConfig>> {
  const current = await d.repo.activeConfig();
  const learned = learnConfig(await d.repo.labelled(), current);
  if (learned.changed) await d.repo.saveConfig(learned.config, staffId, auditEvent(d, "user", staffId, `config-${learned.config.version}`, "lead.config_proposed", { version: learned.config.version, sample: learned.config.sampleSize }));
  return { ok: true, value: learned };
}

export async function activateConfig(d: LeadDeps, staffId: string, version: unknown): Promise<Result<{ version: number }>> {
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { ok: false, code: "invalid", message: "Send a version number." };
  const ok = await d.repo.activateConfig(version, staffId, d.now(), auditEvent(d, "user", staffId, `config-${version}`, "lead.config_activated", { version }));
  return ok ? { ok: true, value: { version } } : notFound;
}

// ---- Scheduled follow-ups ---------------------------------------------------------------------------------------------------------------
export interface FollowUpSender { send(channel: "sms" | "email", to: string, text: string): Promise<boolean> }

/**
 * Cron tick. Closes idle chats (planning one nudge), then handles what is due: Elena's check-ins go only on the channel the lead used, once
 * consent exists, never to someone who opted out, at most twice; an agent whose first-contact time passed gets a note on the file for staff.
 */
export async function runLeadFollowUps(d: LeadDeps, sender: FollowUpSender): Promise<{ sent: number; skipped: number; abandoned: number; escalated: number }> {
  const now = d.now();
  const out = { sent: 0, skipped: 0, abandoned: 0, escalated: 0 };
  for (const l of await d.repo.abandonIdle(now, 24)) {
    out.abandoned++;
    const plans = planFollowUps({ tier: l.score.tier, complete: false, routed: false, now, jurisdiction: leadFacts(l.state.slots, l.score.tier, l.score.score).jurisdiction, checkinsSent: l.checkinsSent })
      .filter(p => p.kind === "elena_checkin" && l.channel !== "chat");
    if (plans.length > 0) await d.repo.save(l, { followUps: plans.map(plan => ({ id: d.newId(), plan })) });
  }
  for (const f of await d.repo.dueFollowUps(now, 100)) {
    const l = await d.repo.get(f.leadId);
    if (!l) { await d.repo.markFollowUp(f.id, "skipped", now); out.skipped++; continue; }
    if (f.kind === "agent_sla") {
      if (l.assignment && !l.assignment.firstContactAt) {
        await d.repo.addNote(l.id, { id: d.newId(), authorType: "elena", body: "First contact time has passed with no contact logged. Staff: please check in with the agent.", createdAt: now });
        out.escalated++;
      }
      await d.repo.markFollowUp(f.id, "sent", now);
      continue;
    }
    const to = l.channel === "sms" ? l.state.slots.phone : l.channel === "email" ? l.state.slots.email : undefined;
    if (!to || l.channel === "chat" || !l.consentContact || l.state.status === "opted_out" || l.checkinsSent >= MAX_CHECKINS || l.assignment?.firstContactAt) {
      await d.repo.markFollowUp(f.id, "skipped", now); out.skipped++; continue;
    }
    const ok = await sender.send(l.channel, to, checkinText(l.state.status === "complete", l.state.slots.goal));
    await d.repo.markFollowUp(f.id, ok ? "sent" : "failed", now);
    if (ok) { await d.repo.save({ ...l, checkinsSent: l.checkinsSent + 1, updatedAt: now }, {}); out.sent++; } else out.skipped++;
  }
  return out;
}

// ---- In-memory repository (tests) -------------------------------------------------------------------------------------------------------
export function createInMemoryLeadRepository(seed: { candidates?: AgentCandidate[]; licences?: AgentLicence[]; stats?: AgentLeadStats[]; labelled?: LabelledLead[] } = {}): LeadRepository & {
  leads: Map<string, LeadRecord>; followUps: (FollowUpRow & { status: string })[]; allNotes: Map<string, LeadNote[]>; configs: (QualifierConfig & { active: boolean })[]; audits: AuditEvent[];
} {
  const leads = new Map<string, LeadRecord>();
  const allNotes = new Map<string, LeadNote[]>();
  const allTurns = new Map<string, LeadTurn[]>();
  const origins = new Map<string, string[]>();
  const followUps: (FollowUpRow & { status: string })[] = [];
  const configs: (QualifierConfig & { active: boolean })[] = [];
  const audits: AuditEvent[] = [];
  const stats = () => {
    const by = new Map<string, AgentLeadStats>((seed.stats ?? []).map(s => [s.agentUserId, { ...s }]));
    for (const l of leads.values()) {
      const a = l.assignment; if (!a) continue;
      const s = by.get(a.agentUserId) ?? { agentUserId: a.agentUserId, openLeads: 0, routed: 0, converted: 0 };
      if (!a.result) s.openLeads++;
      by.set(a.agentUserId, s);
    }
    return [...by.values()];
  };
  return {
    leads, followUps, allNotes, configs, audits,
    async findLatest(channel, externalId) { return [...leads.values()].filter(l => l.channel === channel && l.externalId === externalId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; },
    async get(id) { return leads.get(id); },
    async countCreatedByOrigin(o, since) { return (origins.get(o) ?? []).filter(t => t >= since).length; },
    async save(lead, extra) {
      const isNew = !leads.has(lead.id);
      leads.set(lead.id, structuredClone(lead));
      if (isNew && extra.originHash) origins.set(extra.originHash, [...(origins.get(extra.originHash) ?? []), lead.createdAt]);
      if (extra.turns) allTurns.set(lead.id, [...(allTurns.get(lead.id) ?? []), ...extra.turns]);
      if (extra.notes) allNotes.set(lead.id, [...(allNotes.get(lead.id) ?? []), ...extra.notes]);
      for (const f of extra.followUps ?? []) followUps.push({ id: f.id, leadId: lead.id, kind: f.plan.kind, attempt: f.plan.attempt, dueAt: f.plan.dueAt, status: "pending" });
      if (extra.audit) audits.push(extra.audit);
    },
    async assign(id, a, ev) { const l = leads.get(id); if (l) leads.set(id, { ...l, assignment: a }); audits.push(ev); },
    async setFirstContact(id, at) { const l = leads.get(id); if (l?.assignment) leads.set(id, { ...l, assignment: { ...l.assignment, firstContactAt: at } }); },
    async setResult(id, result, note, at, ev) { const l = leads.get(id); if (l?.assignment) leads.set(id, { ...l, assignment: { ...l.assignment, result, resultAt: at, resultNote: note } }); audits.push(ev); },
    async addNote(id, n) { const cur = allNotes.get(id) ?? []; if (cur.length >= MAX_NOTES_PER_LEAD) return false; allNotes.set(id, [...cur, n]); return true; },
    async notes(id) { return allNotes.get(id) ?? []; },
    async turns(id) { return allTurns.get(id) ?? []; },
    async listForAgent(agent) { return [...leads.values()].filter(l => l.assignment?.agentUserId === agent); },
    async listUnrouted(limit) { return [...leads.values()].filter(l => !l.assignment && (l.state.status === "complete" || l.state.status === "handoff_requested")).slice(0, limit); },
    async activeConfig() { return configs.filter(c => c.active).sort((a, b) => b.version - a.version)[0] ?? DEFAULT_CONFIG; },
    async saveConfig(c, _by, ev) { configs.push({ ...c, active: false }); audits.push(ev); },
    async activateConfig(version, _by, _at, ev) { const c = configs.find(x => x.version === version); if (!c) return false; c.active = true; audits.push(ev); return true; },
    async labelled() { return seed.labelled ?? []; },
    async candidates() { return seed.candidates ?? []; },
    async verifiedLicences() { return seed.licences ?? []; },
    async agentStats() { return stats(); },
    async dueFollowUps(now, limit) { return followUps.filter(f => f.status === "pending" && f.dueAt <= now).slice(0, limit); },
    async markFollowUp(id, status) { const f = followUps.find(x => x.id === id); if (f) f.status = status; },
    async abandonIdle(now, hours) {
      const cutoff = new Date(Date.parse(now) - hours * 3_600_000).toISOString();
      const out: LeadRecord[] = [];
      for (const l of leads.values()) if (l.state.status === "open" && l.updatedAt <= cutoff) { const n = { ...l, state: { ...l.state, status: "abandoned" as const } }; leads.set(l.id, n); out.push(n); }
      return out;
    }
  };
}
