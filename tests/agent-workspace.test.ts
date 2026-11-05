import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addClientNote, askWorkspaceAssistant, assistantAnswer, buildPerformance, clientDetail, forecast, getWorkspace, median, parseNote, rankLeads, scoreLead, updateLead,
  type LeadFact, type WorkspaceDeps
} from "../src/domain/agent-workspace";
import type { AgentLicence } from "../src/domain/licence";
import type { Actor } from "../src/domain/listing-service";

const now = new Date("2026-11-05T00:00:00Z");
const fact = (o: Partial<LeadFact> = {}): LeadFact => ({
  enquiryId: "e1", listingId: "l1", listingTitle: "Queenslander", buyerId: "b1", buyerName: "Sam", enquiredAt: "2026-11-01T00:00:00Z",
  buyerMessages: 0, agentMessages: 0, notes: 0, ...o
});
const agent: Actor = { userId: "a1", userType: "agent" };
const licence: AgentLicence = { userId: "a1", jurisdiction: "QLD", status: "verified" };

function deps(facts: LeadFact[], o: Partial<WorkspaceDeps> = {}, log: string[] = []): WorkspaceDeps {
  return {
    licences: async () => [licence], today: () => "2026-11-05", now: () => now,
    leads: async id => { log.push(`leads:${id}`); return facts; },
    offers: async () => ({ listings: 2, open: 2, openCents: 200_000_000, accepted: 3, acceptedCents: 150_000_000, rejected: 3 }),
    peers: async () => ({ agents: 4, acceptanceRate: 40, medianResponseMinutes: 120 }),
    platformRate: async () => undefined,
    notes: async () => [{ kind: "preference", body: "Wants a pool", createdAt: "2026-11-02T00:00:00Z" }],
    addNote: async (...a) => { log.push(`note:${a[0]}:${a[1]}:${a[2]}`); },
    setStage: async (...a) => { log.push(`stage:${a.join("|")}`); },
    personaName: async () => "Elena", ...o
  };
}

describe("lead scoring", () => {
  it("ranks an open offer with an active buyer above a quiet enquiry", () => {
    const hot = scoreLead(fact({ offerStatus: "under_review", buyerMessages: 4, agentMessages: 2, lastBuyerAt: "2026-11-04T00:00:00Z" }), now);
    const cold = scoreLead(fact({ enquiredAt: "2026-08-01T00:00:00Z" }), now);
    expect(hot.band).toBe("hot");
    expect(hot.stage).toBe("offer");
    expect(cold.band).toBe("cold");
    expect(cold.score).toBe(0);
    expect(rankLeads([fact({ enquiryId: "c", enquiredAt: "2026-08-01T00:00:00Z" }), fact({ enquiryId: "h", offerStatus: "submitted", buyerMessages: 5, lastBuyerAt: "2026-11-04T00:00:00Z" })], now)[0]!.enquiryId).toBe("h");
  });
  it("flags a buyer who has never had a reply, and an overdue follow-up", () => {
    const l = scoreLead(fact({ buyerMessages: 1, lastBuyerAt: "2026-11-02T00:00:00Z", followUpAt: "2026-11-03", stage: "contacted" }), now);
    expect(l.reasons).toContain("Waiting for a first reply");
    expect(l.overdue).toBe(true);
    expect(scoreLead(fact({ followUpAt: "2026-11-03", stage: "lost" }), now).overdue).toBe(false);
  });
  it("keeps the score between 0 and 100", () => {
    const l = scoreLead(fact({ offerStatus: "accepted", buyerMessages: 50, lastBuyerAt: "2026-11-04T00:00:00Z" }), now);
    expect(l.score).toBeLessThanOrEqual(100);
    expect(l.stage).toBe("won");
  });
});

