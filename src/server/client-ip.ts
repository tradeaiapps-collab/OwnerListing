import { isIP } from "node:net";

/** Number of trusted proxy hops in front of the app (env TRUSTED_PROXY_HOPS, default 1). Invalid values fall back to 1. */
export function trustedProxyHops(raw: string | undefined = process.env["TRUSTED_PROXY_HOPS"]): number {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
}

/**
 * Client IP from x-forwarded-for, taken from the right: each trusted proxy appends the address it saw, so the entry
 * `hops` from the end is the first one we can trust. Left-most values are client-controlled and are ignored.
 * Falls back to "unknown" (one shared bucket) when the header is missing, too short or not an IP.
 */
export function clientIp(req: Request, hops: number = trustedProxyHops()): string {
  const parts = (req.headers.get("x-forwarded-for") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const ip = parts.length >= hops ? parts[parts.length - hops] : undefined;
  return ip && isIP(ip) ? ip : "unknown";
}
