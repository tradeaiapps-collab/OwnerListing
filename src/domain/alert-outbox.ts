import { mayAlert, type AlertPreference } from "./buyer";
import { alertKey, type AlertChannel, type AlertDeliveryPort, type DeliveryLogEntry } from "./alerts";
import { withinLimit } from "./rate-limit";

/** Alerts per buyer per hour across all listings. Product can change the number. */
export const ALERT_SEND_RATE = { windowMs: 60 * 60 * 1000, perBuyer: 10 } as const;
export const ALERT_MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 5 * 60 * 1000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;

/** Wait before the next try after `attempts` failed tries: 5 min, 10, 20, 40, ... capped at 6 hours. */
export const retryDelayMs = (attempts: number): number =>
  Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, Math.min(attempts, 20) - 1));

/** A queued alert. `attempts` counts real sends tried; a rate-limit deferral does not add one. */
export interface OutboxRow { id: string; buyerUserId: string; channel: AlertChannel; listingId: string; searchId: string; attempts: number }

export type OutboxResult = "sent" | "retry" | "dead" | "deferred_rate" | "dropped_no_consent" | "dropped_duplicate" | "dropped_no_unsubscribe" | "not_configured";

export interface OutboxDeps {
  port: AlertDeliveryPort;
  /** Rows whose time has come, already claimed for this run. */
  due: readonly OutboxRow[];
  prefsByBuyer: Readonly<Record<string, readonly AlertPreference[]>>;
  /** alertKey values already delivered. */
  alreadySent: ReadonlySet<string>;
  /** Alerts delivered to this buyer inside the rate window before this run started. */
  sentInWindow(buyerUserId: string): Promise<number>;
  unsubscribeUrlFor(buyerUserId: string, channel: AlertChannel): string;
  now(): string;
  /** Insert-only delivery log, once per real attempt or skip. */
  log(entry: DeliveryLogEntry): Promise<void>;
  /** Records the new state of the row. */
  settle(row: OutboxRow, result: OutboxResult, nextAttemptAt?: string): Promise<void>;
}

/**
 * Works through due retries. Consent, unsubscribe, duplicates and the per-buyer rate limit are all re-checked at send time,
 * so a buyer who opts out after the first failure is never contacted. A failed send is retried with backoff up to
 * ALERT_MAX_ATTEMPTS, then marked dead. "not_configured" is not a failure: the row waits one backoff step and keeps its attempt count.
 */
export async function processOutbox(d: OutboxDeps): Promise<Record<OutboxResult, number>> {
  const counts: Record<OutboxResult, number> = {
    sent: 0, retry: 0, dead: 0, deferred_rate: 0, dropped_no_consent: 0, dropped_duplicate: 0, dropped_no_unsubscribe: 0, not_configured: 0
  };
  const sent = new Set(d.alreadySent);
  const sentNow = new Map<string, number>();
  const at = (ms: number) => new Date(Date.parse(d.now()) + ms).toISOString();
  const entry = (r: OutboxRow, outcome: DeliveryLogEntry["outcome"]): DeliveryLogEntry =>
    ({ buyerUserId: r.buyerUserId, channel: r.channel, listingId: r.listingId, searchId: r.searchId, outcome, attemptedAt: d.now() });
  const finish = async (r: OutboxRow, result: OutboxResult, next?: string) => { counts[result]++; await d.settle(r, result, next); };

  for (const r of d.due) {
    const pref = (d.prefsByBuyer[r.buyerUserId] ?? []).find(p => p.channel === r.channel);
    const key = alertKey(r.buyerUserId, r.channel, r.listingId);
    if (!mayAlert(pref)) { await d.log(entry(r, "skipped_no_consent")); await finish(r, "dropped_no_consent"); continue; }
    if (sent.has(key)) { await d.log(entry(r, "skipped_duplicate")); await finish(r, "dropped_duplicate"); continue; }
    const url = d.unsubscribeUrlFor(r.buyerUserId, r.channel).trim();
    if (url === "") { await d.log(entry(r, "skipped_no_unsubscribe")); await finish(r, "dropped_no_unsubscribe"); continue; }

    const already = (sentNow.get(r.buyerUserId) ?? 0) + await d.sentInWindow(r.buyerUserId);
    if (!withinLimit(already + 1, ALERT_SEND_RATE.perBuyer)) { await finish(r, "deferred_rate", at(ALERT_SEND_RATE.windowMs)); continue; }

    let outcome: "sent" | "failed" | "not_configured";
    try { outcome = await d.port.send({ buyerUserId: r.buyerUserId, channel: r.channel, listingId: r.listingId, searchId: r.searchId, unsubscribeUrl: url }); }
    catch { outcome = "failed"; }
    await d.log(entry(r, outcome));

    if (outcome === "sent") {
      sent.add(key);
      sentNow.set(r.buyerUserId, (sentNow.get(r.buyerUserId) ?? 0) + 1);
      await finish(r, "sent");
    } else if (outcome === "not_configured") await finish(r, "not_configured", at(retryDelayMs(Math.max(1, r.attempts))));
    else if (r.attempts + 1 >= ALERT_MAX_ATTEMPTS) await finish(r, "dead");
    else await finish(r, "retry", at(retryDelayMs(r.attempts + 1)));
  }
  return counts;
}
