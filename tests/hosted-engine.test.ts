import { describe, expect, it } from "vitest";
import { createHostedEngine, readHostedConfig, DEFAULT_HOSTED_MODEL } from "../src/adapters/hosted-engine";
import { AiUnavailableError } from "../src/adapters/ollama-engine";
import { isEngineUsable } from "../src/domain/ai-engine";

const cfg = { apiKey: "k", model: "m", timeoutMs: 5000, maxTokens: 100, maxConcurrency: 2 };
const ok = (text: string) => (async () => new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 })) as unknown as typeof fetch;

describe("hosted engine", () => {
  it("is off unless AI_ENGINE=anthropic and a key is set", () => {
    expect(readHostedConfig({})).toMatchObject({ ok: false, state: "off" });
    expect(readHostedConfig({ AI_ENGINE: "ollama" })).toMatchObject({ ok: false, state: "off" });
    expect(readHostedConfig({ AI_ENGINE: "anthropic" })).toMatchObject({ ok: false, state: "invalid" });
    const r = readHostedConfig({ AI_ENGINE: "anthropic", AI_API_KEY: "x" });
    expect(r.ok && r.config.model).toBe(DEFAULT_HOSTED_MODEL);
  });
  it("generates text, sends key header and the system prompt", async () => {
    let seen: { headers: Record<string, string>; body: { system: string } } | undefined;
    const f = (async (_u: string, init: RequestInit) => { seen = { headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) }; return new Response(JSON.stringify({ content: [{ type: "text", text: " Nice home. " }] })); }) as unknown as typeof fetch;
    const e = createHostedEngine(cfg, f);
    expect(isEngineUsable(e)).toBe(true);
    expect(await e.generate("hi", { system: "RULE" })).toBe("Nice home.");
    expect(seen?.headers["x-api-key"]).toBe("k");
    expect(seen?.body.system).toContain("RULE");
  });
  it("maps failures to AiUnavailableError", async () => {
    const bad = createHostedEngine(cfg, (async () => new Response("no", { status: 500 })) as unknown as typeof fetch);
    await expect(bad.generate("x")).rejects.toMatchObject({ code: "http_status" });
    const empty = createHostedEngine(cfg, ok("  "));
    await expect(empty.generate("x")).rejects.toBeInstanceOf(AiUnavailableError);
    const net = createHostedEngine(cfg, (async () => { throw new Error("down"); }) as unknown as typeof fetch);
    expect((await net.status()).reachable).toBe(false);
  });
  it("describes a photo and rejects unsupported types", async () => {
    const e = createHostedEngine(cfg, ok("kitchen\n- stone benchtops"));
    expect(await e.describePhoto({ name: "a.jpg", mimeType: "image/jpeg", bytes: new Uint8Array([1]) })).toEqual(["kitchen", "stone benchtops"]);
    await expect(e.describePhoto({ name: "a.gif", mimeType: "image/gif", bytes: new Uint8Array([1]) })).rejects.toMatchObject({ code: "not_supported" });
  });
});
