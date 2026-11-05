import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inviteAgent, respondToInvite, revokeAppointment } from "../src/domain/agent-appointment-service";
import { readAgentConversation, sendAgentMessage } from "../src/domain/agent-messages";
import type { Actor } from "../src/domain/listing-service";
import { createPgAgentAppointmentRepository } from "../src/server/agent-appointment-db";
import { createPgAgentMessageRepository } from "../src/server/agent-message-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("owner-agent messages on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };

  it("stores messages for an active appointment, refuses them after revoke, and never allows edit or delete", async () => {
    const owner: Actor = { userId: await addUser(t.db, "owner"), userType: "owner" };
    const agent: Actor = { userId: await addUser(t.db, "agent"), userType: "agent" };
    const stranger: Actor = { userId: await addUser(t.db, "agent"), userType: "agent" };
    await t.db.query("INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,'QLD','L-1','verified',$1, now())", [agent.userId]);
    const listingId = await addListing(t.db, owner.userId, { jurisdiction: "QLD" });
    const appts = createPgAgentAppointmentRepository(t.db);
    const inv = await inviteAgent(appts, owner, listingId, { agentUserId: agent.userId }, ids);
    if (!inv.ok) throw new Error("invite");
    const acc = await respondToInvite(appts, agent, inv.value.id, { action: "accept" }, ids);
    if (!acc.ok || !acc.value.appointment) throw new Error("accept");
    const id = acc.value.appointment.id;
    const repo = createPgAgentMessageRepository(t.db);

    expect(await sendAgentMessage(repo, owner, id, { body: "Hello" }, ids)).toMatchObject({ ok: true });
    expect(await sendAgentMessage(repo, agent, id, { body: "Hi there" }, ids)).toMatchObject({ ok: true });
    expect(await repo.insertMessage({ id: randomUUID(), appointmentId: id, senderUserId: stranger.userId, body: "x", sentAt: ids.now() })).toBe(false);
    const conv = await readAgentConversation(repo, agent, id);
    expect(conv).toMatchObject({ ok: true, value: { counterpartName: "Test owner", messages: [{ body: "Hello", mine: false }, { body: "Hi there", mine: true }] } });

    await expect(t.db.query("UPDATE agent_message SET body = 'changed' WHERE appointment_id = $1", [id])).rejects.toThrow(/permanent record/);
    await expect(t.db.query("DELETE FROM agent_message WHERE appointment_id = $1", [id])).rejects.toThrow(/permanent record/);

    await revokeAppointment(appts, owner, id, ids);
    expect(await repo.insertMessage({ id: randomUUID(), appointmentId: id, senderUserId: owner.userId, body: "x", sentAt: ids.now() })).toBe(false);
    expect(await readAgentConversation(repo, agent, id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await readAgentConversation(repo, owner, id)).toMatchObject({ ok: true, value: { open: false } });
  });
});
