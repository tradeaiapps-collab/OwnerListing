/** Read-only audit log queries for staff: input parsing, paging cursor and redaction. Pure functions, no I/O. */

export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;

export interface AuditQuery {
  eventType?: string;
  actorId?: string;
  aggregateType?: string;
  aggregateId?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: { t: string; id: string };
}

export type ParsedAuditQuery = { ok: true; query: AuditQuery } | { ok: false; error: string };

const TOKEN = /^[A-Za-z0-9_.:-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asIso = (v: string): string | null => {
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

export function encodeCursor(c: { t: string; id: string }): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): { t: string; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; id?: unknown };
    if (typeof v.t !== "string" || typeof v.id !== "string" || !UUID.test(v.id)) return null;
    const t = asIso(v.t);
    return t ? { t, id: v.id } : null;
  } catch {
    return null;
  }
}

export function parseAuditQuery(p: URLSearchParams): ParsedAuditQuery {
  const q: AuditQuery = { limit: AUDIT_DEFAULT_LIMIT };
  for (const key of ["eventType", "actorId", "aggregateType", "aggregateId"] as const) {
    const v = p.get(key);
    if (v === null || v === "") continue;
    if (!TOKEN.test(v)) return { ok: false, error: `Invalid ${key}.` };
    q[key] = v;
  }
  const listingId = p.get("listingId");
  if (listingId) {
    if (!TOKEN.test(listingId)) return { ok: false, error: "Invalid listingId." };
    if ((q.aggregateType && q.aggregateType !== "listing") || (q.aggregateId && q.aggregateId !== listingId)) {
      return { ok: false, error: "listingId conflicts with aggregateType/aggregateId." };
    }
    q.aggregateType = "listing";
    q.aggregateId = listingId;
  }
  for (const key of ["from", "to"] as const) {
    const v = p.get(key);
    if (v === null || v === "") continue;
    const iso = asIso(v);
    if (!iso) return { ok: false, error: `Invalid ${key}.` };
    q[key] = iso;
  }
  const lim = p.get("limit");
  if (lim !== null && lim !== "") {
    if (!/^\d{1,4}$/.test(lim) || Number(lim) < 1) return { ok: false, error: "Invalid limit." };
    q.limit = Math.min(Number(lim), AUDIT_MAX_LIMIT);
  }
  const cur = p.get("cursor");
  if (cur) {
    const c = decodeCursor(cur);
    if (!c) return { ok: false, error: "Invalid cursor." };
    q.cursor = c;
  }
  return { ok: true, query: q };
}

const SENSITIVE_KEY = /email|token|secret|password|phone|mobile|name|address|dob|birth|licen[cs]e|abn|tfn|passport|cookie|authorization|hash|sub$/i;
const EMAIL = /[^\s@"']+@[^\s@"']+\.[^\s@"']+/g;
const REDACTED = "[redacted]";

/** Removes personal data and credentials from an audit payload before it leaves the server. Redacts by key name and by email-shaped text. */
export function redactPayload(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.replace(EMAIL, REDACTED);
  if (v === null || typeof v !== "object") return v;
  if (depth >= 5) return REDACTED;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => redactPayload(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactPayload(val, depth + 1);
  }
  return out;
}

export interface AuditRowOut {
  id: string;
  occurredAt: string;
  actorType: string;
  actorId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}