describe("performance and forecast", () => {
  it("computes acceptance, median first reply and hides peers when there are too few agents", () => {
    const leads = rankLeads([fact({ firstAgentAt: "2026-11-01T01:00:00Z" }), fact({ enquiryId: "e2", firstAgentAt: "2026-11-01T03:00:00Z" })], now);
    const offers = { listings: 1, open: 1, openCents: 100, accepted: 1, acceptedCents: 50, rejected: 3 };
    const p = buildPerformance(leads, offers, { agents: 2, acceptanceRate: 10 });
    expect(p.acceptanceRate).toBe(25);
    expect(p.medianResponseMinutes).toBe(120);
    expect(p.peers).toBeUndefined();
    expect(buildPerformance(leads, offers, { agents: 3, acceptanceRate: 10 }).peers).toEqual({ acceptanceRate: 10 });
  });
  it("labels where the forecast rate came from", () => {
    const base = buildPerformance([], { listings: 1, open: 4, openCents: 400_000_000, accepted: 0, acceptedCents: 0, rejected: 0 }, { agents: 0 });
    expect(forecast(base)).toMatchObject({ basis: "assumption", ratePercent: 30, expectedClosings: 1.2 });
    expect(forecast(base, 50).basis).toBe("platform history");
    expect(forecast({ ...base, acceptanceRate: 60, closedDeals: 3 }, 50)).toMatchObject({ basis: "your history", ratePercent: 60 });
  });
  it("median handles empty, odd and even lists", () => {
    expect([median([]), median([3, 1, 2]), median([1, 2, 3, 4])]).toEqual([undefined, 2, 3]);
  });
});

