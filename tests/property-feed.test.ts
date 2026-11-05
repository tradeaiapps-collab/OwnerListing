import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDraftInput } from "../src/domain/listing-service";
import {
  domainListings, domainSearchBody, draftFromItem, eventsFor, feedUrlOk, inTerritory, mapDomainListing, mapReaxml, nextRunAt,
  parseConnectionInput, parseFeedDate, parseTerritory, stableJson, type FeedItem
} from "../src/domain/property-feed";
import { parseXml, XmlError } from "../src/domain/xml-lite";

const SAMPLE = readFileSync(path.join(__dirname, "fixtures", "reaxml-sample.xml"), "utf8");
const NOW = "2026-11-05T00:00:00.000Z";
const items = () => {
  const r = mapReaxml(SAMPLE);
  if ("error" in r) throw new Error(r.error);
  return r;
};
const byId = (id: string) => items().items.find(i => i.externalId === id)!;

describe("xml-lite", () => {
  it("parses elements, attributes, entities and CDATA", () => {
    const doc = parseXml(`<?xml version="1.0"?><a x='1' y="&lt;2&gt;"><!-- c --><b>Tom &amp; Jo &#169;</b><c><![CDATA[<raw>]]></c><d/></a>`);
    expect(doc.attrs).toEqual({ x: "1", y: "<2>" });
    expect(doc.children.map(c => [c.name, c.text])).toEqual([["b", "Tom & Jo ©"], ["c", "<raw>"], ["d", ""]]);
  });
  it("refuses DOCTYPE (no DTDs or external entities), unknown entities and broken nesting", () => {
    expect(() => parseXml(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>`)).toThrow(XmlError);
    expect(() => parseXml("<x>&e;</x>")).toThrow(/Unknown entity/);
    expect(() => parseXml("<x><y></x></y>")).toThrow(XmlError);
    expect(() => parseXml("<x>")).toThrow(/Unclosed/);
    expect(() => parseXml("<a/><b/>")).toThrow(/one root/);
  });
  it("reads attributes in linear time, even from a long run of name characters", () => {
    const t0 = Date.now();
    expect(() => parseXml(`<a ${"x".repeat(1_000_000)}/>`)).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(parseXml(`<a b = "1" c='&amp;' d e="2"/>`).attrs).toEqual({ b: "1", c: "&", e: "2" });
    expect(() => parseXml(`<a b="1/>`)).toThrow(XmlError);
  });
  it("never resolves Object.prototype names as entities or lookup keys", () => {
    expect(() => parseXml("<x>&constructor;</x>")).toThrow(/Unknown entity/);
    const r = mapReaxml(`<propertyList><residential status="constructor"><uniqueID>1</uniqueID><address><suburb>A</suburb><state>QLD</state></address><category name="toString"/></residential></propertyList>`);
    expect(r).toMatchObject({ items: [], rejected: [{ reason: expect.stringContaining("Unknown status") }] });
  });
  it("caps nesting depth", () => {
    expect(() => parseXml("<a>".repeat(100) + "</a>".repeat(100))).toThrow(/deeply/);
  });
});

describe("REAXML mapping", () => {
  it("maps a current residential sale with full address, price, features and land", () => {
    expect(byId("RWP01:1001")).toMatchObject({
      status: "active", transactionType: "sale", useClass: "residential", propertyType: "townhouse", streetAddress: true,
      address: "2/14 Latrobe Tce, Paddington QLD 4064", suburb: "Paddington", state: "QLD", postcode: "4064",
      priceCents: 125_000_000, priceDisplay: "Offers over $1.25m", bedrooms: 3, bathrooms: 2, parking: 2, landAreaSqm: 220,
      headline: "Light-filled townhouse & garden", description: "Three bedrooms, <b>two</b> bathrooms.",
      listedAt: "2026-10-19T14:00:00.000Z", modifiedAt: "2026-11-02T23:15:00.000Z"
    });
  });
  it("turns a monthly rent into a weekly rent and reads state names", () => {
    expect(byId("RWP01:2001")).toMatchObject({ status: "leased", transactionType: "rent", propertyType: "unit", state: "QLD", priceCents: 60_000 });
  });
  it("keeps the sold price and date on a sold listing, even when the price is not displayed", () => {
    expect(byId("RWP01:1002")).toMatchObject({ status: "sold", soldPriceCents: 95_500_000, soldAt: "2026-10-27T14:00:00.000Z", parking: 2 });
  });
  it("maps land (lot number, hectares) and a commercial lease", () => {
    expect(byId("3001")).toMatchObject({ propertyType: "land", address: "Lot 12 Ridge Rd, Samford Valley QLD 4520", landAreaSqm: 15_000, priceCents: 48_000_000 });
    const shop = byId("4001");
    expect(shop).toMatchObject({ useClass: "commercial", propertyType: "retail", transactionType: "rent" });
    expect(shop.priceCents).toBeUndefined();
  });
  it("rejects records without an Australian state and skips unsupported kinds", () => {
    const r = items();
    expect(r.items).toHaveLength(5);
    expect(r.rejected).toEqual([{ externalId: "5001", reason: "Address has no suburb or Australian state." }]);
  });
  it("answers an error for a non-REAXML or broken document", () => {
    expect(mapReaxml("<rss/>")).toEqual({ error: "Not a REAXML feed (expected <propertyList>)." });
    expect(mapReaxml("<propertyList>")).toHaveProperty("error");
  });
});

describe("Domain mapping", () => {
  const sale = { type: "PropertyListing", listing: { id: 2019000001, listingType: "Sale", priceDetails: { price: 1100000, displayPrice: "$1.1m" },
    propertyDetails: { state: "QLD", propertyType: "House", bedrooms: 4, bathrooms: 2, carspaces: 2, unitNumber: "", streetNumber: "7", street: "Hale Street", suburb: "PADDINGTON", postcode: "4064", landArea: 405, latitude: -27.46, longitude: 152.99 },
    headline: "Family home", summaryDescription: "<p>Big yard</p>", dateListed: "2026-10-01T09:00:00", dateUpdated: "2026-11-01T09:00:00Z" } };
  const project = { type: "Project", listings: [{ id: 5, listingType: "Sale", propertyDetails: { state: "QLD", propertyType: "ApartmentUnitFlat", suburb: "Newstead", postcode: "4006" } }] };
  it("flattens listings and projects", () => {
    expect(domainListings([sale, project, { type: "Other" }]).map(l => l["id"])).toEqual([2019000001, 5]);
    expect(domainListings({ nope: 1 })).toEqual([]);
  });
  it("maps a sale listing", () => {
    expect(mapDomainListing(domainListings([sale])[0]!, "Sale")).toMatchObject({
      externalId: "2019000001", status: "active", propertyType: "house", address: "7 Hale Street, PADDINGTON QLD 4064", streetAddress: true,
      priceCents: 110_000_000, bedrooms: 4, parking: 2, landAreaSqm: 405, latitude: -27.46, description: "Big yard", modifiedAt: "2026-11-01T09:00:00.000Z"
    });
  });
  it("maps a sold result and hides nothing it does not know", () => {
    const sold = mapDomainListing({ id: 9, listingType: "Sale", priceDetails: { price: 950000 }, propertyDetails: { state: "QLD", propertyType: "Townhouse", suburb: "Red Hill", postcode: "4059" }, soldData: { soldDate: "2026-10-12" } }, "Sold");
    expect(sold).toMatchObject({ status: "sold", soldPriceCents: 95_000_000, soldAt: "2026-10-11T14:00:00.000Z", streetAddress: false, address: "Red Hill QLD 4059" });
    expect((sold as FeedItem).priceCents).toBeUndefined();
  });
  it("rejects listings without an id or state, and drops coordinates outside Australia", () => {
    expect(mapDomainListing({ propertyDetails: {} }, "Sale")).toEqual({ reject: "No listing id." });
    expect(mapDomainListing({ id: 1, propertyDetails: { suburb: "X", state: "CA" } }, "Sale")).toMatchObject({ reject: expect.stringContaining("state") });
    expect(mapDomainListing({ id: 1, propertyDetails: { suburb: "X", state: "QLD", latitude: 40, longitude: -70 } }, "Sale")).not.toHaveProperty("latitude");
  });
  it("searches postcodes and suburbs, or whole states when that is all there is", () => {
    const t = parseTerritory({ states: "QLD", postcodes: "4064", suburbs: "Red Hill" });
    if (!t.ok) throw new Error();
    const b = domainSearchBody(t.value, "Sold", 2);
    expect(b).toMatchObject({ listingType: "Sold", pageNumber: 2, pageSize: 100 });
    expect((b["locations"] as unknown[]).length).toBe(2);
    expect(domainSearchBody({ states: ["QLD", "NSW"], postcodes: [], suburbs: [] }, "Sale", 1)["locations"]).toHaveLength(2);
  });
});

describe("territory, settings and schedule", () => {
  it("filters by state, then by postcode or suburb", () => {
    const t = parseTerritory({ states: ["qld"], postcodes: ["4064"], suburbs: "Red Hill" });
    expect(t).toEqual({ ok: true, value: { states: ["QLD"], postcodes: ["4064"], suburbs: ["Red Hill"] } });
    if (!t.ok) return;
    expect(inTerritory(t.value, { state: "QLD", postcode: "4064", suburb: "Paddington" })).toBe(true);
    expect(inTerritory(t.value, { state: "QLD", postcode: "4059", suburb: "red hill" })).toBe(true);
    expect(inTerritory(t.value, { state: "QLD", postcode: "4000", suburb: "Brisbane City" })).toBe(false);
    expect(inTerritory(t.value, { state: "NSW", postcode: "4064", suburb: "Paddington" })).toBe(false);
    expect(inTerritory({ states: [], postcodes: [], suburbs: [] }, { state: "WA", suburb: "Perth" })).toBe(true);
    expect(parseTerritory({ states: "XX" })).toMatchObject({ ok: false });
    expect(parseTerritory({ postcodes: "40640" })).toMatchObject({ ok: false });
  });
  it("only allows public https pull addresses without credentials", () => {
    expect(feedUrlOk("https://feeds.vaultre.com.au/agency/123.xml")).toBe(true);
    for (const u of ["http://feeds.example.com/x", "https://user:pw@feeds.example.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x",
      "https://192.168.1.1/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://intranet/x", "https://feeds.example.com:8443/x", "not a url"]) expect(feedUrlOk(u), u).toBe(false);
  });
  it("validates a new connection", () => {
    const agent = "11111111-2222-3333-4444-555555555555";
    expect(parseConnectionInput({ provider: "reaxml", label: "Ray White Paddington", agentUserId: agent, territory: { states: "QLD" } }))
      .toMatchObject({ ok: true, value: { provider: "reaxml", schedule: "daily", sourceUrl: null, comparablesLicensed: false } });
    expect(parseConnectionInput({ provider: "reaxml", label: "No agent" })).toMatchObject({ ok: false, error: expect.stringContaining("agent") });
    expect(parseConnectionInput({ provider: "reaxml", label: "No area", agentUserId: agent })).toMatchObject({ ok: false, error: expect.stringContaining("territory") });
    expect(parseConnectionInput({ provider: "reaxml", label: "CRM comps", agentUserId: agent, territory: { states: "QLD" }, comparablesLicensed: true, licenceTerms: "Agency says we can use it" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("cannot be used in comparables") });
    expect(parseConnectionInput({ provider: "domain", label: "Domain QLD" })).toMatchObject({ ok: false, error: expect.stringContaining("territory") });
    expect(parseConnectionInput({ provider: "domain", label: "Domain QLD", territory: { states: "QLD" }, comparablesLicensed: true, licenceTerms: "ok" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("licence") });
    expect(parseConnectionInput({ provider: "domain", label: "Domain QLD", territory: { states: "QLD" }, comparablesLicensed: true, licenceTerms: "Domain Business plan clause 4.2 allows derived valuations" }))
      .toMatchObject({ ok: true, value: { comparablesLicensed: true } });
    expect(parseConnectionInput({ provider: "reaxml", label: "Bad url", agentUserId: agent, territory: { states: "QLD" }, sourceUrl: "https://10.1.1.1/feed" })).toMatchObject({ ok: false });
    expect(parseConnectionInput({ provider: "zillow", label: "Nope" })).toMatchObject({ ok: false, error: "Choose a provider." });
  });
  it("schedules daily runs at 02:00 Queensland time and weekly ones on Sunday", () => {
    expect(nextRunAt("daily", "2026-11-05T10:00:00.000Z")).toBe("2026-11-05T16:00:00.000Z");
    expect(nextRunAt("daily", "2026-11-05T16:00:00.000Z")).toBe("2026-11-06T16:00:00.000Z");
    expect(nextRunAt("weekly", "2026-11-05T10:00:00.000Z")).toBe("2026-11-07T16:00:00.000Z"); // Sunday 8 Nov 02:00 AEST
    expect(nextRunAt("manual", NOW)).toBeNull();
  });
  it("reads feed dates as Queensland time unless a zone is given", () => {
    expect(parseFeedDate("2026-10-01")).toBe("2026-09-30T14:00:00.000Z");
    expect(parseFeedDate("20261001-123000")).toBe("2026-10-01T02:30:00.000Z");
    expect(parseFeedDate("2026-10-01T12:00:00Z")).toBe("2026-10-01T12:00:00.000Z");
    expect(parseFeedDate("soon")).toBeUndefined();
  });
});

describe("history events from changes", () => {
  const base = byId("RWP01:1001");
  it("lists a new current listing, then records a price change, a withdrawal and nothing for no change", () => {
    expect(eventsFor(undefined, base, NOW)).toEqual([{ type: "listed", occurredAt: base.listedAt, amountCents: 125_000_000 }]);
    expect(eventsFor(base, base, NOW)).toEqual([]);
    const cheaper = { ...base, priceCents: 119_000_000, modifiedAt: "2026-11-04T00:00:00.000Z" };
    expect(eventsFor(base, cheaper, NOW)).toEqual([{ type: "price_changed", occurredAt: "2026-11-04T00:00:00.000Z", amountCents: 119_000_000 }]);
    expect(eventsFor(base, { ...base, status: "withdrawn" }, NOW).map(e => e.type)).toEqual(["withdrawn"]);
  });
  it("records a sale with its listing date the first time a sold record arrives", () => {
    const sold = byId("RWP01:1002");
    expect(eventsFor(undefined, sold, NOW)).toEqual([
      { type: "listed", occurredAt: sold.listedAt, amountCents: 90_000_000 },
      { type: "sold", occurredAt: "2026-10-27T14:00:00.000Z", amountCents: 95_500_000 }
    ]);
  });
  it("records a lease once and ignores events dated in the future", () => {
    const leased = byId("RWP01:2001");
    expect(eventsFor(undefined, leased, NOW).map(e => [e.type, e.amountCents])).toEqual([["rented", 60_000]]);
    expect(eventsFor(leased, leased, NOW)).toEqual([]);
    expect(eventsFor(undefined, { ...base, listedAt: "2027-06-01T00:00:00.000Z" }, NOW)).toEqual([]);
  });
});

describe("drafts and hashing", () => {
  it("builds a draft the listing service accepts", () => {
    const d = parseDraftInput(draftFromItem(byId("RWP01:1001")));
    expect(d).toMatchObject({ ok: true, value: { title: "Light-filled townhouse & garden", jurisdiction: "QLD", propertyType: "townhouse", priceCents: 125_000_000, bedrooms: 3, postcode: "4064" } });
    const land = parseDraftInput(draftFromItem(byId("3001")));
    expect(land).toMatchObject({ ok: true, value: { title: "land in Samford Valley" } });
  });
  it("hashes the same content the same whatever the key order", () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(stableJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  });
});
