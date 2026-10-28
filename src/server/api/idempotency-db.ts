import type { Queryable } from "../db";
import { IDEMPOTENCY_LOCK_SECONDS, IDEMPOTENCY_TTL_HOURS, type Claim, type IdempotencyStore } from "./idempotency";

/** Postgres store for idempotency keys. Every statement is parameterised; the claim is a single atomic upsert. */
export function createPgIdempotencyStore(db: Queryable): IdempotencyStore {
  return {
    async claim(scope, key, hash, method, path): Promise<Claim> {
      // Inserts a new claim, or takes over an expired one, or an abandoned claim for the very same request.
      const won = await db.query(
        `INSERT INTO api_idempotency_key (scope, idem_key, method, path, request_hash, expires_at)
         VALUES ($1, $2::uuid, $3, $4, $5, now() + make_interval(hours => $6))
         ON CONFLICT (scope, idem_key) DO UPDATE
            SET method = EXCLUDED.method, path = EXCLUDED.path, request_hash = EXCLUDED.request_hash, state = 'in_progress',
                locked_at = now(), expires_at = EXCLUDED.expires_at, response_status = NULL, response_headers = NULL, response_body = NULL, completed_at = NULL
          WHERE api_idempotency_key.expires_at <= now()
             OR (api_idempotency_key.state = 'in_progress' AND api_idempotency_key.request_hash = EXCLUDED.request_hash
                 AND api_idempotency_key.locked_at < now() - make_interval(secs => $7))
         RETURNING scope`,
        [scope, key, method, path, hash, IDEMPOTENCY_TTL_HOURS, IDEMPOTENCY_LOCK_SECONDS]);
      if (won.rows.length === 1) return { kind: "claimed" };
      const r = await db.query(
        "SELECT request_hash, state, response_status, response_headers, response_body FROM api_idempotency_key WHERE scope = $1 AND idem_key = $2::uuid",
        [scope, key]);
      const row = r.rows[0];
      // Gone between the two statements (released): report busy, the client retries.
      if (!row) return { kind: "in_progress" };
      if (row["request_hash"] !== hash) return { kind: "mismatch" };
      if (row["state"] !== "completed") return { kind: "in_progress" };
      const headers = (row["response_headers"] && typeof row["response_headers"] === "object" ? row["response_headers"] : {}) as Record<string, string>;
      return { kind: "replay", response: { status: Number(row["response_status"]), headers, body: String(row["response_body"] ?? "") } };
    },
    async complete(scope, key, res) {
      await db.query(
        `UPDATE api_idempotency_key SET state = 'completed', response_status = $3, response_headers = $4::jsonb, response_body = $5, completed_at = now()
          WHERE scope = $1 AND idem_key = $2::uuid AND state = 'in_progress'`,
        [scope, key, res.status, JSON.stringify(res.headers), res.body]);
    },
    async release(scope, key) {
      await db.query("DELETE FROM api_idempotency_key WHERE scope = $1 AND idem_key = $2::uuid AND state = 'in_progress'", [scope, key]);
    }
  };
}
