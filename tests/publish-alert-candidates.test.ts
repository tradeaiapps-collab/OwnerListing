import { describe, expect, it } from "vitest";
import type { AlertPreference, ListingSummary, SavedSearch } from "../src/domain/buyer";
import { planAlerts } from "../src/domain/buyer";
import type { DeliveryLogEntry } from "../src/domain/alerts";
import type { PropertyListing } from "../src/domain/listing";
import { createPublishAlertHook } from "../src/domain/publish-alerts";
import { buildAlertCandidateQuery } from "../src/server/publish-alerts-db";

const summary: ListingSummary = { id: "l1", status: "published", jurisdiction: "QLD", suburb: " New Farm ", transactionType: "sale", useClass: "residential", propertyType: "house", priceCents: 5, bedrooms: 2 };
const search = (id: string, buyerUserId = "b1", o: Partial<SavedSearch> = {}): SavedSearch =>
  ({ id, buyerUserId, transactionType: "sale", useClass: "residential", jurisdictions: ["QLD"], suburbs: [], propertyTypes: [], active: true, ...o });
const consent: AlertPreference = { channel: "email", consentGivenAt: "2026-01-01T00:00:00Z" };
const listing = { ...summary, ownerUserId: "o", ownerUserType: "owner", title: "t", address: "a", disclosures: [], createdAt: "x", updatedAt: "x" } as unknown as PropertyListing;

describe("planAlerts with several searches per buyer", () => {
  it("plans one alert per buyer and channel, from a search that actually matches", () => {
    const searches = [search("s1", "b1", { jurisdictions: ["NSW"] }), search("s2"), search("s3")];
    expect(planAlerts(summary, searches, { b1: [consent] })).toEqual([{ buyerUserId: "b1", searchId: "s2", channel: "email", listingId: "l1" }]);
  });
});

describe("publish alert hook", () => {
  const run = async (searches: SavedSearch[], handledSearchIds: string[], seen: ListingSummary[] = []) => {
    const log: DeliveryLogEntry[] = [];
    await createPublishAlertHook({
      loadSearches: async l => { seen.push(l); return searches; },
      loadPrefs: async () => ({ b1: [consent], b2: [consent] }),
      loadHandled: async () => ({ sentKeys: new Set<string>(), searchIds: new Set(handledSearchIds) }),
      port: { send: async () => "sent" }, unsubscribeUrlFor: () => "http://t/u", now: () => "n", log: async e => { log.push(e); }
    })(listing);
    return log;
  };

  it("evaluates a buyer against all their searches: a second matching search alerts when the first was already attempted", async () => {
    const log = await run([search("s1"), search("s2")], ["s1"]);
    expect(log.map(e => [e.buyerUserId, e.searchId, e.outcome])).toEqual([["b1", "s2", "sent"]]);
  });

  it("still sends one alert per buyer when several searches match, and nothing when every match was attempted", async () => {
    expect((await run([search("s1"), search("s2"), search("s3", "b2")], [])).map(e => e.buyerUserId)).toEqual(["b1", "b2"]);
    expect(await run([search("s1"), search("s2")], ["s1", "s2"])).toEqual([]);
  });

  it("keeps matchesSearch as the final authority over whatever loadSearches returns", async () => {
    const seen: ListingSummary[] = [];
    const log = await run([search("bad", "b1", { jurisdictions: ["NSW"] }), search("inactive", "b2", { active: false })], [], seen);
    expect(log).toEqual([]);
    expect(seen[0]).toMatchObject({ id: "l1", jurisdiction: "QLD" });
  });
});

describe("buildAlertCandidateQuery", () => {
  it("is constant SQL with the listing facts as parameters", () => {
    const a = buildAlertCandidateQuery(summary);
    const b = buildAlertCandidateQuery({ ...summary, suburb: "x'; DROP TABLE saved_search;--", priceCents: 9 });
    expect(a.text).toBe(b.text);
    expect(a.text).not.toMatch(/DROP|New Farm|QLD/);
    expect(a.params.slice(0, 7)).toEqual(["sale", "residential", "QLD", "house", "new farm", 5, 2]);
    expect(b.params[4]).toBe("x'; drop table saved_search;--");
    expect(a.text).toMatch(/LIMIT \$8/);
  });

  it("passes null for facts the listing lacks", () => {
    const { suburb: _s, priceCents: _p, bedrooms: _b, ...bare } = summary;
    expect(buildAlertCandidateQuery(bare).params.slice(4, 7)).toEqual([null, null, null]);
  });
});
