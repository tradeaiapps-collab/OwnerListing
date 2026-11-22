import { codeForStatus, ProviderError, RETRYABLE_STATUS, type ProviderId } from "./errors";
import { RateLimiter, realClock, type Clock } from "./rate-limit";

export type AuthStrategy = (headers: Headers) => void;
export const bearerAuth = (token: string): AuthStrategy => h => { h.set("authorization", `Bearer ${token}`); };
export const headerAuth = (name: string, value: string): AuthStrategy => h => { h.set(name, value); };

export interface ProviderClientOptions {
  provider: ProviderId;
  /** https origin, optionally with a path prefix. */
  baseUrl: string;
  auth: AuthStrategy;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  random?: () => number;
  limiter?: RateLimiter;
  timeoutMs?: number;
  /** Retries after the first attempt. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxResponseBytes?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Retry a POST/PATCH too. Only when the provider treats a repeat as harmless (it has its own idempotency key). */
  retryUnsafe?: boolean;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const MAX_RETRY_AFTER_MS = 30_000;

/** Retry-After as milliseconds (seconds or an HTTP date), or undefined. */
export function retryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.min(Math.max(0, at - nowMs), MAX_RETRY_AFTER_MS);
}

/**
 * Authenticated JSON client for one outside provider: https only, fixed base URL (callers pass a path, never a URL, so a
 * response or user value cannot redirect a key elsewhere), per-attempt timeout, rate limiting, and retry with exponential
 * backoff and jitter on timeouts, network errors, 408/429/5xx (honouring Retry-After). Errors are ProviderError with no secrets in them.
 */
export class ProviderClient {
  private readonly base: URL;
  private readonly f: typeof fetch;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxBytes: number;

  constructor(private readonly o: ProviderClientOptions) {
    let u: URL;
    try { u = new URL(o.baseUrl); } catch { throw new ProviderError(o.provider, "not_configured", "Base URL is not a valid URL."); }
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new ProviderError(o.provider, "not_configured", "Base URL must be a plain https URL.");
    this.base = u;
    this.f = o.fetchImpl ?? fetch;
    this.clock = o.clock ?? realClock;
    this.random = o.random ?? Math.random;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.maxRetries = o.maxRetries ?? 3;
    this.baseDelayMs = o.baseDelayMs ?? 250;
    this.maxDelayMs = o.maxDelayMs ?? 5_000;
    this.maxBytes = o.maxResponseBytes ?? 5 * 1024 * 1024;
  }

  private url(path: string, query?: RequestOptions["query"]): URL {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.split("/").includes("..")) throw new ProviderError(this.o.provider, "client", "Invalid request path.");
    const u = new URL(this.base.href);
    u.pathname = `${this.base.pathname.replace(/\/$/, "")}${path}`;
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u;
  }

  private backoff(attempt: number, retryAfter?: number): number {
    if (retryAfter !== undefined) return retryAfter;
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt) * (0.5 + this.random() / 2);
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const m = method.toUpperCase();
    const url = this.url(path, opts.query);
    const mayRetry = SAFE_METHODS.has(m) || opts.retryUnsafe === true;
    const provider = this.o.provider;
    for (let attempt = 0; ; attempt++) {
      await this.o.limiter?.acquire();
      const headers = new Headers({ accept: "application/json", ...opts.headers });
      if (opts.body !== undefined) headers.set("content-type", "application/json");
      this.o.auth(headers);
      let err: ProviderError;
      let retryAfter: number | undefined;
      try {
        const res = await this.f(url, {
          method: m, headers, redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) })
        });
        if (res.ok) return await this.parse<T>(res);
        retryAfter = retryAfterMs(res.headers.get("retry-after"), this.clock.now());
        await res.body?.cancel().catch(() => undefined);
        err = new ProviderError(provider, codeForStatus(res.status), `${provider} answered ${res.status}.`, res.status, RETRYABLE_STATUS.has(res.status));
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        err = new ProviderError(provider, timedOut ? "timeout" : "network", timedOut ? `${provider} timed out.` : `${provider} could not be reached.`, undefined, true);
      }
      if (!err.retryable || !mayRetry || attempt >= this.maxRetries) throw err;
      await this.clock.sleep(this.backoff(attempt, retryAfter));
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > this.maxBytes) throw new ProviderError(this.o.provider, "bad_response", "Response too large.", res.status);
    const text = await res.text();
    if (text.length > this.maxBytes) throw new ProviderError(this.o.provider, "bad_response", "Response too large.", res.status);
    if (text === "") return undefined as T;
    try { return JSON.parse(text) as T; } catch { throw new ProviderError(this.o.provider, "bad_response", "Response was not JSON.", res.status); }
  }

  get<T = unknown>(path: string, opts?: Omit<RequestOptions, "body">) { return this.request<T>("GET", path, opts); }
  post<T = unknown>(path: string, body?: unknown, opts?: Omit<RequestOptions, "body">) { return this.request<T>("POST", path, { ...opts, body }); }
}
