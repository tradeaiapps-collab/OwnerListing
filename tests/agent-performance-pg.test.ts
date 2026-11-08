import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listFavorites, loadPerformanceFacts, pendingRatings, recentRatingComments, setFavorite, submitAgentRating } from "../src/server/agent-performance-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("agent performance on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  async function agent(listed: boolean) {
    const id = await addUser(t.db, "agent");
    await t.db.query("INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,'QLD','L-1','verified',$1, now())", [id]);
    await t.db.query("INSERT INTO agent_profile (user_id, listed, headline, bio) VALUES ($1,$2,'Bayside','')", [id, listed]);
    return id;
  }
  async function offer(listing: string, buyer: string, status: string, cents: number, at: string) {
    const link = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [link, listing, buyer]);
    await t.db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at) VALUES ($1,$2,$3,30,1000,true,$4,$5,$6)", [listing, buyer, cents, link, status, at]);
  }

  it("computes facts for the agent appointed at the time, counting fallen-through offers, and scopes to listed agents", async () => {
    const owner = await addUser(t.db, "owner"), listed = await agent(true), hidden = await agent(false), b1 = await addUser(t.db, "buyer"), b2 = await addUser(t.db, "buyer");
    const l1 = await addListing(t.db, owner, { jurisdiction: "QLD", suburb: "Ascot", price_cents: 100_000_000, created_at: "2026-09-01T00:00:00Z", status: "published" });
    const l2 = await addListing(t.db, owner, { jurisdiction: "QLD", suburb: "Ascot", price_cents: 100_000_000, created_at: "2026-09-01T00:00:00Z" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, appointed_at) VALUES ($1,$2,$3,'2026-09-01'), ($4,$5,$3,'2026-09-01')", [l1, listed, owner, l2, hidden]);
    await offer(l1, b1, "accepted", 105_000_000, "2026-10-01T00:00:00Z"); // 30 days after creation
    await offer(l2, b1, "fallen_through", 95_000_000, "2026-10-02T00:00:00Z");
    await offer(l2, b2, "rejected", 5_000, "2026-10-03T00:00:00Z");

    const mine = await loadPerformanceFacts(t.db, "2026-09-01", "2026-10-31", "listed");
    expect(mine.agents.map(a => a.agentId)).toEqual([listed]);
    expect(mine.agents[0]!.activeListings).toBe(1);
    expect(mine.offers).toEqual([{ agentId: listed, date: "2026-10-01", fellThrough: false, priceCents: 105_000_000, listCents: 100_000_000, daysToSale: 30 }]);

    const all = await loadPerformanceFacts(t.db, "2026-09-01", "2026-10-31", "all");
    expect(all.offers.filter(o => o.agentId === hidden)).toMatchObject([{ fellThrough: true }]);
    const solo = await loadPerformanceFacts(t.db, "2026-09-01", "2026-10-31", { agentId: hidden });
    expect(solo.agents.map(a => a.agentId)).toEqual([hidden]);
    expect(solo.offers).toHaveLength(1);
  });

  it("lets only the accepted buyer rate, once per sale, credits the appointed agent and never returns the buyer", async () => {
    const owner = await addUser(t.db, "owner"), ag = await agent(true), buyer = await addUser(t.db, "buyer"), other = await addUser(t.db, "buyer");
    const l = await addListing(t.db, owner, { jurisdiction: "QLD", suburb: "Ascot", created_at: "2026-09-01T00:00:00Z" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, appointed_at) VALUES ($1,$2,$3,'2026-09-01')", [l, ag, owner]);
    await offer(l, buyer, "accepted", 90_000_000, "2026-10-01T00:00:00Z");
    await offer(l, other, "rejected", 80_000_000, "2026-10-01T00:00:00Z");
    const now = "2026-10-20T00:00:00Z";
    expect(await pendingRatings(t.db, { userId: buyer, userType: "buyer" })).toMatchObject([{ listingId: l }]);
    expect(await pendingRatings(t.db, { userId: other, userType: "buyer" })).toEqual([]);
    expect(await submitAgentRating(t.db, { userId: other, userType: "buyer" }, { listingId: l, rating: 1 }, now)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await submitAgentRating(t.db, { userId: owner, userType: "owner" }, { listingId: l, rating: 5 }, now)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await submitAgentRating(t.db, { userId: buyer, userType: "buyer" }, { listingId: l, rating: 6 }, now)).toMatchObject({ ok: false, code: "invalid" });
    expect(await submitAgentRating(t.db, { userId: buyer, userType: "buyer" }, { listingId: l, rating: 4, comment: "Clear and prompt" }, now)).toMatchObject({ ok: true });
    expect(await submitAgentRating(t.db, { userId: buyer, userType: "buyer" }, { listingId: l, rating: 5 }, now)).toMatchObject({ ok: false, code: "conflict" });
    expect(await pendingRatings(t.db, { userId: buyer, userType: "buyer" })).toEqual([]);
    const facts = await loadPerformanceFacts(t.db, "2026-10-01", "2026-10-31", { agentId: ag });
    expect(facts.ratings).toEqual([{ agentId: ag, date: "2026-10-20", rating: 4, comment: "Clear and prompt" }]);
    const comments = await recentRatingComments(t.db, ag);
    expect(comments).toEqual([{ rating: 4, comment: "Clear and prompt", month: "2026-10" }]);
    expect(JSON.stringify([facts, comments])).not.toContain(buyer);
  });

  it("keeps favourites per owner, only for marketplace agents", async () => {
    const o1 = await addUser(t.db, "owner"), o2 = await addUser(t.db, "owner"), listed = await agent(true), hidden = await agent(false);
    expect(await setFavorite(t.db, { userId: o1, userType: "owner" }, listed, true)).toEqual({ ok: true, value: { favorite: true } });
    expect(await setFavorite(t.db, { userId: o1, userType: "owner" }, listed, true)).toMatchObject({ ok: true });
    expect(await setFavorite(t.db, { userId: o1, userType: "owner" }, hidden, true)).toMatchObject({ ok: false, code: "not_found" });
    expect(await setFavorite(t.db, { userId: listed, userType: "agent" }, listed, true)).toMatchObject({ ok: false, code: "forbidden" });
    expect([...(await listFavorites(t.db, o1))]).toEqual([listed]);
    expect((await listFavorites(t.db, o2)).size).toBe(0);
    await setFavorite(t.db, { userId: o1, userType: "owner" }, listed, false);
    expect((await listFavorites(t.db, o1)).size).toBe(0);
  });
});
