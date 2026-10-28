import { createHash } from "node:crypto";

/**
 * Idempotency keys (House Listing Spec: "Every write takes an Idempotency-Key header (UUID). A repeat with the same key returns
 * the first result."). A client retrying after a timeout sends the same key, and gets the stored response instead of a second
 * offer, payment or listing.
 *
 * Rules:
 * - Keys are scoped to the caller (signed-in user, staff member, or anonymous client), so one caller can never read another's result.
 * - The same key with a different request (method, path, query or body) is refused: 422 idempotency_key_reused.
 * - While the first request is still running, a repeat gets 409 idempotency_in_progress (retry shortly).
 * - Only successful results (status below 400) are stored and replayed, for 24 hours. A failed request releases its key, so the
 *   client can fix the request and retry with the same key. Set-Cookie is never replayed.
 */
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const REPLAYED_HEADER = "idempotent-replayed";
export const IDEMPOTENCY_TTL_HOURS = 24;
/** A claim older than this with no result is treated as abandoned (the process died) and may be taken over by the same request. */
export const IDEMPOTENCY_LOCK_SECONDS = 60;
/** Larger responses are not stored; the key is released instead. */
export const MAX_STORED_BODY_BYTES = 1_000_000;
/** Response headers kept for replay. */
export const REPLAYED_HEADERS = ["content-type", "location", "cache-control"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isIdempotencyKey = (v: string): boolean => UUID.test(v);

export interface StoredResponse { status: number; headers: Record<string, string>; body: string }

export type Claim =
  | { kind: "claimed" }
  | { kind: "replay"; response: StoredResponse }
  | { kind: "in_progress" }
  | { kind: "mismatch" };

/** Storage for keys. The Postgres version is in idempotency-db.ts. */
export interface IdempotencyStore {
  /** Claims (scope, key) for this request, or reports what already holds it. */
  claim(scope: string, key: string, requestHash: string, method: string, path: string): Promise<Claim>;
  complete(scope: string, key: string, response: StoredResponse): Promise<void>;
  /** Drops an unfinished claim so the key can be used again. */
  release(scope: string, key: string): Promise<void>;
}

/** Fingerprint of the request: method, path with query, and the exact body bytes. */
export function requestHash(method: string, pathWithQuery: string, body: Uint8Array): string {
  return createHash("sha256").update(`${method.toUpperCase()}\n${pathWithQuery}\n`).update(body).digest("hex");
}

/** Whether a finished response may be stored for replay. */
export const storable = (status: number, bodyBytes: number): boolean => status < 400 && bodyBytes <= MAX_STORED_BODY_BYTES;
