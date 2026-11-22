import { BASE_SYSTEM_PROMPT, type AiEnginePort, type GenerateOptions } from "../domain/ai-engine";
import { AiUnavailableError, MAX_RESPONSE_BYTES, type EngineStatus } from "./ollama-engine";

/**
 * Hosted model over the Anthropic Messages API, for the cloud site where no Ollama server is reachable.
 * Off unless AI_ENGINE=anthropic and AI_API_KEY is set; the super-admin switch at /staff/ai still has to be on.
 * Same failure rule as the Ollama adapter: every problem throws AiUnavailableError, callers show "AI unavailable".
 */
export interface HostedConfig { apiKey: string; model: string; timeoutMs: number; maxTokens: number; maxConcurrency: number }

export const DEFAULT_HOSTED_MODEL = "claude-haiku-5-5";
export const HOSTED_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_VISION_BYTES = 3_000_000;
const VISION_PROMPT = "This is a photo from a property listing. List only what you can clearly see, one short phrase per line, no sentences, at most 8 lines. Start the first line with the room or area (for example: bedroom, bathroom, kitchen, living room, garage, backyard, exterior, pool). Then fixtures and finishes you can see (for example: timber floors, stone benchtops, air conditioning, solar panels). Do not guess sizes, counts you cannot see, prices or condition you cannot see.";
const CHARS_PER_TOKEN = 8;

const intIn = (v: string | undefined, def: number, min: number, max: number) => {
  const n = v === undefined || v.trim() === "" ? def : Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : def;
};

export type HostedConfigResult = { ok: true; config: HostedConfig } | { ok: false; state: "off" | "invalid"; problem: string };

/** Reads AI_ENGINE=anthropic, AI_API_KEY, AI_MODEL, AI_TIMEOUT_MS, AI_MAX_TOKENS, AI_MAX_CONCURRENCY. Pure. "off" when AI_ENGINE is not anthropic. */
export function readHostedConfig(env: Record<string, string | undefined>): HostedConfigResult {
  if ((env["AI_ENGINE"] ?? "").trim().toLowerCase() !== "anthropic") return { ok: false, state: "off", problem: "AI_ENGINE is not anthropic." };
  const apiKey = env["AI_API_KEY"]?.trim();
  if (!apiKey) return { ok: false, state: "invalid", problem: "AI_API_KEY is not set." };
  const model = env["AI_MODEL"]?.trim() || DEFAULT_HOSTED_MODEL;
  if (!MODEL_RE.test(model)) return { ok: false, state: "invalid", problem: "AI_MODEL is not a valid model name." };
  return { ok: true, config: { apiKey, model, timeoutMs: intIn(env["AI_TIMEOUT_MS"], 30_000, 1_000, 120_000), maxTokens: intIn(env["AI_MAX_TOKENS"], 512, 16, 2048), maxConcurrency: intIn(env["AI_MAX_CONCURRENCY"], 4, 1, 16) } };
}

export interface HostedEngine extends AiEnginePort { status(): Promise<EngineStatus> }

export function createHostedEngine(cfg: HostedConfig, fetchImpl: typeof fetch = fetch): HostedEngine {
  let inFlight = 0;

  async function call(body: unknown): Promise<string> {
    if (inFlight >= cfg.maxConcurrency) throw new AiUnavailableError("busy");
    inFlight++;
    try {
      let res: Response;
      try {
        res = await fetchImpl(HOSTED_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(cfg.timeoutMs)
        });
      } catch (e) {
        throw new AiUnavailableError(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network");
      }
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new AiUnavailableError("http_status"); }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) { await res.body?.cancel().catch(() => undefined); throw new AiUnavailableError("too_large"); }
      let json: unknown;
      try { const text = await res.text(); if (text.length > MAX_RESPONSE_BYTES) throw new AiUnavailableError("too_large"); json = JSON.parse(text); } catch (e) {
        if (e instanceof AiUnavailableError) throw e;
        throw new AiUnavailableError("bad_response");
      }
      const parts = (json as { content?: unknown } | null)?.content;
      if (!Array.isArray(parts)) throw new AiUnavailableError("bad_response");
      const text = parts.map(p => (p as { type?: unknown; text?: unknown } | null)).filter(p => p?.type === "text" && typeof p.text === "string").map(p => p!.text as string).join("");
      if (text.trim() === "") throw new AiUnavailableError("bad_response");
      return text;
    } finally { inFlight--; }
  }

  return {
    info: () => ({ id: `anthropic:${cfg.model}`, kind: "hosted", version: "1" }),
    readDocument: async () => { throw new AiUnavailableError("not_supported"); },
    async describePhoto(file) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.mimeType) || file.bytes.byteLength > MAX_VISION_BYTES) throw new AiUnavailableError("not_supported");
      const text = await call({
        model: cfg.model, max_tokens: 200, temperature: 0.1,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: file.mimeType, data: Buffer.from(file.bytes).toString("base64") } },
          { type: "text", text: VISION_PROMPT }
        ] }]
      });
      return text.split("\n").map(l => l.replace(/^[\s*•-]+/, "").trim()).filter(l => l.length > 0 && l.length <= 120).slice(0, 12);
    },
    async generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
      const maxTokens = Math.min(cfg.maxTokens, Math.max(16, Math.floor(opts.maxTokens ?? cfg.maxTokens)));
      const system = opts.system ? `${BASE_SYSTEM_PROMPT}\n\n${opts.system}` : BASE_SYSTEM_PROMPT;
      const text = (await call({ model: cfg.model, max_tokens: maxTokens, temperature: 0.2, system, messages: [{ role: "user", content: prompt }] })).trim();
      if (text.length > maxTokens * CHARS_PER_TOKEN) throw new AiUnavailableError("too_large");
      return text;
    },
    /** Sends a 1-token request, so the admin's Test connection proves the key and model work. Never throws. */
    async status(): Promise<EngineStatus> {
      try {
        await call({ model: cfg.model, max_tokens: 16, messages: [{ role: "user", content: "Reply with: ok" }] });
        return { reachable: true, model: cfg.model, modelInstalled: true };
      } catch (e) {
        return { reachable: e instanceof AiUnavailableError && e.code === "http_status" ? true : false, model: cfg.model, modelInstalled: false, error: e instanceof AiUnavailableError ? e.code : "network" };
      }
    }
  };
}
