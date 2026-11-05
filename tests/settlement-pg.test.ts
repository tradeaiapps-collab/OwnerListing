import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSettlement, listSettlements, settlementPortfolio, settlementView, tickChecklistItem, updateMilestone } from "../src/server/settlement-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("settlement tracker on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
  const one = async (sql: string, p: unknown[]) => String((await t.db.query(sql, p)).rows[0]!["id"]);

  /** An accepted offer on a NSW listing, accepted `daysAgo` days ago, with an appointed agent. */
  async function setup(o: { status?: string; daysAgo?: number; agent?: boolean } = {}) {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer"), agent = await addUser(t.db, "agent"), stranger = await addUser(t.db, "buyer");
    const listingId = await addListing(t.db, owner, { title: "12 Reef St", jurisdiction: "NSW" });
    if (o.agent !== false) await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listingId, agent, owner]);
    const token = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [token, listingId, buyer]);
    const offerId = await one("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,80000000,30,4000000,true,$3,$4) RETURNING id", [listingId, buyer, token, o.status ?? "accepted"]);
    await t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, occurred_at) VALUES ($1,'accepted','owner',$2, now() - make_interval(days => $3::int))", [offerId, owner, o.daysAgo ?? 0]);
    return { owner, buyer, agent, stranger, listingId, offerId };
  }

  it("starts once per accepted offer, for the owner or agent only, with stage 1 done and dates estimated", async () => {
    const s = await setup();
    expect((await createSettlement(t.db, s.buyer, s.offerId)).ok).toBe(false);
    expect((await createSettlement(t.db, s.stranger, s.offerId)).ok).toBe(false);
    const id = must(await createSettlement(t.db, s.agent, s.offerId)).id;
    expect((await createSettlement(t.db, s.owner, s.offerId)).ok).toBe(false);
    const v = must(await settlementView(t.db, s.owner, id));
    expect(v.currentStage).toBe("deposit_received");
    expect(v.milestones.map(m => m.status)).toEqual(["completed", ...Array(7).fill("pending")]);
    expect(v.milestones[2]!.targetDate).not.toBeNull();
    expect(v.milestones[7]!.targetDate).not.toBeNull();
    expect(v.doneStages).toBe(1);
    const held = await setup({ status: "submitted" });
    expect((await createSettlement(t.db, held.owner, held.offerId)).ok).toBe(false);
  });

  it("shows each person their own side and nobody else the settlement", async () => {
    const s = await setup();
    const id = must(await createSettlement(t.db, s.owner, s.offerId)).id;
    expect(must(await settlementView(t.db, s.buyer, id)).side).toBe("buyer");
    expect(must(await settlementView(t.db, s.owner, id)).side).toBe("seller");
    expect(must(await settlementView(t.db, s.agent, id)).side).toBe("agent");
    expect((await settlementView(t.db, s.stranger, id)).ok).toBe(false);
    expect((await listSettlements(t.db, s.stranger)).length).toBe(0);
    expect((await listSettlements(t.db, s.buyer)).map(x => x.id)).toEqual([id]);
    const buyerView = must(await settlementView(t.db, s.buyer, id));
    expect(buyerView.canUpdate).toBe(false);
    expect(buyerView.checklists.filter(c => c.items.some(i => i.canTick)).every(c => c.role === "buyer")).toBe(true);
  });

  it("ticks checklist items by role, and not ahead of the current stage", async () => {
    const s = await setup();
    const id = must(await createSettlement(t.db, s.owner, s.offerId)).id;
    must(await tickChecklistItem(t.db, s.buyer, id, { stage: "deposit_received", role: "buyer", itemId: "buyer-0", done: true }));
    expect((await tickChecklistItem(t.db, s.buyer, id, { stage: "deposit_received", role: "agent", itemId: "agent-0", done: true })).ok).toBe(false);
    expect((await tickChecklistItem(t.db, s.buyer, id, { stage: "lawyer_exchange", role: "lawyer", itemId: "lawyer-0", done: true })).ok).toBe(false);
    expect((await tickChecklistItem(t.db, s.owner, id, { stage: "finance_approval", role: "buyer", itemId: "buyer-0", done: true })).ok).toBe(false);
    expect((await tickChecklistItem(t.db, s.stranger, id, { stage: "deposit_received", role: "buyer", itemId: "buyer-0", done: true })).ok).toBe(false);
    expect((await tickChecklistItem(t.db, s.agent, id, { stage: "deposit_received", role: "buyer", itemId: "buyer-9", done: true })).ok).toBe(false);
    const r = must(await tickChecklistItem(t.db, s.agent, id, { stage: "deposit_received", role: "agent", itemId: "agent-0", done: true }));
    expect(r).toEqual({ itemsDone: 1, itemsTotal: 2 });
    const done = (await t.db.query("SELECT items, completed_at FROM settlement_checklists WHERE settlement_id = $1 AND milestone_stage = 'deposit_received' AND role = 'buyer'", [id])).rows[0]!;
    expect((done["items"] as { done: boolean; doneByRole: string }[])[0]).toMatchObject({ done: true, doneByRole: "buyer" });
    expect(done["completed_at"]).not.toBeNull();
    must(await tickChecklistItem(t.db, s.buyer, id, { stage: "deposit_received", role: "buyer", itemId: "buyer-0", done: false }));
    expect((await t.db.query("SELECT completed_at FROM settlement_checklists WHERE settlement_id = $1 AND milestone_stage = 'deposit_received' AND role = 'buyer'", [id])).rows[0]!["completed_at"]).toBeNull();
  });

  it("walks the stages in order to settlement and writes an audit row for every change", async () => {
    const s = await setup();
    const id = must(await createSettlement(t.db, s.owner, s.offerId)).id;
    expect((await updateMilestone(t.db, s.buyer, id, { stage: "deposit_received", status: "completed" })).ok).toBe(false);
    expect((await updateMilestone(t.db, s.owner, id, { stage: "finance_approval", status: "completed" })).ok).toBe(false);
    for (const stage of STAGES_AFTER_FIRST) {
      const r = must(await updateMilestone(t.db, s.agent, id, { stage, status: "completed" }));
      expect(r.completed).toBe(stage === "settlement_completed");
    }
    const v = must(await settlementView(t.db, s.buyer, id));
    expect(v.completed).toBe(true);
    expect(v.doneStages).toBe(8);
    expect(v.stuck.stuck).toBe(false);
    expect((await updateMilestone(t.db, s.owner, id, { stage: "settlement_completed", status: "pending" })).ok).toBe(false);
    expect((await t.db.query("SELECT count(*) AS n FROM audit_event WHERE aggregate_type = 'settlement' AND aggregate_id = $1", [id])).rows[0]!["n"]).toBe("8");
    await expect(t.db.query("DELETE FROM settlement_milestones WHERE settlement_id = $1", [id])).rejects.toThrow(/permanent record/);
  });

  it("blocks and unblocks a stage, and flags stuck deals for agents and staff", async () => {
    const s = await setup();
    const id = must(await createSettlement(t.db, s.owner, s.offerId)).id;
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect(must(await settlementView(t.db, s.agent, id)).stuck.stuck).toBe(false);
    expect(must(await settlementView(t.db, s.agent, id, later)).stuck).toMatchObject({ stuck: true, days: 8 });
    expect((await listSettlements(t.db, s.agent, later))[0]!.stuck.stuck).toBe(true);
    must(await updateMilestone(t.db, s.owner, id, { stage: "deposit_received", status: "blocked", note: "Deposit not received" }));
    expect(must(await settlementView(t.db, s.buyer, id)).stuck).toMatchObject({ stuck: true, blocked: true });
    const pf = await settlementPortfolio(t.db);
    expect(pf.rows.find(r => r.id === id)).toMatchObject({ currentStage: "deposit_received", stuck: { blocked: true } });
    expect(pf.totals.stuck).toBeGreaterThanOrEqual(1);
    must(await updateMilestone(t.db, s.owner, id, { stage: "deposit_received", status: "pending" }));
    expect(must(await settlementView(t.db, s.buyer, id)).milestones[1]).toMatchObject({ status: "pending", note: null });
  });

  it("closes the timeline when the sale falls through", async () => {
    const s = await setup();
    const id = must(await createSettlement(t.db, s.owner, s.offerId)).id;
    await t.db.query("UPDATE formal_offer SET status = 'fallen_through' WHERE id = $1", [s.offerId]);
    expect((await updateMilestone(t.db, s.owner, id, { stage: "deposit_received", status: "completed" })).ok).toBe(false);
    expect((await tickChecklistItem(t.db, s.buyer, id, { stage: "deposit_received", role: "buyer", itemId: "buyer-0", done: true })).ok).toBe(false);
    const v = must(await settlementView(t.db, s.owner, id, new Date(Date.now() + 30 * 86_400_000)));
    expect(v).toMatchObject({ fellThrough: true, canUpdate: false });
    expect(v.stuck.stuck).toBe(false);
  });
});

const STAGES_AFTER_FIRST = ["deposit_received", "cooling_off_expires", "inspection_completed", "finance_approval", "lawyer_exchange", "settlement_scheduled", "settlement_completed"] as const;
