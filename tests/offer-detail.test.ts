import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { depositBps, formatBps, historyWithDeltas, isOpen, timelineFor, versusAsking, type OfferTerms } from "../src/domain/offer-detail";
import { decideOfferPg } from "../src/server/offer-flow-db";
import { offerDetailPg, submitOfferPg } from "../src/server/offers-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const offer = (o: Partial<OfferTerms> = {}): OfferTerms => ({
  id: "o1", priceCents: 100_000_000, depositCents: 10_000_000, settlementDays: 42, conditions: [], status: "submitted", submittedAt: "2026-10-20T00:00:00.000Z", ...o
});

describe("offer detail shaping", () => {
  it("compares with the asking price in cents and basis points", () => {
    expect(versusAsking(97_500_000, 100_000_000)).toEqual({ cents: -2_500_000, bps: -250 });
    expect(versusAsking(100_000_000, undefined)).toBeUndefined();
    expect(formatBps(-250)).toBe("−2.5%");
    expect(formatBps(125)).toBe("+1.25%");
    expect(formatBps(0)).toBe("0%");
  });
  it("gives the deposit share", () => {
    expect(depositBps(offer())).toBe(1000);
  });
  it("orders the timeline and starts it from the offer when no events exist", () => {
    expect(timelineFor(offer(), [])).toEqual([{ type: "submitted", actor: "buyer", at: "2026-10-20T00:00:00.000Z", priceCents: 100_000_000, settlementDays: 42 }]);
    const t = timelineFor(offer(), [
      { type: "rejected", actor: "owner", at: "2026-10-22T00:00:00.000Z" },
      { type: "submitted", actor: "buyer", at: "2026-10-20T00:00:00.000Z" }
    ]);
    expect(t.map(e => e.type)).toEqual(["submitted", "rejected"]);
  });
  it("shows the price change between a buyer's offers", () => {
    const h = historyWithDeltas([offer({ id: "a", priceCents: 95_000_000 }), offer({ id: "b", priceCents: 98_000_000 })]);
    expect(h[0]!.deltaCents).toBeUndefined();
    expect(h[1]!.deltaCents).toBe(3_000_000);
  });
  it("knows which statuses are still open", () => {
    expect(["submitted", "under_review", "countered", "buyer_countered"].every(isOpen)).toBe(true);
    expect(["accepted", "rejected", "withdrawn"].some(isOpen)).toBe(false);
  });
});

describe.skipIf(!DATABASE_URL)("offer history in Postgres", () => {
  let t: TestDb;
  let owner = "", buyer = "", listing = "", other = "";
  beforeAll(async () => {
    t = await createTestDb();
    owner = await addUser(t.db, "owner");
    buyer = await addUser(t.db, "buyer");
    listing = await addListing(t.db, owner, { status: "published", price_cents: 100_000_000 });
    other = await addListing(t.db, owner, { status: "published" });
    await t.db.query("INSERT INTO buyer_verification (user_id, email_verified_at, id_verified_at) VALUES ($1, now(), now())", [buyer]);
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  async function submit(priceCents: number, now: string) {
    const tokenHash = randomBytes(32).toString("hex");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')", [tokenHash, listing, buyer]);
    return (await submitOfferPg(t.db, { tokenHash, listingId: listing, priceCents, conditions: ["Subject to finance"], settlementDays: 30, depositCents: priceCents / 10, now }))!;
  }

  it("writes the submitted event with the offer and the decision event with the status change", async () => {
    const first = await submit(95_000_000, "2026-10-20T01:00:00.000Z");
    expect(await decideOfferPg(t.db, listing, first.id, owner, ["submitted"], "countered", "2026-10-20T02:00:00.000Z")).toBe(true);
    const second = await submit(98_000_000, "2026-10-21T01:00:00.000Z");
    // A decision that does not apply writes nothing, not even history.
    expect(await decideOfferPg(t.db, listing, first.id, owner, ["submitted"], "rejected", "2026-10-21T02:00:00.000Z")).toBe(false);

    const d = (await offerDetailPg(t.db, listing, second.id))!;
    expect(d.offer.priceCents).toBe(98_000_000);
    expect(d.history.map(h => h.priceCents)).toEqual([95_000_000, 98_000_000]);
    expect(d.buyer).toEqual({ emailVerified: true, phoneVerified: false, idVerified: true });
    expect(JSON.stringify(d)).not.toContain(buyer);
    const firstDetail = (await offerDetailPg(t.db, listing, first.id))!;
    expect(firstDetail.events.map(e => [e.type, e.actor])).toEqual([["submitted", "buyer"], ["countered", "owner"]]);
  });

  it("finds nothing for an offer id under another listing", async () => {
    const o = await submit(99_000_000, "2026-10-22T01:00:00.000Z");
    expect(await offerDetailPg(t.db, other, o.id)).toBeUndefined();
  });

  it("includes the buyer's enquiry thread, labelled by side", async () => {
    const e = String((await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1, $2) RETURNING id", [listing, buyer])).rows[0]!["id"]);
    await t.db.query("INSERT INTO enquiry_message (enquiry_id, sender_user_id, body, sent_at) VALUES ($1, $2, 'Is it available?', '2026-10-19T00:00:00Z'), ($1, $3, 'Yes it is.', '2026-10-19T01:00:00Z')", [e, buyer, owner]);
    const o = await submit(97_000_000, "2026-10-23T01:00:00.000Z");
    const d = (await offerDetailPg(t.db, listing, o.id))!;
    expect(d.enquiryId).toBe(e);
    expect(d.messages.map(m => [m.from, m.body])).toEqual([["buyer", "Is it available?"], ["owner", "Yes it is."]]);
  });

  it("refuses to change or delete history, and refuses an accept by anyone but the owner", async () => {
    const o = await submit(96_000_000, "2026-10-24T01:00:00.000Z");
    await expect(t.db.query("UPDATE offer_event SET actor_kind = 'system' WHERE offer_id = $1", [o.id])).rejects.toThrow(/append-only/);
    await expect(t.db.query("DELETE FROM offer_event WHERE offer_id = $1", [o.id])).rejects.toThrow(/append-only/);
    await expect(t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind) VALUES ($1, 'accepted', 'ai')", [o.id])).rejects.toThrow();
  });
});
