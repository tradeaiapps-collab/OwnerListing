import { toListingSummary, type AlertPreference, type ListingSummary, type SavedSearch } from "./buyer";
import { dispatchAlerts, planNewAlerts, type AlertChannel, type AlertDeliveryPort, type DeliveryLogEntry } from "./alerts";
import type { PropertyListing } from "./listing";

/** What was already done for a listing: `sentKeys` are alertKey values already delivered; `searchIds` are searches already attempted. */
export interface HandledAlerts { sentKeys: ReadonlySet<string>; searchIds: ReadonlySet<string> }

export interface PublishAlertDeps {
  /** Active saved searches of active buyers that may match this listing. May pre-filter (only a narrowing); matchesSearch still decides. */
  loadSearches(listing: ListingSummary): Promise<SavedSearch[]>;
  loadPrefs(buyerUserIds: readonly string[]): Promise<Record<string, AlertPreference[]>>;
  loadHandled(listingId: string): Promise<HandledAlerts>;
  /** Fails closed (not_configured) until an email/SMS provider is chosen. */
  port: AlertDeliveryPort;
  unsubscribeUrlFor(buyerUserId: string, channel: AlertChannel): string;
  now(): string;
  log(entry: DeliveryLogEntry): Promise<void>;
}

/**
 * Builds the post-publish hook: match the newly published listing against saved searches, drop any (search, listing) pair
 * already attempted, and dispatch through the port. Consent, unsubscribe link and duplicates are re-checked by dispatchAlerts.
 */
export function createPublishAlertHook(d: PublishAlertDeps): (listing: PropertyListing) => Promise<DeliveryLogEntry[]> {
  return async listing => {
    const summary = toListingSummary(listing);
    const searches = await d.loadSearches(summary);
    const buyers = [...new Set(searches.map(s => s.buyerUserId))];
    if (buyers.length === 0) return [];
    const prefsByBuyer = await d.loadPrefs(buyers);
    const handled = await d.loadHandled(listing.id);
    // Drop already-attempted searches before planning, so a buyer's other matching searches are still considered (one alert per buyer and channel).
    const fresh = searches.filter(s => !handled.searchIds.has(s.id));
    const plans = planNewAlerts(summary, fresh, prefsByBuyer, handled.sentKeys);
    return dispatchAlerts(plans, {
      port: d.port, prefsByBuyer, alreadySent: handled.sentKeys, unsubscribeUrlFor: d.unsubscribeUrlFor, now: d.now, log: d.log
    });
  };
}
