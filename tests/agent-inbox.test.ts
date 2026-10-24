import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentInbox, type AgentInboxDeps, type AgentListingItem } from "../src/domain/agent-inbox";
import type { AgentLicence } from "../src/domain/licence";
import type { Actor } from "../src/domain/listing-service";

const state = vi.hoisted(() => ({ actor: null as Actor | null, deps: null as AgentInboxDeps | null }));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor }));
vi.mock("../src/server/agent-inbox-db", () => ({ getAgentInboxDeps: () => state.deps }));

import * as route from "../app/api/agent/listings/route";

const agent: Actor = { userId: "a1", userType: "agent" };
const row = (id: string, o: Partial<AgentListingItem> = {}): AgentListingItem =>
  ({ listingId: id, title: `T${id}`, jurisdiction: "QLD", status: "published", appointedAt: "2026-10-01T00:00:00.000Z", enquiries: 1, unread: 0, ...o });
const licence = (o: Partial<AgentLicence> = {}): AgentLicence => ({ userId: "a1", jurisdiction: "QLD", status: "verified", ...o });

function deps(rows: AgentListingItem[], licences: AgentLicence[], calls: string[] = []): AgentInboxDeps {
  return {
    appointedListings: async id => { calls.push(id); return rows; },
    licences: async () => licences,
    today: () => "2026-10-24"
  };
}

describe("agentInbox", () => {
  it("lists appointed listings unread-first, then newest appointment", async () => {
    const r = await agentInbox(deps([row("1"), row("2", { unread: 3 }), row("3", { appointedAt: "2026-10-10T00:00:00.000Z" })], [licence()]), agent);
    expect(r.ok && r.value.map(i => i.listingId)).toEqual(["2", "3", "1"]);
  });

  it("is forbidden for owners and buyers, without reading any data", async () => {
    const calls: string[] = [];
    for (const userType of ["owner", "buyer"] as const) {
      const r = await agentInbox(deps([row("1")], [licence()], calls), { userId: "a1", userType });
      expect(r).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(calls).toEqual([]);
  });

  it("is forbidden without a verified licence: none, pending, revoked, expired, or someone else's", async () => {
    const cases: AgentLicence[][] = [
      [], [licence({ status: "pending" })], [licence({ status: "revoked" })],
      [licence({ expiresAt: "2026-10-23" })], [licence({ userId: "someone-else" })]
    ];
    for (const ls of cases) {
      const calls: string[] = [];
      expect(await agentInbox(deps([row("1")], ls, calls), agent)).toMatchObject({ ok: false, code: "forbidden" });
      expect(calls).toEqual([]);
    }
  });

  it("accepts a licence that expires today and hides listings in states the agent is not licensed in", async () => {
    const r = await agentInbox(deps([row("1"), row("2", { jurisdiction: "NSW" })], [licence({ expiresAt: "2026-10-24" })]), agent);
    expect(r.ok && r.value.map(i => i.listingId)).toEqual(["1"]);
  });

  it("returns an empty list for a licensed agent with no appointments", async () => {
    expect(await agentInbox(deps([], [licence()]), agent)).toEqual({ ok: true, value: [] });
  });
});

describe("GET /api/agent/listings", () => {
  beforeEach(() => { state.actor = null; state.deps = deps([row("1", { unread: 2 })], [licence()]); });
  const get = () => route.GET(new Request("http://test/api/agent/listings"));

  it("exports GET only", () => { expect(Object.keys(route)).toEqual(["GET"]); });
  it("401 when signed out", async () => { expect((await get()).status).toBe(401); });
  it("403 for owner and buyer", async () => {
    for (const userType of ["owner", "buyer"] as const) { state.actor = { userId: "x", userType }; expect((await get()).status).toBe(403); }
  });
  it("403 for an agent without a verified licence", async () => {
    state.actor = agent; state.deps = deps([row("1")], [licence({ status: "pending" })]);
    expect((await get()).status).toBe(403);
  });
  it("200 with the agent's listings", async () => {
    state.actor = agent;
    const res = await get();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { listings: AgentListingItem[] }).listings).toMatchObject([{ listingId: "1", unread: 2 }]);
  });
});
