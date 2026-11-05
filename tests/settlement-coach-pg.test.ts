import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coachingStatsPg, coachingView, decideSuggestion } from "../src/server/settlement-coach-db";
import { createSettlement } from "../src/server/settlement-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("settlement coaching on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  const one = async (sql: string, p: unknown[]) => String((await t.db.query(sql, p)).rows[0]!["id"]);

  /** A deal with a short settlement, no inspection condition and a small deposit, so several suggestions apply. */
  async function setup() {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer"), stranger = await addUser(t.db, "buyer");
    const listingId = await addListing(t.db, owner, { title: "3 Coach St", jurisdiction: "NSW" });
    const token = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [token, listingId, buyer]);
    const offerId = await one("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,80000000,10,100000,true,$3,'accepted') RETURNING id", [listingId, buyer, token]);
    await t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, occurred_at) VALUES ($1,'accepted','owner',$2, now())", [offerId, owner]);
    const r = await createSettlement(t.db, owner, offerId);
    if (!r.ok) throw new Error(r.error);
    return { owner, buyer, stranger, offerId, id: r.value.id };
  }

  it("shows the right suggestions to each side, records them once, and hides the deal from strangers", async () => {
    const s = await setup();
    const seller = await coachingView(t.db, s.owner, s.id);
    const buyer = await coachingView(t.db, s.buyer, s.id);
    if (!seller.ok || !buyer.ok) throw new Error("view failed");
    expect(seller.value.suggestions.map(x => x.type)).toEqual(expect.arrayContaining(["inspection_waived", "settlement_too_short", "deposit_low"]));
    expect(buyer.value.suggestions.map(x => x.type)).not.toContain("deposit_low");
    expect((await coachingView(t.db, s.stranger, s.id)).ok).toBe(false);
    await coachingView(t.db, s.owner, s.id);
    const n = Number((await t.db.query("SELECT count(*) AS n FROM negotiation_coaching_offers WHERE offer_id = $1 AND side = 'seller'", [s.offerId])).rows[0]!["n"]);
    expect(n).toBe(seller.value.suggestions.length);
  });

  it("records a decision once, only for a suggestion that was shown, and returns the template only when used", async () => {
    const s = await setup();
    expect((await decideSuggestion(t.db, s.owner, s.id, "deposit_low", true)).ok).toBe(false);
    await coachingView(t.db, s.owner, s.id);
    const used = await decideSuggestion(t.db, s.owner, s.id, "deposit_low", true);
    expect(used.ok && used.value.template).toContain("deposit");
    expect((await decideSuggestion(t.db, s.owner, s.id, "deposit_low", false)).ok).toBe(false);
    const ignored = await decideSuggestion(t.db, s.owner, s.id, "settlement_too_short", false);
    expect(ignored.ok && ignored.value).toEqual({ decision: "dismissed", template: null });
    expect((await decideSuggestion(t.db, s.stranger, s.id, "deposit_low", true)).ok).toBe(false);
    expect((await decideSuggestion(t.db, s.buyer, s.id, "deposit_low", true)).ok).toBe(false);
    const v = await coachingView(t.db, s.owner, s.id);
    expect(v.ok && v.value.suggestions.find(x => x.type === "deposit_low")?.decision).toBe("used");
  });

  it("records outcomes when deals end and compares coached with other deals", async () => {
    const a = await setup(), b = await setup();
    await coachingView(t.db, a.owner, a.id);
    await decideSuggestion(t.db, a.owner, a.id, "deposit_low", true);
    await coachingView(t.db, b.owner, b.id);
    await t.db.query("UPDATE settlement_timeline SET completed_at = now() + interval '30 days' WHERE id = $1", [a.id]);
    await t.db.query("UPDATE formal_offer SET status = 'fallen_through' WHERE id = $1", [b.offerId]);
    const stats = await coachingStatsPg(t.db);
    expect(stats.coached.settled).toBeGreaterThanOrEqual(1);
    expect(stats.uncoached.fellThrough).toBeGreaterThanOrEqual(1);
    const row = (await t.db.query("SELECT outcome, days_to_settle FROM negotiation_coaching_offers WHERE settlement_id = $1 AND suggestion_type = 'deposit_low'", [a.id])).rows[0]!;
    expect(row["outcome"]).toBe("settled");
    expect(Number(row["days_to_settle"])).toBeGreaterThanOrEqual(29);
    expect((await coachingView(t.db, b.owner, b.id)).ok && true).toBe(true);
    await expect(t.db.query("DELETE FROM negotiation_coaching_offers WHERE settlement_id = $1", [a.id])).rejects.toThrow(/permanent/);
  });
});
