import { describe, expect, it } from "vitest";
import { createInMemoryAgentAppointmentRepository } from "../src/domain/agent-appointment-service";
import {
  createInMemoryAgentMatchingRepository, DEFAULT_AGENT_PROFILE, getAgentProfile, inviteBestAgent, parseAgentProfile, rankAgents, saveAgentProfile,
  suggestAgents, type AgentCandidate, type AgentProfile, type ListingFacts
} from "../src/domain/agent-matching";
import type { AgentLicence } from "../src/domain/licence";
import type { Actor } from "../src/domain/listing-service";

const NOW = "2026-10-25T00:00:00.000Z";
const L = "55555555-5555-4555-8555-555555555555";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const A = "a0000000-0000-4000-8000-000000000001";
const B = "b0000000-0000-4000-8000-000000000002";
const C = "c0000000-0000-4000-8000-000000000003";
const D = "d0000000-0000-4000-8000-000000000004";
const facts: ListingFacts = { ownerUserId: owner.userId, jurisdiction: "QLD", postcode: "4005", suburb: "New Farm", transactionType: "sale", useClass: "residential", propertyType: "house" };
const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({ ...DEFAULT_AGENT_PROFILE, ...over });
const cand = (userId: string, p: Partial<AgentProfile> = {}, activeListings = 0): AgentCandidate => ({ userId, displayName: userId.slice(0, 1).toUpperCase(), profile: profile(p), activeListings });
const lic = (userId: string, over: Partial<AgentLicence> = {}): AgentLicence => ({ userId, jurisdiction: "QLD", status: "verified", ...over });
let n = 0;
const ids = { newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, now: () => NOW };

describe("rankAgents", () => {
  it("ranks area first, then expertise, then spare capacity, with reasons", () => {
    const ranked = rankAgents(facts, [
      cand(A, { transactionTypes: ["sale"], useClasses: ["residential"], propertyTypes: ["house"] }),
      cand(B, { servicePostcodes: ["4005"] }, 15),
      cand(C, { serviceSuburbs: ["new farm"], transactionTypes: ["sale"] })
    ], [lic(A), lic(B), lic(C)], NOW);
    expect(ranked.map(r => r.agentUserId)).toEqual([C, B, A]);
    expect(ranked[0]!.reasons).toEqual(["suburb", "transaction_type", "capacity"]);
    expect(ranked[1]!.reasons).toEqual(["postcode"]);
  });

  it("leaves out agents who are unlicensed for the state, expired, not accepting, at capacity, or the owner", () => {
    const ranked = rankAgents(facts, [
      cand(A), cand(B, { acceptingNew: false }), cand(C, { maxActiveListings: 3 }, 3), cand(D), cand(owner.userId)
    ], [lic(A), lic(B), lic(C), lic(D, { expiresAt: "2026-10-24" }), lic(owner.userId)], NOW);
    expect(ranked.map(r => r.agentUserId)).toEqual([A]);
    expect(rankAgents(facts, [cand(A)], [lic(A, { jurisdiction: "NSW" })], NOW)).toEqual([]);
    expect(rankAgents(facts, [cand(A)], [lic(A, { status: "pending" })], NOW)).toEqual([]);
  });

  it("breaks ties by spare capacity, then by id", () => {
    const ranked = rankAgents(facts, [cand(B, {}, 2), cand(A, {}, 2), cand(C, {}, 0)], [lic(A), lic(B), lic(C)], NOW);
    expect(ranked.map(r => r.agentUserId)).toEqual([C, A, B]);
  });
});

describe("parseAgentProfile", () => {
  it("normalises and de-duplicates lists", () => {
    expect(parseAgentProfile({ servicePostcodes: ["4005", " 4005 "], serviceSuburbs: ["New Farm", "new farm"], transactionTypes: ["sale"], bio: "  Hi " }))
      .toEqual({ ok: true, value: { ...DEFAULT_AGENT_PROFILE, servicePostcodes: ["4005"], serviceSuburbs: ["new farm"], transactionTypes: ["sale"], bio: "Hi" } });
  });
  it("refuses bad values", () => {
    for (const bad of [null, { acceptingNew: "yes" }, { maxActiveListings: 0 }, { maxActiveListings: 2.5 }, { servicePostcodes: ["400"] },
      { serviceSuburbs: [""] }, { transactionTypes: ["auction"] }, { useClasses: ["industrial"] }, { propertyTypes: ["castle"] }, { bio: "x".repeat(1001) },
      { servicePostcodes: Array.from({ length: 201 }, (_, i) => String(4000 + i)) }]) {
      expect(parseAgentProfile(bad)).toMatchObject({ ok: false, code: "invalid" });
    }
  });
});

describe("suggestions and automatic assignment", () => {
  const setup = () => {
    const matching = createInMemoryAgentMatchingRepository({
      listings: [{ id: L, ...facts }],
      agents: [
        { userId: A, displayName: "Amy", profile: profile({ servicePostcodes: ["4005"] }) },
        { userId: B, displayName: "Ben", profile: profile() },
        { userId: C, displayName: "Cal", profile: profile({ servicePostcodes: ["4005"] }), status: "suspended" }
      ],
      licences: [lic(A), lic(B), lic(C)]
    });
    const appointments = createInMemoryAgentAppointmentRepository({
      listings: [{ id: L, ownerUserId: owner.userId, jurisdiction: "QLD", title: "House" }],
      users: [
        { id: A, userType: "agent", status: "active", displayName: "Amy" },
        { id: B, userType: "agent", status: "active", displayName: "Ben" }
      ],
      licences: [lic(A), lic(B)]
    });
    return { matching, appointments };
  };

  it("only the owner gets suggestions; suspended agents are not candidates", async () => {
    const { matching } = setup();
    expect(await suggestAgents(matching, { userId: A, userType: "agent" }, L, NOW)).toMatchObject({ ok: false, code: "not_found" });
    const r = await suggestAgents(matching, owner, L, NOW);
    expect(r.ok && r.value.map(s => s.displayName)).toEqual(["Amy", "Ben"]);
  });

  it("invite_best invites the top agent not already invited, as an invitation the agent must accept", async () => {
    const { matching, appointments } = setup();
    const first = await inviteBestAgent(matching, appointments, owner, L, { scope: "enquiries_and_offers", permissions: ["enquiries.handle"] }, ids);
    expect(first).toMatchObject({ ok: true, value: { invite: { agentUserId: A, status: "proposed", permissions: ["enquiries.handle"] }, suggestion: { reasons: ["postcode", "capacity"] } } });
    expect(appointments.appointments).toEqual([]);
    const second = await inviteBestAgent(matching, appointments, owner, L, {}, ids);
    expect(second).toMatchObject({ ok: true, value: { invite: { agentUserId: B } } });
    expect(await inviteBestAgent(matching, appointments, owner, L, {}, ids)).toMatchObject({ ok: false, code: "conflict" });
  });

  it("agent profile is agent-only and audited on save", async () => {
    const { matching } = setup();
    expect(await getAgentProfile(matching, owner)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await saveAgentProfile(matching, { userId: D, userType: "agent" }, { servicePostcodes: ["4000"] }, ids)).toMatchObject({ ok: true });
    expect(await getAgentProfile(matching, { userId: D, userType: "agent" })).toMatchObject({ ok: true, value: { servicePostcodes: ["4000"] } });
    expect(matching.audits.map(a => a.eventType)).toEqual(["agent_profile.saved"]);
  });
});
