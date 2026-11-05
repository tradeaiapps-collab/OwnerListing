import {
  domainListings, domainSearchBody, FEED_LIMITS, feedUrlOk, mapDomainListing, mapReaxml, type FeedItem, type FeedProvider, type MapResult, type Territory
} from "../domain/property-feed";

/**
 * Fetching from property data providers. Every call has a timeout, a size cap and no redirects (a redirect could point a
 * staff-entered URL at an internal address). Errors come back as short key-free messages for the run log; provider response
 * bodies and keys are never put in them.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type FetchResult = MapResult | { error: string };
export interface FeedSource { provider: FeedProvider; sourceUrl: string | null; territory: Territory }

export class FeedFetchError extends Error {}

async function readCapped(r: Response, max: number): Promise<string> {
  const len = Number(r.headers.get("content-length") ?? "0");
  if (len > max) throw new FeedFetchError("The feed is larger than 20 MB.");
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); throw new FeedFetchError("The feed is larger than 20 MB."); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function call(fetchFn: FetchFn, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, redirect: "error", signal: AbortSignal.timeout(FEED_LIMITS.fetchTimeoutMs) });
  } catch (e) {
    throw new FeedFetchError((e as Error)?.name === "TimeoutError" ? "The provider did not answer in time." : "Could not reach the provider.");
  }
}

// ---- REAXML pull ----

export async function fetchReaxml(fetchFn: FetchFn, url: string): Promise<FetchResult> {
  if (!feedUrlOk(url)) return { error: "The feed address is not allowed." };
  try {
    const r = await call(fetchFn, url, { headers: { accept: "application/xml, text/xml" } });
    if (!r.ok) return { error: `The CRM feed answered ${r.status}.` };
    return mapReaxml(await readCapped(r, FEED_LIMITS.maxFeedBytes));
  } catch (e) {
    return { error: e instanceof FeedFetchError ? e.message : "Could not read the CRM feed." };
  }
}

// ---- Domain API ----

export interface DomainConfig { clientId: string; clientSecret: string; apiUrl: string; authUrl: string }

/** Reads DOMAIN_CLIENT_ID and DOMAIN_CLIENT_SECRET. Null (connector off) until both are set. */
export function domainConfig(env: Record<string, string | undefined>): DomainConfig | null {
  const clientId = env["DOMAIN_CLIENT_ID"]?.trim(), clientSecret = env["DOMAIN_CLIENT_SECRET"]?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, apiUrl: "https://api.domain.com.au", authUrl: "https://auth.domain.com.au/v1/connect/token" };
}

const tokenCache = new Map<string, { token: string; until: number }>();
export const clearDomainTokenCache = () => tokenCache.clear();

async function domainToken(fetchFn: FetchFn, c: DomainConfig, now: number): Promise<string> {
  const hit = tokenCache.get(c.clientId);
  if (hit && hit.until > now) return hit.token;
  const r = await call(fetchFn, c.authUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "api_listings_read" }).toString()
  });
  if (r.status === 400 || r.status === 401) throw new FeedFetchError("Domain refused the client id or secret.");
  if (!r.ok) throw new FeedFetchError(`Domain sign-in answered ${r.status}.`);
  const body = (await r.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) throw new FeedFetchError("Domain sign-in gave no token.");
  const ttl = typeof body.expires_in === "number" && body.expires_in > 120 ? body.expires_in - 60 : 600;
  tokenCache.set(c.clientId, { token: body.access_token, until: now + ttl * 1000 });
  return body.access_token;
}

/** Searches Sale, Rent and Sold listings for the territory, page by page, up to the per-run cap. */
export async function fetchDomain(fetchFn: FetchFn, c: DomainConfig | null, territory: Territory, now = Date.now()): Promise<FetchResult> {
  if (!c) return { error: "The Domain API is not set up (DOMAIN_CLIENT_ID and DOMAIN_CLIENT_SECRET)." };
  const out: MapResult = { items: [], rejected: [] };
  const seen = new Set<string>();
  try {
    const token = await domainToken(fetchFn, c, now);
    for (const type of ["Sale", "Rent", "Sold"] as const) {
      for (let page = 1; page <= 10 && out.items.length < FEED_LIMITS.maxItemsPerRun; page++) {
        const r = await call(fetchFn, `${c.apiUrl}/v1/listings/residential/_search`, {
          method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(domainSearchBody(territory, type, page))
        });
        if (r.status === 401 || r.status === 403) { tokenCache.delete(c.clientId); throw new FeedFetchError("Domain refused access: check the API package includes listings."); }
        if (r.status === 429) throw new FeedFetchError("Domain's request limit was reached; the next run continues.");
        if (!r.ok) throw new FeedFetchError(`Domain answered ${r.status}.`);
        const listings = domainListings(JSON.parse(await readCapped(r, FEED_LIMITS.maxFeedBytes)));
        for (const l of listings) {
          const m = mapDomainListing(l, type);
          if ("reject" in m) { out.rejected.push({ ...(m.externalId ? { externalId: m.externalId } : {}), reason: m.reject }); continue; }
          if (seen.has(m.externalId)) continue;
          seen.add(m.externalId);
          out.items.push(m);
        }
        if (listings.length < 100) break;
      }
    }
    return out;
  } catch (e) {
    if (out.items.length) return { ...out, rejected: [...out.rejected, { reason: e instanceof FeedFetchError ? e.message : "Domain gave an unreadable answer." }] };
    return { error: e instanceof FeedFetchError ? e.message : "Domain gave an unreadable answer." };
  }
}

/** Pulls one connection's feed. A REAXML connection with no pull URL gets its data only by push, so a scheduled pull has nothing to do. */
export async function fetchFeed(fetchFn: FetchFn, src: FeedSource, env: Record<string, string | undefined>): Promise<FetchResult> {
  if (src.provider === "reaxml") return src.sourceUrl ? fetchReaxml(fetchFn, src.sourceUrl) : { error: "This CRM feed has no pull address; it is updated when the CRM pushes." };
  return fetchDomain(fetchFn, domainConfig(env), src.territory);
}

export type { FeedItem };
