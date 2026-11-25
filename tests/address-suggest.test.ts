import { describe, expect, it } from "vitest";
import { addressLookupFromEnv, createGooglePlaces, createPhoton, parseGoogleLocation, parseGooglePlace, parseGoogleSuggestions, parsePhoton, parsePhotonLocation } from "../src/adapters/address-lookup";
import { addressParts, auPoint, normaliseAddressQuery, sessionTokenOr, toAuState, type AddressLookupPort } from "../src/domain/address-suggest";
import { ADDRESS_LOOKUP_RATE, runAddressGeocode, runAddressResolve, runAddressSuggest, type AddressSuggestDeps } from "../src/server/address-suggest";

const reply = (body: unknown, ok = true) => async () => ({ ok, text: async () => JSON.stringify(body) });

describe("address query and parts", () => {
  it("normalises the typed text and refuses short, long or control-character input", () => {
    expect(normaliseAddressQuery("  6   Gable St ")).toBe("6 Gable St");
    expect(normaliseAddressQuery("6 ")).toBeNull();
    expect(normaliseAddressQuery("x".repeat(121))).toBeNull();
    expect(normaliseAddressQuery("6 Gable\u0000St")).toBeNull();
    expect(normaliseAddressQuery(42)).toBeNull();
  });

  it("maps state names and builds the form's address format", () => {
    expect(toAuState("Queensland")).toBe("QLD");
    expect(toAuState("new south wales")).toBe("NSW");
    expect(toAuState("Bavaria")).toBeUndefined();
    expect(addressParts({ street: "6 Gable St", suburb: "Bracken Ridge", state: "Queensland", postcode: "4017" }))
      .toEqual({ address: "6 Gable St, Bracken Ridge QLD 4017", street: "6 Gable St", suburb: "Bracken Ridge", state: "QLD", postcode: "4017" });
    expect(addressParts({ street: "6 Gable St", postcode: "40171" })).toEqual({ address: "6 Gable St", street: "6 Gable St" });
    expect(addressParts({ suburb: "Bracken Ridge" })).toBeNull();
  });

  it("accepts only well-formed session tokens", () => {
    expect(sessionTokenOr("3f1c9a2e-1b2c-4d5e-8f90-123456789abc", "fb")).toBe("3f1c9a2e-1b2c-4d5e-8f90-123456789abc");
    expect(sessionTokenOr("bad token!", "fb")).toBe("fb");
    expect(sessionTokenOr(null, "fb")).toBe("fb");
  });
});

