import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSettlement } from "../src/server/settlement-db";
import { partyRiskDetail, refreshRisks, riskDashboard, staffRiskDetail } from "../src/server/settlement-risk-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("settlement risk on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
  const one = async (sql: string, p: unknown[]) => String((await t.db.query(sql, p)).rows[0]!["id"]);

  async function offer(listingId: string, buyer: string, status: string) {
    const token = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [token, listingId, buyer]);
    return one("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,80000000,30,4000000,true,$3,$4) RETURNING id", [listingId, buyer, token, status]);
  }
  async function setup(asking = 85_000_000) {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer"), agent = await addUser(t.db, "agent");
    const listingId = await addListing(t.db, owner, { title: "9 Risk Rd", jurisdiction: "NSW", price_cents: asking });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listingId, agent, owner]);
    const offerId = await offer(listingId, buyer, "accepted");
    await t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, occurred_at) VALUES ($1,'accepted','owner',$2, now() - interval '10 days')", [offerId, owner]);
    const id = must(await createSettlement(t.db, owner, offerId)).id;
    return { owner, buyer, agent, listingId, offerId, id };
  }
  const score = async (id: string) => Number((await t.db.query("SELECT risk_score FROM settlement_risks WHERE settlement_id = $1", [id])).rows[0]!["risk_score"]);

  it("scores a calm sale at the base, below asking price takes points off, and a stranger sees nothing", async () => {
    const s = await setup();
    const out = await refreshRisks(t.db);
    // 20 base. Accepted 10 days ago: cooling-off has ended with no buyer confirmation (+15), finance not confirmed (+5), agreed below asking (-10).
    expect(out.get(s.id)!.score).toBe(30);
    expect((await partyRiskDetail(t.db, s.owner, s.id)).ok).toBe(true);
    expect((await partyRiskDetail(t.db, s.agent, s.id)).ok).toBe(true);
    const asBuyer = await partyRiskDetail(t.db, s.buyer, s.id);
    expect(asBuyer.ok).toBe(false);
    if (!asBuyer.ok) expect(asBuyer.status).toBe(403);
    const stranger = await addUser(t.db, "buyer");
    const asStranger = await partyRiskDetail(t.db, stranger, s.id);
    if (!asStranger.ok) expect(asStranger.status).toBe(404); else throw new Error("stranger saw risk");
  });

  it("picks up late finance, major defects, reschedules, competing offers, and tracks the trend and the high-risk flag", async () => {
    const s = await setup(80_000_000);
    expect((await refreshRisks(t.db)).get(s.id)!.score).toBe(40); // 20 + cooling-off 15 + finance not requested 5
    await t.db.query("UPDATE settlement_milestones SET target_date = current_date - 9 WHERE settlement_id = $1 AND stage = 'finance_approval'", [s.id]);
    const inspector = await addUser(t.db, "agent");
    const insp = await one("INSERT INTO inspection (listing_id, requested_by, inspector_user_id, inspection_type, scheduled_at, status) VALUES ($1,$2,$3,'building', now() - interval '8 days','accepted') RETURNING id", [s.listingId, s.buyer, inspector]);
    await t.db.query("INSERT INTO inspection_finding (inspection_id, area, title, severity, followup_status, created_by) VALUES ($1,'Foundation','Cracked slab','major','open',$2)", [insp, inspector]);
    await t.db.query("UPDATE inspection SET status = 'completed', completed_at = now() WHERE id = $1", [insp]);
    await t.db.query("INSERT INTO inspection_booking (listing_id, buyer_id, slots, status, cancelled_at) VALUES ($1,$2,'[\"2026-12-01T09:00:00Z\"]','cancelled', now())", [s.listingId, s.buyer]);
    await offer(s.listingId, await addUser(t.db, "buyer"), "submitted");

    const out = (await refreshRisks(t.db)).get(s.id)!;
    // 40 + finance 25 + defects 20 + reschedule 10 + competing 25 = 120, capped at 100
    expect(out.score).toBe(100);
    expect(out.band).toBe("high");
    expect(out.primary?.key).toBe("finance_overdue");
    expect(out.predictedFallthroughDate).not.toBeNull();
    const row = (await t.db.query("SELECT previous_score, flagged_at, addressed_at, primary_risk_factor, jsonb_array_length(secondary_risks) AS n FROM settlement_risks WHERE settlement_id = $1", [s.id])).rows[0]!;
    expect(Number(row["previous_score"])).toBe(40);
    expect(row["flagged_at"]).not.toBeNull();
    expect(row["addressed_at"]).toBeNull();
    expect(Number(row["n"])).toBeGreaterThanOrEqual(3);

    // The buyer answers: the defect is resolved and the other offer is withdrawn. Risk falls and the flag is closed.
    await t.db.query("UPDATE inspection_finding SET followup_status = 'resolved' WHERE inspection_id = $1", [insp]);
    await t.db.query("UPDATE formal_offer SET status = 'withdrawn' WHERE listing_id = $1 AND id <> $2", [s.listingId, s.offerId]);
    const d = await riskDashboard(t.db);
    const r = d.rows.find(x => x.id === s.id)!;
    expect(r.score).toBeLessThan(out.score);
    expect(r.trend).toBe("better");
    expect(d.rows[0]!.score).toBeGreaterThanOrEqual(d.rows[d.rows.length - 1]!.score);
    const after = (await t.db.query("SELECT addressed_at FROM settlement_risks WHERE settlement_id = $1", [s.id])).rows[0]!;
    if (r.band !== "high") expect(after["addressed_at"]).not.toBeNull();
    expect(d.alerts.every(a => a.band !== "low")).toBe(true);
    expect(d.alerts.length).toBeLessThanOrEqual(10);
    const live = await staffRiskDetail(t.db, s.id);
    expect(live.ok && live.value.score).toBe(await score(s.id));
  });

  it("closes the flag and records the history when a sale falls through; finished sales are not scored", async () => {
    const s = await setup(80_000_000);
    await t.db.query("UPDATE settlement_milestones SET target_date = current_date - 9 WHERE settlement_id = $1 AND stage = 'finance_approval'", [s.id]);
    await offer(s.listingId, await addUser(t.db, "buyer"), "submitted");
    await refreshRisks(t.db);
    expect(await score(s.id)).toBeGreaterThanOrEqual(60);
    await t.db.query("UPDATE formal_offer SET status = 'fallen_through' WHERE id = $1", [s.offerId]);
    await t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id) VALUES ($1,'fallen_through','buyer',$2)", [s.offerId, s.buyer]);
    const d = await riskDashboard(t.db);
    expect(d.rows.find(r => r.id === s.id)).toBeUndefined();
    expect((await staffRiskDetail(t.db, s.id)).ok).toBe(false);
    const h = (await t.db.query("SELECT reason, final_score, stage_at_fall FROM fallthrough_history WHERE settlement_id = $1", [s.id])).rows[0]!;
    expect(h["reason"]).toBe("other");
    expect(Number(h["final_score"])).toBeGreaterThanOrEqual(60);
    expect((await t.db.query("SELECT addressed_at FROM settlement_risks WHERE settlement_id = $1", [s.id])).rows[0]!["addressed_at"]).not.toBeNull();
    expect(d.history.fellThrough).toBeGreaterThanOrEqual(1);
    expect(d.history.ratePercent).not.toBeNull();
    await expect(t.db.query("DELETE FROM fallthrough_history WHERE settlement_id = $1", [s.id])).rejects.toThrow(/permanent record/);
    // Repeating the refresh does not duplicate the history row.
    await refreshRisks(t.db);
    expect(Number((await t.db.query("SELECT count(*) AS n FROM fallthrough_history WHERE settlement_id = $1", [s.id])).rows[0]!["n"])).toBe(1);
  });

  it("does not score a finished settlement", async () => {
    const s = await setup();
    await t.db.query("UPDATE settlement_timeline SET completed_at = now() WHERE id = $1", [s.id]);
    expect((await refreshRisks(t.db)).has(s.id)).toBe(false);
  });
});
