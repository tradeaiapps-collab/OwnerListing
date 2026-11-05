import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ListingServiceDeps } from "../src/domain/listing-service";
import { mapReaxml, parseConnectionInput, type FeedItem } from "../src/domain/property-feed";
import { appendAuditPg, createPgListingRepository } from "../src/server/db";
import { createPlatformComparablesSource } from "../src/server/property-intelligence";
import {
  agentImports, connectionForPush, createConnection, getConnection, importFeed, importPushedReaxml, listConnections, recentRuns,
  rotatePushToken, runDueFeeds, setConnectionEnabled, startDraftFromImport
} from "../src/server/property-feed-db";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
const NOW = "2026-11-05T00:00:00.000Z";
const xml = (status: string, extra = "", price = "1200000") => `<propertyList>
  <residential modTime="2026-11-01-10:00:00" status="${status}"><agentID>A1</agentID><uniqueID>77</uniqueID><price>${price}</price>
    <address><streetNumber>3</streetNumber><street>Feed St</street><suburb>Paddington</suburb><state>QLD</state><postcode>4064</postcode></address>
    <category name="House"/><headline>Feed home</headline><features><bedrooms>3</bedrooms><bathrooms>2</bathrooms><garages>1</garages></features>
    <listingDate>2026-09-01</listingDate>${extra}</residential>
  <residential status="current"><uniqueID>88</uniqueID><price>700000</price><address><streetNumber>1</streetNumber><street>Far Rd</street><suburb>Cairns</suburb><state>QLD</state><postcode>4870</postcode></address><category name="House"/></residential>
</propertyList>`;

