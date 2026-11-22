import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWorkspace, updateLead } from "../src/domain/agent-workspace";
import type { Actor } from "../src/domain/listing-service";
import { createWorkspaceDeps } from "../src/server/agent-workspace-db";
import { createDispute, respond, submitPosition } from "../src/server/dispute-db";
import { activateConfigPg, activeConfigPg, createExperimentPg, experimentsPg, loadFactsPg, recordSuggestionPg } from "../src/server/elena-learning-db";
import { learnedFor, recordOverallFeedbackPg, stableId, sweepImpliedReactionsPg } from "../src/server/elena-wiring-db";
import { coachingView, decideSuggestion } from "../src/server/settlement-coach-db";
import { createSettlement } from "../src/server/settlement-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const since = "2020-01-01T00:00:00Z";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("Elena learning wired into features (Postgres)", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  // Let pooled clients finish closing before the database is dropped with FORCE (avoids a harmless but noisy race).
  afterAll(async () => { await new Promise(r => setTimeout(r, 300)); await t?.close(); });
  const one = async (sql: string, p: unknown[]) => String((await t.db.query(sql, p)).rows[0]!["id"]);
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
  let version = 0;
  /** Proposes and activates a learned config (what the monthly job and a super admin do). */
  async function activate(typeWeights: Record<string, number>, admin: string) {
    version = Number((await t.db.query("SELECT COALESCE(max(version), 0) + 1 AS v FROM elena_learned_config")).rows[0]!["v"]);
    await t.db.query("INSERT INTO elena_learned_config (version, config, evidence) VALUES ($1, $2::jsonb, '{}'::jsonb)", [version, JSON.stringify({ engine: "elena-learning-v1", typeWeights, regionWeights: {}, trainedOn: 99 })]);
    expect(await activateConfigPg(t.db, version, admin, new Date().toISOString())).toBe(true);
  }

  async function setup() {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer"), agent = await addUser(t.db, "agent");
    const listingId = await addListing(t.db, owner, { title: "5 Wiring St", jurisdiction: "NSW" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listingId, agent, owner]);
    const token = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [token, listingId, buyer]);
    const offerId = await one("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,80000000,10,100000,true,$3,'accepted') RETURNING id", [listingId, buyer, token]);
    await t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, occurred_at) VALUES ($1,'accepted','owner',$2, now())", [offerId, owner]);
    const sid = must(await createSettlement(t.db, owner, offerId)).id;
    return { owner, buyer, agent, listingId, offerId, sid };
  }

  it("settlement coach: records each suggestion once, records the decision, and reorders only when learned weights apply", async () => {
    const s = await setup();
    const base = must(await coachingView(t.db, s.owner, s.sid)).suggestions;
    await coachingView(t.db, s.owner, s.sid);
    const rows = (await t.db.query("SELECT suggestion_type, context, user_role, region FROM elena_suggestion WHERE feature = 'negotiation_coach' AND offer_id = $1 AND user_id = $2", [s.offerId, s.owner])).rows;
    expect(rows).toHaveLength(base.length);
    expect(rows[0]).toMatchObject({ user_role: "seller", region: "NSW" });
    expect(rows[0]!["context"]).toMatchObject({ weighted: false });

    const first = base[0]!;
    expect((await decideSuggestion(t.db, s.owner, s.sid, first.type, true)).ok).toBe(true);
    const f = (await loadFactsPg(t.db, since, s.owner)).find(x => x.type === first.type && x.feature === "negotiation_coach")!;
    expect(f.action).toBe("accepted");

    // Two suggestions share the top severity. Learned weights favour the second, so it moves ahead of the first.
    expect(base[0]!.severity).toBe(base[1]!.severity);
    await activate({ [`negotiation_coach/${base[1]!.type}`]: 1.5, [`negotiation_coach/${base[0]!.type}`]: 0.6 }, s.owner);
    const learned = must(await coachingView(t.db, s.owner, s.sid)).suggestions.map(x => x.type);
    expect(learned.indexOf(base[1]!.type)).toBeLessThan(learned.indexOf(base[0]!.type));
    expect([...learned].sort()).toEqual(base.map(x => x.type).sort());
    // The set of suggestions is unchanged, only the order; the new view says weights were used for it.
    expect(await learnedFor(t.db, "negotiation_coach", s.owner)).toMatchObject({ weighted: true });
  });

  it("A/B arms: the control arm gets the original order, others get learned weights, the arm is stored with each suggestion", async () => {
    const admin = await addUser(t.db, "admin");
    await activate({ "negotiation_coach/deposit_low": 1.2 }, admin);
    await createExperimentPg(t.db, "coach_weights", "negotiation_coach", ["control", "learned"], admin);
    const seen = { control: 0, learned: 0 };
    const users: string[] = [];
    for (let i = 0; i < 40; i++) {
      const u = await addUser(t.db, "owner");
      users.push(u);
      const l = await learnedFor(t.db, "negotiation_coach", u);
      expect(l.experimentKey).toBe("coach_weights");
      expect(l.weighted).toBe(l.arm !== "control");
      seen[l.arm as "control" | "learned"]++;
      expect(await learnedFor(t.db, "negotiation_coach", u)).toEqual(l); // stable per person
      await t.db.query("SELECT 1");
    }
    expect(seen.control).toBeGreaterThan(5);
    expect(seen.learned).toBeGreaterThan(5);
    // A suggestion made through a feature carries the arm.
    const s = await setup();
    const arm = (await learnedFor(t.db, "negotiation_coach", s.owner)).arm;
    await coachingView(t.db, s.owner, s.sid);
    const row = (await t.db.query("SELECT arm, experiment_key FROM elena_suggestion WHERE offer_id = $1 AND user_id = $2 LIMIT 1", [s.offerId, s.owner])).rows[0]!;
    expect(row).toMatchObject({ arm, experiment_key: "coach_weights" });
    // The result lists both arms with a range, and the config stays active.
    const facts = await loadFactsPg(t.db, since);
    const exp = (await experimentsPg(t.db, facts)).find(e => e.key === "coach_weights")!;
    expect(exp.arms.map(a => a.arm)).toEqual(["control", "learned"]);
    expect(exp.arms[0]).toHaveProperty("lower");
    expect((await activeConfigPg(t.db))?.engine).toBe("elena-learning-v1");
    await t.db.query("UPDATE elena_experiment SET status = 'stopped' WHERE key = 'coach_weights'");
  });

  it("mediation: records the round for both parties, the response as a reaction, and links the deal", async () => {
    const s = await setup();
    const id = must(await createDispute(t.db, s.buyer, s.sid, { type: "repair", title: "Roof", description: "Leaking roof found.", position: "Seller pays all", claimCents: 10_000_00, sellerSharePct: 100 })).id;
    must(await submitPosition(t.db, s.owner, s.sid, id, { position: "Half each", sellerSharePct: 50 }));
    let rows = (await t.db.query("SELECT user_id, user_role, suggestion_type, offer_id FROM elena_suggestion WHERE feature = 'mediation' AND offer_id = $1", [s.offerId])).rows;
    expect(rows.map(r => r["user_role"]).sort()).toEqual(["buyer", "seller"]);
    expect(String(rows[0]!["suggestion_type"])).toMatch(/^repair:/);
    must(await respond(t.db, s.buyer, s.sid, id, { response: "accept", sellerSharePct: null, note: "" }));
    must(await respond(t.db, s.owner, s.sid, id, { response: "counter", sellerSharePct: 40, note: "" }));
    const facts = (await loadFactsPg(t.db, since)).filter(f => f.feature === "mediation");
    expect(facts.find(f => f.userId === s.buyer && f.type.startsWith("repair:"))?.action).toBe("accepted");
    expect(facts.find(f => f.userId === s.owner && f.type.startsWith("repair:"))?.action).toBe("modified");
    // Round 2 now exists for both parties.
    rows = (await t.db.query("SELECT 1 FROM elena_suggestion WHERE feature = 'mediation' AND offer_id = $1", [s.offerId])).rows;
    expect(rows.length).toBe(4);
  });

  it("lead scoring: learned weights scale the three signals, scores are recorded for the agent, and acting on a lead is the reaction", async () => {
    const admin = await addUser(t.db, "admin");
    const owner = await addUser(t.db, "owner"), agent = await addUser(t.db, "agent"), buyer = await addUser(t.db, "buyer");
    await t.db.query("INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,'QLD','L-9','verified',$1, now())", [agent]);
    const listing = await addListing(t.db, owner, { jurisdiction: "QLD", title: "Lead house" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listing, agent, owner]);
    const enq = await one("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1,$2, now() - interval '5 hours') RETURNING id", [listing, buyer]);
    await t.db.query("INSERT INTO enquiry_message (enquiry_id, sender_user_id, body, sent_at) VALUES ($1,$2,'Hello', now() - interval '3 hours')", [enq, buyer]);
    const d = createWorkspaceDeps(t.db), me: Actor = { userId: agent, userType: "agent" };
    const before = await d.scoring!(agent);
    await activate({ "lead_scoring/engagement": 1.4, "lead_scoring/fit": 0.7 }, admin);
    const after = await d.scoring!(agent);
    expect(after.weights.engagement).toBeCloseTo(before.weights.engagement * 1.4);
    expect(after.weights.fit).toBeCloseTo(before.weights.fit * 0.7);
    expect(after.weights.followUp).toBe(before.weights.followUp);
    expect(after.hotMin).toBe(before.hotMin);
    const w = await getWorkspace(d, me);
    if (!w.ok) throw new Error(w.message);
    const rec = (await t.db.query("SELECT suggestion_type, context FROM elena_suggestion WHERE feature = 'lead_scoring' AND user_id = $1", [agent])).rows;
    expect(rec).toHaveLength(1);
    expect(rec[0]!["context"]).toMatchObject({ weighted: true });
    await getWorkspace(d, me);
    expect((await t.db.query("SELECT 1 FROM elena_suggestion WHERE feature = 'lead_scoring' AND user_id = $1", [agent])).rows).toHaveLength(1);
    expect(await updateLead(d, me, enq, { stage: "contacted" })).toEqual({ ok: true, value: true });
    expect((await loadFactsPg(t.db, since, agent)).find(f => f.feature === "lead_scoring")?.action).toBe("accepted");
  });

  it("sweep: pricing, listing optimization and inspection drafts get their reaction from what the person did", async () => {
    const owner = await addUser(t.db, "owner");
    const listing = await addListing(t.db, owner, { jurisdiction: "NSW", title: "Sweep St" });
    await t.db.query("UPDATE property_listing SET price_cents = 90000000 WHERE id = $1", [listing]);
    const old = "now() - interval '40 days'";
    const mk = async (feature: string, type: string, extra: Record<string, unknown> = {}) => {
      const id = await recordSuggestionPg(t.db, { feature: feature as never, type, userId: owner, listingId: listing, ...extra });
      await t.db.query("ALTER TABLE elena_suggestion DISABLE TRIGGER elena_suggestion_no_change");
      await t.db.query(`UPDATE elena_suggestion SET created_at = ${old} WHERE id = $1`, [id]);
      await t.db.query("ALTER TABLE elena_suggestion ENABLE TRIGGER elena_suggestion_no_change");
      return id;
    };
    const near = await mk("pricing", "balanced", { context: { recommendedCents: 89000000 } });
    const far = await mk("pricing", "fast_sale", { context: { recommendedCents: 70000000 } });
    const opt = await one("INSERT INTO listing_optimizations (listing_id, suggestion_type, description, estimated_impact) VALUES ($1,'add_photos','x','{}'::jsonb) RETURNING id", [listing]);
    await t.db.query("UPDATE listing_optimizations SET status = 'implemented', implemented_at = now() WHERE id = $1", [opt]);
    await t.db.query("ALTER TABLE elena_suggestion DISABLE TRIGGER elena_suggestion_no_change");
    await t.db.query("INSERT INTO elena_suggestion (id, feature, suggestion_type, user_id, listing_id) VALUES ($1,'listing_optimization','add_photos',$2,$3)", [opt, owner, listing]);
    await t.db.query("ALTER TABLE elena_suggestion ENABLE TRIGGER elena_suggestion_no_change");
    const r = await sweepImpliedReactionsPg(t.db);
    expect(r.pricing).toBe(2);
    expect(r.listingOptimization).toBe(1);
    const facts = await loadFactsPg(t.db, since, owner);
    expect(facts.find(f => f.id === near)?.action).toBe("accepted");
    expect(facts.find(f => f.id === far)?.action).toBe("ignored");
    expect(facts.find(f => f.id === opt)?.action).toBe("accepted");
    expect(await sweepImpliedReactionsPg(t.db)).toEqual({ pricing: 0, listingOptimization: 0, inspectionResponder: 0 });
  });

  it("overall feedback: only the buyer or owner, only after it ended, once per person, joined to the deal outcome", async () => {
    const s = await setup();
    const stranger = await addUser(t.db, "buyer");
    expect(await recordOverallFeedbackPg(t.db, s.buyer, "settlement", s.sid, { helpful: "yes" })).toBe("not_ended");
    await t.db.query("UPDATE settlement_timeline SET state = 'completed', current_stage = 'settlement_completed', completed_at = now() WHERE id = $1", [s.sid]);
    expect(await recordOverallFeedbackPg(t.db, stranger, "settlement", s.sid, { helpful: "yes" })).toBe("not_found");
    expect(await recordOverallFeedbackPg(t.db, s.agent, "settlement", s.sid, { helpful: "yes" })).toBe("not_found");
    expect(await recordOverallFeedbackPg(t.db, s.buyer, "settlement", s.sid, { helpful: "partial", rating: 4 })).toBe("ok");
    expect(await recordOverallFeedbackPg(t.db, s.buyer, "settlement", s.sid, { helpful: "yes" })).toBe("ok");
    expect((await t.db.query("SELECT 1 FROM elena_suggestion WHERE id = $1", [stableId("overall", "settlement", s.sid, s.buyer)])).rows).toHaveLength(1);
    expect(await recordOverallFeedbackPg(t.db, s.owner, "dispute", randomUUID(), { helpful: "yes" })).toBe("not_found");
    const f = (await loadFactsPg(t.db, since, s.buyer)).find(x => x.type === "settlement_overall")!;
    expect(f).toMatchObject({ feature: "negotiation_coach", action: "accepted", helpful: "yes" });
    await t.db.query("INSERT INTO settlement_outcomes (settlement_id, outcome, source) VALUES ($1,'settled','auto') ON CONFLICT DO NOTHING", [s.sid]);
    expect((await loadFactsPg(t.db, since, s.buyer)).find(x => x.type === "settlement_overall")!.dealOutcome).toBe("settled");
  });

  it("the cross-feature view groups by feature and arm", async () => {
    const rows = (await t.db.query("SELECT feature, arm, suggestions::int AS n FROM elena_feature_analytics WHERE feature = 'negotiation_coach'")).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.reduce((a, x) => a + Number(x["n"]), 0)).toBeGreaterThan(0);
  });
});
