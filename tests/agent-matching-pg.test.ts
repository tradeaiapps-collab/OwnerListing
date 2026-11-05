import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inviteAgent, respondToInvite } from "../src/domain/agent-appointment-service";
import { saveAgentProfile, suggestAgents } from "../src/domain/agent-matching";
import type { Actor } from "../src/domain/listing-service";
import { createPgAgentAppointmentRepository } from "../src/server/agent-appointment-db";
import { createPgAgentMatchingRepository } from "../src/server/agent-matching-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("agent matching on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };

  it("saves profiles, counts active appointments for capacity, and suggests only licensed, active, available agents", async () => {
    const owner: Actor = { userId: await addUser(t.db, "owner"), userType: "owner" };
    const mk = async (status = "active", jurisdiction = "QLD") => {
      const id = await addUser(t.db, "agent", status);
      await t.db.query("INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,$2,'L-1','verified',$1, now())", [id, jurisdiction]);
      return { userId: id, userType: "agent" } as Actor;
    };
    const near = await mk();
    const busy = await mk();
    const suspended = await mk("suspended");
    const nsw = await mk("active", "NSW");
    const repo = createPgAgentMatchingRepository(t.db);
    for (const a of [near, suspended, nsw]) {
      expect(await saveAgentProfile(repo, a, { servicePostcodes: ["4005"], transactionTypes: ["sale"] }, ids)).toMatchObject({ ok: true });
    }
    expect(await saveAgentProfile(repo, busy, { servicePostcodes: ["4005"], maxActiveListings: 1 }, ids)).toMatchObject({ ok: true });
    // Saving again updates in place.
    expect(await saveAgentProfile(repo, near, { servicePostcodes: ["4005"], transactionTypes: ["sale"], bio: "Inner north" }, ids)).toMatchObject({ ok: true });
    expect((await repo.getProfile(near.userId))?.bio).toBe("Inner north");

    // Give "busy" one active appointment so they are at capacity.
    const other = await addListing(t.db, owner.userId, { jurisdiction: "QLD" });
    const appts = createPgAgentAppointmentRepository(t.db);
    const inv = await inviteAgent(appts, owner, other, { agentUserId: busy.userId }, ids);
    if (!inv.ok) throw new Error("invite");
    expect(await respondToInvite(appts, busy, inv.value.id, { action: "accept" }, ids)).toMatchObject({ ok: true });

    const listingId = await addListing(t.db, owner.userId, { jurisdiction: "QLD", postcode: "4005", suburb: "New Farm" });
    const r = await suggestAgents(repo, owner, listingId, ids.now());
    expect(r).toMatchObject({ ok: true, value: [{ agentUserId: near.userId, reasons: ["postcode", "transaction_type", "capacity"], bio: "Inner north" }] });
    expect(await suggestAgents(repo, near, listingId, ids.now())).toMatchObject({ ok: false, code: "not_found" });
  });
});
