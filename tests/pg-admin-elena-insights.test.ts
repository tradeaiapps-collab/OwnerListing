import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadInsightFacts } from "../src/server/admin-elena-insights-db";
import type { Queryable } from "../src/server/db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("Elena admin insights facts (Postgres)", () => {
  let t: TestDb;
  let db: Queryable;
  let agentId: string, quietAgent: string;
  const range = { from: "2026-10-10", to: "2026-10-19", bucket: "week" as const }; // previous period: 2026-09-30 to 2026-10-09
  const NOW = new Date("2026-10-25T00:00:00Z");

  async function offer(listing: string, buyer: string, status: string, at: string) {
    const link = (await db.query(`INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at, used_at)
      VALUES (encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $1, $2, now() + interval '1 day', now()) RETURNING token_hash`, [listing, buyer])).rows[0]!["token_hash"];
    await db.query(`INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at)
      VALUES ($1, $2, 100, 30, 10, true, $3, $4, $5)`, [listing, buyer, link, status, at]);
  }
  async function enquiry(listing: string, buyer: string, at: string): Promise<string> {
    return String((await db.query(`INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1, $2, $3) RETURNING id`, [listing, buyer, at])).rows[0]!["id"]);
  }

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const owner = await addUser(db, "owner");
    agentId = await addUser(db, "agent");
    quietAgent = await addUser(db, "agent");
    await db.query(`UPDATE app_user SET display_name = 'Jane Citizen' WHERE id = $1`, [agentId]);
    const b1 = await addUser(db, "buyer"), b2 = await addUser(db, "buyer"), b3 = await addUser(db, "buyer");
    const pad = await addListing(db, owner, { status: "published", jurisdiction: "QLD", suburb: " Paddington ", created_at: "2026-10-11T00:00:00Z" });
    const other = await addListing(db, owner, { status: "published", jurisdiction: "NSW", suburb: null, created_at: "2026-09-01T00:00:00Z" });
    await db.query(`INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, scope) VALUES ($1, $2, $3, 'full')`, [pad, agentId, owner]);
    await db.query(`INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, scope) VALUES ($1, $2, $3, 'full')`, [other, quietAgent, owner]);
    // Current period: 2 enquiries on pad (one replied after 30 min, one never answered and older than 24h at NOW), 1 before.
    const e1 = await enquiry(pad, b1, "2026-10-12T00:00:00Z");
    await enquiry(pad, b2, "2026-10-13T00:00:00Z");
    await enquiry(pad, b3, "2026-10-05T00:00:00Z");
    await db.query(`INSERT INTO enquiry_message (enquiry_id, sender_user_id, body, sent_at) VALUES ($1, $2, 'hi', '2026-10-12T00:30:00Z')`, [e1, agentId]);
    await offer(pad, b1, "accepted", "2026-10-14T00:00:00Z");
    await offer(pad, b2, "rejected", "2026-10-15T00:00:00Z");
    await offer(pad, b3, "submitted", "2026-10-16T00:00:00Z");
    await offer(pad, b3, "accepted", "2026-10-02T00:00:00Z"); // previous period
      }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("counts both periods overall and by trimmed, lower-cased suburb", async () => {
    const f = await loadInsightFacts(db, range, NOW);
    expect(f.current).toMatchObject({ listings: 1, enquiries: 2, offers: 3, accepted: 1, decided: 2 });
    expect(f.previous).toMatchObject({ listings: 0, enquiries: 1, offers: 1, accepted: 1, decided: 1 });
    const pad = f.areas.find(a => a.suburb === "paddington")!;
    expect(pad).toMatchObject({ jurisdiction: "QLD", publishedNow: 1 });
    expect(pad.current).toMatchObject({ enquiries: 2, offers: 3 });
    expect(f.areas.find(a => a.suburb === "unknown suburb")).toMatchObject({ jurisdiction: "NSW", publishedNow: 1 });
  });

  it("measures each appointed agent: offers, unanswered enquiries and first-reply time", async () => {
    const f = await loadInsightFacts(db, range, NOW);
    expect(f.agents).toHaveLength(2);
    const a = f.agents.find(x => x.id === agentId)!;
    expect(a).toMatchObject({ name: "Jane Citizen", listings: 1, enquiries: 2, unanswered: 1, offers: 3, accepted: 1, decided: 2, medianResponseMinutes: 30 });
    expect(f.agents.find(x => x.id === quietAgent)).toMatchObject({ name: "Test agent", enquiries: 0, offers: 0 });
  });

  it("does not count an enquiry as unanswered until 24 hours have passed", async () => {
    const f = await loadInsightFacts(db, range, new Date("2026-10-13T12:00:00Z"));
    expect(f.agents.find(x => x.id === agentId)!.unanswered).toBe(0);
  });
});
