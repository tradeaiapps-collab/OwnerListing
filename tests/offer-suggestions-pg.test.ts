import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgAiDraftRepository } from "../src/server/ai-records-db";
import { enquiryForOfferPg, sameBuyerOffersPg } from "../src/server/offer-suggestions-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("offer suggestion queries on Postgres", () => {
  let t: TestDb;
  let owner: string, b1: string, b2: string, listing: string, other: string;
  const addOffer = async (l: string, buyer: string, price: number, at: string, status = "submitted") => {
    const hash = randomBytes(32).toString("hex");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at, used_at) VALUES ($1,$2,$3, now() + interval '1 day', now())", [hash, l, buyer]);
    const r = await t.db.query(
      `INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at)
       VALUES ($1,$2,$3,30,0,true,$4,$5,$6) RETURNING id`, [l, buyer, price, hash, status, at]);
    return String(r.rows[0]!["id"]);
  };
  beforeAll(async () => {
    t = await createTestDb();
    owner = await addUser(t.db, "owner"); b1 = await addUser(t.db, "buyer"); b2 = await addUser(t.db, "buyer");
    listing = await addListing(t.db, owner, { status: "published" });
    other = await addListing(t.db, owner, { status: "published" });
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("finds only the same buyer's other offers on the same listing, without returning who they are", async () => {
    const first = await addOffer(listing, b1, 70_000_000, "2026-10-20T00:00:00Z", "countered");
    const now = await addOffer(listing, b1, 75_000_000, "2026-10-22T00:00:00Z");
    await addOffer(listing, b2, 90_000_000, "2026-10-21T00:00:00Z");
    await addOffer(other, b1, 50_000_000, "2026-10-21T00:00:00Z");
    const h = await sameBuyerOffersPg(t.db, listing, now);
    expect(h).toEqual([{ priceCents: 70_000_000, submittedAt: "2026-10-20T00:00:00.000Z", status: "countered" }]);
    expect(JSON.stringify(h)).not.toContain(b1);
    expect(await sameBuyerOffersPg(t.db, other, now)).toEqual([]);
    expect((await sameBuyerOffersPg(t.db, listing, first)).map(x => x.priceCents)).toEqual([75_000_000]);
  });

  it("finds the buyer's thread for an offer, and an offer response draft can point at it", async () => {
    const off = await addOffer(listing, b2, 88_000_000, "2026-10-23T00:00:00Z");
    expect(await enquiryForOfferPg(t.db, listing, off)).toBeUndefined();
    const e = String((await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2) RETURNING id", [listing, b2])).rows[0]!["id"]);
    expect(await enquiryForOfferPg(t.db, listing, off)).toBe(e);
    expect(await enquiryForOfferPg(t.db, other, off)).toBeUndefined();
    const repo = createPgAiDraftRepository(t.db);
    const id = randomUUID();
    await repo.insert({
      id, kind: "offer_response", listingId: listing, offerId: off, enquiryId: e, action: "request_information", text: "Could you confirm finance?",
      policyDecision: { mayDraft: true, requiresHumanApproval: true, withinMandate: false, reason: "No mandate." }, guardResult: { ok: true, violations: [] },
      engineId: "ollama:x", modelVersion: "1", promptVersion: "offer-response@1", inputHash: "b".repeat(64), status: "pending", createdBy: owner, createdAt: new Date().toISOString()
    });
    expect((await repo.get(id))?.offerId).toBe(off);
  });
});
