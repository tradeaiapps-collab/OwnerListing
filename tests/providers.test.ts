import { describe, expect, it, vi } from "vitest";
import { ProviderClient, bearerAuth, retryAfterMs } from "../src/server/providers/client";
import { ProviderError } from "../src/server/providers/errors";
import { RateLimiter, type Clock } from "../src/server/providers/rate-limit";
import { createProviderClient } from "../src/server/providers/registry";
import { openSecret, sealSecret } from "../src/server/providers/seal";
import { providerHealth } from "../src/server/providers/health";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, handleProviderWebhook, sign, type ProviderEventInput, type ProviderEventStore } from "../src/server/providers/webhook";
import { checkProviders } from "../src/config/provider-check.mjs";

const fakeClock = (): Clock & { t: number; slept: number[] } => {
  const c = { t: 1_000_000, slept: [] as number[], now: () => c.t, sleep: async (ms: number) => { c.slept.push(ms); c.t += ms; } };
  return c;
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const mk = (fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof ProviderClient>[0]> = {}) =>
  new ProviderClient({ provider: "mls", baseUrl: "https://api.example.com/v1", auth: bearerAuth("k-secret-123456"), fetchImpl, clock: fakeClock(), random: () => 1, ...over });

describe("ProviderClient", () => {
  it("sends the key, joins base path and query, parses JSON", async () => {
    const f = vi.fn(async (_u: URL | string | Request, _i?: RequestInit) => json({ ok: 1 }));
    expect(await mk(f as unknown as typeof fetch).get("/listings", { query: { page: 2, q: undefined } })).toEqual({ ok: 1 });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.com/v1/listings?page=2");
    expect((init!.headers as Headers).get("authorization")).toBe("Bearer k-secret-123456");
    expect(init!.redirect).toBe("error");
  });
  it("retries 503 and 429 with backoff and Retry-After, then succeeds", async () => {
    const clock = fakeClock();
    const f = vi.fn()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(json({ done: true }));
    expect(await mk(f, { clock }).get("/x")).toEqual({ done: true });
    expect(f).toHaveBeenCalledTimes(3);
    expect(clock.slept).toEqual([250, 2000]);
  });
  it("gives up after maxRetries with a retryable error that holds no secret", async () => {
    const f = vi.fn(async () => json({ detail: "k-secret-123456" }, 500));
    const e = await mk(f as unknown as typeof fetch, { maxRetries: 2 }).get("/x").catch((x: unknown) => x) as ProviderError;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ code: "server", status: 500, retryable: true });
    expect(e.message).not.toContain("secret");
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("does not retry 4xx, or a POST unless retryUnsafe", async () => {
    const f401 = vi.fn(async () => json({}, 401));
    expect(await mk(f401 as unknown as typeof fetch).get("/x").catch(x => x)).toMatchObject({ code: "auth", retryable: false });
    expect(f401).toHaveBeenCalledTimes(1);
    const f500 = vi.fn(async () => json({}, 500));
    await mk(f500 as unknown as typeof fetch).post("/x", { a: 1 }).catch(() => undefined);
    expect(f500).toHaveBeenCalledTimes(1);
    await mk(f500 as unknown as typeof fetch, { maxRetries: 1 }).request("POST", "/x", { body: {}, retryUnsafe: true }).catch(() => undefined);
    expect(f500).toHaveBeenCalledTimes(3);
  });
  it("maps network errors and timeouts", async () => {
    const net = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await mk(net as unknown as typeof fetch, { maxRetries: 0 }).get("/x").catch(x => x)).toMatchObject({ code: "network", retryable: true });
    const slow = vi.fn(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); });
    expect(await mk(slow as unknown as typeof fetch, { maxRetries: 0 }).get("/x").catch(x => x)).toMatchObject({ code: "timeout" });
  });
  it("rejects non-JSON bodies and refuses paths that could leave the base URL", async () => {
    const c = mk((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch);
    expect(await c.get("/x").catch(x => x)).toMatchObject({ code: "bad_response" });
    for (const p of ["https://evil.example/x", "//evil.example/x", "/a/../b", "x", "/a\\b"]) {
      expect(await c.get(p).catch(x => x)).toMatchObject({ code: "client" });
    }
  });
  it("only accepts a plain https base URL", () => {
    for (const u of ["http://api.example.com", "https://u:p@api.example.com", "https://api.example.com/?k=1", "nope"]) {
      expect(() => mk(vi.fn() as unknown as typeof fetch, { baseUrl: u })).toThrow(ProviderError);
    }
  });
  it("parses Retry-After seconds and dates, capped", () => {
    expect(retryAfterMs("3", 0)).toBe(3000);
    expect(retryAfterMs("9999", 0)).toBe(30000);
    expect(retryAfterMs(new Date(5000).toUTCString(), 1000)).toBe(4000);
    expect(retryAfterMs("soon", 0)).toBeUndefined();
    expect(retryAfterMs(null, 0)).toBeUndefined();
  });
});

