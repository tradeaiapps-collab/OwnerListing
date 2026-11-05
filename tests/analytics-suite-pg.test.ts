import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAgentFacts, loadSaleFacts, listAgencyTeams } from "../src/server/analytics-suite-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("analytics suite on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("reads recorded sales for the forecast, leaving out voided and unlicensed rows", async () => {
    const prop = String((await t.db.query("INSERT INTO property (address_text, state, suburb, property_type) VALUES ('1 A St','QLD','Paddington','house') RETURNING id")).rows[0]!["id"]);
    const ev = (at: string, cents: number, source = "platform") =>
      t.db.query("INSERT INTO property_event (property_id, event_type, occurred_at, amount_cents, source) VALUES ($1,'sold',$2,$3,$4) RETURNING id", [prop, at, cents, source]);
    await ev("2026-03-31T15:00:00Z", 90_000_000); // 1 Apr in Brisbane
    await ev("2026-05-10T00:00:00Z", 95_000_000, "owner_supplied");
    const v = String((await ev("2026-06-10T00:00:00Z", 1_000)).rows[0]!["id"]);
    await t.db.query("UPDATE property_event SET voided_at = now(), voided_by = 'staff', void_reason = 'fell through' WHERE id = $1", [v]);
    await ev("2023-01-10T00:00:00Z", 50_000_000);
    expect(await loadSaleFacts(t.db, "2024-01")).toEqual([{ month: "2026-04", suburb: "Paddington", propertyType: "house", priceCents: 90_000_000 }]);
  });

  it("credits sales, enquiries and commission to the agent appointed at the time, and filters by team", async () => {
    const owner = await addUser(t.db, "owner"), a1 = await addUser(t.db, "agent"), a2 = await addUser(t.db, "agent"), buyer = await addUser(t.db, "buyer"), b2 = await addUser(t.db, "buyer");
    const l1 = await addListing(t.db, owner, { jurisdiction: "QLD", suburb: "Ascot", price_cents: 100_000_000, created_at: "2026-09-01T00:00:00Z" });
    const rent = await addListing(t.db, owner, { jurisdiction: "QLD", suburb: "Ascot", transaction_type: "rent", price_cents: 80_000 });
    // a2 held l1 until 1 Oct, then a1.
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, appointed_at, revoked_at) VALUES ($1,$2,$3,'2026-09-01','2026-10-01')", [l1, a2, owner]);
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, appointed_at) VALUES ($1,$2,$3,'2026-10-01'), ($4,$2,$3,'2026-10-01')", [l1, a1, owner, rent]);
    await t.db.query("INSERT INTO audit_event (occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id) VALUES ('2026-09-05T00:00:00Z','user',$1,'listing',$2,'listing.published','c')", [owner, l1]);
    const offer = async (listing: string, by: string, status: string, cents: number, at: string) => {
      const link = randomUUID().replace(/-/g, "").padEnd(64, "0");
      await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [link, listing, by]);
      await t.db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at) VALUES ($1,$2,$3,30,1000,true,$4,$5,$6)", [listing, by, cents, link, status, at]);
    };
    await offer(l1, buyer, "accepted", 98_000_000, "2026-10-15T00:00:00Z");
    await offer(l1, b2, "rejected", 90_000_000, "2026-09-20T00:00:00Z");
    await offer(rent, buyer, "accepted", 80_000, "2026-10-16T00:00:00Z");
    await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1,$2,'2026-09-10T00:00:00Z'), ($1,$3,'2026-10-12T00:00:00Z')", [l1, b2, buyer]);
    const admin = await addUser(t.db, "admin");
    await t.db.query(
      `INSERT INTO commission_deal (agent_user_id, listing_id, title, sale_price_cents, kind, rate_bps, calculated_cents, status, deal_date, created_by)
       VALUES ($1,$2,'Sale',98000000,'percentage',200,1960000,'expected','2026-10-15',$3), ($1,$2,'Old',98000000,'percentage',200,5,'cancelled','2026-10-15',$3)`, [a1, l1, admin]);

    const f = await loadAgentFacts(t.db, "2026-09-01", "2026-10-31");
    expect(f.agents.map(a => a.agentId).sort()).toEqual([a1, a2].sort());
    expect(f.agents.find(a => a.agentId === a1)).toMatchObject({ primaryArea: "Ascot", medianListCents: 100_000_000 });
    expect(f.sales).toEqual([{ agentId: a1, date: "2026-10-15", priceCents: 98_000_000, listCents: 100_000_000, daysOnMarket: 40 }]);
    expect(f.enquiries.sort((x, y) => x.date.localeCompare(y.date))).toEqual([
      { agentId: a2, date: "2026-09-10", enquiries: 1, converted: 1 },
      { agentId: a1, date: "2026-10-12", enquiries: 1, converted: 1 }
    ]);
    expect(f.commissions).toEqual([{ agentId: a1, date: "2026-10-15", cents: 1_960_000 }]);

    const team = String((await t.db.query("INSERT INTO agency_team (name, created_by) VALUES ('North office', $1) RETURNING id", [a2])).rows[0]!["id"]);
    await t.db.query("INSERT INTO agency_team_member (team_id, user_id, role, added_by) VALUES ($1,$2,'manager',$2)", [team, a2]);
    const only = await loadAgentFacts(t.db, "2026-09-01", "2026-10-31", team);
    expect(only.agents.map(a => a.agentId)).toEqual([a2]);
    expect(only.sales).toEqual([]);
    expect(only.commissions).toEqual([]);
    expect(await listAgencyTeams(t.db)).toEqual([{ id: team, name: "North office" }]);
  });
});