describe("workspace service", () => {
  let log: string[];
  beforeEach(() => { log = []; });
  it("is closed to non-agents and unlicensed agents without reading data", async () => {
    for (const a of [{ userId: "o", userType: "owner" } as Actor, { userId: "b", userType: "buyer" } as Actor]) {
      expect(await getWorkspace(deps([fact()], {}, log), a)).toMatchObject({ ok: false, code: "forbidden" });
    }
    const none = deps([fact()], { licences: async () => [{ ...licence, status: "pending" }] }, log);
    expect(await getWorkspace(none, agent)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await askWorkspaceAssistant(none, agent, { question: "hi" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(log).toEqual([]);
  });
  it("returns ranked leads, performance and forecast", async () => {
    const r = await getWorkspace(deps([fact({ enquiryId: "x", buyerMessages: 2, lastBuyerAt: "2026-11-04T00:00:00Z" })]), agent);
    expect(r.ok && r.value.performance.closedDeals).toBe(3);
    expect(r.ok && r.value.forecast.basis).toBe("your history");
    expect(r.ok && r.value.leads).toHaveLength(1);
  });
  it("only logs notes and sets stages for the agent's own clients and enquiries", async () => {
    const d = deps([fact()], {}, log);
    expect(await addClientNote(d, agent, "stranger", { body: "x" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await clientDetail(d, agent, "stranger")).toMatchObject({ ok: false, code: "not_found" });
    expect(await updateLead(d, agent, "other", { stage: "new" })).toMatchObject({ ok: false, code: "not_found" });
    expect(log.filter(x => x.startsWith("note") || x.startsWith("stage"))).toEqual([]);
    expect(await addClientNote(d, agent, "b1", { kind: "call", body: " rang back " })).toEqual({ ok: true, value: true });
    expect(await updateLead(d, agent, "e1", { stage: "viewing", followUpAt: "2026-11-10" })).toEqual({ ok: true, value: true });
    expect(log).toContain("note:a1:b1:call");
    expect(log).toContain("stage:a1|e1|viewing|2026-11-10");
  });
  it("validates notes and stage updates", async () => {
    expect(parseNote({ body: "  " })).toMatchObject({ ok: false, code: "invalid" });
    expect(parseNote({ kind: "sms", body: "x" })).toMatchObject({ ok: false });
    expect(parseNote({ body: "x".repeat(2001) })).toMatchObject({ ok: false });
    expect(parseNote({ body: "hi" })).toEqual({ ok: true, value: { kind: "note", body: "hi" } });
    const d = deps([fact()]);
    expect(await updateLead(d, agent, "e1", { stage: "closed" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await updateLead(d, agent, "e1", { stage: "new", followUpAt: "soon" })).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("assistant", () => {
  const ctx = async () => {
    const w = await getWorkspace(deps([fact({ buyerMessages: 2, lastBuyerAt: "2026-11-04T00:00:00Z" })]), agent);
    if (!w.ok) throw new Error("setup");
    return { name: "Elena", ...w.value };
  };
  it("answers performance, leads, pipeline and client questions from the agent's own numbers", async () => {
    const c = await ctx();
    expect(assistantAnswer(c, "How am I performing?")).toMatchObject({ topic: "performance" });
    expect(assistantAnswer(c, "How am I performing?").text).toContain("3 accepted offers");
    expect(assistantAnswer(c, "Which leads should I call first?").text).toContain("Sam");
    const p = assistantAnswer(c, "What will close next month?");
    expect(p.topic).toBe("pipeline");
    expect(p.text).toContain("estimate, not a promise");
    const s = assistantAnswer({ ...c, client: { lead: c.leads[0]!, notes: [{ kind: "preference", body: "Wants a pool", createdAt: "2026-11-02T00:00:00Z" }] } }, "Summarise this client");
    expect(s.topic).toBe("client");
    expect(s.text).toContain("Wants a pool");
    expect(assistantAnswer(c, "what is the weather").topic).toBe("help");
  });
  it("rejects empty or oversized questions and says there is nothing to forecast with no offers", async () => {
    expect(await askWorkspaceAssistant(deps([]), agent, { question: "" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await askWorkspaceAssistant(deps([]), agent, { question: "x".repeat(501) })).toMatchObject({ ok: false });
    const d = deps([], { offers: async () => ({ listings: 0, open: 0, openCents: 0, accepted: 0, acceptedCents: 0, rejected: 0 }) });
    const r = await askWorkspaceAssistant(d, agent, { question: "forecast next month" });
    expect(r.ok && r.value.text).toContain("no open offers");
    expect(r.ok && r.value.name).toBe("Elena");
  });
});

const state = vi.hoisted(() => ({ actor: null as Actor | null, deps: null as WorkspaceDeps | null }));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor }));
vi.mock("../src/server/agent-workspace-db", () => ({ getWorkspaceDeps: () => state.deps }));

describe("workspace routes", () => {
  it("rejects anonymous callers and serves a licensed agent", async () => {
    const root = await import("../app/api/agent/workspace/route");
    const assist = await import("../app/api/agent/workspace/assistant/route");
    const client = await import("../app/api/agent/workspace/clients/[buyerId]/route");
    const lead = await import("../app/api/agent/workspace/leads/[enquiryId]/route");
    state.actor = null; state.deps = deps([fact()]);
    expect((await root.GET(new Request("http://t/api/agent/workspace"))).status).toBe(401);
    state.actor = agent;
    const ok = await root.GET(new Request("http://t/api/agent/workspace"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).leads).toHaveLength(1);
    const post = (b: unknown) => new Request("http://t/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    expect((await assist.POST(post({ question: "How am I performing?" }))).status).toBe(200);
    expect((await assist.POST(post({ question: "" }))).status).toBe(400);
    expect((await client.POST(post({ body: "hi" }), { params: Promise.resolve({ buyerId: "b1" }) })).status).toBe(201);
    expect((await client.GET(new Request("http://t/x"), { params: Promise.resolve({ buyerId: "nobody" }) })).status).toBe(404);
    expect((await lead.PUT(new Request("http://t/x", { method: "PUT", body: JSON.stringify({ stage: "won" }) }), { params: Promise.resolve({ enquiryId: "e1" }) })).status).toBe(200);
    state.actor = { userId: "b", userType: "buyer" };
    expect((await root.GET(new Request("http://t/api/agent/workspace"))).status).toBe(403);
  });
});