describe("RateLimiter", () => {
  it("lets a burst through then spaces calls", async () => {
    const clock = fakeClock();
    const l = new RateLimiter(2, 1, clock);
    await l.acquire(); await l.acquire();
    expect(clock.slept).toEqual([]);
    await l.acquire();
    expect(clock.slept).toEqual([1000]);
  });
  it("rejects nonsense settings", () => {
    expect(() => new RateLimiter(0, 1)).toThrow();
    expect(() => new RateLimiter(1, 0)).toThrow();
  });
});

describe("createProviderClient / health", () => {
  const env = { MLS_API_KEY: "mls-key-1234567890", MLS_API_BASE_URL: "https://mls.example.com" };
  it("is not_configured until key and base URL are both set", () => {
    expect(() => createProviderClient("mls", {})).toThrow(/not configured/);
    expect(() => createProviderClient("zillow", { ZILLOW_API_KEY: "z".repeat(20) })).toThrow(ProviderError);
    expect(createProviderClient("mls", env)).toBeInstanceOf(ProviderClient);
  });
  it("uses a custom key header when named", async () => {
    const f = vi.fn(async (_u: unknown, _i?: RequestInit) => json({}));
    await createProviderClient("mls", { ...env, MLS_API_KEY_HEADER: "X-Api-Key" }, { fetchImpl: f as unknown as typeof fetch }).get("/p");
    const h = f.mock.calls[0]![1]!.headers as Headers;
    expect(h.get("x-api-key")).toBe("mls-key-1234567890");
    expect(h.get("authorization")).toBeNull();
  });
  it("reports config for all four providers without probing by default", async () => {
    const f = vi.fn();
    const r = await providerHealth(env, {}, { fetchImpl: f as unknown as typeof fetch });
    expect(r.map(x => [x.provider, x.config])).toEqual([["fcm", "off"], ["apns", "off"], ["mls", "ready"], ["zillow", "off"]]);
    expect(f).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain("mls-key");
  });
  it("probes only ready providers and reports auth failures", async () => {
    const ok = await providerHealth(env, { probe: true }, { fetchImpl: (async () => json({})) as unknown as typeof fetch });
    expect(ok.find(x => x.provider === "mls")!.probe).toMatchObject({ reachable: true, credentialsAccepted: true });
    expect(ok.find(x => x.provider === "zillow")!.probe).toBeUndefined();
    const denied = await providerHealth(env, { probe: true }, { fetchImpl: (async () => json({}, 403)) as unknown as typeof fetch });
    expect(denied.find(x => x.provider === "mls")!.probe).toMatchObject({ reachable: true, credentialsAccepted: false, error: "auth" });
    const down = await providerHealth(env, { probe: true }, { fetchImpl: (async () => { throw new TypeError("x"); }) as unknown as typeof fetch });
    expect(down.find(x => x.provider === "mls")!.probe).toMatchObject({ reachable: false, credentialsAccepted: null });
  });
});

describe("startup/deploy check knows the new providers", () => {
  const status = (env: Record<string, string>, id: string) => checkProviders(env, { production: true }).find(r => r.id === id)!;
  it("MLS and Zillow are optional: off when unset, incomplete when half set, invalid when malformed", () => {
    expect(status({}, "mls")).toMatchObject({ status: "off", blocking: false });
    expect(status({ MLS_API_KEY: "a".repeat(20) }, "mls")).toMatchObject({ status: "incomplete", missing: ["MLS_API_BASE_URL"], blocking: true });
    expect(status({ MLS_API_KEY: "a".repeat(20), MLS_API_BASE_URL: "http://x.com" }, "mls").status).toBe("invalid");
    expect(status({ ZILLOW_API_KEY: "a".repeat(20), ZILLOW_API_BASE_URL: "https://api.example.com/v1" }, "zillow").status).toBe("ready");
    expect(status({ MLS_API_KEY: "a".repeat(20), MLS_API_BASE_URL: "https://m.example.com", MLS_WEBHOOK_SECRET: "short" }, "mls").status).toBe("invalid");
    expect(status({ PROVIDER_CREDENTIAL_KEY: "nope" }, "providercreds").status).toBe("invalid");
  });
});

