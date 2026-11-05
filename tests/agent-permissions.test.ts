import { describe, expect, it } from "vitest";
import { agentMay, agentPermissions, canActOnListing, SCOPE_PERMISSIONS, type AgentAppointment } from "../src/domain/access";
import {
  createInMemoryAgentAppointmentRepository, inviteAgent, ownerAgentView, parsePermissions, respondToInvite, setAgentPermissions, agentAppointments
} from "../src/domain/agent-appointment-service";
import type { PropertyListing } from "../src/domain/listing";
import type { Actor } from "../src/domain/listing-service";

const L = "55555555-5555-4555-8555-555555555555";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const agent: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "agent" };
let n = 0;
const ids = { newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, now: () => "2026-10-25T00:00:00.000Z" };
const appt = (over: Partial<AgentAppointment> = {}): AgentAppointment => ({ listingId: L, agentUserId: agent.userId, scope: "enquiries_and_offers", revoked: false, ...over });

describe("agent permission model", () => {
  it("scopes are roles: full adds publishing, and offer decisions are never a permission", () => {
    expect(SCOPE_PERMISSIONS.enquiries_and_offers).not.toContain("listing.publish");
    expect(SCOPE_PERMISSIONS.full).toContain("listing.publish");
    expect(JSON.stringify(SCOPE_PERMISSIONS)).not.toMatch(/approve|accept|decision|contract/);
  });

  it("no list means the whole scope; a list narrows it and can never widen it", () => {
    expect(agentPermissions(appt())).toEqual(SCOPE_PERMISSIONS.enquiries_and_offers);
    expect(agentPermissions(appt({ permissions: ["offers.view"] }))).toEqual(["offers.view"]);
    expect(agentPermissions(appt({ permissions: ["offers.view", "listing.publish"] }))).toEqual(["offers.view"]);
  });

  it("agentMay is false when revoked or for another listing or agent", () => {
    expect(agentMay(appt(), L, agent.userId, "offers.view")).toBe(true);
    expect(agentMay(appt({ revoked: true }), L, agent.userId, "offers.view")).toBe(false);
    expect(agentMay(appt(), "other", agent.userId, "offers.view")).toBe(false);
    expect(agentMay(appt(), L, owner.userId, "offers.view")).toBe(false);
  });

  it("publishing through canActOnListing follows the granted list", () => {
    const listing = { id: L, ownerUserId: owner.userId } as PropertyListing;
    const actor = { id: agent.userId, role: "agent" as const };
    expect(canActOnListing(actor, listing, "listing.publish", appt({ scope: "full" }))).toBe(true);
    expect(canActOnListing(actor, listing, "listing.publish", appt({ scope: "full", permissions: ["enquiries.handle"] }))).toBe(false);
    expect(canActOnListing(actor, listing, "listing.publish", appt())).toBe(false);
    expect(canActOnListing(actor, listing, "offer.approve", appt({ scope: "full" }))).toBe(false);
  });

  it("parsePermissions refuses unknown, empty and out-of-scope lists and returns canonical order", () => {
    expect(parsePermissions(undefined, "full")).toEqual({ ok: true, value: undefined });
    expect(parsePermissions(["offers.view", "enquiries.handle", "offers.view"], "enquiries_and_offers")).toEqual({ ok: true, value: ["enquiries.handle", "offers.view"] });
    for (const bad of [[], ["offer.approve"], "offers.view", [1]]) expect(parsePermissions(bad, "full")).toMatchObject({ ok: false, code: "invalid" });
    expect(parsePermissions(["listing.publish"], "enquiries_and_offers")).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("owner manages an agent's permissions", () => {
  const seed = () => createInMemoryAgentAppointmentRepository({
    listings: [{ id: L, ownerUserId: owner.userId, jurisdiction: "QLD", title: "House" }],
    users: [
      { id: owner.userId, userType: "owner", status: "active", displayName: "Olive" },
      { id: agent.userId, userType: "agent", status: "active", email: "amy@agency.test", displayName: "Amy" }
    ],
    licences: [{ userId: agent.userId, jurisdiction: "QLD", status: "verified" }]
  });

  it("permissions chosen at invite carry into the appointment and show to both sides", async () => {
    const repo = seed();
    const inv = await inviteAgent(repo, owner, L, { email: "amy@agency.test", scope: "full", permissions: ["listing.publish", "enquiries.handle"] }, ids);
    expect(inv).toMatchObject({ ok: true, value: { permissions: ["enquiries.handle", "listing.publish"] } });
    if (!inv.ok) return;
    expect(await agentAppointments(repo, agent, ids.now())).toMatchObject({ ok: true, value: [{ kind: "invite", granted: ["enquiries.handle", "listing.publish"] }] });
    const acc = await respondToInvite(repo, agent, inv.value.id, { action: "accept" }, ids);
    expect(acc).toMatchObject({ ok: true, value: { appointment: { permissions: ["enquiries.handle", "listing.publish"] } } });
    expect(await ownerAgentView(repo, owner, L, ids.now())).toMatchObject({ ok: true, value: { active: { granted: ["enquiries.handle", "listing.publish"] } } });
  });

  it("refuses an invite whose permissions exceed the scope", async () => {
    expect(await inviteAgent(seed(), owner, L, { email: "amy@agency.test", permissions: ["listing.publish"] }, ids)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("owner changes permissions on the active appointment; audited; agent and strangers cannot", async () => {
    const repo = seed();
    const inv = await inviteAgent(repo, owner, L, { email: "amy@agency.test" }, ids);
    if (!inv.ok) throw new Error("setup");
    const acc = await respondToInvite(repo, agent, inv.value.id, { action: "accept" }, ids);
    if (!acc.ok || !acc.value.appointment) throw new Error("setup");
    const id = acc.value.appointment.id;
    expect(await setAgentPermissions(repo, agent, id, { permissions: ["offers.view"] }, ids)).toMatchObject({ ok: false, code: "not_found" });
    expect(await setAgentPermissions(repo, owner, id, { permissions: [] }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await setAgentPermissions(repo, owner, id, {}, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await setAgentPermissions(repo, owner, id, { permissions: ["listing.publish"] }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await setAgentPermissions(repo, owner, id, { permissions: ["offers.view"] }, ids)).toMatchObject({ ok: true, value: { permissions: ["offers.view"] } });
    const ev = repo.audits.at(-1)!;
    expect(ev.eventType).toBe("agent_appointment.permissions_changed");
    expect(ev.payload).toMatchObject({ from: ["enquiries.handle", "offer_links.issue", "offers.view", "listing.describe"], to: ["offers.view"] });
  });
});
