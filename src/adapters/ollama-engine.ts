import { isIP } from "node:net";
import { BASE_SYSTEM_PROMPT, type AiEnginePort, type GenerateOptions } from "../domain/ai-engine";
import { isPublicAddress } from "../domain/net-guard";

/**
 * Self-hosted model server speaking the Ollama HTTP API (POST /api/chat, GET /api/tags). Runs on our own machine or private network:
 * no outside AI account. Off unless AI_ENGINE=ollama and a super admin has switched AI on at /staff/ai.
 * Every failure (refused endpoint, busy, timeout, bad or oversized reply) throws AiUnavailableError; callers turn it into "AI unavailable".
 */

export type AiErrorCode = "not_configured" | "endpoint_refused" | "busy" | "timeout" | "network" | "http_status" | "bad_response" | "too_large" | "not_supported";
export class AiUnavailableError extends Error {
  constructor(readonly code: AiErrorCode) { super(`AI unavailable (${code}).`); this.name = "AiUnavailableError"; }
}

export interface OllamaConfig {
  /** Base URL after validation (localhost rewritten to 127.0.0.1), no trailing slash. */
  endpoint: string;
  model: string;
  /** Optional self-hosted vision model (AI_VISION_MODEL, e.g. llama3.2-vision). Without it Elena cannot look at photos. */
  visionModel?: string;
  timeoutMs: number;
  maxTokens: number;
  maxConcurrency: number;
}

export const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
export const DEFAULT_MODEL = "llama3.1:8b";
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
/** Hard cap on any reply body. A non-streaming chat reply for 2048 tokens is far below this. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** Largest photo sent to the vision model (the browser shrinks photos first). */
const MAX_VISION_BYTES = 3_000_000;
const VISION_PROMPT = "This is a photo from a property listing. List only what you can clearly see, one short phrase per line, no sentences, at most 8 lines. Start the first line with the room or area (for example: bedroom, bathroom, kitchen, living room, garage, backyard, exterior, pool). Then fixtures and finishes you can see (for example: timber floors, stone benchtops, air conditioning, solar panels). Do not guess sizes, counts you cannot see, prices or condition you cannot see.";
/** Characters of model text allowed per requested token (generous; longer text means the cap was ignored). */
const CHARS_PER_TOKEN = 8;

const intIn = (v: string | undefined, def: number, min: number, max: number) => {
  const n = v === undefined || v.trim() === "" ? def : Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : def;
};

// [first octet, second octet, prefix length]: loopback and private networks a local model server may sit on.
const V4_LOCAL: readonly (readonly [number, number, number])[] = [[127, 0, 8], [10, 0, 8], [172, 16, 12], [192, 168, 16], [100, 64, 10]];

function isLocalAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c, d] = ip.split(".").map(Number) as [number, number, number, number];
    const n = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    return V4_LOCAL.some(([x, y, bits]) => {
      const mask = (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) === ((((x << 24) | (y << 16)) >>> 0) & mask);
    });
  }
  if (isIP(ip) !== 6) return false;
  const s = ip.toLowerCase();
  if (s === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isLocalAddress(mapped[1]!);
  return /^f[cd][0-9a-f]{2}:/.test(s); // unique local fc00::/7 (first group written in full, e.g. fd12:)
}

/**
 * Checks the configured endpoint. Without AI_ALLOW_REMOTE_ENDPOINT=1 only localhost, a loopback IP or a private-network IP is accepted
 * (a host name could resolve anywhere, so it is refused). With it, a public IP or host name is accepted over https only.
 * Link-local and cloud metadata addresses (169.254.x.x, fe80::), unspecified, multicast and reserved ranges are always refused.
 * Returns the cleaned base URL or a problem.
 */
export function checkEndpoint(raw: string, allowRemote: boolean): { ok: true; endpoint: string } | { ok: false; problem: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, problem: "AI_ENDPOINT is not a valid URL." }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, problem: "AI_ENDPOINT must start with http:// or https://." };
  if (u.username || u.password) return { ok: false, problem: "AI_ENDPOINT must not contain a user name or password." };
  if (u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return { ok: false, problem: "AI_ENDPOINT must be just the server address, with no path." };
  let host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") host = "127.0.0.1";
  const port = u.port ? `:${u.port}` : "";
  const base = (h: string) => `${u.protocol}//${isIP(h) === 6 ? `[${h}]` : h}${port}`;
  if (isIP(host) !== 0) {
    if (isLocalAddress(host)) return { ok: true, endpoint: base(host) };
    if (!isPublicAddress(host)) return { ok: false, problem: "AI_ENDPOINT points at a link-local, metadata or reserved address. Refused." };
  }
  if (!allowRemote) return { ok: false, problem: "AI_ENDPOINT must be localhost or a private-network IP address. A remote server needs AI_ALLOW_REMOTE_ENDPOINT=1." };
  if (u.protocol !== "https:") return { ok: false, problem: "A remote AI_ENDPOINT must use https://." };
  return { ok: true, endpoint: base(host) };
}

export type AiConfigResult = { ok: true; config: OllamaConfig } | { ok: false; state: "off" | "invalid"; problem: string };