describe("Google Places adapter", () => {
  const suggestions = { suggestions: [
    { placePrediction: { placeId: "ChIJabc123", text: { text: "6 Gable Street, Bracken Ridge QLD, Australia" },
      structuredFormat: { mainText: { text: "6 Gable Street" }, secondaryText: { text: "Bracken Ridge QLD, Australia" } } } },
    { queryPrediction: { text: { text: "gable" } } },
    { placePrediction: { placeId: "bad id with spaces", text: { text: "x" } } }
  ] };
  const place = { addressComponents: [
    { longText: "6", shortText: "6", types: ["street_number"] },
    { longText: "Gable Street", shortText: "Gable St", types: ["route"] },
    { longText: "Bracken Ridge", shortText: "Bracken Ridge", types: ["locality", "political"] },
    { longText: "Queensland", shortText: "QLD", types: ["administrative_area_level_1", "political"] },
    { longText: "Australia", shortText: "AU", types: ["country", "political"] },
    { longText: "4017", shortText: "4017", types: ["postal_code"] }
  ] };

  it("keeps place predictions only and drops the country", () => {
    expect(parseGoogleSuggestions(suggestions)).toEqual([{ id: "ChIJabc123", main: "6 Gable Street", secondary: "Bracken Ridge QLD" }]);
  });

  it("builds the parts from address components, Australia only", () => {
    expect(parseGooglePlace(place)).toEqual({ address: "6 Gable St, Bracken Ridge QLD 4017", street: "6 Gable St", suburb: "Bracken Ridge", state: "QLD", postcode: "4017" });
    const nz = { addressComponents: place.addressComponents.map(c => (c.types.includes("country") ? { ...c, shortText: "NZ" } : c)) };
    expect(parseGooglePlace(nz)).toBeNull();
  });

  it("sends the key in a header, limits to Australia and keeps the session token", async () => {
    const calls: { url: string; init: { headers: Record<string, string>; body?: string } }[] = [];
    const port = createGooglePlaces("AIza-test", async (url, init) => { calls.push({ url, init }); return { ok: true, text: async () => JSON.stringify(url.includes("autocomplete") ? suggestions : place) }; });
    await port.suggest("6 Gable", "tok12345");
    await port.resolve("ChIJabc123", "tok12345");
    expect(calls[0]!.url).toBe("https://places.googleapis.com/v1/places:autocomplete");
    expect(calls[0]!.init.headers["x-goog-api-key"]).toBe("AIza-test");
    expect(JSON.parse(calls[0]!.init.body!)).toMatchObject({ input: "6 Gable", includedRegionCodes: ["au"], sessionToken: "tok12345" });
    expect(calls[1]!.url).toContain("/places/ChIJabc123?");
    expect(calls[1]!.url).toContain("sessionToken=tok12345");
    expect(calls.every(c => !c.url.includes("AIza"))).toBe(true);
  });

  it("hides the provider's error and refuses odd place ids without calling out", async () => {
    let called = false;
    const port = createGooglePlaces("AIza-test", async () => { called = true; throw new Error("https://places.googleapis.com?key=AIza-test"); });
    await expect(port.suggest("6 Gable", "t")).rejects.toThrow("Address lookup unavailable.");
    called = false;
    expect(await port.resolve("../evil", "t")).toBeNull();
    expect(called).toBe(false);
  });
});

describe("Photon adapter", () => {
  const body = { features: [
    { properties: { osm_type: "N", osm_id: 1, countrycode: "AU", housenumber: "6", street: "Gable Street", district: "Bracken Ridge", city: "Brisbane City", state: "Queensland", postcode: "4017", type: "house" } },
    { properties: { osm_type: "N", osm_id: 2, countrycode: "AU", housenumber: "6", street: "Gable Street", district: "Bracken Ridge", city: "Brisbane City", state: "Queensland", postcode: "4017", type: "house" } },
    { properties: { osm_type: "W", osm_id: 3, countrycode: "AU", name: "Gable Street", type: "street", city: "Toowoomba", state: "Queensland", postcode: "4350" } },
    { properties: { osm_type: "N", osm_id: 4, countrycode: "NZ", housenumber: "6", street: "Gable Street", city: "Auckland" } },
    { properties: { osm_type: "N", osm_id: 5, countrycode: "AU", name: "Gable Park", type: "locality" } }
  ] };

  it("keeps Australian streets and houses with their parts, without duplicates", () => {
    expect(parsePhoton(body)).toEqual([
      { id: "N1", main: "6 Gable Street", secondary: "Bracken Ridge QLD 4017", parts: { address: "6 Gable Street, Bracken Ridge QLD 4017", street: "6 Gable Street", suburb: "Bracken Ridge", state: "QLD", postcode: "4017" } },
      { id: "W3", main: "Gable Street", secondary: "Toowoomba QLD 4350", parts: { address: "Gable Street, Toowoomba QLD 4350", street: "Gable Street", suburb: "Toowoomba", state: "QLD", postcode: "4350" } }
    ]);
  });

  it("queries inside Australia and refuses a non-https base", async () => {
    let url = "";
    const port = createPhoton("https://photon.example.com/", async u => { url = u; return { ok: true, text: async () => JSON.stringify(body) }; });
    expect((await port.suggest("6 Gable", "t")).length).toBe(2);
    expect(url.startsWith("https://photon.example.com/api/?q=6+Gable")).toBe(true);
    expect(url).toContain("bbox=112.9%2C-43.7%2C153.7%2C-10.6");
    expect(() => createPhoton("http://photon.example.com")).toThrow();
  });

  it("picks Google with a key, Photon without, and nothing when turned off", () => {
    expect(addressLookupFromEnv({ GOOGLE_PLACES_API_KEY: "AIza-x" })?.provider).toBe("google");
    expect(addressLookupFromEnv({})?.provider).toBe("osm");
    expect(addressLookupFromEnv({ ADDRESS_LOOKUP: "off", GOOGLE_PLACES_API_KEY: "AIza-x" })).toBeNull();
  });
});

