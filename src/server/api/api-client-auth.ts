import { NextResponse } from "next/server";
import { API_RATE, API_USER_TYPES, parseKey, routeTemplate, secretMatches, verifyToken, type ApiScope } from "../../domain/api-keys";
import type { Queryable } from "../db";
import { keyById, keyByPublicId, logCall, recentCalls } from "../public-api-db";

/** Who is calling the public API with a key or token. The user comes from the key's row, never from the request. */
export interface ApiClient { keyId: string; userId: string; userType: string; scopes: ApiScope[] }

const deny = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  NextResponse.json({ error: message, code }, { status, headers: { "cache-control": "no-store", ...headers } });
const unauthorised = () => deny(401, "unauthenticated", "Send a valid API key or token as Authorization: Bearer.", { "www-authenticate": 'Bearer realm="api"' });

export function tokenSecret(env: Record<string, string | undefined> = process.env): string | undefined {
  const s = env["API_TOKEN_SECRET"] ?? env["SESSION_SECRET"];
  return s && s.length >= 32 ? s : undefined;
}

export async function authenticateClient(db: Queryable, req: Request, nowSeconds: number, env: Record<string, string | undefined> = process.env): Promise<ApiClient | null> {
  const m = /^Bearer ([A-Za-z0-9_.-]{20,400})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const cred = m[1]!;
  if (cred.startsWith("olk_")) {
    const k = parseKey(cred);
    if (!k) return null;
    const row = await keyByPublicId(db, k.publicId);
    if (!row || !secretMatches(k.secret, row.secretHash) || !API_USER_TYPES.includes(row.userType)) return null;
    return { keyId: row.id, userId: row.userId, userType: row.userType, scopes: row.scopes as ApiScope[] };
  }
  const secret = tokenSecret(env);
  if (cred.startsWith("olt_") && secret) {
    const c = verifyToken(cred, secret, nowSeconds);
    if (!c) return null;
    const row = await keyById(db, c.kid);
    // The token can only narrow what the key still holds: a revoked key or a scope removed since issue ends it at once.
    if (!row || !API_USER_TYPES.includes(row.userType)) return null;
    return { keyId: row.id, userId: row.userId, userType: row.userType, scopes: c.scopes.filter(s => row.scopes.includes(s)) };
  }
  return null;
}

/**
 * Runs `handler` for an authenticated API client holding `scope`: 401 without valid credentials, 403 without the scope, 429 over the
 * per-key limit. Every call that gets past authentication is logged (route template, method, status) for usage insights.
 */
export async function withClient(
  db: Queryable, req: Request, scope: ApiScope, handler: (client: ApiClient) => Promise<Response>,
  nowSeconds: number = Math.floor(Date.now() / 1000), env: Record<string, string | undefined> = process.env
): Promise<Response> {
  const client = await authenticateClient(db, req, nowSeconds, env);
  if (!client) return unauthorised();
  const route = routeTemplate(new URL(req.url).pathname);
  const finish = async (res: Response) => { try { await logCall(db, client.keyId, route, req.method.toUpperCase(), res.status); } catch { /* usage log is best effort */ } return res; };
  if (!client.scopes.includes(scope)) return finish(deny(403, "forbidden", `This key needs the ${scope} scope.`));
  if ((await recentCalls(db, client.keyId)) >= API_RATE.perKey) {
    return finish(deny(429, "rate_limited", `Limit is ${API_RATE.perKey} calls per ${API_RATE.windowSeconds} seconds.`, { "retry-after": String(API_RATE.windowSeconds) }));
  }
  let res: Response;
  try { res = await handler(client); } catch (e) { await finish(new Response(null, { status: 500 })); throw e; }
  return finish(res);
}
