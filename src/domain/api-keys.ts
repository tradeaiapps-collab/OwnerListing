import { API_SCOPES, SCOPE_DESCRIPTIONS, type ApiScope } from "./api-scopes";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API keys and OAuth 2.0 client-credentials tokens. Pure apart from randomness.
 * A key is `olk_<12 chars>.<secret>`. The part before the dot is the public client id, the part after is the client secret.
 * Only SHA-256(secret) is stored (the secret is 256 random bits). An integrator either sends the whole key as a Bearer token or
 * exchanges client_id + client_secret at /api/v1/oauth/token for a one-hour signed token.
 */
/** Only these account types may hold keys. */
export const API_USER_TYPES: readonly string[] = ["owner", "agent"];
export { API_SCOPES, SCOPE_DESCRIPTIONS, type ApiScope };
export const MAX_KEYS_PER_USER = 10;
export const TOKEN_TTL_SECONDS = 3600;
export const API_RATE = { windowSeconds: 60, perKey: 120 } as const;

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const PUBLIC_ID_RE = /^olk_[a-z0-9]{12}$/;
const KEY_RE = /^(olk_[a-z0-9]{12})\.([A-Za-z0-9_-]{43})$/;

export function newPublicId(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(12);
  let id = "";
  for (let i = 0; i < 12; i++) id += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  return `olk_${id}`;
}

export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

export interface NewKey { publicId: string; secret: string; fullKey: string; secretHash: string }
export function generateKey(random: (n: number) => Buffer = randomBytes): NewKey {
  const publicId = newPublicId(random);
  const secret = random(32).toString("base64url");
  return { publicId, secret, fullKey: `${publicId}.${secret}`, secretHash: hashSecret(secret) };
}

export function parseKey(raw: string): { publicId: string; secret: string } | null {
  const m = KEY_RE.exec(raw);
  return m ? { publicId: m[1]!, secret: m[2]! } : null;
}

export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseScopes(input: unknown): ApiScope[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > API_SCOPES.length) return null;
  const out: ApiScope[] = [];
  for (const s of input) {
    if (typeof s !== "string" || !(API_SCOPES as readonly string[]).includes(s)) return null;
    if (!out.includes(s as ApiScope)) out.push(s as ApiScope);
  }
  return out;
}

/** The scopes a token may carry: those asked for, if the key holds all of them; otherwise null. No scope asked = all of the key's. */
export function narrowScopes(keyScopes: readonly string[], requested: string | undefined): ApiScope[] | null {
  const have = keyScopes.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s));
  if (!requested || !requested.trim()) return have;
  const asked = requested.trim().split(/\s+/);
  if (asked.some(s => !have.includes(s as ApiScope))) return null;
  return [...new Set(asked)] as ApiScope[];
}

// ---- Bearer tokens (OAuth client credentials) ----

export interface TokenClaims { kid: string; scopes: ApiScope[]; exp: number }
const sign = (body: string, secret: string) => createHmac("sha256", `${secret}:olt:v1`).update(body).digest("base64url");

export function signToken(claims: TokenClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `olt_${body}.${sign(body, secret)}`;
}

export function verifyToken(token: string, secret: string, nowSeconds: number): TokenClaims | null {
  if (!token.startsWith("olt_") || secret.length < 32) return null;
  const [body, sig, extra] = token.slice(4).split(".");
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(body, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<TokenClaims>;
    if (typeof c.kid !== "string" || typeof c.exp !== "number" || c.exp <= nowSeconds || !Array.isArray(c.scopes)) return null;
    const scopes = parseScopes(c.scopes);
    return scopes ? { kid: c.kid, scopes, exp: c.exp } : null;
  } catch { return null; }
}

/** Collapses ids so usage is grouped by route template, never by listing id or key. */
export function routeTemplate(path: string): string {
  return path
    .replace(/^\/api(\/v\d+)?/, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{id}")
    .slice(0, 120) || "/";
}
