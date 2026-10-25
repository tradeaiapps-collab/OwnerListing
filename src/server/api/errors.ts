/**
 * The error contract for /api/v1 (House Listing Spec, "Error format"). Every error is
 *   { "error": { "code", "message", "correlationId", "reasons"?, "fields"?, "nextStep"?, "details"? } }
 * with a stable machine-readable `code` from the list below and the HTTP status that goes with it. `message` is for people and
 * may change; clients branch on `code` only. Pure: no I/O.
 */
export const API_ERROR_CODES = {
  invalid_input: 400,
  idempotency_key_required: 400,
  idempotency_key_invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  mfa_required: 403,
  verification_required: 403,
  not_found: 404,
  unsupported_version: 404,
  method_not_allowed: 405,
  conflict: 409,
  version_conflict: 409,
  invalid_transition: 409,
  idempotency_in_progress: 409,
  gone: 410,
  link_expired: 410,
  link_used: 410,
  payload_too_large: 413,
  unsupported_media_type: 415,
  unprocessable: 422,
  idempotency_key_reused: 422,
  publish_blocked: 422,
  policy_blocked: 422,
  upload_rejected: 422,
  region_not_enabled: 423,
  rate_limited: 429,
  internal: 500,
  upstream_failed: 502,
  unavailable: 503,
  ai_unavailable: 503
} as const satisfies Record<string, number>;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;

export const isApiErrorCode = (v: unknown): v is ApiErrorCode => typeof v === "string" && Object.hasOwn(API_ERROR_CODES, v);

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    correlationId: string;
    reasons?: string[];
    fields?: Record<string, string>;
    nextStep?: string;
    details?: Record<string, unknown>;
  };
}

/** The default code for a status when the route did not name one. */
export function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400: return "invalid_input";
    case 401: return "unauthenticated";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 405: return "method_not_allowed";
    case 409: return "conflict";
    case 410: return "gone";
    case 413: return "payload_too_large";
    case 415: return "unsupported_media_type";
    case 422: return "unprocessable";
    case 423: return "region_not_enabled";
    case 429: return "rate_limited";
    case 502: return "upstream_failed";
    case 503: return "unavailable";
    default: return status >= 500 ? "internal" : "invalid_input";
  }
}

const DEFAULT_MESSAGE: Partial<Record<ApiErrorCode, string>> = {
  invalid_input: "The request is not valid.",
  unauthenticated: "Sign in required.",
  forbidden: "You cannot do this.",
  not_found: "Not found.",
  method_not_allowed: "Method not allowed.",
  conflict: "This conflicts with the current state.",
  gone: "This is no longer available.",
  payload_too_large: "The request is too large.",
  unsupported_media_type: "Unsupported content type.",
  unprocessable: "The request could not be processed.",
  rate_limited: "Too many requests. Try again later.",
  internal: "Something went wrong on our side. Try again later.",
  upstream_failed: "A service we depend on failed. Try again later.",
  unavailable: "This is not available right now. Try again later."
};

const VERIFY_STEPS = new Set(["verify_email", "verify_phone", "verify_id"]);
const stringList = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every(x => typeof x === "string") ? v : undefined);
function stringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const e = Object.entries(v as Record<string, unknown>);
  return e.every(([, x]) => typeof x === "string") ? Object.fromEntries(e) as Record<string, string> : undefined;
}

/** Builds a v1 error body directly (used by the API layer itself, e.g. idempotency and version errors). */
export function apiError(code: ApiErrorCode, correlationId: string, message?: string, extra: Omit<ApiErrorBody["error"], "code" | "message" | "correlationId"> = {}): ApiErrorBody {
  return { error: { code, message: message ?? DEFAULT_MESSAGE[code] ?? DEFAULT_MESSAGE[codeForStatus(API_ERROR_CODES[code])] ?? "Request failed.", correlationId, ...extra } };
}

/**
 * Turns whatever error body a route handler returned (today mostly { error: "message", ...extras }, sometimes plain text) into the
 * v1 shape. The code comes from the body's own `code` when it is a known one, else from the status (a 403 that names a
 * verification step becomes verification_required). Known extras keep their names; any other field goes under `details`.
 */
export function toV1ErrorBody(status: number, body: unknown, correlationId: string): ApiErrorBody {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const { error, message, code, reasons, fields, nextStep, ...rest } = b;
  const nested = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  if (nested && isApiErrorCode(nested["code"])) return { error: { ...(nested as ApiErrorBody["error"]), correlationId } };
  let c: ApiErrorCode = isApiErrorCode(code) ? code : codeForStatus(status);
  if (!isApiErrorCode(code) && status === 403 && typeof nextStep === "string" && VERIFY_STEPS.has(nextStep)) c = "verification_required";
  const text = typeof error === "string" && error ? error : typeof message === "string" && message ? message : typeof body === "string" && body.trim() && body.length <= 300 ? body.trim() : undefined;
  const details: Record<string, unknown> = { ...rest, ...(typeof code === "string" && !isApiErrorCode(code) ? { reason: code } : {}) };
  const r = stringList(reasons), f = stringMap(fields);
  return apiError(c, correlationId, text, {
    ...(r ? { reasons: r } : {}),
    ...(f ? { fields: f } : {}),
    ...(typeof nextStep === "string" ? { nextStep } : {}),
    ...(Object.keys(details).length ? { details } : {})
  });
}
