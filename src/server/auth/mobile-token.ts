import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Tokens for the phone app. The web keeps its session cookie; the app cannot hold a cookie safely, so it signs in for a pair:
 *   access token   olm1.<payload>.<sig>   15 minutes, sent as Authorization: Bearer on every call
 *   refresh token  olr1_<session id>_<random>   kept in the phone's keychain/keystore, rotated on every use
 * The access token is signed with a key derived from SESSION_SECRET for this purpose only, so a web cookie can never be replayed as
 * a bearer token or the other way round. Only a SHA-256 of the refresh secret is stored.
 */
export const ACCESS_PREFIX = "olm1.";
export const REFRESH_PREFIX = "olr1_";
export const MOBILE_ACCESS_TTL_SECONDS = 15 * 60;
/** A refresh token unused this long stops working (the app signs in again). */
export const MOBILE_IDLE_TTL_SECONDS = 30 * 24 * 60 * 60;
/** However active, a phone signs in again after this long. */
export const MOBILE_MAX_TTL_SECONDS = 90 * 24 * 60 * 60;

export type MobileUserType = "owner" | "agent" | "buyer" | "vendor";

export interface MobileAccessPayload {
  /** app_user.id */
  uid: string;
  ut: MobileUserType;
  /** mobile_session.id */
  sid: string;
  exp: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES: readonly string[] = ["owner", "agent", "buyer", "vendor"];
const accessKey = (secret: string) => createHmac("sha256", secret).update("ol-mobile-access-v1").digest();
const mac = (data: string, secret: string) => createHmac("sha256", accessKey(secret)).update(data).digest();

export function signMobileAccess(p: MobileAccessPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(p)).toString("base64url");
  return `${ACCESS_PREFIX}${body}.${mac(body, secret).toString("base64url")}`;
}

export function verifyMobileAccess(token: string | undefined, secret: string, nowSeconds: number): MobileAccessPayload | null {
  if (!token || secret.length < 32 || !token.startsWith(ACCESS_PREFIX)) return null;
  const parts = token.slice(ACCESS_PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = mac(body, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<MobileAccessPayload>;
    if (typeof p.uid !== "string" || typeof p.sid !== "string" || !UUID.test(p.sid) || typeof p.ut !== "string" || !TYPES.includes(p.ut)) return null;
    if (typeof p.exp !== "number" || p.exp <= nowSeconds) return null;
    return { uid: p.uid, ut: p.ut as MobileUserType, sid: p.sid, exp: p.exp };
  } catch {
    return null;
  }
}

/** The bearer token on this request when it is a phone-app access token; undefined otherwise (cookie, API key or nothing). */
export function mobileBearer(req: Request): string | undefined {
  const m = /^Bearer (\S{1,1000})$/.exec(req.headers.get("authorization") ?? "");
  return m && m[1]!.startsWith(ACCESS_PREFIX) ? m[1] : undefined;
}

export const hashRefreshSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

export function newRefreshToken(sessionId: string): { token: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { token: `${REFRESH_PREFIX}${sessionId}_${secret}`, hash: hashRefreshSecret(secret) };
}

/** Splits a refresh token into its session id and secret, or null when it is malformed. */
export function parseRefreshToken(token: unknown): { sessionId: string; secret: string } | null {
  if (typeof token !== "string" || token.length > 200 || !token.startsWith(REFRESH_PREFIX)) return null;
  const rest = token.slice(REFRESH_PREFIX.length);
  const sessionId = rest.slice(0, 36);
  const secret = rest.slice(37);
  if (!UUID.test(sessionId) || rest[36] !== "_" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  return { sessionId, secret };
}

/** Constant-time comparison of two hex hashes. */
export function sameHash(a: string | null | undefined, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
