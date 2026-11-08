import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveAgentProfile } from "../src/domain/agent-matching";
import { activateConfig, agentLeadDetail, agentLogContact, agentSetResult, converse, proposeConfig, runLeadFollowUps, staffAssign, unroutedLeads, type LeadDeps } from "../src/domain/lead-service";
import type { Actor } from "../src/domain/listing-service";
import { createPgAgentMatchingRepository } from "../src/server/agent-matching-db";
import { createPgLeadRepository, purgeOldLeadText } from "../src/server/lead-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("lead qualifier on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  let clock = "2026-11-05T01:00:00.000Z";
  const deps = (): LeadDeps => ({ repo: createPgLeadRepository(t.db), now: () => clock, newId: () => randomUUID() });
  const mkAgent = async (postcodes: string[], jurisdiction = "QLD"): Promise<Actor> => {
    const id = await addUser(t.db, "agent");
    await t.db.query("INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,$2,'L-1','verified',$1, now())", [id, jurisdiction]);
    const a: Actor = { userId: id, userType: "agent" };
    await saveAgentProfile(createPgAgentMatchingRepository(t.db), a, { servicePostcodes: postcodes, transactionTypes: ["sale"] }, { newId: () => randomUUID(), now: () => clock });
    return a;
  };
  const FULL = "I want to buy a house in New Farm 4005, within a month, budget $900k, relocating for work, pre-approved, mobile 0412 345 678";

  it("runs a lead end to end: qualify, route, agent works it, result feeds learning, follow-ups and purge", async () => {
    const agent = await mkAgent(["4005"]);
    const d = deps();
    const r = await converse(d, { channel: "chat", externalId: "hash-1", text: FULL, originHash: "o-1" });
    expect(r).toMatchObject({ ok: true, value: { routed: true, tier: "hot" } });
    const id = (r as { ok: true; value: { leadId: string } }).value.leadId;

    const detail = await agentLeadDetail(d, agent, id);
    expect(detail.ok && detail.value.slots).toMatchObject({ goal: "buy", postcode: "4005", phone: "+61412345678" });
    expect(detail.ok && detail.value.notes[0]?.body).toMatch(/HOT lead/);
    expect(detail.ok && detail.value.transcript).toHaveLength(2);
    const stranger = await mkAgent(["4005"]);
    expect(await agentLeadDetail(d, stranger, id)).toMatchObject({ ok: false, code: "not_found" });

    // A second message goes on the file; only one open lead per identity.
    await converse(d, { channel: "chat", externalId: "hash-1", text: "Saturday works" });
    expect((await t.db.query("SELECT count(*)::int AS n FROM lead WHERE external_id = 'hash-1'")).rows[0]!["n"]).toBe(1);

    expect(await agentLogContact(d, agent, id)).toMatchObject({ ok: true });
    expect(await agentSetResult(d, agent, id, { result: "converted", note: "Sold" })).toMatchObject({ ok: true });
    expect(await agentSetResult(d, agent, id, { result: "lost" })).toMatchObject({ ok: false, code: "conflict" });
    const stats = await createPgLeadRepository(t.db).agentStats();
    expect(stats.find(s => s.agentUserId === agent.userId)).toMatchObject({ routed: 1, converted: 1, openLeads: 0 });

    const follow = await t.db.query("SELECT kind, status FROM lead_followup WHERE lead_id = $1", [id]);
    expect(follow.rows).toEqual([{ kind: "agent_sla", status: "pending" }]);
    clock = "2026-11-05T09:00:00.000Z";
    const tick = await runLeadFollowUps(d, { send: async () => true });
    expect(tick.escalated).toBe(0); // first contact was logged
    await t.db.query("UPDATE lead SET updated_at = now() - interval '200 days' WHERE id = $1", [id]);
    expect(await purgeOldLeadText(t.db, 180)).toBe(4);
    expect((await t.db.query("SELECT count(*)::int AS n FROM lead_note WHERE lead_id = $1", [id])).rows[0]!["n"]).toBeGreaterThan(0);
  });

  it("holds unrouted leads for staff, who can assign a licensed agent but not an unlicensed one", async () => {
    const far = await mkAgent(["4217"]);
    const d = deps();
    const r = await converse(d, { channel: "email", externalId: "buyer@example.test", text: FULL.replace("mobile 0412 345 678", "").replace("New Farm 4005", "Cairns 4870") });
    expect(r).toMatchObject({ ok: true, value: { routed: false } });
    const id = (r as { ok: true; value: { leadId: string } }).value.leadId;
    expect((await unroutedLeads(d)).some(l => l.id === id)).toBe(true);
    const nsw = await mkAgent(["4005"], "NSW");
    expect(await staffAssign(d, "00000000-0000-4000-8000-000000000000", id, nsw.userId)).toMatchObject({ ok: false, code: "conflict" });
    // The far agent covers other postcodes; staff may still assign them (they are licensed in QLD and available).
    expect(await staffAssign(d, (await addUser(t.db, "admin")), id, far.userId)).toMatchObject({ ok: true });
    expect((await unroutedLeads(d)).some(l => l.id === id)).toBe(false);
  });

  it("rate limits new conversations per origin and keeps one live conversation per identity", async () => {
    const d = deps();
    for (let i = 0; i < 10; i++) expect((await converse(d, { channel: "chat", externalId: `rl-${i}`, text: "hi", originHash: "o-rl" })).ok).toBe(true);
    expect(await converse(d, { channel: "chat", externalId: "rl-x", text: "hi", originHash: "o-rl" })).toMatchObject({ ok: false, code: "rate_limited" });
    await expect(t.db.query("INSERT INTO lead (id, channel, external_id) VALUES ($1,'chat','rl-1')", [randomUUID()])).rejects.toThrow();
  });

  it("stores config versions inactive until activated, and the active one scores new leads", async () => {
    const d = deps();
    const rows = Array.from({ length: 60 }, (_, i) => ({ slots: { timeline: i < 30 ? "now" : "later", budgetMax: 800_000 }, result: (i < 30 ? i < 24 : i < 36) ? "converted" : "lost", asked: {} }));
    for (const [i, r] of rows.entries()) {
      const leadId = randomUUID(), agentId = await addUser(t.db, "agent");
      await t.db.query("INSERT INTO lead (id, channel, external_id, slots, status) VALUES ($1,'chat',$2,$3::jsonb,'complete')", [leadId, `cfg-${i}`, JSON.stringify(r.slots)]);
      await t.db.query("INSERT INTO lead_assignment (lead_id, agent_user_id, agent_score, sla_due_at, result) VALUES ($1,$2,50,now(),$3)", [leadId, agentId, r.result]);
    }
    const p = await proposeConfig(d, await addUser(t.db, "admin"));
    expect(p.ok && p.value.changed).toBe(true);
    expect((await d.repo.activeConfig()).version).toBe(0);
    expect(await activateConfig(d, await addUser(t.db, "admin"), 1)).toMatchObject({ ok: true });
    const active = await d.repo.activeConfig();
    expect(active.version).toBe(1);
    expect(Object.values(active.weights).reduce((a, b) => a + b, 0)).toBe(100);
  });
});
