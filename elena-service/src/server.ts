import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { answerChat } from "./chat.ts";
import type { ElenaConfig } from "./config.ts";
import { ELENA_RULES } from "./rules.ts";
import { BadRequest, parseChatRequest } from "./schema.ts";
import { serveVideo } from "./video.ts";
import { httpSynthesiser, TtlCache, type Synthesiser, type Synthesised } from "./voice.ts";

const MAX_BODY = 32 * 1024;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new BadRequest("Request body is too large.", 413)); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new BadRequest("Body must be JSON.")); } });
    req.on("error", reject);
  });
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createElenaServer(cfg: ElenaConfig, opts: { synthesise?: Synthesiser | undefined; now?: () => number } = {}): Server {
  const synth = opts.synthesise ?? (cfg.ttsUrl ? httpSynthesiser(cfg.ttsUrl, cfg.ttsApiKey) : undefined);
  const now = opts.now ?? Date.now;
  const texts = new TtlCache<string>(5000, 60 * 60_000, Infinity, now);
  const audio = new TtlCache<Synthesised>(200, 24 * 60 * 60_000, 50 * 1024 * 1024, now);
  const inflight = new Map<string, Promise<Synthesised>>();
  const windows = new Map<string, { start: number; n: number }>();

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s), "x-elena-api-version": "1", "cache-control": "no-store" });
    res.end(s);
  };
  const fail = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });

  /** Returns the calling project's name, or null after answering 401/429. */
  function authenticate(req: IncomingMessage, res: ServerResponse): string | null {
    let client = "anonymous";
    if (cfg.apiKeys.size) {
      const given = String(req.headers["x-api-key"] ?? (req.headers["authorization"] ?? "").toString().replace(/^Bearer\s+/i, ""));
      const hit = [...cfg.apiKeys].find(([, secret]) => same(secret, given));
      if (!hit) { fail(res, 401, "unauthorized", "Missing or wrong API key."); return null; }
      client = hit[0];
    }
    const w = windows.get(client);
    if (!w || now() - w.start >= 60_000) windows.set(client, { start: now(), n: 1 });
    else if (++w.n > cfg.requestsPerMinute) { res.setHeader("retry-after", "30"); fail(res, 429, "rate_limited", "Too many requests."); return null; }
    return client;
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      // /api/chat and /api/v1/chat are the same thing; v1 is the contract.
      const p = url.pathname.replace(/^\/api(\/v1)?/, "/api").replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (url.pathname === "/healthz") return send(res, 200, { ok: true, version: "v1", rules_version: ELENA_RULES.version });
      if (!p.startsWith("/api/")) return fail(res, 404, "not_found", "Unknown path.");
      if (!authenticate(req, res)) return;

      if (p === "/api/chat") {
        if (method !== "POST") return fail(res, 405, "method_not_allowed", "Use POST.");
        const r = answerChat(parseChatRequest(await readJson(req)));
        texts.set(r.response_id, r.text);
        return send(res, 200, r);
      }
      if (p === "/api/rules") return method === "GET" ? send(res, 200, ELENA_RULES) : fail(res, 405, "method_not_allowed", "Use GET.");

      let m = /^\/api\/voice\/([0-9a-f]{24})$/.exec(p);
      if (m) {
        if (method !== "GET" && method !== "HEAD") return fail(res, 405, "method_not_allowed", "Use GET.");
        if (!synth) return fail(res, 501, "tts_not_configured", "No text-to-speech service is configured (ELENA_TTS_URL). Clients can use the device voice.");
        const id = m[1]!;
        let clip = audio.get(id);
        if (!clip) {
          const text = texts.get(id);
          if (text === undefined) return fail(res, 404, "unknown_response", "Unknown or expired response_id. Call /api/chat again.");
          let job = inflight.get(id);
          if (!job) { job = synth(text).finally(() => inflight.delete(id)); inflight.set(id, job); }
          try { clip = await job; } catch { return fail(res, 502, "tts_failed", "The voice service did not answer."); }
          audio.set(id, clip, clip.audio.length);
        }
        const etag = `"${id}"`;
        const headers = { "content-type": clip.contentType, "cache-control": "public, max-age=31536000, immutable", etag };
        if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); return void res.end(); }
        res.writeHead(200, { ...headers, "content-length": clip.audio.length });
        return void res.end(method === "HEAD" ? undefined : clip.audio);
      }

      m = /^\/api\/video\/([a-z]+)$/.exec(p);
      if (m) {
        if (method !== "GET" && method !== "HEAD") return fail(res, 405, "method_not_allowed", "Use GET.");
        if (serveVideo(req, res, cfg.mediaDir, m[1]!, url.searchParams.get("format"))) return;
        return fail(res, 404, "unknown_animation", "Animations: idle, talking, presenting. Formats: mp4, webm.");
      }
      return fail(res, 404, "not_found", "Unknown path.");
    } catch (e) {
      if (e instanceof BadRequest) return fail(res, e.status, e.status === 422 ? "invalid_question" : "bad_request", e.message);
      console.error("elena-service error", e instanceof Error ? e.message : e);
      return fail(res, 500, "server_error", "Something went wrong.");
    }
  });
}
