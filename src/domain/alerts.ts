import { mayAlert, planAlerts, type AlertPreference, type ListingSummary, type PlannedAlert, type SavedSearch } from "./buyer";

export type AlertChannel = PlannedAlert["channel"];

/** What a delivery port is asked to send. Property facts only; every message carries an unsubscribe link. */
export interface AlertMessage {
  buyerUserId: string;
  channel: AlertChannel;
  listingId: string;
  searchId: string;
  unsubscribeUrl: string;
}

export type DeliveryOutcome = "sent" | "failed" | "not_configured" | "skipped_no_consent" | "skipped_duplicate" | "skipped_no_unsubscribe";

/** One row of the insert-only alert_delivery log. */
export interface DeliveryLogEntry { buyerUserId: string; channel: AlertChannel; listingId: string; searchId: string; outcome: DeliveryOutcome; attemptedAt: string }

export interface AlertDeliveryPort { send(msg: AlertMessage): Promise<"sent" | "failed" | "not_configured"> }

export const alertKey = (buyerUserId: string, channel: AlertChannel, listingId: string) => `${buyerUserId}:${channel}:${listingId}`;

/** Matching + consent gate + dedupe. `alreadySent` holds alertKey values for alerts already delivered. */
export function planNewAlerts(
  listing: ListingSummary, searches: readonly SavedSearch[],
  prefsByBuyer: Readonly<Record<string, readonly AlertPreference[]>>, alreadySent: ReadonlySet<string>
): PlannedAlert[] {
  return planAlerts(listing, searches, prefsByBuyer).filter(a => !alreadySent.has(alertKey(a.buyerUserId, a.channel, a.listingId)));
}

export interface DispatchDeps {
  port: AlertDeliveryPort;
  prefsByBuyer: Readonly<Record<string, readonly AlertPreference[]>>;
  alreadySent: ReadonlySet<string>;
  /** Returns the buyer's unsubscribe link for the channel; empty means none, so nothing is sent. */
  unsubscribeUrlFor(buyerUserId: string, channel: AlertChannel): string;
  now(): string;
  /** Called once for every attempt, including skipped ones. Insert-only. */
  log(entry: DeliveryLogEntry): Promise<void>;
}

/** Re-checks consent and duplicates at send time, refuses to send without an unsubscribe link, logs every attempt. */
export async function dispatchAlerts(plans: readonly PlannedAlert[], d: DispatchDeps): Promise<DeliveryLogEntry[]> {
  const sent = new Set(d.alreadySent);
  const out: DeliveryLogEntry[] = [];
  for (const p of plans) {
    const key = alertKey(p.buyerUserId, p.channel, p.listingId);
    const pref = (d.prefsByBuyer[p.buyerUserId] ?? []).find(x => x.channel === p.channel);
    const unsubscribeUrl = d.unsubscribeUrlFor(p.buyerUserId, p.channel).trim();
    let outcome: DeliveryOutcome;
    if (!mayAlert(pref)) outcome = "skipped_no_consent";
    else if (sent.has(key)) outcome = "skipped_duplicate";
    else if (unsubscribeUrl === "") outcome = "skipped_no_unsubscribe";
    else {
      try { outcome = await d.port.send({ buyerUserId: p.buyerUserId, channel: p.channel, listingId: p.listingId, searchId: p.searchId, unsubscribeUrl }); }
      catch { outcome = "failed"; }
      if (outcome === "sent") sent.add(key);
    }
    const entry: DeliveryLogEntry = { buyerUserId: p.buyerUserId, channel: p.channel, listingId: p.listingId, searchId: p.searchId, outcome, attemptedAt: d.now() };
    await d.log(entry);
    out.push(entry);
  }
  return out;
}
