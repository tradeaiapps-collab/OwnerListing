import { createHash } from "node:crypto";

/** Status sync back to an agency CRM (pure). A listing's status is compared with what the CRM was last told; a change becomes one event. */
export const SYNC_STATUSES = ["active", "sold", "rented", "delisted"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];
export const CRM_EVENTS = ["listing.sold", "listing.rented", "listing.delisted", "listing.reactivated"] as const;
export type CrmEvent = (typeof CRM_EVENTS)[number];

export interface ListingFacts {
  status: string; transactionType: string; updatedAt: string;
  saleType?: "sold" | "rented"; saleAt?: string;
}

/** What the CRM should consider this listing right now, and since when. Draft, review and suspended listings are not synced. */
export function currentStatus(f: ListingFacts): { status: SyncStatus; since: string } | undefined {
  if (f.saleType) return { status: f.saleType, since: f.saleAt ?? f.updatedAt };
  if (f.status === "withdrawn" || f.status === "archived") return { status: "delisted", since: f.updatedAt };
  if (f.status === "published") return { status: "active", since: f.updatedAt };
  return undefined;
}

const EVENT_FOR: Record<Exclude<SyncStatus, "active">, CrmEvent> = { sold: "listing.sold", rented: "listing.rented", delisted: "listing.delisted" };

export type SyncPlan = { kind: "none" } | { kind: "baseline" } | { kind: "event"; event: CrmEvent };

/**
 * previous = status last told to the CRM (undefined when never seen). A first sighting is a quiet baseline, unless the change
 * happened after sync was switched on (then the CRM has not heard it and must). Going back to active is "reactivated".
 */
export function planSync(previous: SyncStatus | undefined, now: { status: SyncStatus; since: string }, enabledAt: string): SyncPlan {
  if (previous === undefined) {
    if (now.status !== "active" && Date.parse(now.since) > Date.parse(enabledAt)) return { kind: "event", event: EVENT_FOR[now.status] };
    return { kind: "baseline" };
  }
  if (previous === now.status) return { kind: "none" };
  return { kind: "event", event: now.status === "active" ? "listing.reactivated" : EVENT_FOR[now.status] };
}

export interface CrmPayload {
  listingId: string; externalId?: string; status: SyncStatus; title: string; suburb?: string; postcode?: string;
  transactionType: string; occurredAt: string; priceCents?: number;
}
export const crmPayload = (p: CrmPayload): Record<string, unknown> => ({ ...p });

/** Stable id the CRM can use to ignore a repeat: same listing, same event, same moment. */
export const crmEventId = (connectionId: string, listingId: string, event: CrmEvent, occurredAt: string): string =>
  createHash("sha256").update(`${connectionId}|${listingId}|${event}|${new Date(occurredAt).toISOString()}`).digest("hex").slice(0, 32);
