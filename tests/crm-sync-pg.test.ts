import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearLeadOverride, getWorkspace, overrideLeadScore } from "../src/domain/agent-workspace";
import type { Actor } from "../src/domain/listing-service";
import { verifySignature } from "../src/domain/webhooks";
import { createWorkspaceDeps, loadScoringConfig } from "../src/server/agent-workspace-db";
import { deliverDue, disableOutbound, enableOutbound, getOutbound, recentDeliveries, sweepStatusChanges } from "../src/server/crm-sync-db";
import type { SendInput } from "../src/server/webhook-delivery";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("CRM status sync and lead scoring on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const hourAgo = () => new Date(Date.now() - 3600_000).toISOString();
  async function setup() {
    await t.db.query("DELETE FROM crm_outbound_delivery"); // deliverDue works on every connection, so each test starts with an empty queue
    const owner = await addUser(t.db, "owner"), agent = await addUser(t.db, "agent"), staff = await addUser(t.db, "owner");
    const listing = await addListing(t.db, owner, { jurisdiction: "QLD", title: "8 Owner Rd", status: "published", suburb: "Paddington", postcode: "4064" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listing, agent, owner]);
    const c = await t.db.query("INSERT INTO feed_connection (provider, label, agent_user_id, created_by) VALUES ('reaxml','Test CRM',$1,$2) RETURNING id", [agent, staff]);
    return { owner, agent, staff, listing, conn: String(c.rows[0]!["id"]) };
  }
  const sold = async (listing: string, cents = 91_000_000) => {
    const p = await t.db.query("INSERT INTO property (address_text, state) VALUES ('8 Owner Rd','QLD') RETURNING id");
    const ev = await t.db.query("INSERT INTO property_event (property_id, listing_id, event_type, occurred_at, amount_cents, source) VALUES ($1,$2,'sold', now(), $3,'platform') RETURNING id", [p.rows[0]!["id"], listing, cents]);
    return String(ev.rows[0]!["id"]);
  };
  const ok = async () => ({ status: 200 });

  it("rejects bad addresses, keeps the secret out of reads, and starts quietly", async () => {
    const s = await setup();
    expect(await enableOutbound(t.db, s.staff, s.conn, "http://crm.example.com/h", hourAgo())).toMatchObject({ ok: false });
    expect(await enableOutbound(t.db, s.staff, s.conn, "https://127.0.0.1/h", hourAgo())).toMatchObject({ ok: false });
    expect(await enableOutbound(t.db, s.staff, randomUUID(), "https://crm.example.com/h", hourAgo())).toEqual({ ok: false, message: "Connection not found." });
    const r = await enableOutbound(t.db, s.staff, s.conn, "https://crm.example.com/h", hourAgo());
    expect(r).toMatchObject({ ok: true });
    expect(JSON.stringify(await getOutbound(t.db, s.conn))).not.toContain("whsec_");
    expect(await getOutbound(t.db, s.conn)).toMatchObject({ enabled: true, url: "https://crm.example.com/h", failures: 0 });
    // The listing was already live: the first sweep records it without sending anything.
    expect(await sweepStatusChanges(t.db)).toBe(0);
    expect((await t.db.query("SELECT status FROM crm_sync_state WHERE connection_id = $1", [s.conn])).rows).toEqual([{ status: "active" }]);
  });

  it("queues one signed event when a listing sells, once, and not for voided sales", async () => {
    const s = await setup();
    const en = await enableOutbound(t.db, s.staff, s.conn, "https://crm.example.com/h", hourAgo());
    if (!en.ok) throw new Error(en.message);
    await sweepStatusChanges(t.db);
    const ev = await sold(s.listing);
    expect(await sweepStatusChanges(t.db)).toBe(1);
    expect(await sweepStatusChanges(t.db)).toBe(0);
    const sent: SendInput[] = [];
    const counts = await deliverDue(t.db, async i => { sent.push(i); return { status: 204 }; });
    expect(counts).toMatchObject({ delivered: 1, retried: 0, failed: 0 });
    const m = sent.find(i => JSON.parse(i.body).data.listingId === s.listing)!;
    const body = JSON.parse(m.body);
    expect(body).toMatchObject({ type: "listing.sold", data: { status: "sold", title: "8 Owner Rd", suburb: "Paddington", priceCents: 91_000_000 } });
    expect(m.url).toBe("https://crm.example.com/h");
    expect(verifySignature(en.secret, m.body, m.headers["ol-signature"]!, Math.floor(Date.now() / 1000))).toBe(true);
    expect((await recentDeliveries(t.db, s.conn))[0]).toMatchObject({ eventType: "listing.sold", state: "delivered", attempts: 1 });
    // The sale is reversed (voided): the listing is live again and the CRM hears that.
    await t.db.query("UPDATE property_event SET voided_at = now(), voided_by = $2, void_reason = 'Sale fell through' WHERE id = $1", [ev, s.staff]);
    expect(await sweepStatusChanges(t.db)).toBe(1);
    const again: SendInput[] = [];
    await deliverDue(t.db, async i => { again.push(i); return { status: 200 }; });
    expect(JSON.parse(again.find(i => JSON.parse(i.body).data.listingId === s.listing)!.body).type).toBe("listing.reactivated");
  });

  it("sends delisted for withdrawn or archived, and ignores suspended", async () => {
    const s = await setup();
    await enableOutbound(t.db, s.staff, s.conn, "https://crm.example.com/h", hourAgo());
    await sweepStatusChanges(t.db);
    await t.db.query("UPDATE property_listing SET status = 'suspended' WHERE id = $1", [s.listing]);
    expect(await sweepStatusChanges(t.db)).toBe(0);
    await t.db.query("UPDATE property_listing SET status = 'withdrawn', updated_at = now() WHERE id = $1", [s.listing]);
    expect(await sweepStatusChanges(t.db)).toBe(1);
    expect((await recentDeliveries(t.db, s.conn))[0]).toMatchObject({ eventType: "listing.delisted", state: "pending" });
  });

  it("does not send other agents' listings, and nothing while paused or switched off", async () => {
    const s = await setup();
    const other = await addUser(t.db, "owner");
    const stranger = await addListing(t.db, other, { jurisdiction: "QLD", title: "Not mine", status: "published" });
    await enableOutbound(t.db, s.staff, s.conn, "https://crm.example.com/h", hourAgo());
    await sweepStatusChanges(t.db);
    await sold(stranger);
    expect(await sweepStatusChanges(t.db)).toBe(0);
    await disableOutbound(t.db, s.staff, s.conn, new Date().toISOString());
    await sold(s.listing);
    expect(await sweepStatusChanges(t.db)).toBe(0);
  });

  it("retries a failing CRM with backoff, then switches sync off after 10 failures", async () => {
    const s = await setup();
    await enableOutbound(t.db, s.staff, s.conn, "https://crm.example.com/h", hourAgo());
    await sweepStatusChanges(t.db);
    await sold(s.listing);
    await sweepStatusChanges(t.db);
    expect(await deliverDue(t.db, async () => ({ status: 500 }))).toMatchObject({ delivered: 0, retried: 1 });
    const row = (await recentDeliveries(t.db, s.conn))[0]!;
    expect(row).toMatchObject({ state: "pending", attempts: 1, lastStatus: 500 });
    // Not due yet: nothing is sent until the backoff passes.
    let calls = 0;
    expect(await deliverDue(t.db, async () => { calls++; return { status: 200 }; })).toMatchObject({ delivered: 0 });
    expect(calls).toBe(0);
    await t.db.query("UPDATE feed_connection SET outbound_failures = 9 WHERE id = $1", [s.conn]);
    await t.db.query("UPDATE crm_outbound_delivery SET next_attempt_at = now(), attempts = 4 WHERE id = $1", [row.id]);
    expect(await deliverDue(t.db, async () => { throw new Error("connect refused"); })).toMatchObject({ failed: 1 });
    expect((await recentDeliveries(t.db, s.conn))[0]).toMatchObject({ state: "failed", attempts: 5, lastError: "connect refused" });
    expect(await getOutbound(t.db, s.conn)).toMatchObject({ enabled: false });
    expect(await sweepStatusChanges(t.db)).toBe(0);
  });

  it("a delivery queued before sync is switched off is marked failed, not sent", async () => {
    const s = await setup();
    await enableOutbound(t.db, s.staff, s.conn, "https://crm.example.com/h", hourAgo());
    await sweepStatusChanges(t.db);
    await sold(s.listing);
    await sweepStatusChanges(t.db);
    await disableOutbound(t.db, s.staff, s.conn, new Date().toISOString());
    let calls = 0;
    expect(await deliverDue(t.db, async () => { calls++; return { status: 200 }; })).toMatchObject({ failed: 1, delivered: 0 });
    expect(calls).toBe(0);
    expect((await recentDeliveries(t.db, s.conn))[0]).toMatchObject({ state: "failed", lastError: "sync switched off" });
  });

  it("scoring rules are one row that the database keeps valid", async () => {
    expect(await loadScoringConfig(t.db)).toEqual({ hotMin: 70, warmMin: 40, weights: { engagement: 60, fit: 25, followUp: 15 } });
    await expect(t.db.query("UPDATE lead_scoring_setting SET w_fit = 30 WHERE id = 1")).rejects.toThrow();
    await expect(t.db.query("UPDATE lead_scoring_setting SET warm_min = 70 WHERE id = 1")).rejects.toThrow();
    await expect(t.db.query("INSERT INTO lead_scoring_setting (id, hot_min, warm_min, w_engagement, w_fit, w_follow_up) VALUES (2,70,40,60,25,15)")).rejects.toThrow();
  });

  it("scores property fit from saved searches and lets the agent override, privately", async () => {
    const owner = await addUser(t.db, "owner"), a1 = await addUser(t.db, "agent"), a2 = await addUser(t.db, "agent"), buyer = await addUser(t.db, "buyer");
    for (const a of [a1, a2]) await t.db.query("INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,'QLD','L-1','verified',$1, now())", [a]);
    const listing = await addListing(t.db, owner, { jurisdiction: "QLD", title: "Fit Home", status: "published", suburb: "Paddington", price_cents: 90_000_000, bedrooms: 3 });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listing, a1, owner]);
    const enq = String((await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2) RETURNING id", [listing, buyer])).rows[0]!["id"]);
    await t.db.query("INSERT INTO saved_search (buyer_user_id, criteria) VALUES ($1, $2::jsonb)", [buyer, JSON.stringify({ transactionType: "sale", suburbs: ["Paddington"], minBedrooms: 3, maxPriceCents: 95_000_000 })]);

    const d = createWorkspaceDeps(t.db);
    const me: Actor = { userId: a1, userType: "agent" }, other: Actor = { userId: a2, userType: "agent" };
    const first = await getWorkspace(d, me);
    if (!first.ok) throw new Error(first.message);
    const lead = first.value.leads[0]!;
    expect(lead).toMatchObject({ fitPercent: 100 });
    expect(lead.overridden).toBeUndefined();
    expect(lead.reasons).toContain("100% match to saved searches");

    expect(await overrideLeadScore(d, me, enq, { score: 97, reason: "Pre-approved, wants to offer" })).toEqual({ ok: true, value: true });
    expect(await overrideLeadScore(d, other, enq, { score: 1, reason: "sneaky" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await overrideLeadScore(d, me, enq, { score: 200, reason: "bad" })).toMatchObject({ ok: false, code: "invalid" });
    const second = await getWorkspace(d, me);
    if (!second.ok) throw new Error(second.message);
    expect(second.value.leads[0]).toMatchObject({ score: 97, band: "hot", overridden: true, autoScore: lead.score });
    expect(second.value.performance.hot).toBe(1);

    expect(await clearLeadOverride(d, other, enq)).toMatchObject({ ok: false, code: "not_found" });
    expect(await clearLeadOverride(d, me, enq)).toEqual({ ok: true, value: true });
    const third = await getWorkspace(d, me);
    if (!third.ok) throw new Error(third.message);
    expect(third.value.leads[0]!.score).toBe(lead.score);

    // Staff change the thresholds: the same lead moves band without any change by the agent.
    await t.db.query("UPDATE lead_scoring_setting SET hot_min = $1, warm_min = 1 WHERE id = 1", [Math.min(100, lead.score + 1)]);
    const fourth = await getWorkspace(d, me);
    if (!fourth.ok) throw new Error(fourth.message);
    expect(fourth.value.leads[0]!.band).toBe("warm");
    await t.db.query("UPDATE lead_scoring_setting SET hot_min = 70, warm_min = 40 WHERE id = 1");
  });
});
