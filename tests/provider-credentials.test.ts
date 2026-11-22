import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDomainTokenCache, testDomainConnection, type FetchFn } from "../src/adapters/feed-providers";
import { domainConfig } from "../src/adapters/feed-providers";
import { credentialKey, maskId, parseDomainCredentials } from "../src/server/provider-credentials-db";

const KEY = Buffer.alloc(32, 7).toString("base64");
const CFG = domainConfig({ DOMAIN_CLIENT_ID: "client_abcd1234", DOMAIN_CLIENT_SECRET: "secret_xyz" });

describe("parseDomainCredentials", () => {
  it("trims and accepts both values", () => {
    expect(parseDomainCredentials({ clientId: " id1 ", clientSecret: " s3cret " })).toEqual({ ok: true, clientId: "id1", clientSecret: "s3cret" });
  });
  it("refuses missing, spaced, multi-line and oversized values", () => {
    for (const b of [null, {}, { clientId: "a" }, { clientId: "a b", clientSecret: "x" }, { clientId: "a", clientSecret: "x\ny" }, { clientId: "a".repeat(201), clientSecret: "x" }, { clientId: "a", clientSecret: 5 }])
      expect(parseDomainCredentials(b).ok).toBe(false);
  });
});

describe("credential key and masking", () => {
  it("prefers PROVIDER_CREDENTIAL_KEY, falls back to MFA_SECRET_KEY, fails closed on a bad key", () => {
    expect(credentialKey({ PROVIDER_CREDENTIAL_KEY: KEY, MFA_SECRET_KEY: "x" })).toBe(KEY);
    expect(credentialKey({ MFA_SECRET_KEY: KEY })).toBe(KEY);
    expect(credentialKey({ PROVIDER_CREDENTIAL_KEY: "short" })).toBeUndefined();
    expect(credentialKey({})).toBeUndefined();
  });
  it("shows only the last four characters", () => {
    expect(maskId("client_abcd1234")).toBe("••••1234");
    expect(maskId("abc")).toBe("••••");
  });
});

describe("testDomainConnection", () => {
  afterEach(() => clearDomainTokenCache());
  const fetchOf = (r: () => Response): FetchFn => vi.fn(async () => r());
  it("is ok when Domain gives a token, and asks for a token only (no listings call)", async () => {
    const f = fetchOf(() => new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 }));
    expect(await testDomainConnection(f, CFG)).toEqual({ ok: true });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
  it("says the keys were refused on 401 without echoing them", async () => {
    const r = await testDomainConnection(fetchOf(() => new Response("secret_xyz bad", { status: 401 })), CFG);
    expect(r).toEqual({ ok: false, error: "Domain refused the client id or secret." });
    expect(JSON.stringify(r)).not.toContain("secret_xyz");
  });
  it("reports unreachable and missing keys", async () => {
    expect(await testDomainConnection(async () => { throw new TypeError("boom secret_xyz"); }, CFG)).toEqual({ ok: false, error: "Could not reach the provider." });
    expect(await testDomainConnection(fetchOf(() => new Response("")), null)).toEqual({ ok: false, error: "No Domain keys are set." });
  });
  it("re-checks every time instead of using a cached token", async () => {
    const f = fetchOf(() => new Response(JSON.stringify({ access_token: "t", expires_in: 3600 })));
    await testDomainConnection(f, CFG); await testDomainConnection(f, CFG);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });
});
