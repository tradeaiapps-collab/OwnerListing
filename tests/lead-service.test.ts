import type { LabelledLead } from "../src/domain/lead-learning";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PROFILE, type AgentCandidate } from "../src/domain/agent-matching";
import {
  activateConfig, agentAddNote, agentLeadDetail, agentLeads, agentLogContact, agentSetResult, converse, createInMemoryLeadRepository, optOutLead, proposeConfig,
  runLeadFollowUps, staffAssign, unroutedLeads, type ConverseInput, type LeadDeps
} from "../src/domain/lead-service";
import type { Actor } from "../src/domain/listing-service";

const AG = "a0000000-0000-4000-8000-000000000001", AG2 = "b0000000-0000-4000-8000-000000000002";
const agent: Actor = { userId: AG, userType: "agent" };
const other: Actor = { userId: AG2, userType: "agent" };
const candidate = (userId: string, name: string): AgentCandidate => ({ userId, displayName: name, activeListings: 0, profile: { ...DEFAULT_AGENT_PROFILE, servicePostcodes: ["4005"] } });
let n = 0;
let clock = "2026-11-05T01:00:00.000Z";
function setup(opts: { agents?: AgentCandidate[]; labelled?: LabelledLead[] } = {}) {
  const agents = opts.agents ?? [candidate(AG, "Sam Smith")];
  const repo = createInMemoryLeadRepository({ candidates: agents, licences: agents.map(a => ({ userId: a.userId, jurisdiction: "QLD", status: "verified" as const })), ...(opts.labelled ? { labelled: opts.labelled } : {}) });
  const d: LeadDeps = { repo, now: () => clock, newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}` };
  return { repo, d };
}
const chat = (d: LeadDeps, text: string, id = "visitor-1", extra: Partial<ConverseInput> = {}) => converse(d, { channel: "chat", externalId: id, text, ...extra });
const val = async (p: ReturnType<typeof chat>) => { const r = await p; if (!r.ok) throw new Error(r.message); return r.value; };

const FULL = "I want to buy a house in New Farm 4005, within a month, budget $900k, relocating for work, pre-approved, mobile 0412 345 678";

describe("converse", () => {
  it("introduces Elena as an AI on the first reply only", async () => {
    const { d } = setup();
    expect((await val(chat(d, "hi"))).reply).toMatch(/AI assistant/);
    expect((await val(chat(d, "buy"))).reply).not.toMatch(/AI assistant/);
  });
  it("qualifies a ready buyer in one message and routes to the best licensed agent", async () => {
    const { d, repo } = setup();
    const r = await val(chat(d, FULL));
    expect(r).toMatchObject({ routed: true, tier: "hot", status: "complete", agentFirstName: "Sam" });
    expect(r.reply).toMatch(/Sam/);
    expect(r.reply).not.toMatch(/0412|@/); // no contact details leak back
    const lead = [...repo.leads.values()][0]!;
    expect(lead.assignment?.agentUserId).toBe(AG);
    expect(lead.assignment?.reasons.join(" ")).toMatch(/4005/);
    expect(repo.followUps.map(f => f.kind)).toEqual(["agent_sla"]);
    expect(repo.audits.map(a => a.eventType)).toContain("lead.routed");
    expect([...repo.allNotes.values()][0]?.[0]?.body).toMatch(/HOT lead/);
  });
  it("walks a multi-turn chat to completion", async () => {
    const { d } = setup();
    const steps = ["hello", "I'd like to buy", "New Farm 4005", "in about 3 months", "under 1.1m", "a unit", "relocating", "yes pre-approved", "0412 345 678"];
    let last;
    for (const s of steps) { last = await val(chat(d, s)); if (last.routed) break; }
    expect(last?.routed).toBe(true);
  });
  it("does not route a cold lead; nurtures by check-in on sms only", async () => {
    const { d, repo } = setup();
    let r = await val(converse(d, { channel: "sms", externalId: "+61412345678", text: "just looking to buy in 4005, no rush" }));
    for (let i = 0; i < 14 && r.status === "open"; i++) r = await val(converse(d, { channel: "sms", externalId: "+61412345678", text: "skip" }));
    expect(r.status).toBe("complete");
    expect(r.routed).toBe(false);
    expect(r.tier).toBe("cold");
    expect(r.reply).toMatch(/no rush/i);
    expect(repo.followUps.every(f => f.kind === "elena_checkin")).toBe(true);
    expect(await unroutedLeads(d)).toHaveLength(1);
  });
  it("queues for staff when no agent covers the area", async () => {
    const { d, repo } = setup({ agents: [{ ...candidate(AG, "Sam"), profile: { ...DEFAULT_AGENT_PROFILE, servicePostcodes: ["4217"] } }] });
    const r = await val(chat(d, FULL));
    expect(r.routed).toBe(false);
    expect(r.reply).toMatch(/team member/);
    expect(await unroutedLeads(d)).toHaveLength(1);
    expect([...repo.allNotes.values()][0]?.[0]?.body).toMatch(/Not routed/);
  });
  it("adds later messages from a routed lead to the agent's file", async () => {
    const { d, repo } = setup();
    await val(chat(d, FULL));
    const r = await val(chat(d, "Can we do Saturday?"));
    expect(r.routed).toBe(true);
    expect(r.reply).toMatch(/agent's file/);
    expect([...repo.allNotes.values()][0]?.some(x => x.body.includes("Saturday"))).toBe(true);
    expect(repo.leads.size).toBe(1);
  });
  it("stays silent after STOP and never reopens", async () => {
    const { d, repo } = setup();
    await val(chat(d, "hi"));
    const stop = await val(chat(d, "stop"));
    expect(stop.status).toBe("opted_out");
    const again = await val(chat(d, "hello again"));
    expect(again.reply).toBe("");
    expect(repo.leads.size).toBe(1);
  });
  it("optOutLead flags an existing lead but creates none", async () => {
    const { d, repo } = setup();
    expect(await optOutLead(d, "sms", "+61400000000")).toBe(false);
    await val(converse(d, { channel: "sms", externalId: "+61400000000", text: "hi" }));
    expect(await optOutLead(d, "sms", "+61400000000")).toBe(true);
    expect([...repo.leads.values()][0]?.state.status).toBe("opted_out");
  });
  it("limits new conversations per origin and rejects bad input", async () => {
    const { d } = setup();
    for (let i = 0; i < 10; i++) await val(chat(d, "hi", `v${i}`, { originHash: "o1" }));
    const r = await chat(d, "hi", "v11", { originHash: "o1" });
    expect(r).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await chat(d, "   ")).toMatchObject({ ok: false, code: "invalid" });
    expect(await chat(d, "x".repeat(2001))).toMatchObject({ ok: false, code: "invalid" });
  });
  it("uses the model's reading only when the rules found nothing for the asked slot", async () => {
    const { repo } = setup();
    const engine = { info: () => ({ id: "t", kind: "self_hosted" as const, version: "1" }), readDocument: async () => "", describePhoto: async () => [], generate: async () => '{"timeline":"3m","goal":"sell"}' };
    const d: LeadDeps = { repo, engine, now: () => clock, newId: () => `88888888-8888-4888-8888-${String(++n).padStart(12, "0")}` };
    await val(chat(d, "I want to buy in 4005 a house"));
    await val(chat(d, "whenever the kids finish school"));
    const lead = [...repo.leads.values()][0]!;
    expect(lead.state.slots.timeline).toBe("3m");
    expect(lead.state.slots.goal).toBe("buy"); // rules won over the model
  });
});

describe("agent and staff actions", () => {
  it("shows a lead only to its assigned agent", async () => {
    const { d, repo } = setup({ agents: [candidate(AG, "Sam Smith"), candidate(AG2, "Pat Lee")] });
    const r = await val(chat(d, FULL));
    const id = [...repo.leads.keys()][0]!;
    const mine = (r.agentFirstName === "Sam" ? agent : other);
    const theirs = mine === agent ? other : agent;
    const detail = await agentLeadDetail(d, mine, id);
    expect(detail.ok && detail.value.slots.phone).toBe("+61412345678");
    expect(detail.ok && detail.value.transcript.length).toBeGreaterThan(0);
    expect(await agentLeadDetail(d, theirs, id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await agentLeadDetail(d, { userId: AG, userType: "owner" }, id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await agentLeads(d, { userId: AG, userType: "buyer" })).toMatchObject({ ok: false, code: "forbidden" });
  });
  it("logs first contact, notes and a one-time result", async () => {
    const { d, repo } = setup();
    await val(chat(d, FULL));
    const id = [...repo.leads.keys()][0]!;
    clock = "2026-11-05T02:00:00.000Z";
    expect(await agentLogContact(d, agent, id)).toMatchObject({ ok: true, value: { firstContactAt: "2026-11-05T02:00:00.000Z" } });
    expect(await agentAddNote(d, agent, id, "Called, booked inspection")).toMatchObject({ ok: true });
    expect(await agentAddNote(d, agent, id, "")).toMatchObject({ ok: false, code: "invalid" });
    expect(await agentSetResult(d, agent, id, { result: "won" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await agentSetResult(d, agent, id, { result: "converted", note: "Sold" })).toMatchObject({ ok: true });
    expect(await agentSetResult(d, agent, id, { result: "lost" })).toMatchObject({ ok: false, code: "conflict" });
    expect(await agentSetResult(d, other, id, { result: "lost" })).toMatchObject({ ok: false, code: "not_found" });
  });
  it("lets staff assign only to a licensed, available agent", async () => {
    const { d, repo } = setup({ agents: [{ ...candidate(AG, "Sam"), profile: { ...DEFAULT_AGENT_PROFILE, servicePostcodes: ["4217"] } }] });
    await val(chat(d, FULL));
    const id = [...repo.leads.keys()][0]!;
    expect(await staffAssign(d, "s1", id, AG2)).toMatchObject({ ok: false, code: "conflict" });
    expect(await staffAssign(d, "s1", id, AG)).toMatchObject({ ok: true, value: { assignedBy: "staff" } });
    expect(await unroutedLeads(d)).toHaveLength(0);
    expect(await staffAssign(d, "s1", "nope", AG)).toMatchObject({ ok: false, code: "invalid" });
  });
  it("proposes a config from results and only changes behaviour once activated", async () => {
    const labelled = [
      ...Array.from({ length: 30 }, (_, i) => ({ slots: { timeline: "now" as const, budgetMax: 800_000, postcode: "4005", suburb: "x", propertyType: "house", motivation: "relocating" as const, financeReady: "yes" as const }, result: (i % 2 ? "lost" : "converted") as "lost" | "converted", asked: {} })),
      ...Array.from({ length: 30 }, () => ({ slots: {}, result: "lost" as const, asked: {} }))
    ];
    const { d, repo } = setup({ labelled });
    const p = await proposeConfig(d, "s1");
    expect(p.ok && p.value.changed).toBe(true);
    expect((await repo.activeConfig()).version).toBe(0);
    expect(await activateConfig(d, "s1", 99)).toMatchObject({ ok: false, code: "not_found" });
    expect(await activateConfig(d, "s1", 1)).toMatchObject({ ok: true });
    expect((await repo.activeConfig()).version).toBe(1);
  });
});

describe("runLeadFollowUps", () => {
  it("closes idle chats, checks in once on sms with consent, never after STOP, and flags missed first contact", async () => {
    const { d, repo } = setup();
    clock = "2026-11-05T01:00:00.000Z";
    await val(converse(d, { channel: "sms", externalId: "+61412345678", text: "I want to buy in 4005" }));
    await val(chat(d, FULL, "visitor-routed"));
    const sent: string[] = [];
    const sender = { send: async (_c: "sms" | "email", to: string, text: string) => { sent.push(`${to}|${text}`); return true; } };
    clock = "2026-11-06T04:00:00.000Z"; // 26h later; 14:00 Brisbane
    const r1 = await runLeadFollowUps(d, sender);
    expect(r1.abandoned).toBe(1);
    clock = "2026-11-08T04:00:00.000Z";
    const r2 = await runLeadFollowUps(d, sender);
    expect(r2.sent).toBeGreaterThanOrEqual(1);
    expect(sent[0]).toMatch(/^\+61412345678\|Hi, it's Elena \(AI assistant\)/);
    expect(sent[0]).toMatch(/STOP/);
    expect(r1.escalated).toBe(1);
    expect([...repo.allNotes.values()].flat().some(x => x.body.includes("First contact time has passed"))).toBe(true);
  });
  it("skips check-ins for opted-out numbers", async () => {
    const { d } = setup();
    clock = "2026-11-05T01:00:00.000Z";
    await val(converse(d, { channel: "sms", externalId: "+61499999999", text: "I want to buy in 4005" }));
    await optOutLead(d, "sms", "+61499999999");
    const sent: string[] = [];
    clock = "2026-11-09T04:00:00.000Z";
    await runLeadFollowUps(d, { send: async (_c, to) => { sent.push(to); return true; } });
    expect(sent).toEqual([]);
  });
});
