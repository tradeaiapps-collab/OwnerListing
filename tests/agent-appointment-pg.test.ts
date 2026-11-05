import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inviteAgent, ownerAgentView, respondToInvite, revokeAppointment, agentAppointments, setAgentPermissions } from "../src/domain/agent-appointment-service";
import type { Actor } from "../src/domain/listing-service";
import { createPgAgentAppointmentRepository } from "../src/server/agent-appointment-db";
import { appointmentForPg } from "../src/server/db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("agent appointments on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };
  const licence = (userId: string, jurisdiction = "QLD") => t.db.query(
    "INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,$2,'L-1','verified',$1, now())",
    [userId, jurisdiction]
  );
  const setup = async () => {
    const ownerId = await addUser(t.db, "owner");
    const a1 = await addUser(t.db, "agent");
    const a2 = await addUser(t.db, "agent");
    await licence(a1); await licence(a2);
    const listingId = await addListing(t.db, ownerId, { jurisdiction: "QLD", title: "Queenslander" });
    const owner: Actor = { userId: ownerId, userType: "owner" };
    return { owner, agent1: { userId: a1, userType: "agent" } as Actor, agent2: { userId: a2, userType: "agent" } as Actor, listingId,
      repo: createPgAgentAppointmentRepository(t.db) };
  };
  const audits = async (eventType: string) =>
    Number((await t.db.query("SELECT count(*) AS n FROM audit_event WHERE event_type = $1 AND aggregate_type = 'agent_appointment'", [eventType])).rows[0]!["n"]);

  it("invite -> accept -> revoke, with access following the appointment and an audit row per step", async () => {
    const { owner, agent1, agent2, listingId, repo } = await setup();
    const before = await audits("agent_appointment.accepted");
    const inv = await inviteAgent(repo, owner, listingId, { agentUserId: agent1.userId, scope: "full" }, ids);
    const other = await inviteAgent(repo, owner, listingId, { agentUserId: agent2.userId }, ids);
    if (!inv.ok || !other.ok) throw new Error(JSON.stringify([inv, other]));
    expect(await appointmentForPg(t.db, listingId, agent1.userId)).toBeUndefined();

    const acc = await respondToInvite(repo, agent1, inv.value.id, { action: "accept" }, ids);
    if (!acc.ok || !acc.value.appointment) throw new Error(JSON.stringify(acc));
    expect(await appointmentForPg(t.db, listingId, agent1.userId)).toMatchObject({ scope: "full", revoked: false });
    expect((await repo.getInvite(other.value.id))?.status).toBe("withdrawn");
    expect(await audits("agent_appointment.accepted")).toBe(before + 1);

    const view = await ownerAgentView(repo, owner, listingId, ids.now());
    expect(view).toMatchObject({ ok: true, value: { active: { agentUserId: agent1.userId, licensed: true, agentName: "Test agent" }, invites: [] } });
    expect(await agentAppointments(repo, agent1, ids.now())).toMatchObject({ ok: true, value: [{ kind: "appointment", listingTitle: "Queenslander" }] });

    expect(await revokeAppointment(repo, owner, acc.value.appointment.id, ids)).toMatchObject({ ok: true });
    expect(await appointmentForPg(t.db, listingId, agent1.userId)).toBeUndefined();
    const row = (await t.db.query("SELECT revoked_by FROM listing_agent_appointment WHERE id = $1", [acc.value.appointment.id])).rows[0]!;
    expect(String(row["revoked_by"])).toBe(owner.userId);
  });

  it("two accepted invitations cannot both become active on one listing", async () => {
    const { owner, agent1, agent2, listingId, repo } = await setup();
    const a = await inviteAgent(repo, owner, listingId, { agentUserId: agent1.userId }, ids);
    const b = await inviteAgent(repo, owner, listingId, { agentUserId: agent2.userId }, ids);
    if (!a.ok || !b.ok) throw new Error("setup");
    const results = await Promise.all([
      respondToInvite(repo, agent1, a.value.id, { action: "accept" }, ids),
      respondToInvite(repo, agent2, b.value.id, { action: "accept" }, ids)
    ]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const n = (await t.db.query("SELECT count(*) AS n FROM listing_agent_appointment WHERE listing_id = $1 AND revoked_at IS NULL", [listingId])).rows[0]!["n"];
    expect(Number(n)).toBe(1);
  });

  it("the SQL guards refuse a non-owner invite, a non-agent invitee and a duplicate open invite", async () => {
    const { owner, agent1, listingId, repo } = await setup();
    const buyer = await addUser(t.db, "buyer");
    const base = { id: randomUUID(), listingId, ownerUserId: owner.userId, agentUserId: agent1.userId, scope: "enquiries_and_offers" as const,
      status: "proposed" as const, createdAt: ids.now() };
    const ev = () => ({ id: randomUUID(), occurredAt: ids.now(), actorType: "user" as const, actorId: owner.userId, aggregateType: "agent_appointment",
      aggregateId: randomUUID(), eventType: "agent_appointment.invited", correlationId: randomUUID(), payload: {} });
    expect(await repo.insertInvite({ ...base, ownerUserId: agent1.userId }, ev())).toBe(false);
    expect(await repo.insertInvite({ ...base, id: randomUUID(), agentUserId: buyer }, ev())).toBe(false);
    expect(await repo.insertInvite(base, ev())).toBe(true);
    expect(await repo.insertInvite({ ...base, id: randomUUID() }, ev())).toBe(false);
  });

  it("invitations and appointments cannot be deleted", async () => {
    const { owner, agent1, listingId, repo } = await setup();
    const inv = await inviteAgent(repo, owner, listingId, { agentUserId: agent1.userId }, ids);
    if (!inv.ok) throw new Error("setup");
    await respondToInvite(repo, agent1, inv.value.id, { action: "accept" }, ids);
    await expect(t.db.query("DELETE FROM agent_appointment_invite WHERE id = $1", [inv.value.id])).rejects.toThrow(/permanent record/);
    await expect(t.db.query("DELETE FROM listing_agent_appointment WHERE listing_id = $1", [listingId])).rejects.toThrow(/permanent record/);
  });
});

