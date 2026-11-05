import { createHmac, randomUUID } from "node:crypto";
import { readCookie, SESSION_COOKIE, verifySession } from "../auth/session";
import { STAFF_COOKIE, verifyStaffSession } from "../auth/staff-session";
import { getDb } from "../context";
import { apiError, toV1ErrorBody, type ApiErrorBody } from "./errors";
import { createPgIdempotencyStore } from "./idempotency-db";
import {
  IDEMPOTENCY_HEADER, REPLAYED_HEADER, REPLAYED_HEADERS, isIdempotencyKey, requestHash, storable, type IdempotencyStore
} from "./idempotency";
import { API_VERSION_RESPONSE_HEADER, requestedVersion, resolveApiPath, type RequestedVersion } from "./version";

/**
 * The API layer every route handler is wrapped in (`export const POST = withApi(post)`; tests/api-standards.test.ts checks
 * that every route is). It adds, for every request:
 * - X-Correlation-Id on the response (the caller's own, if it sent a well-formed one).
 * - On /api/v1: the v1 error format for every error (errors.ts), the Api-Version header, and a required Idempotency-Key on writes.
 * - On writes that send an Idempotency-Key (v1 or legacy): replay of the first successful result (idempotency.ts).
 * Unversioned /api/... responses keep their body exactly as the handler wrote it, so the site's own pages are unaffected.
 */

export const CORRELATION_HEADER = "x-correlation-id";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/**
 * No idempotency handling: sign-in and logout (cookie flows), provider webhooks (they carry their own event ids and need the raw
 * body untouched) and internal cron calls (secret-guarded, already safe to repeat).
 */
const IDEMPOTENCY_EXEMPT = [/^\/api\/auth\//, /^\/api\/oauth\//, /^\/api\/webhooks\//, /^\/api\/internal\//, /^\/api\/dev\//];

export interface ApiLayerDeps {
  store: () => IdempotencyStore;
  secret: () => string | undefined;
  newId: () => string;
  nowSeconds: () => number;
}

const defaults: ApiLayerDeps = {
  store: () => createPgIdempotencyStore(getDb()),
  secret: () => process.env["SESSION_SECRET"],
  newId: () => randomUUID(),
  nowSeconds: () => Math.floor(Date.now() / 1000)
};

const CORRELATION_SHAPE = /^[A-Za-z0-9._:-]{8,100}$/;

/** Who the key belongs to. Cookies are only signature-checked here; the handler still does the full sign-in check. */
function scopeOf(req: Request, d: ApiLayerDeps): string {
  const secret = d.secret();
  const now = d.nowSeconds();
  if (secret && secret.length >= 32) {
    const user = verifySession(readCookie(req, SESSION_COOKIE), secret, now);
    if (user) return `user:${user.uid}`;
    const staff = verifyStaffSession(readCookie(req, STAFF_COOKIE), secret, now);
    if (staff) return `staff:${staff.uid}`;
  }
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",").map(s => s.trim()).filter(Boolean).pop() ?? "unknown";
  return `anon:${createHmac("sha256", `${secret ?? ""}:idempotency-scope:v1`).update(ip).digest("hex")}`;
}

function jsonResponse(body: ApiErrorBody, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

/** Rewrites an error response into the v1 format, keeping its status and its other headers (Set-Cookie, Retry-After, ...). */
async function asV1Error(res: Response, correlationId: string): Promise<Response> {
  const text = await res.text();
  let parsed: unknown = text;
  if ((res.headers.get("content-type") ?? "").includes("json")) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(toV1ErrorBody(res.status, parsed, correlationId)), { status: res.status, statusText: res.statusText, headers });
}

function stamp(res: Response, version: RequestedVersion, correlationId: string): Response {
  // Responses from fetch-style constructors can have immutable headers; copy when needed.
  let out = res;
  try {
    out.headers.set(CORRELATION_HEADER, correlationId);
  } catch {
    out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
    out.headers.set(CORRELATION_HEADER, correlationId);
  }
  if (version !== "legacy") out.headers.set(API_VERSION_RESPONSE_HEADER, version);
  return out;
}

