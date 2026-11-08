import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PROFILE, type AgentCandidate, type AgentProfile } from "../src/domain/agent-matching";
import { learnConfig, liftOf, normaliseTo100, MIN_SAMPLE, type LabelledLead } from "../src/domain/lead-learning";
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS, SCORE_COMPONENTS, type LeadSlots } from "../src/domain/lead-qualifier";
import { intoSendWindow, leadFacts, planFollowUps, routeLead, smoothedRate } from "../src/domain/lead-routing";
import type { AgentLicence } from "../src/domain/licence";

const NOW = "2026-11-05T01:00:00.000Z";
const A = "a0000000-0000-4000-8000-000000000001", B = "b0000000-0000-4000-8000-000000000002", C = "c0000000-0000-4000-8000-000000000003";
const prof = (o: Partial<AgentProfile> = {}): AgentProfile => ({ ...DEFAULT_AGENT_PROFILE, ...o });
const cand = (userId: string, p: Partial<AgentProfile> = {}): AgentCandidate => ({ userId, displayName: `Agent ${userId.slice(0, 1)}`, profile: prof(p), activeListings: 0 });
const lic = (userId: string, o: Partial<AgentLicence> = {}): AgentLicence => ({ userId, jurisdiction: "QLD", status: "verified", ...o });
const slots: LeadSlots = { goal: "buy", postcode: "4005", suburb: "New Farm", propertyType: "house", timeline: "1m", budgetMax: 900_000 };
const facts = (s: LeadSlots = slots) => leadFacts(s, "hot", 85);

describe("routeLead", () => {
  it("needs a place, and a licensed agent", () => {
    expect(routeLead(leadFacts({ goal: "buy" }, "hot", 80), [cand(A)], [lic(A)], [], NOW)).toEqual({ routed: false, reason: "no_location" });
    expect(routeLead(facts(), [cand(A)], [], [], NOW)).toEqual({ routed: false, reason: "no_licensed_agent" });
    expect(routeLead(facts(), [cand(A)], [lic(A, { jurisdiction: "NSW" })], [], NOW)).toEqual({ routed: false, reason: "no_licensed_agent" });
    expect(routeLead(facts(), [cand(A)], [lic(A, { expiresAt: "2026-01-01" })], [], NOW)).toEqual({ routed: false, reason: "no_licensed_agent" });
  });
  it("prefers area, then work type, with reasons; skips agents for other areas, other work and full books", () => {
    const r = routeLead(facts(), [
      cand(A, { servicePostcodes: ["4005"], transactionTypes: ["sale"], propertyTypes: ["house"] }),
      cand(B, { serviceSuburbs: ["new farm"] }),
      cand(C, { servicePostcodes: ["4217"] })
    ], [lic(A), lic(B), lic(C)], [], NOW);
    expect(r.routed && r.best.agentUserId).toBe(A);
    expect(r.routed && r.best.reasons.join(" ")).toMatch(/postcode 4005/);
    expect(r.routed && r.alternatives.map(x => x.agentUserId)).toEqual([B]);
  });
  it("never routes sale leads to rent-only agents or residential to commercial-only", () => {
    expect(routeLead(facts(), [cand(A, { transactionTypes: ["rent"] })], [lic(A)], [], NOW)).toEqual({ routed: false, reason: "no_agent_available" });
    expect(routeLead(facts(), [cand(A, { useClasses: ["commercial"] })], [lic(A)], [], NOW)).toEqual({ routed: false, reason: "no_agent_available" });
    expect(routeLead(facts({ ...slots, goal: "rent" }), [cand(A, { transactionTypes: ["rent"] })], [lic(A)], [], NOW).routed).toBe(true);
  });
  it("balances workload and honours the cap and not-accepting", () => {
    const stats = [{ agentUserId: A, openLeads: 20, routed: 20, converted: 0 }, { agentUserId: B, openLeads: 2, routed: 2, converted: 0 }, { agentUserId: C, openLeads: 25, routed: 25, converted: 5 }];
    const r = routeLead(facts(), [cand(A), cand(B), cand(C), cand("d0000000-0000-4000-8000-000000000004", { acceptingNew: false })], [lic(A), lic(B), lic(C), lic("d0000000-0000-4000-8000-000000000004")], stats, NOW);
    expect(r.routed && r.best.agentUserId).toBe(B);
    expect(r.routed && r.alternatives.map(x => x.agentUserId)).toEqual([A]); // C is full, D not accepting
  });
  it("rewards a proven track record but not a lucky 1 from 1", () => {
    const stats = [{ agentUserId: A, openLeads: 3, routed: 40, converted: 16 }, { agentUserId: B, openLeads: 3, routed: 1, converted: 1 }, { agentUserId: C, openLeads: 3, routed: 40, converted: 1 }];
    const r = routeLead(facts(), [cand(A), cand(B), cand(C)], [lic(A), lic(B), lic(C)], stats, NOW);
    expect(r.routed && [r.best.agentUserId, ...r.alternatives.map(x => x.agentUserId)]).toEqual([A, B, C]);
    expect(smoothedRate(1, 1, 0.1)).toBeLessThan(0.2);
  });
});