describe.skipIf(!DATABASE_URL)("agent permissions on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };

  it("stores the owner's list on invite and appointment, exposes it to access checks, and lets the owner change it", async () => {
    const owner: Actor = { userId: await addUser(t.db, "owner"), userType: "owner" };
    const agent: Actor = { userId: await addUser(t.db, "agent"), userType: "agent" };
    await t.db.query("INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,'QLD','L-1','verified',$1, now())", [agent.userId]);
    const listingId = await addListing(t.db, owner.userId, { jurisdiction: "QLD" });
    const repo = createPgAgentAppointmentRepository(t.db);
    const inv = await inviteAgent(repo, owner, listingId, { agentUserId: agent.userId, scope: "full", permissions: ["enquiries.handle", "listing.publish"] }, ids);
    if (!inv.ok) throw new Error(JSON.stringify(inv));
    expect((await repo.getInvite(inv.value.id))?.permissions).toEqual(["enquiries.handle", "listing.publish"]);
    const acc = await respondToInvite(repo, agent, inv.value.id, { action: "accept" }, ids);
    if (!acc.ok || !acc.value.appointment) throw new Error(JSON.stringify(acc));
    expect(await appointmentForPg(t.db, listingId, agent.userId)).toMatchObject({ scope: "full", permissions: ["enquiries.handle", "listing.publish"] });
    expect(await setAgentPermissions(repo, owner, acc.value.appointment.id, { permissions: ["offers.view"] }, ids)).toMatchObject({ ok: true });
    expect((await appointmentForPg(t.db, listingId, agent.userId))?.permissions).toEqual(["offers.view"]);
    expect(Number((await t.db.query("SELECT count(*) AS n FROM audit_event WHERE aggregate_id = $1 AND event_type = 'agent_appointment.permissions_changed'",
      [acc.value.appointment.id])).rows[0]!["n"])).toBe(1);
  });

  it("the database refuses unknown permissions, an empty list and publishing without the full scope", async () => {
    const owner = await addUser(t.db, "owner");
    const agent = await addUser(t.db, "agent");
    const listingId = await addListing(t.db, owner);
    const ins = (scope: string, perms: string[]) => t.db.query(
      "INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, scope, permissions, revoked_at) VALUES ($1,$2,$3,$4,$5::text[], now())",
      [listingId, agent, owner, scope, perms]);
    await expect(ins("full", ["offer.approve"])).rejects.toThrow(/agent_appointment_permissions_known/);
    await expect(ins("full", [])).rejects.toThrow(/agent_appointment_permissions_known/);
    await expect(ins("enquiries_and_offers", ["listing.publish"])).rejects.toThrow(/agent_appointment_publish_needs_full/);
    await ins("full", ["listing.publish"]);
  });
});