describe("sealed secrets", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  it("round-trips and fails closed", () => {
    const s = sealSecret("tok-123", key);
    expect(s).not.toContain("tok-123");
    expect(openSecret(s, key)).toBe("tok-123");
    expect(sealSecret("tok-123", key)).not.toBe(s);
    expect(openSecret(s, Buffer.alloc(32, 8).toString("base64"))).toBeUndefined();
    expect(openSecret(s.slice(0, -2) + "AA", key)).toBeUndefined();
    expect(openSecret("garbage", key)).toBeUndefined();
    expect(() => sealSecret("x", undefined)).toThrow(/PROVIDER_CREDENTIAL_KEY/);
  });
});

describe("handleProviderWebhook", () => {
  const secret = "s".repeat(40);
  const now = 1_800_000_000;
  const memory = () => {
    const rows = new Map<string, ProviderEventInput & { status?: string }>();
    const store: ProviderEventStore = {
      async record(e) { const k = `${e.provider}:${e.eventId}`; if (rows.has(k)) return { inserted: false }; rows.set(k, e); return { inserted: true, id: k }; },
      async finish(id, status) { rows.get(id)!.status = status; }
    };
    return { rows, store };
  };
  const call = (body: string, o: { secret?: string | undefined; ts?: string; sig?: string | null; store: ProviderEventStore; onEvent?: Parameters<typeof handleProviderWebhook>[0]["onEvent"] }) => {
    const ts = o.ts ?? String(now);
    const h = new Headers({ [TIMESTAMP_HEADER]: ts });
    const sig = o.sig === undefined ? sign(secret, ts, body) : o.sig;
    if (sig) h.set(SIGNATURE_HEADER, sig);
    return handleProviderWebhook({ provider: "mls", secret: "secret" in o ? o.secret : secret, rawBody: body, headers: h, store: o.store, nowSeconds: now, ...(o.onEvent ? { onEvent: o.onEvent } : {}) });
  };
  const ev = JSON.stringify({ id: "evt-1", type: "listing.updated", listing: "L1" });

  it("is off (503) while the secret is unset or short", async () => {
    const { store, rows } = memory();
    expect((await call(ev, { store, secret: undefined })).status).toBe(503);
    expect((await call(ev, { store, secret: "short" })).status).toBe(503);
    expect(rows.size).toBe(0);
  });
  it("rejects missing, wrong, stale and replayed-with-new-body signatures without storing", async () => {
    const { store, rows } = memory();
    expect((await call(ev, { store, sig: null })).status).toBe(401);
    expect((await call(ev, { store, sig: "0".repeat(64) })).status).toBe(401);
    expect((await call(ev, { store, sig: "zz" })).status).toBe(401);
    const old = String(now - 301);
    expect((await call(ev, { store, ts: old, sig: sign(secret, old, ev) })).status).toBe(401);
    expect((await call(ev + " ", { store, sig: sign(secret, String(now), ev) })).status).toBe(401);
    expect(rows.size).toBe(0);
  });
  it("stores a verified event once and acknowledges repeats", async () => {
    const { store, rows } = memory();
    expect((await call(ev, { store })).body).toEqual({ ok: true });
    const again = await call(ev, { store });
    expect(again.status).toBe(200);
    expect(again.body["note"]).toMatch(/Duplicate/);
    expect(rows.size).toBe(1);
    expect([...rows.values()][0]).toMatchObject({ eventId: "evt-1", eventType: "listing.updated" });
  });
  it("uses the body hash as event id when none is sent, and validates shape", async () => {
    const { store, rows } = memory();
    await call(JSON.stringify({ type: "x" }), { store });
    expect([...rows.values()][0]!.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect((await call("[]", { store })).status).toBe(400);
    expect((await call("not json", { store })).status).toBe(400);
    expect((await call(JSON.stringify({ id: "a" }), { store })).status).toBe(400);
  });
  it("refuses an oversized body before verifying", async () => {
    const { store } = memory();
    expect((await call("x".repeat(256 * 1024 + 1), { store })).status).toBe(413);
  });
  it("records the handler outcome and acknowledges even when the handler throws", async () => {
    const { store, rows } = memory();
    await call(ev, { store, onEvent: async () => "processed" });
    expect([...rows.values()][0]!.status).toBe("processed");
    const m = memory();
    expect((await call(ev, { store: m.store, onEvent: async () => { throw new Error("boom"); } })).status).toBe(200);
    expect([...m.rows.values()][0]!.status).toBe("failed");
  });
});
