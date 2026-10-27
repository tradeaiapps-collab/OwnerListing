import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryAgentAppointmentRepository, type AgentAppointmentRepository } from "../src/domain/agent-appointment-service";
import type { Actor } from "../src/domain/listing-service";

const state = vi.hoisted(() => ({ actor: null as Actor | null, repo: null as AgentAppointmentRepository | null }));

vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => ({}) }));
vi.mock("../src/server/agent-appointment-db", () => {
  let n = 0;
  return {
    getAgentAppointmentRepo: () => state.repo,
    appointmentIds: { newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, now: () => "2026-10-25T00:00:00.000Z" }
  };
});

import * as listingRoute from "../app/api/listings/[id]/agent-appointments/route";
import * as inviteRoute from "../app/api/agent-invites/[id]/route";
import * as appointmentRoute from "../app/api/agent-appointments/[id]/route";
import * as mineRoute from "../app/api/agent/appointments/route";
process.env["APP_URL"] = "http://test";

const LISTING = "55555555-5555-4555-8555-555555555555";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const agent: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "agent" };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (url: string, body: unknown, origin = "http://test") =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });

describe("agent appointment routes", () => {
  beforeEach(() => {
    state.repo = createInMemoryAgentAppointmentRepository({
      listings: [{ id: LISTING, ownerUserId: owner.userId, jurisdiction: "QLD", title: "House" }],
      users: [
        { id: owner.userId, userType: "owner", status: "active", displayName: "Olive" },
        { id: agent.userId, userType: "agent", status: "active", email: "amy@agency.test", displayName: "Amy" }
      ],
      licences: [{ userId: agent.userId, jurisdiction: "QLD", status: "verified" }]
    });
    state.actor = owner;
  });

  it("returns 401 for every route when signed out", async () => {
    state.actor = null;
    expect((await listingRoute.GET(new Request("http://test/x"), ctx(LISTING))).status).toBe(401);
    expect((await listingRoute.POST(post("http://test/x", {}), ctx(LISTING))).status).toBe(401);
    expect((await inviteRoute.POST(post("http://test/x", {}), ctx("x"))).status).toBe(401);
    expect((await appointmentRoute.POST(post("http://test/x", { action: "revoke" }), ctx("x"))).status).toBe(401);
    expect((await mineRoute.GET(new Request("http://test/x"))).status).toBe(401);
  });

  it("rejects a cross-site POST before doing anything", async () => {
    expect((await listingRoute.POST(post("http://test/x", { email: "amy@agency.test" }, "http://evil.test"), ctx(LISTING))).status).toBe(403);
  });

  it("runs invite -> accept -> revoke over HTTP", async () => {
    const inv = await listingRoute.POST(post("http://test/x", { email: "amy@agency.test", scope: "full" }), ctx(LISTING));
    expect(inv.status).toBe(201);
    const { invite } = await inv.json();

    state.actor = agent;
    const list = await (await mineRoute.GET(new Request("http://test/x"))).json();
    expect(list.items).toMatchObject([{ kind: "invite", id: invite.id, licensed: true }]);
    const acc = await inviteRoute.POST(post("http://test/x", { action: "accept" }), ctx(invite.id));
    expect(acc.status).toBe(200);
    const { appointment } = await acc.json();
    expect((await appointmentRoute.POST(post("http://test/x", { action: "revoke" }), ctx(appointment.id))).status).toBe(404);

    state.actor = owner;
    const view = await (await listingRoute.GET(new Request("http://test/x"), ctx(LISTING))).json();
    expect(view.active).toMatchObject({ agentName: "Amy", scope: "full" });
    expect(JSON.stringify(view)).not.toContain("amy@agency.test");
    expect((await appointmentRoute.POST(post("http://test/x", { action: "delete" }), ctx(appointment.id))).status).toBe(400);
    expect((await appointmentRoute.POST(post("http://test/x", { action: "revoke" }), ctx(appointment.id))).status).toBe(200);
  });

  it("maps a second open invitation to 409", async () => {
    await listingRoute.POST(post("http://test/x", { email: "amy@agency.test" }), ctx(LISTING));
    expect((await listingRoute.POST(post("http://test/x", { email: "amy@agency.test" }), ctx(LISTING))).status).toBe(409);
  });
});
