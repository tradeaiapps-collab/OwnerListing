import { beforeEach, describe, expect, it } from "vitest";
import {
  agentAppointments, createInMemoryAgentAppointmentRepository, inviteAgent, ownerAgentView, respondToInvite, revokeAppointment
} from "../src/domain/agent-appointment-service";
import type { Actor } from "../src/domain/listing-service";

const LISTING = "55555555-5555-4555-8555-555555555555";
const OTHER_LISTING = "66666666-6666-4666-8666-666666666666";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const agent: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "agent" };
const agent2: Actor = { userId: "77777777-7777-4777-8777-777777777777", userType: "agent" };
const unlicensed: Actor = { userId: "88888888-8888-4888-8888-888888888888", userType: "agent" };
const stranger: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "owner" };

let n = 0;
const ids = { newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, now: () => "2026-10-25T00:00:00.000Z" };

const seed = () => createInMemoryAgentAppointmentRepository({
  listings: [
    { id: LISTING, ownerUserId: owner.userId, jurisdiction: "QLD", title: "House" },
    { id: OTHER_LISTING, ownerUserId: stranger.userId, jurisdiction: "QLD", title: "Other" }
  ],
  users: [
    { id: owner.userId, userType: "owner", status: "active", displayName: "Olive" },
    { id: agent.userId, userType: "agent", status: "active", email: "amy@agency.test", displayName: "Amy" },
    { id: agent2.userId, userType: "agent", status: "active", email: "ben@agency.test", displayName: "Ben" },
    { id: unlicensed.userId, userType: "agent", status: "active", email: "cal@agency.test", displayName: "Cal" },
    { id: stranger.userId, userType: "owner", status: "active", email: "sam@example.test", displayName: "Sam" },
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", userType: "agent", status: "suspended", email: "sus@agency.test" }
  ],
  licences: [
    { userId: agent.userId, jurisdiction: "QLD", status: "verified", expiresAt: "2027-01-01" },
    { userId: agent2.userId, jurisdiction: "QLD", status: "verified" },
    { userId: unlicensed.userId, jurisdiction: "NSW", status: "verified" }
  ]
});

