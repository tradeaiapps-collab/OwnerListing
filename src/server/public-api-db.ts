import type { Queryable } from "./db";
import { API_RATE, MAX_KEYS_PER_USER, type ApiScope, type NewKey } from "../domain/api-keys";
import { MAX_ENDPOINTS_PER_USER, type WebhookEvent } from "../domain/webhooks";
import type { UsageRow } from "../domain/api-insights";

/** Database access for API keys, webhook endpoints and the usage log. Every statement is parameterised. */

export interface KeyRow { id: string; publicId: string; name: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const toKey = (r: Record<string, unknown>): KeyRow => ({
  id: String(r["id"]), publicId: String(r["public_id"]), name: String(r["name"]), scopes: r["scopes"] as string[],
  createdAt: iso(r["created_at"])!, lastUsedAt: iso(r["last_used_at"]), revokedAt: iso(r["revoked_at"])
});

export async function createKey(db: Queryable, userId: string, name: string, scopes: ApiScope[], key: NewKey): Promise<KeyRow | "limit"> {
  const n = await db.query("SELECT count(*)::int AS n FROM api_key WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  if (Number(n.rows[0]?.["n"]) >= MAX_KEYS_PER_USER) return "limit";
  const r = await db.query(
    "INSERT INTO api_key (user_id, public_id, secret_hash, name, scopes) VALUES ($1,$2,$3,$4,$5) RETURNING id, public_id, name, scopes, created_at, last_used_at, revoked_at",
    [userId, key.publicId, key.secretHash, name, scopes]);
  return toKey(r.rows[0]!);
}

export async function listKeys(db: Queryable, userId: string): Promise<KeyRow[]> {
  const r = await db.query("SELECT id, public_id, name, scopes, created_at, last_used_at, revoked_at FROM api_key WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
  return r.rows.map(toKey);
}

export async function revokeKey(db: Queryable, userId: string, id: string): Promise<boolean> {
  const r = await db.query("UPDATE api_key SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id", [id, userId]);
  return r.rows.length === 1;
}

export interface KeyAuthRow { id: string; userId: string; userType: string; secretHash: string; scopes: string[] }
const AUTH_SELECT = `SELECT k.id, k.user_id, u.user_type, k.secret_hash, k.scopes FROM api_key k JOIN app_user u ON u.id = k.user_id
                      WHERE k.revoked_at IS NULL AND u.status = 'active' AND u.deleted_at IS NULL`;
const toAuth = (r?: Record<string, unknown>): KeyAuthRow | null =>
  r ? { id: String(r["id"]), userId: String(r["user_id"]), userType: String(r["user_type"]), secretHash: String(r["secret_hash"]), scopes: r["scopes"] as string[] } : null;

/** A live key (not revoked) whose owner is still an active account. */
export async function keyByPublicId(db: Queryable, publicId: string): Promise<KeyAuthRow | null> {
  return toAuth((await db.query(`${AUTH_SELECT} AND k.public_id = $1`, [publicId])).rows[0]);
}
export async function keyById(db: Queryable, id: string): Promise<KeyAuthRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return toAuth((await db.query(`${AUTH_SELECT} AND k.id = $1::uuid`, [id])).rows[0]);
}

/** Calls this key made in the rate window. */
export async function recentCalls(db: Queryable, keyId: string): Promise<number> {
  const r = await db.query("SELECT count(*)::int AS n FROM api_request_log WHERE key_id = $1 AND at > now() - make_interval(secs => $2)", [keyId, API_RATE.windowSeconds]);
  return Number(r.rows[0]?.["n"] ?? 0);
}

export async function logCall(db: Queryable, keyId: string, route: string, method: string, status: number): Promise<void> {
  await db.query("INSERT INTO api_request_log (key_id, route, method, status) VALUES ($1,$2,$3,$4)", [keyId, route, method, status]);
  await db.query("UPDATE api_key SET last_used_at = now() WHERE id = $1", [keyId]);
}

export async function usageRows(db: Queryable, userId: string, days: number): Promise<UsageRow[]> {
  const r = await db.query(
    `SELECT l.route, l.method, l.status, count(*)::int AS calls FROM api_request_log l JOIN api_key k ON k.id = l.key_id
      WHERE k.user_id = $1 AND l.at > now() - make_interval(days => $2) GROUP BY 1,2,3 ORDER BY calls DESC LIMIT 200`, [userId, days]);
  return r.rows.map(x => ({ route: String(x["route"]), method: String(x["method"]), status: Number(x["status"]), calls: Number(x["calls"]) }));
}

// ---- webhook endpoints ----
export interface EndpointRow { id: string; url: string; events: string[]; active: boolean; createdAt: string }
const toEndpoint = (r: Record<string, unknown>): EndpointRow => ({ id: String(r["id"]), url: String(r["url"]), events: r["events"] as string[], active: r["active"] === true, createdAt: iso(r["created_at"])! });

export async function createEndpoint(db: Queryable, userId: string, url: string, events: WebhookEvent[], secret: string): Promise<EndpointRow | "limit"> {
  const n = await db.query("SELECT count(*)::int AS n FROM api_webhook_endpoint WHERE user_id = $1 AND active", [userId]);
  if (Number(n.rows[0]?.["n"]) >= MAX_ENDPOINTS_PER_USER) return "limit";
  const r = await db.query("INSERT INTO api_webhook_endpoint (user_id, url, secret, events) VALUES ($1,$2,$3,$4) RETURNING id, url, events, active, created_at", [userId, url, secret, events]);
  return toEndpoint(r.rows[0]!);
}
export async function listEndpoints(db: Queryable, userId: string): Promise<EndpointRow[]> {
  return (await db.query("SELECT id, url, events, active, created_at FROM api_webhook_endpoint WHERE user_id = $1 ORDER BY created_at DESC", [userId])).rows.map(toEndpoint);
}
export async function deleteEndpoint(db: Queryable, userId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const r = await db.query("DELETE FROM api_webhook_endpoint WHERE id = $1::uuid AND user_id = $2 RETURNING id", [id, userId]);
  return r.rows.length === 1;
}
export async function failingEndpointCount(db: Queryable, userId: string): Promise<{ total: number; failing: number }> {
  const r = await db.query("SELECT count(*)::int AS total, count(*) FILTER (WHERE consecutive_failures >= 3 OR NOT active)::int AS failing FROM api_webhook_endpoint WHERE user_id = $1", [userId]);
  return { total: Number(r.rows[0]?.["total"] ?? 0), failing: Number(r.rows[0]?.["failing"] ?? 0) };
}

/** Offers on the user's own listings. Price, status and time only. */
export async function offersOnMyListings(db: Queryable, userId: string, limit = 100) {
  const r = await db.query(
    `SELECT o.id, o.listing_id, o.price_cents, o.status, o.submitted_at FROM formal_offer o JOIN property_listing p ON p.id = o.listing_id
      WHERE p.owner_user_id = $1 ORDER BY o.submitted_at DESC LIMIT $2`, [userId, limit]);
  return r.rows.map(x => ({ id: String(x["id"]), listingId: String(x["listing_id"]), priceCents: Number(x["price_cents"]), status: String(x["status"]), submittedAt: iso(x["submitted_at"])! }));
}
