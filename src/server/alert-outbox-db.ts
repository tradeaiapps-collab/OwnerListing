import { randomUUID } from "node:crypto";
import { ALERT_SEND_RATE, processOutbox, retryDelayMs, type OutboxResult, type OutboxRow } from "../domain/alert-outbox";
import { alertKey, type AlertChannel, type AlertDeliveryPort, type DeliveryLogEntry } from "../domain/alerts";
import type { AlertPreference } from "../domain/buyer";
import { unsubscribeUrlFor } from "./alert-unsubscribe";
import { appendAuditPg, type Queryable } from "./db";

const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : undefined);
const isChannel = (v: unknown): v is AlertChannel => v === "email" || v === "sms";
/** A claimed row is hidden from other runs for this long; if the run dies, the row comes back. */
const LEASE_MS = 10 * 60 * 1000;
const BATCH = 100;

/** Alert consent and unsubscribe state for the given buyers. */
export async function loadAlertPrefs(db: Queryable, buyerUserIds: readonly string[]): Promise<Record<string, AlertPreference[]>> {
  const r = await db.query(
    "SELECT buyer_user_id, channel, consent_given_at, unsubscribed_at FROM alert_preference WHERE buyer_user_id = ANY($1::uuid[])",
    [buyerUserIds]);
  const out: Record<string, AlertPreference[]> = {};
  for (const row of r.rows) {
    const buyer = row["buyer_user_id"];
    const channel = row["channel"];
    if (typeof buyer !== "string" || !isChannel(channel)) continue;
    const consentGivenAt = iso(row["consent_given_at"]);
    const unsubscribedAt = iso(row["unsubscribed_at"]);
    (out[buyer] ??= []).push({
      channel,
      ...(consentGivenAt !== undefined ? { consentGivenAt } : {}),
      ...(unsubscribedAt !== undefined ? { unsubscribedAt } : {})
    });
  }
  return out;
}

