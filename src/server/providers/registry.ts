import { bearerAuth, headerAuth, ProviderClient, type ProviderClientOptions } from "./client";
import { ProviderError, type ProviderId } from "./errors";
import { RateLimiter } from "./rate-limit";

type Env = Record<string, string | undefined>;
const val = (env: Env, k: string) => { const v = env[k]?.trim(); return v ? v : undefined; };

/** Env names for the providers reached over a plain HTTPS API. FCM and APNs use their own token flows and get their clients in their own PRs. */
const HTTP_PROVIDERS = {
  mls: { key: "MLS_API_KEY", base: "MLS_API_BASE_URL", header: "MLS_API_KEY_HEADER", rate: "MLS_RATE_PER_SECOND" },
  zillow: { key: "ZILLOW_API_KEY", base: "ZILLOW_API_BASE_URL", header: "ZILLOW_API_KEY_HEADER", rate: "ZILLOW_RATE_PER_SECOND" }
} as const;
export type HttpProviderId = keyof typeof HTTP_PROVIDERS;
export const isHttpProvider = (p: ProviderId): p is HttpProviderId => p in HTTP_PROVIDERS;

/**
 * Builds the client for MLS or Zillow from env, or throws ProviderError("not_configured"). Auth is `Authorization: Bearer <key>`
 * unless <PROVIDER>_API_KEY_HEADER names a different header (set when the real spec arrives). Default 5 calls per second, burst 5.
 */
export function createProviderClient(provider: HttpProviderId, env: Env, over: Partial<ProviderClientOptions> = {}): ProviderClient {
  const n = HTTP_PROVIDERS[provider];
  const key = val(env, n.key), base = val(env, n.base);
  if (!key || !base) throw new ProviderError(provider, "not_configured", `${provider} is not configured (${n.key}, ${n.base}).`);
  const header = val(env, n.header);
  const rate = Number(val(env, n.rate) ?? 5);
  const perSecond = Number.isFinite(rate) && rate > 0 && rate <= 100 ? rate : 5;
  return new ProviderClient({
    provider, baseUrl: base, auth: header ? headerAuth(header, key) : bearerAuth(key),
    limiter: new RateLimiter(Math.max(1, Math.ceil(perSecond)), perSecond), ...over
  });
}