describe("follow-ups", () => {
  it("moves messages into 8am to 8pm local time", () => {
    // 2026-11-05T14:00Z = midnight in Brisbane (UTC+10): moved to 8am.
    expect(intoSendWindow("2026-11-05T14:00:00.000Z", "Australia/Brisbane")).toBe("2026-11-05T22:00:00.000Z");
    expect(intoSendWindow("2026-11-05T01:00:00.000Z", "Australia/Brisbane")).toBe("2026-11-05T01:00:00.000Z");
  });
  it("plans an SLA for routed leads and capped check-ins otherwise", () => {
    const hot = planFollowUps({ tier: "hot", complete: true, routed: true, now: NOW, jurisdiction: "QLD", checkinsSent: 0 });
    expect(hot).toEqual([{ kind: "agent_sla", dueAt: "2026-11-05T05:00:00.000Z", attempt: 1 }]);
    const open = planFollowUps({ tier: "warm", complete: false, routed: false, now: NOW, jurisdiction: "QLD", checkinsSent: 0 });
    expect(open[0]?.kind).toBe("elena_checkin");
    expect(planFollowUps({ tier: "cold", complete: true, routed: false, now: NOW, jurisdiction: "QLD", checkinsSent: 2 })).toEqual([]);
  });
});

const mk = (n: number, strong: boolean, convert: boolean): LabelledLead[] =>
  Array.from({ length: n }, (_, i): LabelledLead => ({
    slots: strong ? { timeline: "now", budgetMax: 800_000, postcode: "4005", suburb: "x", propertyType: "house", motivation: "relocating", financeReady: "yes", phone: "+61412345678", email: "a@b.c" } : {},
    result: convert && i % 2 === 0 ? "converted" : "lost", asked: { timeline: 1, finance: 1 }
  }));

describe("learning", () => {
  it("changes nothing under the minimum sample", () => {
    const r = learnConfig(mk(MIN_SAMPLE - 1, true, true), DEFAULT_CONFIG);
    expect(r.changed).toBe(false);
    expect(r.config).toBe(DEFAULT_CONFIG);
  });
  it("shifts weight toward answers that predict conversion, within bounds, summing to 100", () => {
    const fast = (n: number, conv: number): LabelledLead[] => Array.from({ length: n }, (_, i) => ({ slots: { timeline: "now" as const, budgetMax: 800_000 }, result: i < conv ? "converted" as const : "lost" as const, asked: {} }));
    const slow = (n: number, conv: number): LabelledLead[] => Array.from({ length: n }, (_, i) => ({ slots: { timeline: "later" as const, budgetMax: 800_000 }, result: i < conv ? "converted" as const : "lost" as const, asked: {} }));
    const r = learnConfig([...fast(30, 24), ...slow(30, 6)], DEFAULT_CONFIG);
    expect(r.changed).toBe(true);
    expect(r.config.weights.timeline).toBeGreaterThan(DEFAULT_WEIGHTS.timeline);
    expect(r.config.version).toBe(1);
    expect(SCORE_COMPONENTS.reduce((a, c) => a + r.config.weights[c], 0)).toBe(100);
    for (const c of SCORE_COMPONENTS) expect(r.config.weights[c]).toBeLessThanOrEqual(DEFAULT_WEIGHTS[c] * 1.6 + 2);
    expect(r.config.questionOrder.slice(0, 2)).toEqual(["goal", "location"]);
    expect(new Set(r.config.questionOrder).size).toBe(8);
  });
  it("moves a question that makes people leave later, and ignores abandoned chats for weights", () => {
    const abandoned: LabelledLead[] = Array.from({ length: 20 }, () => ({ slots: {}, result: "unresponsive", asked: { contact: 1 }, abandonedAfter: "contact", abandoned: true }));
    const base: LabelledLead[] = [
      ...Array.from({ length: 20 }, (_, i): LabelledLead => ({ slots: { timeline: "now" }, result: i < 16 ? "converted" : "lost", asked: {} })),
      ...Array.from({ length: 20 }, (_, i): LabelledLead => ({ slots: { timeline: "later" }, result: i < 4 ? "converted" : "lost", asked: {} }))
    ];
    const r = learnConfig([...base, ...abandoned], DEFAULT_CONFIG);
    const withoutAbandoned = learnConfig(base, DEFAULT_CONFIG);
    expect(r.config.weights).toEqual(withoutAbandoned.config.weights);
    expect(r.dropoff.find(d => d.slot === "contact")?.rate).toBe(1);
    expect(r.config.questionOrder.indexOf("contact")).toBeGreaterThanOrEqual(withoutAbandoned.config.questionOrder.indexOf("contact"));
  });
  it("normalises to exactly 100 and softens tiny groups", () => {
    const w = normaliseTo100({ timeline: 33.3, budget: 33.3, location: 11.1, propertyType: 11.1, motivation: 11.1, finance: 0.1, contact: 0 });
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBe(100);
    expect(liftOf("budget", [{ slots: { budgetMax: 1 }, result: "converted", asked: {} }]).lift).toBeGreaterThan(0);
  });
});
