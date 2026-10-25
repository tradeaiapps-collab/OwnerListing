import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_COUNTER_FROM, WITHDRAWABLE } from "../src/domain/offer-counter";
import { statusesAllowing } from "../src/domain/offer-decision";
import {
  buyerAgreePg, buyerCounterPg, buyerWithdrawPg, countersForOfferPg, expireCountersPg, offersForBuyerPg, ownerCounterPg, type NewCounter
} from "../src/server/offer-counter-db";
import { decideOfferPg } from "../src/server/offer-flow-db";
import { offersForOwnerPg, submitOfferPg } from "../src/server/offers-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL: the counter-offer statements are guarded single statements, so their WHERE clauses are the rules.
const T0 = "2026-10-25T00:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();
const terms = (priceCents: number) => ({ priceCents, depositCents: priceCents / 10, settlementDays: 30, conditions: ["Building inspection"] });

describe.skipIf(!DATABASE_URL)("counter-offers (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  /** A published listing with one submitted 900k offer from a buyer. */
  async function offer() {
    const owner = await addUser(db, "owner");
    const buyer = await addUser(db, "buyer");
    const listingId = await addListing(db, owner, { status: "published" });
    const tokenHash = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3,$4)", [tokenHash, listingId, buyer, at(24)]);
    const saved = await submitOfferPg(db, { tokenHash, listingId, priceCents: 90_000_000, conditions: ["Finance approval"], settlementDays: 42, depositCents: 9_000_000, now: T0 });
    return { owner, buyer, listingId, offerId: saved!.id };
  }
  const counter = (offerId: string, userId: string, priceCents: number, now = at(1), expiresAt = at(73)): NewCounter =>
    ({ offerId, userId, now, expiresAt, ...terms(priceCents) });
  const status = async (offerId: string) => String((await db.query("SELECT status FROM formal_offer WHERE id = $1", [offerId])).rows[0]!["status"]);
  const ownerView = async (o: { listingId: string; owner: string; offerId: string }) => (await offersForOwnerPg(db, o.listingId, o.owner, o.offerId))[0]!;

  it("runs a full back-and-forth: owner counters, buyer counters, owner counters again, buyer agrees, owner accepts", async () => {
    const o = await offer();
    const c1 = await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 98_000_000));
    expect(c1?.round).toBe(1);
    expect(await status(o.offerId)).toBe("countered");
    expect((await ownerView(o)).openCounter?.priceCents).toBe(98_000_000);
    // Standing buyer terms are still the original offer while the owner's counter waits.
    expect((await ownerView(o)).priceCents).toBe(90_000_000);

    const c2 = await buyerCounterPg(db, counter(o.offerId, o.buyer, 93_000_000, at(2), at(74)));
    expect(c2?.round).toBe(2);
    expect(await status(o.offerId)).toBe("buyer_countered");
    expect((await ownerView(o)).priceCents).toBe(93_000_000);
    expect((await ownerView(o)).openCounter).toBeUndefined();

    const c3 = await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 95_000_000, at(3), at(75)));
    expect(c3?.round).toBe(3);
    expect(await buyerAgreePg(db, o.offerId, o.buyer, c3!.id, at(4))).toBe(true);
    expect(await status(o.offerId)).toBe("buyer_countered");
    expect((await ownerView(o)).priceCents).toBe(95_000_000);

    expect(await decideOfferPg(db, o.listingId, o.offerId, o.owner, statusesAllowing("accept"), "accepted", at(5))).toBe(true);
    const row = (await db.query("SELECT status, accepted_counter_id FROM formal_offer WHERE id = $1", [o.offerId])).rows[0]!;
    expect(row).toEqual({ status: "accepted", accepted_counter_id: c3!.id });
    expect((await ownerView(o)).priceCents).toBe(95_000_000);
    expect((await countersForOfferPg(db, o.offerId)).map(c => [c.round, c.fromParty, c.status])).toEqual([
      [1, "owner", "countered"], [2, "buyer", "countered"], [3, "owner", "agreed"]
    ]);
  });

  it("accepting the buyer's open counter accepts those terms and closes the counter", async () => {
    const o = await offer();
    await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 98_000_000));
    const c2 = await buyerCounterPg(db, counter(o.offerId, o.buyer, 94_000_000, at(2), at(74)));
    expect(await decideOfferPg(db, o.listingId, o.offerId, o.owner, statusesAllowing("accept"), "accepted", at(3))).toBe(true);
    const counters = await countersForOfferPg(db, o.offerId);
    expect(counters.find(c => c.id === c2!.id)?.status).toBe("accepted");
    expect((await ownerView(o)).priceCents).toBe(94_000_000);
  });

  it("rejecting closes the open counter as rejected", async () => {
    const o = await offer();
    await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 98_000_000));
    await buyerCounterPg(db, counter(o.offerId, o.buyer, 94_000_000, at(2), at(74)));
    expect(await decideOfferPg(db, o.listingId, o.offerId, o.owner, statusesAllowing("reject"), "rejected", at(3))).toBe(true);
    expect((await countersForOfferPg(db, o.offerId)).at(-1)?.status).toBe("rejected");
    expect(await status(o.offerId)).toBe("rejected");
  });

  it("enforces turns: the owner cannot counter twice in a row or accept while their own counter waits", async () => {
    const o = await offer();
    await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 98_000_000));
    expect(await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 97_000_000))).toBeUndefined();
    expect(await decideOfferPg(db, o.listingId, o.offerId, o.owner, statusesAllowing("accept"), "accepted", at(2))).toBe(false);
    // The buyer cannot counter twice either.
    await buyerCounterPg(db, counter(o.offerId, o.buyer, 93_000_000, at(2), at(74)));
    expect(await buyerCounterPg(db, counter(o.offerId, o.buyer, 94_000_000, at(3), at(75)))).toBeUndefined();
    expect((await countersForOfferPg(db, o.offerId))).toHaveLength(2);
  });

  it("the buyer cannot counter before the owner has countered or asked for a counter", async () => {
    const o = await offer();
    expect(await buyerCounterPg(db, counter(o.offerId, o.buyer, 95_000_000))).toBeUndefined();
    // After a plain request for a counter (no terms), the buyer may answer.
    expect(await decideOfferPg(db, o.listingId, o.offerId, o.owner, statusesAllowing("counter_request"), "countered", at(1))).toBe(true);
    expect((await buyerCounterPg(db, counter(o.offerId, o.buyer, 95_000_000, at(2), at(74))))?.round).toBe(1);
  });

  it("only the owner of the listing and only the buyer of the offer can act", async () => {
    const o = await offer();
    const stranger = await addUser(db, "owner");
    const otherBuyer = await addUser(db, "buyer");
    expect(await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, stranger, 98_000_000))).toBeUndefined();
    const c1 = await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 98_000_000));
    expect(await buyerCounterPg(db, counter(o.offerId, otherBuyer, 95_000_000))).toBeUndefined();
    expect(await buyerAgreePg(db, o.offerId, otherBuyer, c1!.id, at(2))).toBe(false);
    expect(await buyerWithdrawPg(db, o.offerId, otherBuyer, WITHDRAWABLE, at(2))).toBe(false);
    expect(await offersForBuyerPg(db, otherBuyer)).toEqual([]);
    expect((await offersForBuyerPg(db, o.buyer)).map(x => x.id)).toEqual([o.offerId]);
  });

  it("stops at the round limit", async () => {
    const o = await offer();
    for (let round = 1; round <= 10; round++) {
      const c = round % 2 === 1
        ? await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 99_000_000 - round * 100_000, at(round), at(round + 72)))
        : await buyerCounterPg(db, counter(o.offerId, o.buyer, 90_000_000 + round * 100_000, at(round), at(round + 72)));
      expect(c?.round).toBe(round);
    }
    // Round 10 was the buyer's; the owner cannot make an 11th, but can still accept or reject.
    expect(await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 95_000_000, at(11), at(83)))).toBeUndefined();
    expect(await decideOfferPg(db, o.listingId, o.offerId, o.owner, statusesAllowing("accept"), "accepted", at(11))).toBe(true);
  });

  it("an unanswered counter expires the offer; an expired counter cannot be agreed to", async () => {
    const o = await offer();
    const c1 = await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 98_000_000, at(1), at(25)));
    expect(await expireCountersPg(db, at(24), { offerId: o.offerId })).toEqual([]);
    expect(await buyerAgreePg(db, o.offerId, o.buyer, c1!.id, at(26))).toBe(false);
    expect(await buyerCounterPg(db, counter(o.offerId, o.buyer, 95_000_000, at(26), at(98)))).toBeUndefined();
    expect(await expireCountersPg(db, at(26), { listingId: o.listingId })).toEqual([o.offerId]);
    expect(await status(o.offerId)).toBe("expired");
    const c = (await countersForOfferPg(db, o.offerId))[0]!;
    expect([c.status, c.closedAt]).toEqual(["expired", at(25)]);
    expect(await decideOfferPg(db, o.listingId, o.offerId, o.owner, statusesAllowing("accept"), "accepted", at(27))).toBe(false);
  });

  it("the buyer can withdraw mid-negotiation but not after acceptance", async () => {
    const o = await offer();
    await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 98_000_000));
    expect(await buyerWithdrawPg(db, o.offerId, o.buyer, WITHDRAWABLE, at(2))).toBe(true);
    expect(await status(o.offerId)).toBe("withdrawn");
    expect((await countersForOfferPg(db, o.offerId))[0]?.status).toBe("withdrawn");

    const p = await offer();
    await decideOfferPg(db, p.listingId, p.offerId, p.owner, statusesAllowing("accept"), "accepted", at(1));
    expect(await buyerWithdrawPg(db, p.offerId, p.buyer, WITHDRAWABLE, at(2))).toBe(false);
  });

  it("the database refuses a second open counter, edits to closed rows' terms are not checked here but bad terms are", async () => {
    const o = await offer();
    const c1 = await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 98_000_000));
    await expect(db.query(
      "INSERT INTO offer_counter (offer_id, round, from_party, created_by, price_cents, settlement_days, deposit_cents, expires_at) VALUES ($1, 2, 'buyer', $2, 1, 1, 0, now() + interval '1 day')",
      [o.offerId, o.buyer]
    )).rejects.toThrow(/offer_counter_one_open/);
    await expect(db.query("UPDATE offer_counter SET deposit_cents = price_cents + 1 WHERE id = $1", [c1!.id])).rejects.toThrow(/check constraint/);
    await expect(db.query("UPDATE offer_counter SET status = 'agreed', closed_at = now(), from_party = 'buyer' WHERE id = $1", [c1!.id])).rejects.toThrow(/check constraint/);
  });

  it("only one of two concurrent owner counters wins", async () => {
    const o = await offer();
    const results = await Promise.all([
      ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 98_000_000)),
      ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 97_000_000))
    ].map(p => p.catch(() => undefined)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await countersForOfferPg(db, o.offerId)).toHaveLength(1);
  });
});