/** Reads AI_ENGINE, AI_ENDPOINT, AI_MODEL, AI_TIMEOUT_MS, AI_MAX_TOKENS, AI_MAX_CONCURRENCY, AI_ALLOW_REMOTE_ENDPOINT. Pure. */
export function readAiConfig(env: Record<string, string | undefined>): AiConfigResult {
  const engine = (env["AI_ENGINE"] ?? "").trim().toLowerCase();
  if (engine === "" || engine === "none") return { ok: false, state: "off", problem: "AI_ENGINE is not set, so no model server is used." };
  if (engine !== "ollama") return { ok: false, state: "invalid", problem: "AI_ENGINE must be ollama (or empty for no AI)." };
  const ep = checkEndpoint(env["AI_ENDPOINT"]?.trim() || DEFAULT_ENDPOINT, env["AI_ALLOW_REMOTE_ENDPOINT"] === "1");
  if (!ep.ok) return { ok: false, state: "invalid", problem: ep.problem };
  const model = env["AI_MODEL"]?.trim() || DEFAULT_MODEL;
  if (!MODEL_RE.test(model)) return { ok: false, state: "invalid", problem: "AI_MODEL is not a valid model name (see `ollama list`)." };
  const vision = env["AI_VISION_MODEL"]?.trim();
  if (vision && !MODEL_RE.test(vision)) return { ok: false, state: "invalid", problem: "AI_VISION_MODEL is not a valid model name (see `ollama list`)." };
  return {
    ok: true,
    config: {
      endpoint: ep.endpoint, model, ...(vision ? { visionModel: vision } : {}),
      timeoutMs: intIn(env["AI_TIMEOUT_MS"], 30_000, 1_000, 120_000),
      maxTokens: intIn(env["AI_MAX_TOKENS"], 512, 16, 2048),
      maxConcurrency: intIn(env["AI_MAX_CONCURRENCY"], 2, 1, 8)
    }
  };
}

type FetchFn = typeof fetch;

/** Reads at most MAX_RESPONSE_BYTES of the body; more than that is refused. */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) { await res.body?.cancel().catch(() => undefined); throw new AiUnavailableError("too_large"); }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new AiUnavailableError("too_large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface EngineStatus { reachable: boolean; model: string; modelInstalled: boolean; error?: AiErrorCode }

export interface OllamaEngine extends AiEnginePort { status(): Promise<EngineStatus> }

/** The adapter. One instance per config, so the concurrency cap is shared by every request on this server. */
export function createOllamaEngine(cfg: OllamaConfig, fetchImpl: FetchFn = fetch): OllamaEngine {
  let inFlight = 0;

  async function call(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
    if (inFlight >= cfg.maxConcurrency) throw new AiUnavailableError("busy");
    inFlight++;
    try {
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.endpoint}${path}`, {
          method: init.method,
          headers: init.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          redirect: "error",
          signal: AbortSignal.timeout(cfg.timeoutMs)
        });
      } catch (e) {
        throw new AiUnavailableError(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network");
      }
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new AiUnavailableError("http_status"); }
      let text: string;
      try { text = await readCapped(res); } catch (e) {
        if (e instanceof AiUnavailableError) throw e;
        throw new AiUnavailableError(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network");
      }
      try { return JSON.parse(text) as unknown; } catch { throw new AiUnavailableError("bad_response"); }
    } finally {
      inFlight--;
    }
  }

  return {
    info: () => ({ id: `ollama:${cfg.model}`, kind: "self_hosted", version: "1" }),
    readDocument: async () => { throw new AiUnavailableError("not_supported"); },
    /** Looks at one photo with the self-hosted vision model and returns short plain observations, one per line. Needs AI_VISION_MODEL. */
    async describePhoto(file) {
      if (!cfg.visionModel || !/^image\/(jpeg|png|webp)$/.test(file.mimeType) || file.bytes.byteLength > MAX_VISION_BYTES) throw new AiUnavailableError("not_supported");
      const body = await call("/api/chat", {
        method: "POST",
        body: {
          model: cfg.visionModel, stream: false,
          messages: [{ role: "user", content: VISION_PROMPT, images: [Buffer.from(file.bytes).toString("base64")] }],
          options: { num_predict: 200, temperature: 0.1 }
        }
      });
      const content = (body as { message?: { content?: unknown } } | null)?.message?.content;
      if (typeof content !== "string") throw new AiUnavailableError("bad_response");
      return content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").split("\n").map(l => l.replace(/^[\s*•-]+/, "").trim()).filter(l => l.length > 0 && l.length <= 120).slice(0, 12);
    },

    async generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
      const maxTokens = Math.min(cfg.maxTokens, Math.max(16, Math.floor(opts.maxTokens ?? cfg.maxTokens)));
      const system = opts.system ? `${BASE_SYSTEM_PROMPT}\n\n${opts.system}` : BASE_SYSTEM_PROMPT;
      const body = await call("/api/chat", {
        method: "POST",
        body: {
          model: cfg.model, stream: false,
          messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
          options: { num_predict: maxTokens, temperature: 0.2 }
        }
      });
      const content = (body as { message?: { content?: unknown } } | null)?.message?.content;
      if (typeof content !== "string") throw new AiUnavailableError("bad_response");
      // Some open models print their reasoning in <think> tags first; that is never shown (an unclosed tag hides the rest).
      const text = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim();
      if (text.length === 0) throw new AiUnavailableError("bad_response");
      if (text.length > maxTokens * CHARS_PER_TOKEN) throw new AiUnavailableError("too_large");
      return text;
    },

    /** Is the server answering, and is the configured model pulled? Never throws. */
    async status(): Promise<EngineStatus> {
      try {
        const body = await call("/api/tags", { method: "GET" });
        const models = (body as { models?: unknown } | null)?.models;
        if (!Array.isArray(models)) return { reachable: true, model: cfg.model, modelInstalled: false, error: "bad_response" };
        const names = models.map(m => (m as { name?: unknown } | null)?.name).filter((n): n is string => typeof n === "string");
        const want = cfg.model.includes(":") ? cfg.model : `${cfg.model}:latest`;
        return { reachable: true, model: cfg.model, modelInstalled: names.includes(cfg.model) || names.includes(want) };
      } catch (e) {
        return { reachable: false, model: cfg.model, modelInstalled: false, error: e instanceof AiUnavailableError ? e.code : "network" };
      }
    }
  };
}