describe.skipIf(!DATABASE_URL)("property feeds on PostgreSQL", () => {
  let t: TestDb;
  let staff: string, agent: string, otherAgent: string;
  const user = async (type: string) => String((await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,'U',$2,'active') RETURNING id", [`${randomUUID()}@t.au`, type])).rows[0]!["id"]);
  const conn = async (body: Record<string, unknown>) => {
    const p = parseConnectionInput(body);
    if (!p.ok) throw new Error(p.error);
    const r = await createConnection(t.db, staff, p.value, NOW);
    if (!r.ok) throw new Error(r.error);
    return { ...r, conn: (await getConnection(t.db, r.id))! };
  };
  const deps = (): ListingServiceDeps => ({
    repo: createPgListingRepository(t.db), appendAudit: e => appendAuditPg(t.db, e), now: () => NOW, newId: () => randomUUID(), requiredDisclosures: () => null
  });

  beforeAll(async () => {
    t = await createTestDb();
    staff = await user("owner");
    agent = await user("agent");
    otherAgent = await user("agent");
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("creates a CRM connection with a push token stored only as a hash, and refuses a non-agent owner", async () => {
    const { id, pushToken } = await conn({ provider: "reaxml", label: "Agency CRM", agentUserId: agent, territory: { postcodes: "4064" } });
    expect(pushToken).toMatch(/^[\w-]{40,}$/);
    const raw = await t.db.query("SELECT push_token_hash FROM feed_connection WHERE id = $1", [id]);
    expect(String(raw.rows[0]!["push_token_hash"])).not.toContain(pushToken!);
    expect((await connectionForPush(t.db, id, pushToken!))?.id).toBe(id);
    expect(await connectionForPush(t.db, id, "wrong")).toBeNull();
    const p = parseConnectionInput({ provider: "reaxml", label: "Owner CRM", agentUserId: staff, territory: { states: "QLD" } });
    expect(p.ok && await createConnection(t.db, staff, p.value, NOW)).toEqual({ ok: false, error: "That user is not an agent account." });
    const audit = await t.db.query("SELECT event_type FROM audit_event WHERE aggregate_id = $1", [id]);
    expect(audit.rows.map(r => r["event_type"])).toContain("feed.connection_created");
  });

  it("imports a pushed feed: property, listed event, staged record; outside-territory records are skipped; a resend changes nothing", async () => {
    const { conn: c } = await conn({ provider: "reaxml", label: "Push CRM", agentUserId: agent, territory: { postcodes: "4064" } });
    const run = await importPushedReaxml(t.db, c, xml("current"), NOW);
    expect(run).toMatchObject({ status: "ok", trigger: "push", fetched: 2, created: 1, skipped: 1, events: 1 });
    const again = await importPushedReaxml(t.db, c, xml("current"), NOW);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1, events: 0 });
    const ev = await t.db.query("SELECT e.event_type, e.amount_cents, e.source, p.address_text FROM property_event e JOIN property p ON p.id = e.property_id WHERE e.feed_connection_id = $1", [c.id]);
    expect(ev.rows).toEqual([{ event_type: "listed", amount_cents: "120000000", source: "licensed_third_party", address_text: "3 Feed St, Paddington QLD 4064" }]);
  });

  it("records a price change and then the sale, reusing the same property", async () => {
    const { conn: c } = await conn({ provider: "reaxml", label: "Sale CRM", agentUserId: agent, territory: { postcodes: "4064" } });
    await importFeed(t.db, c, mapReaxml(xml("current")), "staff", NOW);
    await importFeed(t.db, c, mapReaxml(xml("current", "", "1150000").replace("2026-11-01-10:00:00", "2026-11-02-10:00:00")), "staff", NOW);
    const sold = await importFeed(t.db, c, mapReaxml(xml("sold", "<soldDetails><soldPrice>1180000</soldPrice><soldDate>2026-11-03</soldDate></soldDetails>", "1150000")), "staff", NOW);
    expect(sold).toMatchObject({ updated: 1, skipped: 1, events: 1 });
    const ev = await t.db.query("SELECT event_type, amount_cents FROM property_event WHERE feed_connection_id = $1 ORDER BY occurred_at", [c.id]);
    expect(ev.rows.map(r => [r["event_type"], Number(r["amount_cents"])])).toEqual([["listed", 120_000_000], ["price_changed", 115_000_000], ["sold", 118_000_000]]);
    // Both connections matched the same street address to one property.
    const props = await t.db.query("SELECT count(*)::int AS n FROM property WHERE address_text = '3 Feed St, Paddington QLD 4064'");
    expect(props.rows[0]!["n"]).toBe(1);
  });

  it("uses sold prices in comparables only from a connection whose licence allows it", async () => {
    const subject = { transactionType: "sale" as const, propertyType: "house", suburb: "Paddington", postcode: "4064" };
    const ids = async () => (await createPlatformComparablesSource(t.db).find(subject, NOW)).map(c => c.priceCents);
    expect(await ids()).not.toContain(118_000_000);
    const { conn: lic } = await conn({ provider: "domain", label: "Domain licensed", territory: { postcodes: "4064" }, comparablesLicensed: true, licenceTerms: "Domain data licence clause 4 allows derived valuations" });
    const item = mapReaxml(xml("sold", "<soldDetails><soldPrice>1210000</soldPrice><soldDate>2026-10-20</soldDate></soldDetails>").replace("3 Feed", "4 Feed").replace("<streetNumber>3", "<streetNumber>4"));
    await importFeed(t.db, lic, item, "staff", NOW);
    expect(await ids()).toContain(121_000_000);
    expect(await ids()).not.toContain(118_000_000);
  });

  it("runs due connections once (claimed), records failures, and skips paused and push-only ones", async () => {
    const { id } = await conn({ provider: "domain", label: "Domain due", territory: { states: "QLD" } });
    await t.db.query("UPDATE feed_connection SET next_run_at = $2 WHERE id = $1", [id, "2026-11-04T16:00:00Z"]);
    const { id: pushOnly } = await conn({ provider: "reaxml", label: "Push only due", agentUserId: agent, territory: { states: "QLD" } });
    await t.db.query("UPDATE feed_connection SET next_run_at = $2 WHERE id = $1", [pushOnly, "2026-11-04T16:00:00Z"]);
    const runs = await runDueFeeds(t.db, async () => Response.json([]), {}, NOW);
    expect(runs.filter(r => r.connectionId === id)).toEqual([expect.objectContaining({ status: "failed", error: expect.stringContaining("not set up") })]);
    expect(runs.some(r => r.connectionId === pushOnly)).toBe(false);
    expect((await getConnection(t.db, id))!.nextRunAt).toBe("2026-11-05T16:00:00.000Z");
    expect(await runDueFeeds(t.db, async () => Response.json([]), {}, NOW)).toEqual([]);
    await setConnectionEnabled(t.db, staff, id, false, NOW);
    await t.db.query("UPDATE feed_connection SET next_run_at = $2 WHERE id = $1", [id, "2026-11-04T16:00:00Z"]);
    expect(await runDueFeeds(t.db, async () => Response.json([]), {}, NOW)).toEqual([]);
    expect(await recentRuns(t.db, id)).toHaveLength(1);
    const listed = (await listConnections(t.db)).find(c => c.id === id)!;
    expect(listed).toMatchObject({ enabled: false, lastRun: { status: "failed" } });
  });

  it("never changes the facts of a property it matched, and keeps unlicensed listings out of days on market", async () => {
    const own = await t.db.query("INSERT INTO property (address_text, state, suburb, postcode, property_type, bedrooms) VALUES ('8 Owner Rd, Paddington QLD 4064','QLD','Paddington','4064','house',5) RETURNING id");
    const pid = String(own.rows[0]!["id"]);
    await t.db.query("INSERT INTO property_event (property_id, event_type, occurred_at, amount_cents, source) VALUES ($1,'sold','2026-10-30T00:00:00Z',99900000,'platform')", [pid]);
    const { conn: c } = await conn({ provider: "reaxml", label: "Overwrite CRM", agentUserId: agent, territory: { postcodes: "4064" } });
    const feed = `<propertyList><residential status="current"><uniqueID>own-1</uniqueID><price>500000</price><listingDate>2026-01-01</listingDate>
      <address><streetNumber>8</streetNumber><street>Owner Rd</street><suburb>Paddington</suburb><state>QLD</state><postcode>4064</postcode></address>
      <category name="Unit"/><features><bedrooms>1</bedrooms></features></residential></propertyList>`;
    expect(await importPushedReaxml(t.db, c, feed, NOW)).toMatchObject({ created: 1, events: 1 });
    const p = await t.db.query("SELECT property_type, bedrooms FROM property WHERE id = $1", [pid]);
    expect(p.rows[0]).toEqual({ property_type: "house", bedrooms: 5 });
    const sale = (await createPlatformComparablesSource(t.db).find({ transactionType: "sale", propertyType: "house", suburb: "Paddington", postcode: "4064" }, NOW))
      .find(r => r.priceCents === 99_900_000);
    expect(sale).toBeDefined();
    expect(sale!.daysOnMarket).toBeUndefined();
  });

  it("rotating the push token retires the old one", async () => {
    const { id, pushToken } = await conn({ provider: "reaxml", label: "Rotate", agentUserId: agent, territory: { states: "QLD" } });
    const next = await rotatePushToken(t.db, staff, id, NOW);
    expect(await connectionForPush(t.db, id, pushToken!)).toBeNull();
    expect((await connectionForPush(t.db, id, next!))?.id).toBe(id);
  });

  it("shows agents only their own imports and starts one draft per record", async () => {
    const { conn: c } = await conn({ provider: "reaxml", label: "Draft CRM", agentUserId: agent, territory: { postcodes: "4064" } });
    await importPushedReaxml(t.db, c, xml("current").replaceAll("77", "99"), NOW);
    const mine = (await agentImports(t.db, agent)).filter(i => i.connectionId === c.id);
    expect(mine).toHaveLength(1);
    expect((await agentImports(t.db, otherAgent)).length).toBe(0);
    const actor = { userId: agent, userType: "agent" as const };
    expect(await startDraftFromImport(t.db, deps(), { userId: otherAgent, userType: "agent" }, c.id, mine[0]!.externalId)).toMatchObject({ ok: false, status: 404 });
    expect(await startDraftFromImport(t.db, deps(), { userId: staff, userType: "owner" }, c.id, mine[0]!.externalId)).toMatchObject({ ok: false, status: 403 });
    const first = await startDraftFromImport(t.db, deps(), actor, c.id, mine[0]!.externalId);
    expect(first).toMatchObject({ ok: true, created: true });
    const second = await startDraftFromImport(t.db, deps(), actor, c.id, mine[0]!.externalId);
    expect(second).toEqual({ ok: true, listingId: first.ok ? first.listingId : "", created: false });
    const l = await t.db.query("SELECT owner_user_id, status, title, price_cents, property_id FROM property_listing WHERE id = $1", [first.ok ? first.listingId : ""]);
    expect(l.rows[0]).toMatchObject({ owner_user_id: agent, status: "draft", title: "Feed home", price_cents: "120000000" });
    expect(l.rows[0]!["property_id"]).toBeTruthy();
    const item = (await agentImports(t.db, agent)).find(i => i.connectionId === c.id)!;
    expect(item.draftListingId).toBe(first.ok ? first.listingId : "");
    expect((item.item as FeedItem).address).toBe("3 Feed St, Paddington QLD 4064");
  });
});
