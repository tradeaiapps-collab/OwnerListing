import { randomUUID } from "node:crypto";
import { crmEventId, crmPayload, currentStatus, planSync, type CrmEvent, type SyncStatus } from "../domain/crm-sync";
import { readBrand } from "../config/brand";
import { DISABLE_AFTER_FAILURES, MAX_ATTEMPTS, envelopeBody, newWebhookSecret, nextAttemptDelaySeconds, signPayload, validateWebhookUrl } from "../domain/webhooks";
import { appendAuditPg, type Queryable } from "./db";
import { httpsSender, type Sender } from "./webhook-delivery";

/**
 * Sends listing status changes (sold, rented, delisted, reactivated) to the agency CRM's webhook. Parameterised SQL only.
 * sweep: compare each connection's listings with what the CRM was last told and queue one event per change.
 * deliver: send what is due, signed, with the same retry schedule as the public API webhooks.
 */
const iso = (v: unknown) => new Date(String(v)).toISOString();

export interface OutboundInfo { enabled: boolean; url: string | null; failures: number; enabledAt: string | null }
export interface DeliveryRow { id: string; eventType: string; listingId: string; state: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string; deliveredAt: string | null }

export async function getOutbound(db: Queryable, connectionId: string): Promise<OutboundInfo | undefined> {
  const r = (await db.query("SELECT outbound_enabled, outbound_url, outbound_failures, outbound_enabled_at FROM feed_connection WHERE id = $1::uuid", [connectionId])).rows[0];
  return r ? { enabled: r["outbound_enabled"] === true, url: r["outbound_url"] ? String(r["outbound_url"]) : null, failures: Number(r["outbound_failures"]), enabledAt: r["outbound_enabled_at"] ? iso(r["outbound_enabled_at"]) : null } : undefined;
}

/** Turns sync on (or changes its address) and issues a new signing secret, returned once. Only changes made after this moment are sent. */
export async function enableOutbound(db: Queryable, staffId: string, connectionId: string, rawUrl: unknown, now: string): Promise<{ ok: true; secret: string } | { ok: false; message: string }> {
  const v = validateWebhookUrl(rawUrl);
  if (!v.ok) return v;
  const secret = newWebhookSecret();
  const r = await db.query(
    `UPDATE feed_connection SET outbound_url = $2, outbound_secret = $3, outbound_enabled = true, outbound_failures = 0,
            outbound_enabled_at = COALESCE(CASE WHEN outbound_url = $2 THEN outbound_enabled_at END, $4::timestamptz), updated_at = $4::timestamptz
      WHERE id = $1::uuid RETURNING id`, [connectionId, v.url, secret, now]);
  if (r.rows.length === 0) return { ok: false, message: "Connection not found." };
  await appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType: "user", actorId: staffId, aggregateType: "feed_connection", aggregateId: connectionId, eventType: "feed.outbound_enabled", correlationId: randomUUID(), payload: { host: new URL(v.url).hostname } });
  return { ok: true, secret };
}

export async function disableOutbound(db: Queryable, staffId: string, connectionId: string, now: string): Promise<boolean> {
  const r = await db.query("UPDATE feed_connection SET outbound_enabled = false, updated_at = $2::timestamptz WHERE id = $1::uuid RETURNING id", [connectionId, now]);
  if (r.rows.length === 0) return false;
  await appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType: "user", actorId: staffId, aggregateType: "feed_connection", aggregateId: connectionId, eventType: "feed.outbound_disabled", correlationId: randomUUID(), payload: {} });
  return true;
}

export async function recentDeliveries(db: Queryable, connectionId: string, limit = 20): Promise<DeliveryRow[]> {
  const r = await db.query(
    `SELECT id, event_type, listing_id, state, attempts, last_status, last_error, created_at, delivered_at FROM crm_outbound_delivery
      WHERE connection_id = $1::uuid ORDER BY created_at DESC, id LIMIT $2::int`, [connectionId, limit]);
  return r.rows.map(x => ({ id: String(x["id"]), eventType: String(x["event_type"]), listingId: String(x["listing_id"]), state: String(x["state"]), attempts: Number(x["attempts"]),
    lastStatus: x["last_status"] == null ? null : Number(x["last_status"]), lastError: x["last_error"] ? String(x["last_error"]) : null, createdAt: iso(x["created_at"]), deliveredAt: x["delivered_at"] ? iso(x["delivered_at"]) : null }));
}

