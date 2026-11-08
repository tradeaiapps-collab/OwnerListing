import { resolveTxt } from "node:dns/promises";
import { normaliseHost, platformHostsFrom, verifyRecordName, verifyRecordValue, type TenantView } from "../domain/white-label";
import { getDb } from "./context";
import type { Queryable } from "./db";
import { resolveByHost } from "./white-label-db";

/** Request-time tenant lookup (cached per server process) and the DNS ownership check for a custom domain. */

export const TENANT_CACHE_MS = 45_000;
const FAILURE_CACHE_MS = 10_000;
const MAX_CACHED_HOSTS = 500;
type Entry = { at: number; ttl: number; value: TenantView | null };
const g = globalThis as unknown as { __olTenantCache?: Map<string, Entry> };
const cache = () => (g.__olTenantCache ??= new Map());
export const clearTenantCache = () => cache().clear();

/** The host a request was sent to, normalised, or null when it is missing or not a plain DNS name (IP addresses never match a tenant). */
export function requestHost(h: { get(name: string): string | null }): string | null {
  return normaliseHost(h.get("host") ?? h.get("x-forwarded-host") ?? "");
}

/**
 * The active white-label tenant for this host, or null for the platform brand. Platform hosts and localhost skip the lookup. Results (including
 * "none") are cached for about 45 seconds; if the database fails the platform brand is used, so the site still renders.
 */
export async function tenantForHost(host: string | null, db: () => Queryable = getDb, env: Record<string, string | undefined> = process.env, now: number = Date.now()): Promise<TenantView | null> {
  if (!host || host === "localhost" || platformHostsFrom(env).includes(host)) return null;
  const c = cache();
  const hit = c.get(host);
  if (hit && now - hit.at < hit.ttl) return hit.value;
  let value: TenantView | null = null, ttl = TENANT_CACHE_MS;
  try {
    value = await resolveByHost(db(), host);
  } catch {
    ttl = FAILURE_CACHE_MS;
  }
  if (c.size >= MAX_CACHED_HOSTS) c.clear(); // random Host headers must not grow memory without bound
  c.set(host, { at: now, ttl, value });
  return value;
}

export type TxtLookup = (name: string) => Promise<string[][]>;

/** True when `_wl-verify.<host>` has a TXT record equal to `wl-verify=<token>`. A lookup failure counts as not verified. */
export async function dnsVerified(host: string, token: string, lookup: TxtLookup = resolveTxt): Promise<boolean> {
  try {
    const want = verifyRecordValue(token);
    return (await lookup(verifyRecordName(host))).some(parts => parts.join("").trim() === want);
  } catch {
    return false;
  }
}
