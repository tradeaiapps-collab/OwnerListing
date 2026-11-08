import { describe, expect, it } from "vitest";
import { createApiClient, type FetchLike, type TokenPair, type TokenStore } from "../mobile/src/lib/api-client";
import { formatPrice, roomsLine, searchQuery } from "../mobile/src/lib/format";
import { hrefFor, routeForLink } from "../mobile/src/lib/links";

const memoryStore = (initial: TokenPair | null = null) => {
  let v = initial;
  const s: TokenStore & { value(): TokenPair | null } = {
    async read() { return v; }, async write(t) { v = t; }, async clear() { v = null; }, value: () => v
  };
  return s;
};
const reply = (status: number, body: unknown) => ({ status, json: async () => body });

describe("phone app API client", () => {
  it("sends the bearer token and JSON", async () => {
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const fetch: FetchLike = async (url, init) => { calls.push({ url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) }); return reply(200, { ok: 1 }); };
    const api = createApiClient({ baseUrl: "https://example.com/", store: memoryStore({ accessToken: "A1", refreshToken: "R1" }), fetch });
    expect(await api.post("/api/buyer/saved-listings", { listingId: "x" })).toEqual({ ok: 1 });
    expect(calls[0]).toEqual({ url: "https://example.com/api/buyer/saved-listings", headers: { accept: "application/json", "content-type": "application/json", authorization: "Bearer A1" }, body: '{"listingId":"x"}' });
  });

  it("refuses non-https servers (except a computer on the local network) and non-API paths", async () => {
    const fetch: FetchLike = async () => reply(200, {});
    expect(() => createApiClient({ baseUrl: "http://example.com", store: memoryStore(), fetch })).toThrow();
    expect(() => createApiClient({ baseUrl: "https://example.com/evil/path", store: memoryStore(), fetch })).toThrow();
    expect(() => createApiClient({ baseUrl: "http://192.168.1.20:3004", store: memoryStore(), fetch })).not.toThrow();
    const api = createApiClient({ baseUrl: "https://example.com", store: memoryStore(), fetch });
    await expect(api.get("https://other.example/api/x")).rejects.toThrow();
  });

  it("refreshes once on 401, retries, and shares one refresh between parallel calls", async () => {
    const store = memoryStore({ accessToken: "old", refreshToken: "R1" });
    let refreshes = 0;
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith("/api/mobile/auth/refresh")) {
        refreshes++;
        expect(JSON.parse(init.body!)).toEqual({ refreshToken: "R1" });
        return reply(200, { accessToken: "new", refreshToken: "R2" });
      }
      return init.headers["authorization"] === "Bearer new" ? reply(200, { url }) : reply(401, { error: "Sign in required." });
    };
    const api = createApiClient({ baseUrl: "https://example.com", store, fetch });
    const out = await Promise.all([api.get("/api/a"), api.get("/api/b"), api.get("/api/c")]);
    expect(out).toHaveLength(3);
    expect(refreshes).toBe(1);
    expect(store.value()).toEqual({ accessToken: "new", refreshToken: "R2" });
  });

  it("signs out when the refresh is refused, but keeps tokens when the server is down", async () => {
    let signedOut = 0;
    const store = memoryStore({ accessToken: "old", refreshToken: "R1" });
    let refreshStatus = 503;
    const fetch: FetchLike = async url => (url.endsWith("/refresh") ? reply(refreshStatus, {}) : reply(401, {}));
    const api = createApiClient({ baseUrl: "https://example.com", store, fetch, onSignedOut: () => { signedOut++; } });
    await expect(api.get("/api/x")).rejects.toMatchObject({ status: 401, code: "signed_out" });
    expect(store.value()).not.toBeNull();
    refreshStatus = 401;
    await expect(api.get("/api/x")).rejects.toMatchObject({ status: 401 });
    expect(store.value()).toBeNull();
    expect(signedOut).toBe(1);
  });

  it("surfaces the server's error message and code", async () => {
    const fetch: FetchLike = async () => reply(403, { error: "Confirm it's you", code: "mfa_required" });
    const api = createApiClient({ baseUrl: "https://example.com", store: memoryStore({ accessToken: "a", refreshToken: "r" }), fetch });
    await expect(api.post("/api/x")).rejects.toMatchObject({ status: 403, message: "Confirm it's you", code: "mfa_required" });
  });

  it("signs in, stores the tokens, and signs out on the server", async () => {
    const store = memoryStore();
    const seen: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push(`${init.method} ${url} ${init.headers["authorization"] ?? "-"}`);
      return url.endsWith("/login") ? reply(200, { accessToken: "A", refreshToken: "R", user: { id: "u", userType: "buyer" }, mfa: { required: false, enrolled: false } }) : reply(200, { ok: true });
    };
    const api = createApiClient({ baseUrl: "https://example.com", store, fetch });
    expect(await api.signIn("a@b.c", "pw", { label: "Pixel", platform: "android" })).toEqual({ user: { id: "u", userType: "buyer" }, mfa: { required: false, enrolled: false } });
    expect(store.value()).toEqual({ accessToken: "A", refreshToken: "R" });
    await api.signOut();
    expect(store.value()).toBeNull();
    expect(seen).toEqual(["POST https://example.com/api/mobile/auth/login -", "POST https://example.com/api/mobile/auth/logout Bearer A"]);
  });
});

describe("notification links in the app", () => {
  const id = "4b1e2c3d-1111-4222-8333-444455556666";
  it.each([
    [`/listings/${id}`, { screen: "listing", id }],
    [`https://ownerlisting.com.au/listings/${id.toUpperCase()}?from=email`, { screen: "listing", id }],
    [`/agent-appointments/${id}/messages`, { screen: "messages", appointmentId: id }],
    ["/agent/appointments", { screen: "appointments" }],
    ["/buyer/saved", { screen: "saved" }],
    ["/listings/not-an-id", { screen: "notifications" }],
    ["javascript:alert(1)", { screen: "notifications" }],
    [null, { screen: "notifications" }]
  ])("%s", (link, route) => expect(routeForLink(link)).toEqual(route));
  it("maps to app paths", () => {
    expect(hrefFor({ screen: "messages", appointmentId: id })).toBe(`/messages/${id}`);
    expect(hrefFor({ screen: "listing", id })).toBe(`/listing/${id}`);
  });
});

describe("app display helpers", () => {
  it("formats prices", () => {
    expect(formatPrice(85_000_000, "sale")).toBe("$850,000");
    expect(formatPrice(65_000, "rent")).toBe("$650 per week");
    expect(formatPrice(undefined, "sale")).toBe("Contact owner");
  });
  it("joins rooms", () => expect(roomsLine({ bedrooms: 3, bathrooms: 2, parking: null })).toBe("3 bed · 2 bath"));
  it("builds the search query", () => {
    expect(searchQuery({})).toBe("");
    expect(searchQuery({ q: " Paddington ", transactionType: "sale", minBedrooms: 3, maxPriceDollars: 900000, page: 2 }))
      .toBe("?q=Paddington&transactionType=sale&minBedrooms=3&maxPriceCents=90000000&page=2");
    expect(searchQuery({ maxPriceDollars: 500 })).toBe(""); // a price filter needs sale or rent
  });
});
