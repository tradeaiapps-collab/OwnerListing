import { hasVerifiedLicence, type AgentLicence } from "./licence";
import type { Actor, Failure, Result } from "./listing-service";

/**
 * Agent workspace: performance, lead scoring, pipeline stages and a client log, all for listings the agent is appointed to.
 * Pure rules. The assistant answers from these numbers only (rule based, self hosted); it never decides or sends anything.
 */
export const STAGES = ["new", "contacted", "viewing", "offer", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];
export const NOTE_KINDS = ["note", "call", "email", "meeting", "preference"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const MAX_NOTE_LENGTH = 2000;
export const MIN_PEERS = 3;

const OPEN = ["submitted", "under_review", "countered"];
const DAY = 86_400_000;

export interface LeadFact {
  enquiryId: string; listingId: string; listingTitle: string; buyerId: string; buyerName: string; enquiredAt: string;
  buyerMessages: number; agentMessages: number; lastBuyerAt?: string; firstAgentAt?: string;
  offerStatus?: string; offerPriceCents?: number; stage?: Stage; followUpAt?: string; notes: number;
  /** The listing's property type, for filtering team reports. */
  propertyType?: string;
}
export interface Lead extends LeadFact { score: number; band: "hot" | "warm" | "cold"; reasons: string[]; nextAction: string; stage: Stage; overdue: boolean }

const ageDays = (iso: string | undefined, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / DAY : Infinity);

/** 0-100 from offer activity, buyer engagement and recency. Reasons are what the agent sees. */
export function scoreLead(f: LeadFact, now: Date): Lead {
  let score = 0;
  const reasons: string[] = [];
  const add = (n: number, why: string) => { score += n; reasons.push(why); };
  if (f.offerStatus === "accepted") add(50, "Offer accepted");
  else if (f.offerStatus && OPEN.includes(f.offerStatus)) add(40, "Offer in progress");
  if (f.buyerMessages > 0) add(Math.min(f.buyerMessages, 5) * 6, `${f.buyerMessages} message${f.buyerMessages === 1 ? "" : "s"} from the buyer`);
  const idle = ageDays(f.lastBuyerAt ?? f.enquiredAt, now);
  if (idle <= 3) add(20, "Active in the last 3 days");
  else if (idle <= 14) add(10, "Active in the last 2 weeks");
  else if (idle > 30) add(-15, "Quiet for over a month");
  const waiting = f.buyerMessages > 0 && f.agentMessages === 0;
  if (waiting && idle > 1) add(10, "Waiting for a first reply");
  score = Math.max(0, Math.min(100, score));
  const band = score >= 70 ? "hot" : score >= 40 ? "warm" : "cold";
  const stage: Stage = f.stage ?? (f.offerStatus === "accepted" ? "won" : f.offerStatus && OPEN.includes(f.offerStatus) ? "offer" : f.agentMessages > 0 ? "contacted" : "new");
  const today = now.toISOString().slice(0, 10);
  const overdue = !!f.followUpAt && f.followUpAt < today && stage !== "won" && stage !== "lost";
  const nextAction =
    stage === "won" || stage === "lost" ? "No action needed."
    : waiting ? "Reply to the buyer; they have not had a first answer."
    : f.offerStatus && OPEN.includes(f.offerStatus) ? "Review the offer with the owner."
    : overdue ? "Follow-up is overdue; contact the buyer."
    : idle > 14 ? "Check in; this lead has gone quiet."
    : "Keep the conversation moving and offer a viewing.";
  return { ...f, score, band, reasons, nextAction, stage, overdue };
}

export const rankLeads = (facts: readonly LeadFact[], now: Date): Lead[] =>
  facts.map(f => scoreLead(f, now)).sort((a, b) => b.score - a.score || (a.enquiredAt < b.enquiredAt ? 1 : -1));

export interface OfferFacts { listings: number; open: number; openCents: number; accepted: number; acceptedCents: number; rejected: number }
export interface PeerFacts { agents: number; acceptanceRate?: number; medianResponseMinutes?: number }
export interface Performance {
  listings: number; enquiries: number; hot: number; unanswered: number; overdue: number;
  openOffers: number; pipelineCents: number; closedDeals: number; closedCents: number;
  acceptanceRate?: number; medianResponseMinutes?: number;
  peers?: { acceptanceRate?: number; medianResponseMinutes?: number };
}

export function median(v: readonly number[]): number | undefined {
  if (v.length === 0) return undefined;
  const s = [...v].sort((a, b) => a - b), m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
}

export function buildPerformance(leads: readonly Lead[], offers: OfferFacts, peers: PeerFacts): Performance {
  const decided = offers.accepted + offers.rejected;
  const replies = leads.filter(l => l.firstAgentAt).map(l => (Date.parse(l.firstAgentAt!) - Date.parse(l.enquiredAt)) / 60_000).filter(m => m >= 0);
  const p: Performance = {
    listings: offers.listings, enquiries: leads.length, hot: leads.filter(l => l.band === "hot").length,
    unanswered: leads.filter(l => l.buyerMessages > 0 && l.agentMessages === 0).length, overdue: leads.filter(l => l.overdue).length,
    openOffers: offers.open, pipelineCents: offers.openCents, closedDeals: offers.accepted, closedCents: offers.acceptedCents
  };
  if (decided > 0) p.acceptanceRate = Math.round((offers.accepted / decided) * 100);
  const mr = median(replies);
  if (mr !== undefined) p.medianResponseMinutes = mr;
  // Peer figures are shown only when enough other agents exist that no one can be singled out.
  if (peers.agents >= MIN_PEERS) p.peers = { ...(peers.acceptanceRate !== undefined ? { acceptanceRate: peers.acceptanceRate } : {}), ...(peers.medianResponseMinutes !== undefined ? { medianResponseMinutes: peers.medianResponseMinutes } : {}) };
  return p;
}

export interface Forecast { expectedClosings: number; expectedCents: number; ratePercent: number; basis: "your history" | "platform history" | "assumption" }
export const ASSUMED_RATE = 30;
/** Next-month closings: open offers times the best available acceptance rate, labelled with where that rate came from. Not a promise. */
export function forecast(p: Performance, platformRate?: number): Forecast {
  const own = p.acceptanceRate !== undefined && p.closedDeals + 1 >= 3 ? p.acceptanceRate : undefined;
  const ratePercent = own ?? platformRate ?? ASSUMED_RATE;
  const basis = own !== undefined ? "your history" : platformRate !== undefined ? "platform history" : "assumption";
  const share = ratePercent / 100;
  return { expectedClosings: Math.round(p.openOffers * share * 10) / 10, expectedCents: Math.round(p.pipelineCents * share), ratePercent, basis };
}

export const money = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(cents / 100);
const mins = (m: number) => (m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`);

export interface NoteFact { kind: NoteKind; body: string; createdAt: string }
export interface AssistantContext { name: string; performance: Performance; forecast: Forecast; leads: readonly Lead[]; client?: { lead: Lead; notes: readonly NoteFact[] } | undefined }
export interface AssistantAnswer { topic: "performance" | "leads" | "pipeline" | "client" | "help"; text: string; suggestions: string[] }

export function performanceSummary(p: Performance): string {
  const parts = [`${p.closedDeals} accepted offer${p.closedDeals === 1 ? "" : "s"} worth ${money(p.closedCents)}`, `${p.openOffers} open offer${p.openOffers === 1 ? "" : "s"} worth ${money(p.pipelineCents)}`];
  if (p.acceptanceRate !== undefined) parts.push(`${p.acceptanceRate}% acceptance of decided offers${p.peers?.acceptanceRate !== undefined ? ` (other agents: ${p.peers.acceptanceRate}%)` : ""}`);
  if (p.medianResponseMinutes !== undefined) parts.push(`median first reply ${mins(p.medianResponseMinutes)}${p.peers?.medianResponseMinutes !== undefined ? ` (other agents: ${mins(p.peers.medianResponseMinutes)})` : ""}`);
  return parts.join("; ") + ".";
}

export function clientSummary(l: Lead, notes: readonly NoteFact[]): string {
  const last = notes[0];
  const prefs = notes.filter(n => n.kind === "preference").slice(0, 3).map(n => n.body);
  return [
    `${l.buyerName} enquired about ${l.listingTitle} and is ${l.band} (${l.score}/100): ${l.reasons.join(", ").toLowerCase() || "no activity yet"}.`,
    l.offerStatus ? `Offer status: ${l.offerStatus.replace("_", " ")}${l.offerPriceCents ? ` at ${money(l.offerPriceCents)}` : ""}.` : "No offer yet.",
    prefs.length ? `Preferences noted: ${prefs.join("; ")}.` : "No preferences recorded yet.",
    last ? `Last logged: ${last.kind} on ${last.createdAt.slice(0, 10)}.` : "Nothing logged yet.",
    `Suggested next step: ${l.nextAction}`
  ].join(" ");
}

/** Topic match on plain words. The answer is built from the agent's own numbers; no model call. */
export function assistantAnswer(c: AssistantContext, question: string): AssistantAnswer {
  const q = question.toLowerCase();
  const suggestions = ["How am I performing?", "Which leads should I call first?", "What will close next month?"];
  if (c.client && /(client|buyer|summar|about (him|her|them))/.test(q)) return { topic: "client", text: clientSummary(c.client.lead, c.client.notes), suggestions };
  if (/(forecast|next month|close|closing|pipeline|expect)/.test(q)) {
    const f = c.forecast;
    return { topic: "pipeline", suggestions, text: c.performance.openOffers === 0
      ? "You have no open offers, so I would expect no closings from the current pipeline. More viewings and follow-ups on warm leads are the way to change that."
      : `You have ${c.performance.openOffers} open offer${c.performance.openOffers === 1 ? "" : "s"} worth ${money(c.performance.pipelineCents)}. At a ${f.ratePercent}% acceptance rate (${f.basis}) I would expect about ${f.expectedClosings} closing${f.expectedClosings === 1 ? "" : "s"}, roughly ${money(f.expectedCents)}. This is an estimate, not a promise.` };
  }
  if (/(lead|follow|call|quality|who)/.test(q)) {
    const top = c.leads.filter(l => l.stage !== "won" && l.stage !== "lost").slice(0, 3);
    return { topic: "leads", suggestions, text: top.length === 0 ? "You have no active leads right now." : `Top leads: ${top.map(l => `${l.buyerName} on ${l.listingTitle} (${l.score}/100, ${l.nextAction.toLowerCase()})`).join(" ")}${c.performance.unanswered ? ` ${c.performance.unanswered} buyer${c.performance.unanswered === 1 ? " is" : "s are"} still waiting for a first reply.` : ""}` };
  }
  if (/(perform|sales|deal|team|top|how am i|response|insight|trend)/.test(q)) return { topic: "performance", text: `${c.name} here. ${performanceSummary(c.performance)}${c.performance.unanswered ? ` ${c.performance.unanswered} lead${c.performance.unanswered === 1 ? " needs" : "s need"} a first reply.` : ""}`, suggestions };
  return { topic: "help", text: "I can summarise your performance, rank your leads, forecast next month's closings, or summarise a client. I am an AI assistant, not a licensed agent, and I only use your own listings' data.", suggestions };
}

export interface WorkspaceDeps {
  licences(): Promise<readonly AgentLicence[]>;
  today(): string;
  now(): Date;
  leads(agentId: string): Promise<LeadFact[]>;
  offers(agentId: string): Promise<OfferFacts>;
  peers(agentId: string): Promise<PeerFacts>;
  platformRate(): Promise<number | undefined>;
  notes(agentId: string, buyerId: string): Promise<NoteFact[]>;
  addNote(agentId: string, buyerId: string, kind: NoteKind, body: string, at: string): Promise<void>;
  setStage(agentId: string, enquiryId: string, stage: Stage, followUpAt: string | null): Promise<void>;
  personaName(): Promise<string>;
}
export interface Workspace { performance: Performance; forecast: Forecast; leads: Lead[] }

const deny = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
export async function gate(d: Pick<WorkspaceDeps, "licences" | "today">, a: Actor): Promise<Failure | undefined> {
  if (a.userType !== "agent") return deny("forbidden", "Only agents can use the agent workspace.");
  const ls = await d.licences(), today = d.today();
  if (!ls.some(l => hasVerifiedLicence(ls, a.userId, l.jurisdiction, today))) return deny("forbidden", "A verified licence is required to use the agent workspace.");
  return undefined;
}

export async function getWorkspace(d: WorkspaceDeps, a: Actor): Promise<Result<Workspace>> {
  const f = await gate(d, a); if (f) return f;
  const [facts, offers, peers, rate] = await Promise.all([d.leads(a.userId), d.offers(a.userId), d.peers(a.userId), d.platformRate()]);
  const leads = rankLeads(facts, d.now());
  const performance = buildPerformance(leads, offers, peers);
  return { ok: true, value: { performance, forecast: forecast(performance, rate), leads } };
}

const find = (leads: readonly Lead[], buyerId: string) => leads.find(l => l.buyerId === buyerId);

export async function clientDetail(d: WorkspaceDeps, a: Actor, buyerId: string): Promise<Result<{ lead: Lead; notes: NoteFact[]; summary: string }>> {
  const f = await gate(d, a); if (f) return f;
  const lead = find(rankLeads(await d.leads(a.userId), d.now()), buyerId);
  if (!lead) return deny("not_found", "That client is not on one of your listings.");
  const notes = await d.notes(a.userId, buyerId);
  return { ok: true, value: { lead, notes, summary: clientSummary(lead, notes) } };
}

export function parseNote(body: unknown): Result<{ kind: NoteKind; body: string }> {
  const o = (body ?? {}) as Record<string, unknown>;
  const kind = o["kind"] ?? "note", text = typeof o["body"] === "string" ? o["body"].trim() : "";
  if (!(NOTE_KINDS as readonly unknown[]).includes(kind)) return deny("invalid", "Choose a note type: note, call, email, meeting or preference.");
  if (!text) return deny("invalid", "Write something to log.");
  if (text.length > MAX_NOTE_LENGTH) return deny("invalid", `Keep it under ${MAX_NOTE_LENGTH} characters.`);
  return { ok: true, value: { kind: kind as NoteKind, body: text } };
}

export async function addClientNote(d: WorkspaceDeps, a: Actor, buyerId: string, body: unknown): Promise<Result<true>> {
  const f = await gate(d, a); if (f) return f;
  const p = parseNote(body); if (!p.ok) return p;
  if (!find(rankLeads(await d.leads(a.userId), d.now()), buyerId)) return deny("not_found", "That client is not on one of your listings.");
  await d.addNote(a.userId, buyerId, p.value.kind, p.value.body, d.now().toISOString());
  return { ok: true, value: true };
}

export async function updateLead(d: WorkspaceDeps, a: Actor, enquiryId: string, body: unknown): Promise<Result<true>> {
  const f = await gate(d, a); if (f) return f;
  const o = (body ?? {}) as Record<string, unknown>;
  if (!(STAGES as readonly unknown[]).includes(o["stage"])) return deny("invalid", "Choose a stage: " + STAGES.join(", ") + ".");
  const fu = o["followUpAt"] ?? null;
  if (fu !== null && (typeof fu !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fu) || Number.isNaN(Date.parse(fu)))) return deny("invalid", "Follow-up must be a date (YYYY-MM-DD) or empty.");
  if (!(await d.leads(a.userId)).some(l => l.enquiryId === enquiryId)) return deny("not_found", "That enquiry is not on one of your listings.");
  await d.setStage(a.userId, enquiryId, o["stage"] as Stage, fu as string | null);
  return { ok: true, value: true };
}

export async function askWorkspaceAssistant(d: WorkspaceDeps, a: Actor, body: unknown): Promise<Result<AssistantAnswer & { name: string }>> {
  const f = await gate(d, a); if (f) return f;
  const o = (body ?? {}) as Record<string, unknown>;
  const q = typeof o["question"] === "string" ? o["question"].trim() : "";
  if (!q || q.length > 500) return deny("invalid", "Ask a question of up to 500 characters.");
  const w = await getWorkspace(d, a); if (!w.ok) return w;
  const buyerId = typeof o["buyerId"] === "string" ? o["buyerId"] : undefined;
  const lead = buyerId ? find(w.value.leads, buyerId) : undefined;
  const name = await d.personaName();
  const client = lead ? { lead, notes: await d.notes(a.userId, lead.buyerId) } : undefined;
  return { ok: true, value: { ...assistantAnswer({ name, performance: w.value.performance, forecast: w.value.forecast, leads: w.value.leads, client }, q), name } };
}
