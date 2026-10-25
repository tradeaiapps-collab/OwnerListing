import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_COUNTER_FROM, WITHDRAWABLE } from "../src/domain/offer-counter";
import { statusesAllowing } from "../src/domain/offer-decision";
import { buyerAgreePg, buyerCounterPg, buyerWithdrawPg, expireCountersPg, ownerCounterPg, type NewCounter } from "../src/server/offer-counter-db";
import { decideOfferPg } from "../src/server/offer-flow-db";
import { offerTimelinePg } from "../src/server/offer-timeline-db";
import { submitOfferPg } from "../src/server/offers-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL: every offer state change writes its timeline row in the same statement.
// formal_offer.submitted_at is the database clock, so the scripted steps run a day ahead of it to stay in order.
const T0 = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 86_400_000).toISOString();
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();
const terms = (priceCents: number) => ({ priceCents, depositCents: priceCents / 10, settlementDays: 30, conditions: ["Building inspection"] });

describe.skipIf(!DATABASE_URL)("offer timeline (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  async function offer() {
    const owner = await addUser(db, "owner");
    const buyer = await addUser(db, "buyer");
    const listingId = await addListing(db, owner, { status: "published" });
    const tokenHash = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3,$4)", [tokenHash, listingId, buyer, at(24)]);
    const saved = await submitOfferPg(db, { tokenHash, listingId, priceCents: 90_000_000, conditions: ["Finance approval"], settlementDays: 42, depositCents: 9_000_000, now: T0 });
    return { owner, buyer, listingId, offerId: saved!.id };
  }
  const counter = (offerId: string, userId: string, priceCents: number, h: number, replyHours = 72): NewCounter =>
    ({ offerId, userId, now: at(h), expiresAt: at(h + replyHours), ...terms(priceCents) });
  const shape = async (offerId: string) =>
    (await offerTimelinePg(db, offerId)).map(e => [e.type, e.actor, e.fromStatus ?? null, e.toStatus, e.terms?.priceCents ?? null]);

  it("records every step of a negotiation in order, with the terms of each step", async () => {
    const o = await offer();
    const c1 = await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 98_000_000, 1));
    await buyerCounterPg(db, counter(o.offerId, o.buyer, 93_000_000, 2));
    const c3 = await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 95_000_000, 3));
    await buyerAgreePg(db, o.offerId, o.buyer, c3!.id, at(4));
    await decideOfferPg(db, o.listingId, o.offerId, o.owner, statusesAllowing("accept"), "accepted", at(5));
    expect(await shape(o.offerId)).toEqual([
      ["submitted", "buyer", null, "submitted", 90_000_000],
      ["countered", "owner", "submitted", "countered", 98_000_000],
      ["buyer_countered", "buyer", "countered", "buyer_countered", 93_000_000],
      ["countered", "owner", "buyer_countered", "countered", 95_000_000],
      ["buyer_agreed", "buyer", "countered", "buyer_countered", 95_000_000],
      ["accepted", "owner", "buyer_countered", "accepted", 95_000_000]
    ]);
    const tl = await offerTimelinePg(db, o.offerId);
    expect(tl.map(e => e.round ?? null)).toEqual([null, 1, 2, 3, 3, 3]);
    expect(tl[1]!.occurredAt).toBe(at(1));
    expect(c1?.round).toBe(1);
    // Actors are roles only: no user ids leave the database through the timeline.
    expect(JSON.stringify(tl)).not.toContain(o.owner);
    expect(JSON.stringify(tl)).not.toContain(o.buyer);
  });

  it("records accept on the original terms, reject, a counter request and a withdrawal", async () => {
    const a = await offer();
    await decideOfferPg(db, a.listingId, a.offerId, a.owner, statusesAllowing("accept"), "accepted", at(1));
    expect((await shape(a.offerId)).at(-1)).toEqual(["accepted", "owner", "submitted", "accepted", 90_000_000]);

    const b = await offer();
    await decideOfferPg(db, b.listingId, b.offerId, b.owner, statusesAllowing("counter_request"), "countered", at(1));
    await decideOfferPg(db, b.listingId, b.offerId, b.owner, statusesAllowing("reject"), "rejected", at(2));
    expect((await shape(b.offerId)).slice(1)).toEqual([
      ["counter_requested", "owner", "submitted", "countered", null],
      ["rejected", "owner", "countered", "rejected", null]
    ]);

    const c = await offer();
    await buyerWithdrawPg(db, c.offerId, c.buyer, WITHDRAWABLE, at(1));
    expect((await shape(c.offerId)).at(-1)).toEqual(["withdrawn", "buyer", "submitted", "withdrawn", null]);
  });

  it("records expiry as a system event at the moment the counter lapsed, once", async () => {
    const o = await offer();
    await ownerCounterPg(db, o.listingId, OWNER_COUNTER_FROM, counter(o.offerId, o.owner, 98_000_000, 1, 24));
    await expireCountersPg(db, at(30), { offerId: o.offerId });
    await expireCountersPg(db, at(31), { offerId: o.offerId });
    const last = (await offerTimelinePg(db, o.offerId)).at(-1)!;
    expect([last.type, last.actor, last.fromStatus, last.toStatus, last.occurredAt, last.round]).toEqual(["expired", "system", "countered", "expired", at(25), 1]);
    expect((await offerTimelinePg(db, o.offerId)).filter(e => e.type === "expired")).toHaveLength(1);
  });

  it("writes no event when an action is refused", async () => {
    const o = await offer();
    expect(await buyerCounterPg(db, counter(o.offerId, o.buyer, 95_000_000, 1))).toBeUndefined();
    expect(await decideOfferPg(db, o.listingId, o.offerId, randomUUID(), statusesAllowing("accept"), "accepted", at(1))).toBe(false);
    expect(await shape(o.offerId)).toHaveLength(1);
  });

  it("is append-only and enforces who may accept or expire", async () => {
    const o = await offer();
    await expect(db.query("UPDATE offer_event SET to_status = 'accepted' WHERE offer_id = $1", [o.offerId])).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM offer_event WHERE offer_id = $1", [o.offerId])).rejects.toThrow(/append-only/);
    await expect(db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, to_status) VALUES ($1, 'accepted', 'buyer', $2, 'accepted')",
      [o.offerId, o.buyer])).rejects.toThrow(/check constraint/);
    await expect(db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, to_status) VALUES ($1, 'accepted', 'system', 'accepted')",
      [o.offerId])).rejects.toThrow(/check constraint/);
    await expect(db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, to_status) VALUES ($1, 'expired', 'owner', $2, 'expired')",
      [o.offerId, o.owner])).rejects.toThrow(/check constraint/);
  });
});

