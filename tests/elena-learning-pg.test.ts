import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiDraftRecord } from "../src/domain/ai-draft-record";
import { createPgAiDraftRepository } from "../src/server/ai-records-db";
import type { Queryable } from "../src/server/db";
import {
  activateConfigPg, activeConfigPg, armForPg, createExperimentPg, loadFactsPg, proposeMonthlyConfigPg, recordFeedbackPg, recordManualOutcomePg, recordSuggestionPg,
  refreshUserPatternsPg, suggestionOwnerPg, syncSettlementOutcomesPg
} from "../src/server/elena-learning-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("Elena learning loop (Postgres)", () => {
  let t: TestDb, db: Queryable, owner: string, agent: string, listing: string;
  const since = "2020-01-01T00:00:00Z";
  const draft = (by: string, over: Partial<AiDraftRecord> = {}): AiDraftRecord => ({
    id: randomUUID(), kind: "offer_response", listingId: listing, action: "recommend_counter", text: "Call me on 0412 345 678 or a@b.com",
    policyDecision: { allowed: true } as never, guardResult: { ok: true, violations: [] } as never, engineId: "elena-coach-rules", modelVersion: "m1", promptVersion: "p1",
    inputHash: "a".repeat(64), status: "pending", createdBy: by, createdAt: new Date().toISOString(), ...over
  });
  const offer = async (buyer: string, price = 90000000) => {
    const hash = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3,'2027-01-01')", [hash, listing, buyer]);
    return (await db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash) VALUES ($1,$2,$3,30,1000000,true,$4) RETURNING id", [listing, buyer, price, hash])).rows[0]!["id"] as string;
  };

  beforeAll(async () => {
    t = await createTestDb(); db = t.db;
    owner = await addUser(db, "owner"); agent = await addUser(db, "agent");
    listing = await addListing(db, owner, { status: "published", jurisdiction: "NSW" });
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("turns an AI draft into a suggestion and its send, edit or discard into automatic feedback", async () => {
    const repo = createPgAiDraftRepository(db);
    const offerId = await offer(await addUser(db, "buyer"));
    const sent = draft(owner, { offerId }), edited = draft(owner, { offerId }), dropped = draft(owner, { offerId });
    for (const d of [sent, edited, dropped]) await repo.insert(d);
    await repo.finish(sent.id, "sent", owner, new Date().toISOString());
    await repo.finish(edited.id, "edited_sent", owner, new Date().toISOString());
    await repo.finish(dropped.id, "discarded", owner, new Date().toISOString());
    const facts = await loadFactsPg(db, since, owner);
    const by = (id: string) => facts.find(f => f.id === id)!;
    expect(by(sent.id)).toMatchObject({ feature: "negotiation_coach", type: "recommend_counter", region: "NSW", userRole: "owner", action: "accepted" });
    expect(by(edited.id).action).toBe("modified");
    expect(by(dropped.id).action).toBe("rejected");
    // Finishing twice must not double count.
    await repo.finish(sent.id, "sent", owner, new Date().toISOString());
    expect((await db.query("SELECT count(*)::int AS n FROM elena_feedback WHERE suggestion_id = $1", [sent.id])).rows[0]!["n"]).toBe(1);
  });

  it("stores suggestion text only with training consent, and redacted", async () => {
    const noConsent = await recordSuggestionPg(db, { feature: "pricing", type: "x", userId: owner, consent: false });
    const row = (await db.query("SELECT suggestion_text, consent_for_training FROM elena_suggestion WHERE id = $1", [noConsent])).rows[0]!;
    expect(row["consent_for_training"]).toBe(false);
    const id = await recordSuggestionPg(db, { feature: "pricing", type: "y", userId: owner, consent: true, text: "ring 0412 345 678 or a@b.com", context: { note: "a@b.com", round: 2 } });
    const r = (await db.query("SELECT suggestion_text, context FROM elena_suggestion WHERE id = $1", [id])).rows[0]!;
    expect(r["suggestion_text"]).toBe("ring [phone] or [email]");
    expect(r["context"]).toEqual({ round: 2 });
  });

  it("is insert-only", async () => {
    const id = await recordSuggestionPg(db, { feature: "other", type: "z", userId: owner });
    await recordFeedbackPg(db, { suggestionId: id, action: "accepted", source: "user", recordedBy: owner });
    await expect(db.query("UPDATE elena_suggestion SET feature = 'pricing' WHERE id = $1", [id])).rejects.toThrow(/permanent record/);
    await expect(db.query("DELETE FROM elena_feedback WHERE suggestion_id = $1", [id])).rejects.toThrow(/permanent record/);
  });

  it("only the suggestion's own person can be matched, and a person's answer wins over the automatic one", async () => {
    const id = await recordSuggestionPg(db, { feature: "mediation", type: "m", userId: owner });
    expect(await suggestionOwnerPg(db, id)).toBe(owner);
    expect(await suggestionOwnerPg(db, randomUUID())).toBeUndefined();
    await recordFeedbackPg(db, { suggestionId: id, action: "rejected", source: "auto" });
    await recordFeedbackPg(db, { suggestionId: id, action: "accepted", helpful: "yes", rating: 5, source: "user", recordedBy: owner });
    const f = (await loadFactsPg(db, since, owner)).find(x => x.id === id)!;
    expect(f).toMatchObject({ action: "accepted", helpful: "yes", rating: 5 });
    expect(await recordFeedbackPg(db, { suggestionId: randomUUID(), action: "accepted", source: "user" })).toBe(false);
  });

  it("fills outcomes from settlements and lets staff complete them without blanking", async () => {
    const buyer = await addUser(db, "buyer");
    const o = await offer(buyer);
    const s = (await db.query("INSERT INTO settlement_timeline (offer_id, listing_id, buyer_id, seller_id, agent_id, state, current_stage, completed_at, created_by) VALUES ($1,$2,$3,$4,$5,'completed','settlement_completed', now() + interval '40 days',$4) RETURNING id", [o, listing, buyer, owner, agent])).rows[0]!["id"] as string;
    expect(await syncSettlementOutcomesPg(db)).toBe(1);
    expect(await syncSettlementOutcomesPg(db)).toBe(0);
    let row = (await db.query("SELECT * FROM settlement_outcomes WHERE settlement_id = $1", [s])).rows[0]!;
    expect(row["outcome"]).toBe("settled");
    expect(row["final_price_cents"]).toBe("90000000");
    expect(row["time_to_settlement_days"]).toBeGreaterThanOrEqual(39);
    expect(await recordManualOutcomePg(db, { settlementId: s, outcome: "settled", userSatisfaction: 5, recordedBy: agent })).toBe(true);
    row = (await db.query("SELECT * FROM settlement_outcomes WHERE settlement_id = $1", [s])).rows[0]!;
    expect(row["user_satisfaction"]).toBe(5);
    expect(row["final_price_cents"]).toBe("90000000");
    expect(await recordManualOutcomePg(db, { settlementId: randomUUID(), outcome: "settled", recordedBy: agent })).toBe(false);
    // The deal outcome joins onto the suggestions made for that offer.
    const sid = await recordSuggestionPg(db, { feature: "negotiation_coach", type: "t", userId: owner, offerId: o });
    expect((await loadFactsPg(db, since, owner)).find(f => f.id === sid)!.dealOutcome).toBe("settled");
  });

  it("learns patterns only for consenting people and proposes, never activates, a config", async () => {
    const a = await addUser(db, "agent"), b = await addUser(db, "agent");
    for (let i = 0; i < 40; i++) {
      const id = await recordSuggestionPg(db, { feature: "enquiry_reply", type: i % 2 ? "draft_reply" : "reject", userId: a, consent: true, region: "VIC" });
      await recordFeedbackPg(db, { suggestionId: id, action: i % 2 ? "accepted" : "rejected", responseSeconds: 60, source: "auto" });
      const id2 = await recordSuggestionPg(db, { feature: "enquiry_reply", type: "draft_reply", userId: b, consent: false, region: "VIC" });
      await recordFeedbackPg(db, { suggestionId: id2, action: "accepted", responseSeconds: 60, source: "auto" });
    }
    expect(await refreshUserPatternsPg(db, new Date())).toBeGreaterThanOrEqual(1);
    expect((await db.query("SELECT 1 FROM user_patterns WHERE user_id = $1", [a])).rows.length).toBe(1);
    expect((await db.query("SELECT 1 FROM user_patterns WHERE user_id = $1", [b])).rows.length).toBe(0);
    const proposal = await proposeMonthlyConfigPg(db, new Date());
    expect(proposal?.version).toBe(1);
    expect(await activeConfigPg(db)).toBeUndefined();
    expect(await activateConfigPg(db, 99, owner, new Date().toISOString())).toBe(false);
    expect(await activateConfigPg(db, 1, owner, new Date().toISOString())).toBe(true);
    expect((await activeConfigPg(db))?.engine).toBe("elena-learning-v1");
    const second = await proposeMonthlyConfigPg(db, new Date());
    expect(await activateConfigPg(db, second!.version, owner, new Date().toISOString())).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM elena_learned_config WHERE status = 'active'")).rows[0]!["n"]).toBe(1);
  });

  it("assigns a stable arm only while an experiment runs", async () => {
    expect(await armForPg(db, "valuation", owner)).toBeUndefined();
    expect(await createExperimentPg(db, "tone_test", "valuation", ["a", "b"], owner)).toBe(true);
    expect(await createExperimentPg(db, "tone_test", "valuation", ["a", "b"], owner)).toBe(false);
    const first = await armForPg(db, "valuation", owner);
    expect(first?.key).toBe("tone_test");
    expect(await armForPg(db, "valuation", owner)).toEqual(first);
  });
});