/** Writes the insert-only delivery log row and an audit event. Ids and outcome only: no address, number, name or link. */
export async function logDeliveryPg(db: Queryable, e: DeliveryLogEntry): Promise<void> {
  await db.query(
    `INSERT INTO alert_delivery (buyer_user_id, channel, listing_id, saved_search_id, outcome, attempted_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [e.buyerUserId, e.channel, e.listingId, e.searchId === "" ? null : e.searchId, e.outcome, e.attemptedAt]);
  await appendAuditPg(db, {
    id: randomUUID(), occurredAt: e.attemptedAt, actorType: "system", actorId: "alert-delivery",
    aggregateType: "listing", aggregateId: e.listingId, eventType: `alert.${e.outcome}`, correlationId: randomUUID(),
    payload: { channel: e.channel, buyerUserId: e.buyerUserId, savedSearchId: e.searchId }
  });
}

/** Queues an alert. Re-queuing the same buyer, channel and listing is a no-op, so a row is never doubled. */
export async function enqueueAlertPg(
  db: Queryable, a: { buyerUserId: string; channel: AlertChannel; listingId: string; searchId: string }, attempts: number, nextAttemptAt: string
): Promise<void> {
  await db.query(
    `INSERT INTO alert_outbox (buyer_user_id, channel, listing_id, saved_search_id, attempts, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (buyer_user_id, channel, listing_id) DO NOTHING`,
    [a.buyerUserId, a.channel, a.listingId, a.searchId, attempts, nextAttemptAt]);
}

export const queueAfterFailure = (db: Queryable, e: DeliveryLogEntry): Promise<void> =>
  enqueueAlertPg(db, e, 1, new Date(Date.parse(e.attemptedAt) + retryDelayMs(1)).toISOString());

export const queueDeferred = (db: Queryable, a: { buyerUserId: string; channel: AlertChannel; listingId: string; searchId: string }, nowIso: string): Promise<void> =>
  enqueueAlertPg(db, a, 0, new Date(Date.parse(nowIso) + ALERT_SEND_RATE.windowMs).toISOString());

/** True when the buyer has already been sent their hourly share of alerts. */
export async function overRatePg(db: Queryable, buyerUserId: string, nowIso: string): Promise<boolean> {
  return (await sentInWindowPg(db, buyerUserId, nowIso)) >= ALERT_SEND_RATE.perBuyer;
}

export async function sentInWindowPg(db: Queryable, buyerUserId: string, nowIso: string): Promise<number> {
  const since = new Date(Date.parse(nowIso) - ALERT_SEND_RATE.windowMs).toISOString();
  const r = await db.query(
    "SELECT count(*)::int AS n FROM alert_delivery WHERE buyer_user_id = $1 AND outcome = 'sent' AND attempted_at >= $2",
    [buyerUserId, since]);
  const n = r.rows[0]?.["n"];
  // Fails closed: an unreadable count counts as over the limit.
  return typeof n === "number" && Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** Takes due rows for this run in one statement. SKIP LOCKED plus a lease keep two runs from sending the same alert. */
export async function claimDueOutbox(db: Queryable, nowIso: string, limit = BATCH): Promise<OutboxRow[]> {
  const r = await db.query(
    `UPDATE alert_outbox SET next_attempt_at = $1::timestamptz + ($3::int * interval '1 millisecond'), updated_at = $1
      WHERE id IN (SELECT id FROM alert_outbox WHERE status = 'pending' AND next_attempt_at <= $1
                    ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, buyer_user_id, channel, listing_id, saved_search_id, attempts`,
    [nowIso, limit, LEASE_MS]);
  return r.rows.flatMap(row => {
    const channel = row["channel"];
    if (!isChannel(channel)) return [];
    return [{
      id: String(row["id"]), buyerUserId: String(row["buyer_user_id"]), channel, listingId: String(row["listing_id"]),
      searchId: String(row["saved_search_id"] ?? ""), attempts: Number(row["attempts"])
    }];
  });
}

const SETTLED: Record<OutboxResult, { status: "pending" | "sent" | "dead" | "dropped"; attempt: 0 | 1 }> = {
  sent: { status: "sent", attempt: 1 }, retry: { status: "pending", attempt: 1 }, dead: { status: "dead", attempt: 1 },
  deferred_rate: { status: "pending", attempt: 0 }, not_configured: { status: "pending", attempt: 0 },
  dropped_no_consent: { status: "dropped", attempt: 0 }, dropped_duplicate: { status: "dropped", attempt: 0 }, dropped_no_unsubscribe: { status: "dropped", attempt: 0 }
};

export async function settleOutboxPg(db: Queryable, row: OutboxRow, result: OutboxResult, nowIso: string, nextAttemptAt?: string): Promise<void> {
  const s = SETTLED[result];
  await db.query(
    `UPDATE alert_outbox SET status = $2, attempts = attempts + $3, next_attempt_at = COALESCE($4::timestamptz, next_attempt_at), updated_at = $5 WHERE id = $1`,
    [row.id, s.status, s.attempt, nextAttemptAt ?? null, nowIso]);
}

/** One worker run: claim due rows, send what is still allowed, settle each row, audit the run. */
export async function runAlertOutbox(
  db: Queryable, port: AlertDeliveryPort, env: Readonly<Record<string, string | undefined>>, nowIso: string
): Promise<Record<OutboxResult, number>> {
  const due = await claimDueOutbox(db, nowIso);
  const buyers = [...new Set(due.map(r => r.buyerUserId))];
  const listings = [...new Set(due.map(r => r.listingId))];
  const prefsByBuyer = buyers.length ? await loadAlertPrefs(db, buyers) : {};
  const alreadySent = new Set<string>();
  if (listings.length) {
    const r = await db.query("SELECT buyer_user_id, channel, listing_id FROM alert_delivery WHERE outcome = 'sent' AND listing_id = ANY($1::uuid[])", [listings]);
    for (const row of r.rows) if (isChannel(row["channel"])) alreadySent.add(alertKey(String(row["buyer_user_id"]), row["channel"], String(row["listing_id"])));
  }
  const counts = await processOutbox({
    port, due, prefsByBuyer, alreadySent,
    sentInWindow: id => sentInWindowPg(db, id, nowIso),
    unsubscribeUrlFor: (id, channel) => unsubscribeUrlFor(env, id, channel),
    now: () => nowIso,
    log: e => logDeliveryPg(db, e),
    settle: (row, result, next) => settleOutboxPg(db, row, result, nowIso, next)
  });
  await appendAuditPg(db, {
    id: randomUUID(), occurredAt: nowIso, actorType: "system", actorId: "alert-delivery", aggregateType: "alert_outbox", aggregateId: "run",
    eventType: "alert.outbox_run", correlationId: randomUUID(), payload: { claimed: due.length, ...counts }
  });
  return counts;
}

/**
 * Turns one channel off for a buyer. Only the first call changes anything; the row and the buyer's consent date stay.
 * Anything queued for that channel is dropped at send time because consent is re-checked there.
 */
export async function unsubscribeAlertPg(db: Queryable, buyerUserId: string, channel: AlertChannel, nowIso: string): Promise<boolean> {
  const r = await db.query(
    "UPDATE alert_preference SET unsubscribed_at = $3 WHERE buyer_user_id = $1 AND channel = $2 AND unsubscribed_at IS NULL RETURNING buyer_user_id",
    [buyerUserId, channel, nowIso]);
  if (r.rows.length > 0) {
    await appendAuditPg(db, {
      id: randomUUID(), occurredAt: nowIso, actorType: "user", actorId: buyerUserId, aggregateType: "alert_preference", aggregateId: buyerUserId,
      eventType: "alert.unsubscribed", correlationId: randomUUID(), payload: { channel, via: "link" }
    });
  }
  return r.rows.length > 0;
}
