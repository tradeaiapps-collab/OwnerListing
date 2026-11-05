import { afterEach, describe, expect, it } from "vitest";
import { clearDomainTokenCache, domainConfig, fetchDomain, fetchFeed, fetchReaxml, type FetchFn } from "../src/adapters/feed-providers";
import type { Territory } from "../src/domain/property-feed";

const XML = `<propertyList><residential status="current"><uniqueID>1</uniqueID><price>500000</price><address><streetNumber>1</streetNumber><street>A St</street><suburb>Paddington</suburb><state>QLD</state><postcode>4064</postcode></address><category name="House"/></residential></propertyList>`;
const T: Territory = { states: ["QLD"], postcodes: ["4064"], suburbs: [] };
const CFG = domainConfig({ DOMAIN_CLIENT_ID: "client_abc", DOMAIN_CLIENT_SECRET: "secret_xyz" });

function fake(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchFn = async (url, init = {}) => { calls.push({ url, init }); return handler(url, init); };
  return { fn, calls };
}

describe("REAXML pull", () => {
  it("fetches without following redirects and maps the feed", async () => {
    const f = fake(() => new Response(XML, { status: 200 }));
    const r = await fetchReaxml(f.fn, "https://feeds.example.com.au/a.xml");
    expect("items" in r && r.items[0]?.externalId).toBe("1");
    expect(f.calls[0]!.init.redirect).toBe("error");
    expect(f.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
  it("refuses private addresses without calling, and reports HTTP errors, size and network failures without detail", async () => {
    const f = fake(() => new Response("x"));
    expect(await fetchReaxml(f.fn, "https://127.0.0.1/a.xml")).toEqual({ error: "The feed address is not allowed." });
    expect(f.calls).toHaveLength(0);
    expect(await fetchReaxml(fake(() => new Response("no", { status: 403 })).fn, "https://feeds.example.com.au/a")).toEqual({ error: "The CRM feed answered 403." });
    expect(await fetchReaxml(fake(() => new Response("x", { headers: { "content-length": String(30 * 1024 * 1024) } })).fn, "https://feeds.example.com.au/a")).toEqual({ error: "The feed is larger than 20 MB." });
    expect(await fetchReaxml(async () => { throw new TypeError("secret detail"); }, "https://feeds.example.com.au/a")).toEqual({ error: "Could not reach the provider." });
  });
  it("a push-only CRM connection has nothing to pull", async () => {
    expect(await fetchFeed(fake(() => new Response("")).fn, { provider: "reaxml", sourceUrl: null, territory: T }, {})).toMatchObject({ error: expect.stringContaining("push") });
  });
});

describe("Domain API", () => {
  afterEach(() => clearDomainTokenCache());
  const listing = (id: number) => ({ type: "PropertyListing", listing: { id, listingType: "Sale", priceDetails: { price: 900000 }, propertyDetails: { state: "QLD", suburb: "Paddington", postcode: "4064", propertyType: "House", streetNumber: "1", street: "B St" } } });

  it("is off until both keys are set", async () => {
    expect(domainConfig({ DOMAIN_CLIENT_ID: "x" })).toBeNull();
    expect(await fetchDomain(fake(() => new Response("")).fn, null, T)).toEqual({ error: expect.stringContaining("not set up") });
  });
  it("signs in with client credentials once, then searches sale, rent and sold", async () => {
    const f = fake((url, init) => {
      if (url.includes("auth.domain.com.au")) return Response.json({ access_token: "tok", expires_in: 3600 });
      const body = JSON.parse(String(init.body));
      return Response.json(body.listingType === "Sale" ? [listing(1), listing(2)] : body.listingType === "Sold" ? [listing(2), { type: "PropertyListing", listing: { id: 3 } }] : []);
    });
    const r = await fetchDomain(f.fn, CFG, T);
    if ("error" in r) throw new Error(r.error);
    expect(r.items.map(i => i.externalId)).toEqual(["1", "2"]);
    expect(r.rejected).toEqual([{ externalId: "3", reason: "No suburb or Australian state." }]);
    const auth = f.calls[0]!;
    expect(String(auth.init.body)).toContain("grant_type=client_credentials");
    expect((auth.init.headers as Record<string, string>)["authorization"]).toBe(`Basic ${Buffer.from("client_abc:secret_xyz").toString("base64")}`);
    expect(f.calls.filter(c => c.url.includes("auth.")).length).toBe(1);
    expect(f.calls.slice(1).every(c => (c.init.headers as Record<string, string>)["authorization"] === "Bearer tok")).toBe(true);
  });
  it("pages while full pages come back, up to ten pages", async () => {
    let pages = 0;
    const f = fake((url, init) => {
      if (url.includes("auth.")) return Response.json({ access_token: "tok", expires_in: 3600 });
      const b = JSON.parse(String(init.body));
      if (b.listingType !== "Sale") return Response.json([]);
      pages++;
      return Response.json(b.pageNumber <= 2 ? Array.from({ length: 100 }, (_, i) => listing(b.pageNumber * 1000 + i)) : [listing(9999)]);
    });
    const r = await fetchDomain(f.fn, CFG, T);
    expect(pages).toBe(3);
    expect("items" in r && r.items.length).toBe(201);
  });
  it("explains refused keys and rate limits in a sentence, with no provider text", async () => {
    expect(await fetchDomain(fake(() => new Response("bad client secret xyz", { status: 401 })).fn, CFG, T)).toEqual({ error: "Domain refused the client id or secret." });
    clearDomainTokenCache();
    const limited = fake(url => (url.includes("auth.") ? Response.json({ access_token: "t" }) : new Response("slow down", { status: 429 })));
    expect(await fetchDomain(limited.fn, CFG, T)).toEqual({ error: expect.stringContaining("request limit") });
  });
});