describe.skipIf(!DATABASE_URL)("offer timeline backfill migration (Postgres)", () => {
  const name = `ol_test_${randomUUID().replace(/-/g, "")}`;
  let client: pg.Client;
  const dbDir = path.join(process.cwd(), "db");
  const TIMELINE = "20261025200000_offer_events.sql";

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${name}`;
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    for (const f of (await readdir(dbDir)).filter(f => f.endsWith(".sql") && f < TIMELINE).sort()) await client.query(await readFile(path.join(dbDir, f), "utf8"));
  }, 60_000);
  afterAll(async () => {
    await client?.end();
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("gives offers made before the migration a timeline from formal_offer, the audit log and lapsed counters", async () => {
    const q = async (text: string, p: unknown[] = []) => (await client.query(text, p)).rows;
    const user = async (type: string) => String((await q("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,'T',$2,'active') RETURNING id", [`${randomUUID()}@example.test`, type]))[0]!["id"]);
    const owner = await user("owner");
    const buyer = await user("buyer");
    const listing = String((await q(`INSERT INTO property_listing (owner_user_id, jurisdiction, transaction_type, use_class, property_type, title, address_text, status)
      VALUES ($1,'QLD','sale','residential','house','Home','1 Test St','published') RETURNING id`, [owner]))[0]!["id"]);
    const newOffer = async (submitted: string) => {
      const hash = randomUUID().replace(/-/g, "").padEnd(64, "0");
      await q("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3,now() + interval '1 day')", [hash, listing, buyer]);
      return String((await q(`INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, submitted_at)
        VALUES ($1,$2,90000000,42,9000000,TRUE,$3,$4) RETURNING id`, [listing, buyer, hash, submitted]))[0]!["id"]);
    };
    const audit = (offerId: string, actor: string, type: string, payload: object, occurred: string) =>
      q(`INSERT INTO audit_event (occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload)
        VALUES ($1,'user',$2,'formal_offer',$3,$4,'c',$5::jsonb)`, [occurred, actor, offerId, type, JSON.stringify(payload)]);

    const accepted = await newOffer(at(0));
    await q("UPDATE formal_offer SET status = 'accepted' WHERE id = $1", [accepted]);
    await audit(accepted, owner, "offer.countered", { decision: "counter_request", from: "submitted", to: "countered" }, at(1));
    await audit(accepted, owner, "offer.accepted", { decision: "accept", from: "countered", to: "accepted" }, at(2));

    const lapsed = await newOffer(at(0));
    const counterId = String((await q(`INSERT INTO offer_counter (offer_id, round, from_party, created_by, price_cents, settlement_days, deposit_cents, status, created_at, expires_at, closed_at)
      VALUES ($1,1,'owner',$2,98000000,30,0,'expired',$3,$4,$4) RETURNING id`, [lapsed, owner, at(1), at(25)]))[0]!["id"]);
    await q("UPDATE formal_offer SET status = 'expired' WHERE id = $1", [lapsed]);
    await audit(lapsed, owner, "offer.countered", { counterId, round: 1, from: "submitted" }, at(1));

    await client.query(await readFile(path.join(dbDir, TIMELINE), "utf8"));
    const events = async (id: string) => (await q("SELECT event_type, actor_kind, to_status, price_cents FROM offer_event WHERE offer_id = $1 ORDER BY occurred_at", [id]))
      .map(r => [r["event_type"], r["actor_kind"], r["to_status"], r["price_cents"] === null ? null : Number(r["price_cents"])]);
    expect(await events(accepted)).toEqual([
      ["submitted", "buyer", "submitted", 90_000_000], ["counter_requested", "owner", "countered", null], ["accepted", "owner", "accepted", null]
    ]);
    expect(await events(lapsed)).toEqual([
      ["submitted", "buyer", "submitted", 90_000_000], ["countered", "owner", "countered", 98_000_000], ["expired", "system", "expired", null]
    ]);
  });
});