/** Queues events for every connection with sync on. Returns how many were queued. */
export async function sweepStatusChanges(db: Queryable): Promise<number> {
  const conns = await db.query("SELECT id, agent_user_id, outbound_enabled_at FROM feed_connection WHERE outbound_enabled AND enabled");
  let queued = 0;
  for (const c of conns.rows) {
    const connId = String(c["id"]), enabledAt = iso(c["outbound_enabled_at"]);
    const rows = await db.query(
      `SELECT l.id, l.title, l.suburb, l.postcode, l.status, l.transaction_type, l.updated_at, ev.event_type AS sale_type, ev.occurred_at AS sale_at, ev.amount_cents AS sale_cents,
              fr.external_id, st.status AS synced
         FROM property_listing l
         LEFT JOIN listing_agent_appointment a ON a.listing_id = l.id AND a.agent_user_id = $2::uuid AND a.revoked_at IS NULL
         LEFT JOIN feed_record fr ON fr.connection_id = $1::uuid AND fr.draft_listing_id = l.id
         LEFT JOIN crm_sync_state st ON st.connection_id = $1::uuid AND st.listing_id = l.id
         LEFT JOIN LATERAL (SELECT e.event_type, e.occurred_at, e.amount_cents FROM property_event e
                             WHERE e.listing_id = l.id AND e.event_type IN ('sold','rented') AND e.voided_at IS NULL ORDER BY e.occurred_at DESC LIMIT 1) ev ON true
        WHERE (a.listing_id IS NOT NULL OR fr.external_id IS NOT NULL) AND l.status IN ('published','withdrawn','archived')
        ORDER BY l.updated_at DESC LIMIT 1000`, [connId, c["agent_user_id"] ?? null]);
    for (const x of rows.rows) {
      const cur = currentStatus({ status: String(x["status"]), transactionType: String(x["transaction_type"]), updatedAt: iso(x["updated_at"]),
        ...(x["sale_type"] ? { saleType: String(x["sale_type"]) as "sold" | "rented", saleAt: iso(x["sale_at"]) } : {}) });
      if (!cur) continue;
      const plan = planSync(x["synced"] ? (String(x["synced"]) as SyncStatus) : undefined, cur, enabledAt);
      if (plan.kind === "none") continue;
      if (plan.kind === "event") {
        const payload = crmPayload({ listingId: String(x["id"]), ...(x["external_id"] ? { externalId: String(x["external_id"]) } : {}), status: cur.status, title: String(x["title"]),
          ...(x["suburb"] ? { suburb: String(x["suburb"]) } : {}), ...(x["postcode"] ? { postcode: String(x["postcode"]) } : {}), transactionType: String(x["transaction_type"]), occurredAt: cur.since,
          ...(cur.status === "sold" || cur.status === "rented" ? (x["sale_cents"] != null ? { priceCents: Number(x["sale_cents"]) } : {}) : {}) });
        const ins = await db.query(
          `INSERT INTO crm_outbound_delivery (connection_id, listing_id, event_type, occurred_at, payload) VALUES ($1::uuid,$2::uuid,$3,$4::timestamptz,$5::jsonb)
           ON CONFLICT (connection_id, listing_id, event_type, occurred_at) DO NOTHING RETURNING id`, [connId, x["id"], plan.event, cur.since, JSON.stringify(payload)]);
        queued += ins.rows.length;
      }
      await db.query(
        `INSERT INTO crm_sync_state (connection_id, listing_id, status) VALUES ($1::uuid,$2::uuid,$3)
         ON CONFLICT (connection_id, listing_id) DO UPDATE SET status = EXCLUDED.status, synced_at = now()`, [connId, x["id"], cur.status]);
    }
  }
  return queued;
}

export interface DeliverCounts { delivered: number; retried: number; failed: number }

