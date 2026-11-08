import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatOfferPg, createPgTurnRepository, verifiedDisclosuresPg } from "../src/server/chat-assistant-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("enquiry assistant (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  async function world() {
    const owner = await addUser(db, "owner");
    const buyer = await addUser(db, "buyer");
    const listing = await addListing(db, owner);
    const enquiry = String((await db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2) RETURNING id", [listing, buyer])).rows[0]!["id"]);
    return { owner, buyer, listing, enquiry };
  }
  const offer = async (listing: string, buyer: string, price: number, ago: string) => {
    const hash = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at, used_at) VALUES ($1,$2,$3, now() + interval '1 day', now())", [hash, listing, buyer]);
    return String((await db.query(
      `INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, conditions, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at)
       VALUES ($1,$2,$3,'["Subject to finance"]'::jsonb,30,$4,true,$5,'submitted', now() - $6::interval) RETURNING id`,
      [listing, buyer, price, price / 10, hash, ago]
    )).rows[0]!["id"]);
  };

  it("stores turns in order and refuses edits and deletes", async () => {
    const w = await world();
    const repo = createPgTurnRepository(db);
    const base = { enquiryId: w.enquiry, askedByUserId: w.buyer, askedByRole: "buyer" as const, topic: "offer" as const, pose: "tablet" as const };
    await repo.add({ ...base, id: randomUUID(), question: "First?", answer: "One.", createdAt: "2026-10-30T01:00:00.000Z" });
    await repo.add({ ...base, id: randomUUID(), question: "Second?", answer: "Two.", createdAt: "2026-10-30T02:00:00.000Z" });
    const list = await repo.list(w.enquiry);
    expect(list.map(x => x.question)).toEqual(["First?", "Second?"]);
    await expect(db.query("UPDATE enquiry_assistant_turn SET answer = 'x'")).rejects.toThrow();
    await expect(db.query("DELETE FROM enquiry_assistant_turn")).rejects.toThrow();
  });

  it("the table rejects an unknown pose or role", async () => {
    const w = await world();
    await expect(db.query(
      "INSERT INTO enquiry_assistant_turn (enquiry_id, asked_by_user_id, asked_by_role, question, topic, pose, answer) VALUES ($1,$2,'staff','q','offer','tablet','a')",
      [w.enquiry, w.buyer]
    )).rejects.toThrow();
    await expect(db.query(
      "INSERT INTO enquiry_assistant_turn (enquiry_id, asked_by_user_id, asked_by_role, question, topic, pose, answer) VALUES ($1,$2,'buyer','q','offer','dance','a')",
      [w.enquiry, w.buyer]
    )).rejects.toThrow();
  });

  it("reads the buyer's newest offer with its newest counter, and nothing for another buyer", async () => {
    const w = await world();
    expect(await chatOfferPg(db, w.listing, w.buyer)).toBeUndefined();
    await offer(w.listing, w.buyer, 100_000_000, "2 days");
    const id = await offer(w.listing, w.buyer, 105_000_000, "1 day");
    await db.query(
      `INSERT INTO offer_counter (offer_id, round, from_party, created_by, price_cents, settlement_days, deposit_cents, status, expires_at)
       VALUES ($1, 1, 'owner', $2, 110000000, 45, 11000000, 'open', now() + interval '2 days')`,
      [id, w.owner]
    );
    const o = await chatOfferPg(db, w.listing, w.buyer);
    expect(o).toMatchObject({ priceCents: 105_000_000, settlementDays: 30, conditions: ["Subject to finance"], counter: { fromParty: "owner", priceCents: 110_000_000, settlementDays: 45, status: "open" } });
    expect(await chatOfferPg(db, w.listing, await addUser(db, "buyer"))).toBeUndefined();
    expect(await verifiedDisclosuresPg(db, w.listing)).toBe(0);
  });
});