/** Builds the wrapper with its dependencies (tests pass fakes; routes use withApi below). */
export function createWithApi(d: ApiLayerDeps) {
  // A handler that takes no request (a few public GETs) keeps that signature; it still gets the headers and error format.
  return function withApi<A extends [req?: Request, ...rest: never[]] | [req: Request, ...rest: unknown[]]>(handler: (...args: A) => Response | Promise<Response>) {
    return async (...args: A): Promise<Response> => {
      const req = args[0] ?? new Request("http://localhost/");
      const call = () => handler(...args);
      const version = requestedVersion(req);
      const supplied = req.headers.get(CORRELATION_HEADER);
      const correlationId = supplied && CORRELATION_SHAPE.test(supplied) ? supplied : d.newId();
      const v1 = version !== "legacy";
      const finish = async (res: Response) => stamp(v1 && res.status >= 400 ? await asV1Error(res, correlationId) : res, version, correlationId);
      const fail = (code: Parameters<typeof apiError>[0], status: number, message: string, headers: Record<string, string> = {}) =>
        stamp(v1 ? jsonResponse(apiError(code, correlationId, message), status, headers)
                 : new Response(JSON.stringify({ error: message, code }), { status, headers: { "content-type": "application/json", ...headers } }), version, correlationId);

      const method = req.method.toUpperCase();
      const url = new URL(req.url);
      const resolved = resolveApiPath(url.pathname);
      const path = resolved.kind === "versioned" || resolved.kind === "legacy" ? resolved.path : url.pathname;
      const key = req.headers.get(IDEMPOTENCY_HEADER);
      const idempotent = WRITE_METHODS.has(method) && !IDEMPOTENCY_EXEMPT.some(re => re.test(path));

      if (idempotent && key === null && v1) {
        return fail("idempotency_key_required", 400, "Send an Idempotency-Key header (a UUID) with every write. Reuse it only to retry the same request.");
      }
      if (!idempotent || key === null) {
        try {
          return await finish(await call());
        } catch (e) {
          if (!v1) throw e;
          return stamp(jsonResponse(apiError("internal", correlationId), 500), version, correlationId);
        }
      }
      if (!isIdempotencyKey(key)) return fail("idempotency_key_invalid", 400, "Idempotency-Key must be a UUID.");

      const store = d.store();
      const scope = scopeOf(req, d);
      const hash = requestHash(method, `${path}${url.search}`, new Uint8Array(await req.clone().arrayBuffer()));
      const claim = await store.claim(scope, key.toLowerCase(), hash, method, path);
      if (claim.kind === "mismatch") return fail("idempotency_key_reused", 422, "This Idempotency-Key was already used for a different request. Use a new key.");
      if (claim.kind === "in_progress") return fail("idempotency_in_progress", 409, "The first request with this Idempotency-Key is still running. Retry shortly.", { "retry-after": "1" });
      if (claim.kind === "replay") {
        const headers = new Headers(claim.response.headers);
        headers.set(REPLAYED_HEADER, "true");
        return stamp(new Response(claim.response.status === 204 ? null : claim.response.body, { status: claim.response.status, headers }), version, correlationId);
      }

      let res: Response;
      try {
        res = await call();
      } catch (e) {
        await store.release(scope, key.toLowerCase());
        if (!v1) throw e;
        return stamp(jsonResponse(apiError("internal", correlationId), 500), version, correlationId);
      }
      const body = res.status === 204 || res.status === 304 ? "" : await res.clone().text();
      if (storable(res.status, Buffer.byteLength(body))) {
        const headers: Record<string, string> = {};
        for (const h of REPLAYED_HEADERS) {
          const v = res.headers.get(h);
          if (v !== null) headers[h] = v;
        }
        await store.complete(scope, key.toLowerCase(), { status: res.status, headers, body });
      } else {
        await store.release(scope, key.toLowerCase());
      }
      return finish(res);
    };
  };
}

export const withApi = createWithApi(defaults);
