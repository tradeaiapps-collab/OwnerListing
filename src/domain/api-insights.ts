import { buildOpenApi, documentedOperations } from "./openapi";
import { WEBHOOK_EVENTS } from "./webhooks";

/**
 * What Elena says to integrators. Deterministic (no outside AI): usage suggestions come from counts, answers about the API come
 * from the OpenAPI document. She sees route templates and status counts only, never request bodies or other people's data.
 */
export interface UsageRow { route: string; method: string; status: number; calls: number }
export interface Suggestion { id: string; message: string }
export interface UsageReport {
  totalCalls: number; errorRate: number;
  topRoutes: { route: string; method: string; calls: number; errors: number }[];
  suggestions: Suggestion[];
}

export function analyseUsage(rows: readonly UsageRow[], ctx: { webhookEndpoints: number; failingEndpoints: number }): UsageReport {
  const total = rows.reduce((a, r) => a + r.calls, 0);
  const count = (f: (r: UsageRow) => boolean) => rows.filter(f).reduce((a, r) => a + r.calls, 0);
  const errors = count(r => r.status >= 400);
  const byRoute = new Map<string, { route: string; method: string; calls: number; errors: number }>();
  for (const r of rows) {
    const k = `${r.method} ${r.route}`;
    const e = byRoute.get(k) ?? { route: r.route, method: r.method, calls: 0, errors: 0 };
    e.calls += r.calls;
    if (r.status >= 400) e.errors += r.calls;
    byRoute.set(k, e);
  }
  const suggestions: Suggestion[] = [];
  const add = (id: string, message: string) => suggestions.push({ id, message });
  const throttled = count(r => r.status === 429);
  if (throttled > 0) add("rate_limited", `${throttled} calls were throttled (429). Slow down, honour the Retry-After header, and cache listing reads for a minute or two.`);
  const unauthorised = count(r => r.status === 401);
  if (unauthorised > 0) add("auth_failures", `${unauthorised} calls were rejected as unauthorised. Check the key has not been revoked, or refresh your token before it expires (they last one hour).`);
  const forbidden = count(r => r.status === 403);
  if (forbidden > 0) add("missing_scope", `${forbidden} calls lacked a scope. Create a key with the scope the endpoint needs (see the OpenAPI document).`);
  const missingIdem = rows.filter(r => r.status === 400 && /^(POST|PUT|PATCH|DELETE)$/.test(r.method)).reduce((a, r) => a + r.calls, 0);
  if (missingIdem > 0) add("write_errors", `${missingIdem} write calls were refused as bad requests. Writes need an Idempotency-Key header (a fresh UUID per action).`);
  const reads = count(r => r.method === "GET" && /^\/(public\/listings|me\/listings|me\/offers)/.test(r.route));
  if (reads >= 200 && ctx.webhookEndpoints === 0) add("use_webhooks", `${reads} listing and offer reads this week and no webhook endpoint. Subscribe to ${WEBHOOK_EVENTS.join(", ")} instead of polling.`);
  if (total > 0 && errors / total > 0.2) add("high_error_rate", `${Math.round((errors / total) * 100)}% of calls failed. Start with the busiest failing route below.`);
  if (ctx.failingEndpoints > 0) add("failing_webhooks", `${ctx.failingEndpoints} webhook endpoint(s) are failing deliveries. Make sure the URL answers 2xx within 8 seconds and the signature is checked against the raw body.`);
  const hot = [...byRoute.values()].sort((a, b) => b.calls - a.calls);
  return { totalCalls: total, errorRate: total ? errors / total : 0, topRoutes: hot.slice(0, 5), suggestions };
}

const TOPICS: { id: string; words: string[]; answer: string }[] = [
  { id: "auth", words: ["auth", "authenticate", "key", "token", "bearer", "oauth", "credentials", "secret", "login"],
    answer: "Create a key in your dashboard (owners and agents only) and send it as Authorization: Bearer olk_.... For OAuth, POST client_id (olk_...) and client_secret to /api/v1/oauth/token with grant_type=client_credentials and use the one-hour olt_ token the same way. The secret is shown once." },
  { id: "idempotency", words: ["idempotency", "idempotent", "retry", "duplicate", "repeat"],
    answer: "Every write needs an Idempotency-Key header with a UUID. Retry a failed request with the same key and you get the first result back instead of a second action." },
  { id: "rate", words: ["rate", "limit", "throttle", "429", "quota", "many"],
    answer: "Each key may make 120 calls per 60 seconds. Over that you get 429 with a Retry-After header. Cache reads, and use webhooks rather than polling." },
  { id: "errors", words: ["error", "errors", "code", "status", "401", "403", "404", "400", "fail", "failed"],
    answer: "Errors look like { error: { code, message, correlationId } }. Branch on code. Quote the correlationId if you contact support. 401 means bad credentials, 403 a missing scope, 429 slow down." },
  { id: "webhooks", words: ["webhook", "webhooks", "event", "events", "signature", "signing", "verify", "subscribe", "notification"],
    answer: `Create an endpoint with POST /api/v1/developer/webhooks (https URL and a list of events: ${WEBHOOK_EVENTS.join(", ")}). Each delivery has an OL-Signature header, t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>"> using your whsec_ secret. Reject timestamps older than 5 minutes. Answer 2xx within 8 seconds; failures retry after 1 min, 5 min, 30 min and 2 h with the same event id, so de-duplicate on it. Payloads hold ids only; fetch the details with the API.` },
  { id: "scopes", words: ["scope", "scopes", "permission", "permissions", "access"],
    answer: "Scopes: listings.read (published and your own listings), offers.read (price and status of offers on your listings), webhooks.manage (endpoints). Give a key only what it needs." }
];

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

export function answerApiQuestion(question: string): { answer: string; references: string[] } {
  const q = new Set(tokens(question));
  if (q.size === 0) return { answer: "Ask me about keys, scopes, webhooks, errors, rate limits or any endpoint.", references: [] };
  const spec = buildOpenApi() as { paths: Record<string, Record<string, { summary?: string; description?: string }>> };
  const ops = documentedOperations().map(op => {
    const [method, path] = op.split(" ") as [string, string];
    const o = spec.paths[path]![method.toLowerCase()]!;
    const hay = new Set(tokens(`${path} ${o.summary ?? ""} ${o.description ?? ""}`));
    const score = [...q].filter(w => w.length > 2 && hay.has(w)).length;
    return { op, summary: o.summary ?? "", score };
  }).filter(o => o.score > 0).sort((a, b) => b.score - a.score || a.op.localeCompare(b.op)).slice(0, 3);
  const topic = TOPICS.map(t => ({ t, score: t.words.filter(w => q.has(w)).length })).filter(x => x.score > 0).sort((a, b) => b.score - a.score)[0];
  if (!topic && ops.length === 0) {
    return { answer: "I could not find that in the API documentation. The full description is at /api/v1/openapi. You can ask about keys, scopes, webhooks, errors, rate limits or a specific endpoint.", references: ["GET /openapi"] };
  }
  const parts: string[] = [];
  if (topic) parts.push(topic.t.answer);
  if (ops.length) parts.push("Related endpoints: " + ops.map(o => `${o.op} (${o.summary})`).join("; ") + ".");
  return { answer: parts.join(" "), references: ops.map(o => o.op) };
}
