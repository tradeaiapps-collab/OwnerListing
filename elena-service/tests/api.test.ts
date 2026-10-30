import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createElenaServer } from "../src/server.ts";

const media = path.join(__dirname, "..", "media");
const cfg = loadConfig({ ELENA_API_KEYS: "ownerlisting:k1,archova:k2" }, media);
let calls = 0;
const server = createElenaServer(cfg, { synthesise: async t => { calls++; return { audio: Buffer.from(`audio:${t}`), contentType: "audio/mpeg" }; } });
const bare = createElenaServer(loadConfig({ ELENA_API_KEYS: "a:b" }, media));
let url = "", bareUrl = "";
beforeAll(async () => {
  await Promise.all([server, bare].map(s => new Promise<void>(r => s.listen(0, r))));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; bareUrl = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); bare.close(); });

const listing = { title: "Banksia home", address: "14 Banksia St", transaction_type: "sale", property_type: "house", asking_cents: 115_000_000 };
const offer = { price_cents: 108_000_000, deposit_cents: 10_800_000, settlement_days: 30, conditions: ["Subject to finance"], status: "submitted" };
const chat = (body: unknown, key = "k1", base = url) => fetch(`${base}/api/chat`, { method: "POST", headers: { "x-api-key": key }, body: JSON.stringify(body) });
const q = (question: string, extra: object = {}) => ({ user_role: "buyer", question, listing_context: listing, offer_context: offer, ...extra });

describe("chat", () => {
  it("answers, with type, pose, suggestions and a voice url", async () => {
    const r = await chat(q("How could we close the gap?"));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-elena-api-version")).toBe("1");
    const j = await r.json();
    expect(j).toMatchObject({ version: "v1", topic: "compromise", answer_type: "info", pose: "tablet" });
    expect(j.text).toContain("$70,000 apart");
    expect(j.voice_url).toBe(`/api/v1/voice/${j.response_id}`);
  });
  it("types advice, privacy and unknown answers", async () => {
    expect((await (await chat(q("Should I accept this?"))).json()).answer_type).toBe("advice");
    expect((await (await chat(q("What is the lowest price they will take?"))).json()).answer_type).toBe("advice");
    expect((await (await chat(q("banana"))).json()).answer_type).toBe("clarification");
  });
  it("welcomes when no question is sent", async () => {
    const j = await (await chat({ user_role: "owner", listing_context: listing })).json();
    expect(j).toMatchObject({ topic: "welcome", pose: "wave" });
  });
  it("accepts the /api/v1 path too", async () => {
    expect((await fetch(`${url}/api/v1/chat`, { method: "POST", headers: { "x-api-key": "k2" }, body: JSON.stringify(q("hi")) })).status).toBe(200);
  });
  it("refuses fields that could carry private data", async () => {
    for (const extra of [{ owner_phone: "0412 345 678" }, { floor_cents: 100 }]) {
      const r = await chat(q("hi", extra));
      expect(r.status).toBe(400);
      expect((await r.json()).error.message).toContain(Object.keys(extra)[0]);
    }
    const nested = await chat(q("hi", { offer_context: { ...offer, owner_floor_cents: 1 } }));
    expect(nested.status).toBe(400);
  });
  it("refuses contact details in the question and bad input", async () => {
    expect((await chat(q("call me on 0412 345 678"))).status).toBe(422);
    expect((await chat(q("email a@b.com"))).status).toBe(422);
    expect((await chat(q("x".repeat(501)))).status).toBe(400);
    expect((await chat(q("hi", { user_role: "admin" }))).status).toBe(400);
    expect((await chat("nope")).status).toBe(400);
  });
  it("needs a valid API key", async () => {
    expect((await chat(q("hi"), "wrong")).status).toBe(401);
    expect((await fetch(`${url}/api/chat`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });
  it("answers in under 200 ms (p95 over 200 calls)", async () => {
    const ms: number[] = [];
    for (let i = 0; i < 200; i++) { const t = performance.now(); await (await chat(q("Where do things stand?"))).text(); ms.push(performance.now() - t); }
    ms.sort((a, b) => a - b);
    expect(ms[Math.floor(ms.length * 0.95)]!).toBeLessThan(200);
  });
});

describe("voice", () => {
  it("synthesises once, then serves the cached clip", async () => {
    const c = await (await chat(q("What does settlement mean?"))).json();
    const before = calls;
    const a = await fetch(`${url}${c.voice_url}`, { headers: { "x-api-key": "k1" } });
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("audio/mpeg");
    expect(a.headers.get("cache-control")).toContain("immutable");
    expect(await a.text()).toBe(`audio:${c.text}`);
    const b = await fetch(`${url}${c.voice_url}`, { headers: { "x-api-key": "k2", "if-none-match": a.headers.get("etag")! } });
    expect(b.status).toBe(304);
    await (await fetch(`${url}${c.voice_url}`, { headers: { "x-api-key": "k1" } })).arrayBuffer();
    expect(calls - before).toBe(1);
  });
  it("404s an unknown id and 501s without a voice service", async () => {
    expect((await fetch(`${url}/api/voice/${"0".repeat(24)}`, { headers: { "x-api-key": "k1" } })).status).toBe(404);
    const c = await (await chat(q("hi"), "b", bareUrl)).json();
    const r = await fetch(`${bareUrl}${c.voice_url}`, { headers: { "x-api-key": "b" } });
    expect(r.status).toBe(501);
    expect((await r.json()).error.code).toBe("tts_not_configured");
  });
});

describe("video", () => {
  const get = (p: string, h: Record<string, string> = {}) => fetch(`${url}/api/video/${p}`, { headers: { "x-api-key": "k1", ...h } });
  it.each([["idle", "mp4", "video/mp4"], ["talking", "webm", "video/webm"], ["presenting", "mp4", "video/mp4"]])("serves %s.%s under 1 MB, cacheable", async (name, fmt, type) => {
    const r = await get(`${name}?format=${fmt}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe(type);
    expect(r.headers.get("cache-control")).toContain("max-age");
    expect((await r.arrayBuffer()).byteLength).toBeLessThan(1_000_000);
    expect((await get(`${name}?format=${fmt}`, { "if-none-match": r.headers.get("etag")! })).status).toBe(304);
  });
  it("supports ranges, content negotiation and unknown names", async () => {
    const r = await get("idle", { range: "bytes=0-99" });
    expect(r.status).toBe(206);
    expect((await r.arrayBuffer()).byteLength).toBe(100);
    expect((await get("idle", { accept: "video/webm" })).headers.get("content-type")).toBe("video/webm");
    expect((await get("dancing")).status).toBe(404);
  });
});

describe("rules", () => {
  it("publishes the version and constraints", async () => {
    const j = await (await fetch(`${url}/api/rules`, { headers: { "x-api-key": "k1" } })).json();
    expect(j.apiVersion).toBe("v1");
    expect(j.constraints.length).toBeGreaterThan(3);
  });
});