describe("address lookup service", () => {
  const port = (over: Partial<AddressLookupPort> = {}): AddressLookupPort => ({
    provider: "google",
    suggest: async () => [{ id: "ChIJabc123", main: "6 Gable Street", secondary: "Bracken Ridge QLD" }],
    resolve: async () => ({ address: "6 Gable St, Bracken Ridge QLD 4017", street: "6 Gable St", suburb: "Bracken Ridge", state: "QLD", postcode: "4017" }),
    locate: async () => ({ lat: -27.3155, lng: 153.0391 }),
    ...over
  });
  const deps = (p: AddressLookupPort | null, hits = 1): AddressSuggestDeps & { buckets: string[] } => {
    const buckets: string[] = [];
    return { buckets, port: p, hit: async b => { buckets.push(b); return hits; } };
  };

  it("returns suggestions and counts both the person and the address", async () => {
    const d = deps(port());
    const r = await runAddressSuggest(d, "u1", "6 Gable", "tok12345", "1.2.3.4");
    expect(r).toEqual({ ok: true, value: { provider: "google", suggestions: [{ id: "ChIJabc123", main: "6 Gable Street", secondary: "Bracken Ridge QLD" }] } });
    expect(d.buckets.length).toBe(2);
  });

  it("refuses bad input before counting or calling out", async () => {
    const d = deps(port({ suggest: async () => { throw new Error("should not be called"); } }));
    expect(await runAddressSuggest(d, "u1", "6", null)).toMatchObject({ ok: false, code: "invalid" });
    expect(await runAddressResolve(d, "u1", "../x", null)).toMatchObject({ ok: false, code: "invalid" });
    expect(d.buckets).toEqual([]);
  });

  it("rate limits and fails closed when the counter is unusable", async () => {
    expect(await runAddressSuggest(deps(port(), ADDRESS_LOOKUP_RATE.perPerson + 1), "u1", "6 Gable", null)).toMatchObject({ ok: false, code: "rate_limited" });
    const broken: AddressSuggestDeps = { port: port(), hit: async () => undefined };
    expect(await runAddressSuggest(broken, "u1", "6 Gable", null)).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("says unavailable when off or when the provider fails, and not found for a foreign place", async () => {
    expect(await runAddressSuggest(deps(null), "u1", "6 Gable", null)).toMatchObject({ ok: false, code: "unavailable" });
    expect(await runAddressSuggest(deps(port({ suggest: async () => { throw new Error("x"); } })), "u1", "6 Gable", null)).toMatchObject({ ok: false, code: "unavailable" });
    expect(await runAddressResolve(deps(port({ resolve: async () => null })), "u1", "ChIJabc123", null)).toMatchObject({ ok: false, code: "not_found" });
    expect(await runAddressResolve(deps(port()), "u1", "ChIJabc123", "tok12345")).toMatchObject({ ok: true, value: { postcode: "4017" } });
  });
});

describe("address geocoding for the map pin", () => {
  it("keeps only finite points inside Australia, rounded to 6 decimals", () => {
    expect(auPoint(-27.31551234, 153.03912345)).toEqual({ lat: -27.315512, lng: 153.039123 });
    expect(auPoint(-36.85, 174.76)).toBeNull(); // Auckland
    expect(auPoint(Number.NaN, 150)).toBeNull();
    expect(auPoint("1", "2")).toBeNull();
  });

  it("reads Photon's [lng, lat] and skips non-Australian features", () => {
    const j = { features: [
      { properties: { countrycode: "NZ" }, geometry: { coordinates: [174.76, -36.85] } },
      { properties: { countrycode: "AU" }, geometry: { coordinates: [153.0391, -27.3155] } }
    ] };
    expect(parsePhotonLocation(j)).toEqual({ lat: -27.3155, lng: 153.0391 });
    expect(parsePhotonLocation({ features: [] })).toBeNull();
    expect(parsePhotonLocation({})).toBeNull();
  });

  it("reads the first Google place inside Australia", () => {
    expect(parseGoogleLocation({ places: [{ location: { latitude: -33.8688, longitude: 151.2093 } }] })).toEqual({ lat: -33.8688, lng: 151.2093 });
    expect(parseGoogleLocation({ places: [{ location: { latitude: 51.5, longitude: -0.12 } }] })).toBeNull();
    expect(parseGoogleLocation({})).toBeNull();
  });

  it("queries Photon with the address and the house, street and suburb layers", async () => {
    let url = "";
    const port = createPhoton("https://photon.example.com", async u => { url = u; return { ok: true, text: async () => JSON.stringify({ features: [{ properties: { countrycode: "AU" }, geometry: { coordinates: [153.0, -27.4] } }] }) }; });
    expect(await port.locate("6 Gable St, Bracken Ridge QLD 4017")).toEqual({ lat: -27.4, lng: 153 });
    expect(url).toContain("q=6+Gable+St%2C+Bracken+Ridge+QLD+4017");
    expect(url).toContain("layer=house");
    expect(url).toContain("layer=locality");
  });

  it("sends Google a text search for the position only, with the key in a header", async () => {
    let init: { headers: Record<string, string>; body?: string } | undefined;
    const port = createGooglePlaces("AIza-x", async (_u, i) => { init = i; return { ok: true, text: async () => JSON.stringify({ places: [{ location: { latitude: -37.8, longitude: 144.96 } }] }) }; });
    expect(await port.locate("1 Collins St, Melbourne VIC 3000")).toEqual({ lat: -37.8, lng: 144.96 });
    expect(init?.headers["x-goog-fieldmask"]).toBe("places.location");
    expect(init?.headers["x-goog-api-key"]).toBe("AIza-x");
    expect(init?.body).toContain('"regionCode":"au"');
  });

  const d = (p: AddressLookupPort | null, hits = 1): AddressSuggestDeps => ({ port: p, hit: async () => hits });
  const okPort: AddressLookupPort = { provider: "osm", suggest: async () => [], resolve: async () => null, locate: async () => ({ lat: -27.3155, lng: 153.0391 }) };

  it("returns the position, and refuses bad input, rate limits, outages and unknown addresses", async () => {
    expect(await runAddressGeocode(d(okPort), "u1", "6 Gable St, Bracken Ridge QLD 4017", "1.2.3.4")).toEqual({ ok: true, value: { lat: -27.3155, lng: 153.0391 } });
    expect(await runAddressGeocode(d(okPort), "u1", "6")).toMatchObject({ ok: false, code: "invalid" });
    expect(await runAddressGeocode(d(okPort, ADDRESS_LOOKUP_RATE.perPerson + 1), "u1", "6 Gable St")).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await runAddressGeocode(d(null), "u1", "6 Gable St")).toMatchObject({ ok: false, code: "unavailable" });
    expect(await runAddressGeocode(d({ ...okPort, locate: async () => { throw new Error("x"); } }), "u1", "6 Gable St")).toMatchObject({ ok: false, code: "unavailable" });
    expect(await runAddressGeocode(d({ ...okPort, locate: async () => null }), "u1", "6 Gable St")).toMatchObject({ ok: false, code: "not_found" });
  });
});
