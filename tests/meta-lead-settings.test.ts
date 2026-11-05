import { describe, expect, it, vi } from "vitest";
import { testMetaConnection } from "../src/adapters/ad-lead-providers";
import { META_ENV_NAMES, META_FIELDS, metaSettingsKey, metaStatus, pickMeta, resolveMeta, validateMetaField } from "../src/domain/meta-lead-settings";

const GOOD = { appId: "1234567890", appSecret: "a".repeat(32), verifyToken: "verify-token-123456", pageToken: "EAAB" + "x".repeat(60) };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("Meta lead settings (pure)", () => {
  it("validates every field and rejects spaces, short secrets and a non-numeric App ID", () => {
    for (const f of META_FIELDS) expect(validateMetaField(f, GOOD[f])).toEqual({ ok: true, value: GOOD[f] });
    expect(validateMetaField("appId", "abc").ok).toBe(false);
    expect(validateMetaField("appSecret", "short").ok).toBe(false);
    expect(validateMetaField("verifyToken", "has a space in it 123").ok).toBe(false);
    expect(validateMetaField("pageToken", "x".repeat(1025)).ok).toBe(false);
    expect(validateMetaField("pageToken", 123).ok).toBe(false);
    expect(validateMetaField("appSecret", `  ${GOOD.appSecret}  `)).toEqual({ ok: true, value: GOOD.appSecret });
  });
  it("lets an environment variable win per field, and ignores an invalid one", () => {
    const stored = { appSecret: GOOD.appSecret };
    expect(pickMeta("appSecret", stored, { META_APP_SECRET: "b".repeat(32) })).toEqual({ value: "b".repeat(32), source: "env" });
    expect(pickMeta("appSecret", stored, {})).toEqual({ value: GOOD.appSecret, source: "database" });
    expect(pickMeta("appSecret", stored, { META_APP_SECRET: "short" })).toBeUndefined();
    expect(pickMeta("appId", {}, {})).toBeUndefined();
  });
  it("is complete only with app secret, verify token and Page token (App ID is optional)", () => {
    const { appId, ...three } = GOOD;
    expect(resolveMeta(three, {})).toEqual(three);
    expect(resolveMeta(GOOD, {})).toEqual(GOOD);
    expect(resolveMeta({ appId, appSecret: GOOD.appSecret, verifyToken: GOOD.verifyToken }, {})).toBeNull();
    expect(resolveMeta({ appSecret: GOOD.appSecret, verifyToken: GOOD.verifyToken }, { [META_ENV_NAMES.pageToken]: GOOD.pageToken })).toMatchObject({ pageToken: GOOD.pageToken });
  });
  it("uses PROVIDER_CREDENTIAL_KEY, then MESSAGING_SETTINGS_KEY, then MFA_SECRET_KEY", () => {
    expect(metaSettingsKey({ PROVIDER_CREDENTIAL_KEY: "p", MESSAGING_SETTINGS_KEY: "m", MFA_SECRET_KEY: "f" })).toBe("p");
    expect(metaSettingsKey({ PROVIDER_CREDENTIAL_KEY: " ", MESSAGING_SETTINGS_KEY: "m" })).toBe("m");
    expect(metaSettingsKey({ MFA_SECRET_KEY: "f" })).toBe("f");
    expect(metaSettingsKey({})).toBeUndefined();
  });
  it("reports status from completeness and the last test", () => {
    const t = { at: "2026-11-05T00:00:00Z", ok: true, message: "m", pageName: null, pageId: null, appChecked: false };
    expect(metaStatus(false, t)).toBe("disconnected");
    expect(metaStatus(true, null)).toBe("untested");
    expect(metaStatus(true, t)).toBe("connected");
    expect(metaStatus(true, { ...t, ok: false })).toBe("test_failed");
  });
});

describe("testMetaConnection", () => {
  const cfg = { appSecret: GOOD.appSecret, verifyToken: GOOD.verifyToken, pageToken: GOOD.pageToken };
  it("checks the Page token, sends keys only in the Authorization header", async () => {
    const f = vi.fn(async () => json(200, { id: "P1", name: "Acme Homes" }));
    const r = await testMetaConnection(f, cfg);
    expect(r).toMatchObject({ ok: true, pageId: "P1", pageName: "Acme Homes", appChecked: false });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/me\?fields=id,name$/);
    expect(url).not.toContain(GOOD.pageToken);
    expect((init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${GOOD.pageToken}`);
    expect(init.redirect).toBe("error");
  });
  it("also checks the app secret when the App ID is known", async () => {
    const f = vi.fn(async (u: string) => (u.includes("/me?") ? json(200, { id: "P1", name: "A" }) : json(200, { id: GOOD.appId })));
    expect(await testMetaConnection(f, { ...cfg, appId: GOOD.appId })).toMatchObject({ ok: true, appChecked: true });
    const [url, init] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).not.toContain(GOOD.appSecret);
    expect((init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${GOOD.appId}|${GOOD.appSecret}`);
    const bad = vi.fn(async (u: string) => (u.includes("/me?") ? json(200, { id: "P1" }) : json(400, { error: { message: "Invalid secret " + GOOD.appSecret } })));
    const r = await testMetaConnection(bad, { ...cfg, appId: GOOD.appId });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(GOOD.appSecret);
  });
  it("gives short key-free messages for a refused token, an outage and a timeout", async () => {
    for (const status of [400, 401, 403]) expect((await testMetaConnection(async () => json(status, { error: { message: GOOD.pageToken } }), cfg)).message).toMatch(/refused the Page access token/);
    const out = await testMetaConnection(async () => json(500, {}), cfg);
    expect([out.ok, out.message]).toEqual([false, "Meta answered 500."]);
    expect((await testMetaConnection(async () => { throw new Error("boom " + GOOD.pageToken); }, cfg)).message).toBe("Could not reach Meta.");
    expect((await testMetaConnection(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, cfg)).message).toBe("Meta did not answer in time.");
    expect((await testMetaConnection(async () => json(200, {}), cfg)).ok).toBe(false);
  });
});