describe("agent appointment service", () => {
  let repo: ReturnType<typeof seed>;
  beforeEach(() => { repo = seed(); });

  const invite = async (body: Record<string, unknown>, who = owner, listing = LISTING) => inviteAgent(repo, who, listing, body, ids);

  it("owner invites by email with the default scope; nothing is granted until the agent accepts", async () => {
    const r = await invite({ email: " AMY@agency.test " });
    expect(r).toMatchObject({ ok: true, value: { agentUserId: agent.userId, scope: "enquiries_and_offers", status: "proposed" } });
    expect(repo.appointments).toEqual([]);
    expect(repo.audits.map(a => a.eventType)).toEqual(["agent_appointment.invited"]);
  });

  it("only the listing owner can invite, and non-owners get 404", async () => {
    expect(await invite({ email: "amy@agency.test" }, stranger)).toMatchObject({ ok: false, code: "not_found" });
    expect(await invite({ email: "amy@agency.test" }, agent)).toMatchObject({ ok: false, code: "not_found" });
    expect(await invite({ email: "amy@agency.test" }, owner, "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses non-agent, suspended, unknown and self invitations with one generic message", async () => {
    const msgs = new Set<string>();
    for (const body of [{ email: "sam@example.test" }, { email: "sus@agency.test" }, { email: "nobody@x.test" }, { agentUserId: owner.userId }]) {
      const r = await invite(body);
      expect(r).toMatchObject({ ok: false, code: "invalid" });
      if (!r.ok) msgs.add(r.message);
    }
    expect(msgs.size).toBe(1);
  });

  it("validates input: exactly one of agentUserId or email, and a known scope", async () => {
    expect(await invite({})).toMatchObject({ ok: false, code: "invalid" });
    expect(await invite({ email: "amy@agency.test", agentUserId: agent.userId })).toMatchObject({ ok: false, code: "invalid" });
    expect(await invite({ email: "amy@agency.test", scope: "everything" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await inviteAgent(repo, owner, LISTING, null, ids)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("rejects a second open invitation to the same agent", async () => {
    await invite({ email: "amy@agency.test" });
    expect(await invite({ agentUserId: agent.userId })).toMatchObject({ ok: false, code: "conflict" });
  });

  it("agent accepts: appointment created with the invited scope, other open invites withdrawn, audited", async () => {
    const a = await invite({ email: "amy@agency.test", scope: "full" });
    const b = await invite({ email: "ben@agency.test" });
    if (!a.ok || !b.ok) throw new Error("setup");
    const r = await respondToInvite(repo, agent, a.value.id, { action: "accept" }, ids);
    expect(r).toMatchObject({ ok: true, value: { invite: { status: "accepted" }, appointment: { agentUserId: agent.userId, scope: "full" } } });
    expect(repo.invites.find(i => i.id === b.value.id)?.status).toBe("withdrawn");
    expect(repo.audits.at(-1)?.eventType).toBe("agent_appointment.accepted");
    expect(await respondToInvite(repo, agent2, b.value.id, { action: "accept" }, ids)).toMatchObject({ ok: false, code: "conflict" });
  });

  it("refuses new invitations while an agent is active", async () => {
    const a = await invite({ email: "amy@agency.test" });
    if (!a.ok) throw new Error("setup");
    await respondToInvite(repo, agent, a.value.id, { action: "accept" }, ids);
    expect(await invite({ email: "ben@agency.test" })).toMatchObject({ ok: false, code: "conflict" });
  });

  it("an agent without a verified licence for the listing's state cannot accept (shown as blocked to the owner)", async () => {
    const r = await invite({ email: "cal@agency.test" });
    if (!r.ok) throw new Error("setup");
    const view = await ownerAgentView(repo, owner, LISTING, ids.now());
    expect(view).toMatchObject({ ok: true, value: { active: null, invites: [{ agentName: "Cal", licensed: false }] } });
    expect(await respondToInvite(repo, unlicensed, r.value.id, { action: "accept" }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect(repo.appointments).toEqual([]);
  });

  it("an expired licence (judged on the state's local date) blocks accepting", async () => {
    const r = await invite({ email: "amy@agency.test" });
    if (!r.ok) throw new Error("setup");
    const later = { ...ids, now: () => "2027-01-01T14:30:00.000Z" }; // already 2 Jan in Brisbane
    expect(await respondToInvite(repo, agent, r.value.id, { action: "accept" }, later)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("only the invited agent may accept or decline, and only the owner may withdraw", async () => {
    const r = await invite({ email: "amy@agency.test" });
    if (!r.ok) throw new Error("setup");
    const id = r.value.id;
    expect(await respondToInvite(repo, agent2, id, { action: "accept" }, ids)).toMatchObject({ ok: false, code: "not_found" });
    expect(await respondToInvite(repo, owner, id, { action: "accept" }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await respondToInvite(repo, agent, id, { action: "withdraw" }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await respondToInvite(repo, agent, id, { action: "bogus" }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await respondToInvite(repo, agent, id, { action: "decline" }, ids)).toMatchObject({ ok: true, value: { invite: { status: "declined" } } });
    expect(await respondToInvite(repo, agent, id, { action: "accept" }, ids)).toMatchObject({ ok: false, code: "conflict" });
    const again = await invite({ email: "amy@agency.test" });
    if (!again.ok) throw new Error("re-invite after decline");
    expect(await respondToInvite(repo, owner, again.value.id, { action: "withdraw" }, ids)).toMatchObject({ ok: true, value: { invite: { status: "withdrawn" } } });
  });

  it("owner revokes: the appointment ends at once, is audited, and cannot be revoked twice; others get 404", async () => {
    const r = await invite({ email: "amy@agency.test" });
    if (!r.ok) throw new Error("setup");
    const acc = await respondToInvite(repo, agent, r.value.id, { action: "accept" }, ids);
    if (!acc.ok || !acc.value.appointment) throw new Error("setup");
    const appointmentId = acc.value.appointment.id;
    expect(await revokeAppointment(repo, agent, appointmentId, ids)).toMatchObject({ ok: false, code: "not_found" });
    expect(await revokeAppointment(repo, stranger, appointmentId, ids)).toMatchObject({ ok: false, code: "not_found" });
    expect(await revokeAppointment(repo, owner, appointmentId, ids)).toMatchObject({ ok: true, value: { revokedAt: ids.now() } });
    expect(repo.audits.at(-1)?.eventType).toBe("agent_appointment.revoked");
    expect(await revokeAppointment(repo, owner, appointmentId, ids)).toMatchObject({ ok: false, code: "conflict" });
    expect(await repo.activeForListing(LISTING)).toBeUndefined();
    expect(await invite({ email: "ben@agency.test" })).toMatchObject({ ok: true });
  });

  it("agent list shows invitations first, then active appointments, with licence status; non-agents are refused", async () => {
    const a = await invite({ email: "amy@agency.test" });
    if (!a.ok) throw new Error("setup");
    let list = await agentAppointments(repo, agent, ids.now());
    expect(list).toMatchObject({ ok: true, value: [{ kind: "invite", listingTitle: "House", ownerName: "Olive", licensed: true }] });
    await respondToInvite(repo, agent, a.value.id, { action: "accept" }, ids);
    list = await agentAppointments(repo, agent, ids.now());
    expect(list).toMatchObject({ ok: true, value: [{ kind: "appointment", scope: "enquiries_and_offers" }] });
    expect(await agentAppointments(repo, owner, ids.now())).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("owner view is owner-only", async () => {
    expect(await ownerAgentView(repo, stranger, LISTING, ids.now())).toMatchObject({ ok: false, code: "not_found" });
    expect(await ownerAgentView(repo, owner, LISTING, ids.now())).toEqual({ ok: true, value: { active: null, invites: [] } });
  });
});