export async function deliverDue(db: Queryable, send: Sender = httpsSender, nowSeconds: () => number = () => Math.floor(Date.now() / 1000), batch = 20): Promise<DeliverCounts> {
  const counts: DeliverCounts = { delivered: 0, retried: 0, failed: 0 };
  // Claiming pushes next_attempt_at out so a crashed run or second worker does not resend at once.
  const due = await db.query(
    `UPDATE crm_outbound_delivery d SET next_attempt_at = now() + interval '2 minutes'
      WHERE d.id IN (SELECT id FROM crm_outbound_delivery WHERE state = 'pending' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.connection_id, d.attempts`, [batch]);
  for (const d of due.rows) {
    const row = (await db.query(
      `SELECT c.outbound_url, c.outbound_secret, c.outbound_enabled, x.event_type, x.occurred_at, x.listing_id, x.payload FROM crm_outbound_delivery x
         JOIN feed_connection c ON c.id = x.connection_id WHERE x.id = $1::uuid`, [d["id"]])).rows[0];
    if (!row || row["outbound_enabled"] !== true || !row["outbound_url"] || !row["outbound_secret"]) {
      await db.query("UPDATE crm_outbound_delivery SET state = 'failed', last_error = 'sync switched off' WHERE id = $1::uuid", [d["id"]]);
      counts.failed++; continue;
    }
    const eventId = crmEventId(String(d["connection_id"]), String(row["listing_id"]), String(row["event_type"]) as CrmEvent, iso(row["occurred_at"]));
    const body = envelopeBody({ id: eventId, type: String(row["event_type"]), createdAt: iso(row["occurred_at"]), data: row["payload"] as Record<string, unknown> });
    let status = 0; let error: string | null = null;
    try {
      status = (await send({ url: String(row["outbound_url"]), body, timeoutMs: 8000, headers: {
        "content-type": "application/json", "user-agent": `${readBrand().name.replace(/[^A-Za-z0-9]/g, "")}-CrmSync/1`,
        "ol-signature": signPayload(String(row["outbound_secret"]), body, nowSeconds()), "ol-event-id": eventId, "ol-event-type": String(row["event_type"]) } })).status;
    } catch (e) { error = (e as Error).message.slice(0, 200); }
    const attempts = Number(d["attempts"]) + 1;
    if (status >= 200 && status < 300) {
      await db.query("UPDATE crm_outbound_delivery SET state='delivered', attempts=$2, last_status=$3, last_error=NULL, delivered_at=now() WHERE id=$1::uuid", [d["id"], attempts, status]);
      await db.query("UPDATE feed_connection SET outbound_failures = 0 WHERE id = $1::uuid", [d["connection_id"]]);
      counts.delivered++; continue;
    }
    const delay = nextAttemptDelaySeconds(attempts);
    if (delay !== null && attempts < MAX_ATTEMPTS) {
      await db.query("UPDATE crm_outbound_delivery SET attempts=$2, last_status=$3, last_error=$4, next_attempt_at = now() + make_interval(secs => $5) WHERE id=$1::uuid", [d["id"], attempts, status || null, error ?? `HTTP ${status}`, delay]);
      counts.retried++;
    } else {
      await db.query("UPDATE crm_outbound_delivery SET state='failed', attempts=$2, last_status=$3, last_error=$4 WHERE id=$1::uuid", [d["id"], attempts, status || null, error ?? `HTTP ${status}`]);
      counts.failed++;
    }
    // A CRM that keeps failing is switched off so it stops being hit; staff turn it back on from /staff/feeds.
    await db.query(
      `UPDATE feed_connection SET outbound_failures = outbound_failures + 1,
              outbound_enabled = (outbound_failures + 1) < $2 AND outbound_enabled WHERE id = $1::uuid`, [d["connection_id"], DISABLE_AFTER_FAILURES]);
  }
  return counts;
}

export async function runCrmSync(db: Queryable, send: Sender = httpsSender): Promise<{ queued: number } & DeliverCounts> {
  const queued = await sweepStatusChanges(db);
  return { queued, ...(await deliverDue(db, send)) };
}
