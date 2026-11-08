import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { readBrand } from "../config/brand";
import { isPublicAddress } from "../domain/net-guard";
import { DISABLE_AFTER_FAILURES, MAX_ATTEMPTS, envelopeBody, nextAttemptDelaySeconds, signPayload } from "../domain/webhooks";
import type { Queryable } from "./db";

/** Moves new events to the endpoints that want them, then sends what is due. Called by a scheduler (app/api/internal/webhooks/run). */

export interface SendInput { url: string; body: string; headers: Record<string, string>; timeoutMs: number }
export interface SendResult { status: number }
export type Sender = (i: SendInput) => Promise<SendResult>;

/**
 * Real sender. The host is resolved once, every address must be public, and the connection goes to that address (so a name that
 * changes between check and connect cannot reach an internal host). Redirects are never followed. The response body is discarded.
 */
export const httpsSender: Sender = input => new Promise((resolve, reject) => {
  const u = new URL(input.url);
  const guardedLookup = ((host: string, _o: unknown, cb: (e: Error | null, address?: string, family?: number) => void) => {
    dnsLookup(host, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs.length || !addrs.every(a => isPublicAddress(a.address))) return cb(new Error("Host resolves to a non-public address."));
      cb(null, addrs[0]!.address, addrs[0]!.family);
    });
  }) as never;
  const req = httpsRequest({ host: u.hostname, port: 443, path: `${u.pathname}${u.search}`, method: "POST", headers: { ...input.headers, "content-length": String(Buffer.byteLength(input.body)) }, lookup: guardedLookup, timeout: input.timeoutMs }, res => {
    res.resume();
    resolve({ status: res.statusCode ?? 0 });
  });
  req.on("timeout", () => req.destroy(new Error("Timed out.")));
  req.on("error", reject);
  req.end(input.body);
});

export async function fanOutEvents(db: Queryable, limit = 200): Promise<number> {
  const ev = await db.query("SELECT id FROM api_event WHERE fanned_out_at IS NULL ORDER BY created_at LIMIT $1", [limit]);
  const ids = ev.rows.map(r => String(r["id"]));
  if (ids.length === 0) return 0;
  await db.query(
    `INSERT INTO api_webhook_delivery (endpoint_id, event_id)
     SELECT w.id, e.id FROM api_event e JOIN api_webhook_endpoint w ON w.user_id = e.owner_user_id AND w.active AND e.event_type = ANY(w.events)
      WHERE e.id = ANY($1::uuid[]) ON CONFLICT (endpoint_id, event_id) DO NOTHING`, [ids]);
  await db.query("UPDATE api_event SET fanned_out_at = now() WHERE id = ANY($1::uuid[])", [ids]);
  return ids.length;
}

export interface RunCounts { events: number; delivered: number; retried: number; failed: number }

export async function runWebhooks(db: Queryable, send: Sender = httpsSender, nowSeconds: () => number = () => Math.floor(Date.now() / 1000), batch = 20): Promise<RunCounts> {
  const counts: RunCounts = { events: await fanOutEvents(db), delivered: 0, retried: 0, failed: 0 };
  // Claiming pushes next_attempt_at out, so a crashed run or a second worker does not resend at once.
  const due = await db.query(
    `UPDATE api_webhook_delivery d SET next_attempt_at = now() + interval '2 minutes'
      WHERE d.id IN (SELECT id FROM api_webhook_delivery WHERE state = 'pending' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.endpoint_id, d.event_id, d.attempts`, [batch]);
  for (const d of due.rows) {
    const info = await db.query(
      `SELECT w.url, w.secret, w.active, e.event_type, e.payload, e.created_at FROM api_webhook_delivery x
         JOIN api_webhook_endpoint w ON w.id = x.endpoint_id JOIN api_event e ON e.id = x.event_id WHERE x.id = $1`, [d.id]);
    const row = info.rows[0];
    if (!row || row["active"] !== true) { await db.query("UPDATE api_webhook_delivery SET state = 'failed', last_error = 'endpoint disabled' WHERE id = $1", [d.id]); counts.failed++; continue; }
    const body = envelopeBody({ id: String(d.event_id), type: String(row["event_type"]), createdAt: new Date(row["created_at"] as string).toISOString(), data: row["payload"] as Record<string, unknown> });
    const t = nowSeconds();
    let status = 0; let error: string | null = null;
    try {
      status = (await send({ url: String(row["url"]), body, timeoutMs: 8000, headers: {
        "content-type": "application/json", "user-agent": `${readBrand().name.replace(/[^A-Za-z0-9]/g, "")}-Webhooks/1`, "ol-signature": signPayload(String(row["secret"]), body, t),
        "ol-event-id": String(d.event_id), "ol-event-type": String(row["event_type"]), "ol-delivery-id": randomUUID() } })).status;
    } catch (e) { error = (e as Error).message.slice(0, 200); }
    const attempts = Number(d.attempts) + 1;
    if (status >= 200 && status < 300) {
      await db.query("UPDATE api_webhook_delivery SET state='delivered', attempts=$2, last_status=$3, last_error=NULL, delivered_at=now() WHERE id=$1", [d.id, attempts, status]);
      await db.query("UPDATE api_webhook_endpoint SET consecutive_failures = 0 WHERE id = $1", [d.endpoint_id]);
      counts.delivered++;
      continue;
    }
    const delay = nextAttemptDelaySeconds(attempts);
    if (delay !== null && attempts < MAX_ATTEMPTS) {
      await db.query("UPDATE api_webhook_delivery SET attempts=$2, last_status=$3, last_error=$4, next_attempt_at = now() + make_interval(secs => $5) WHERE id=$1", [d.id, attempts, status || null, error ?? `HTTP ${status}`, delay]);
      counts.retried++;
    } else {
      await db.query("UPDATE api_webhook_delivery SET state='failed', attempts=$2, last_status=$3, last_error=$4 WHERE id=$1", [d.id, attempts, status || null, error ?? `HTTP ${status}`]);
      counts.failed++;
    }
    await db.query(
      `UPDATE api_webhook_endpoint SET consecutive_failures = consecutive_failures + 1,
              active = (consecutive_failures + 1) < $2, disabled_at = CASE WHEN (consecutive_failures + 1) >= $2 THEN now() ELSE disabled_at END WHERE id = $1`,
      [d.endpoint_id, DISABLE_AFTER_FAILURES]);
  }
  return counts;
}
