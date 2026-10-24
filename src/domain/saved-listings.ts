import type { Actor, Failure, Result } from "./listing-service";

export const MAX_SAVED_LISTINGS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the buyer's saved page may show: public listing facts only (no owner, address detail or documents). */
export interface SavedListingView {
  listingId: string; title: string; suburb?: string; priceCents?: number; bedrooms?: number;
  transactionType: "sale" | "rent"; savedAt: string;
}

export interface SavedListingRepository {
  /** Only published listings, newest bookmark first. */
  list(buyerUserId: string): Promise<SavedListingView[]>;
  /** False when the listing does not exist or is not published. Saving twice is not an error. */
  add(buyerUserId: string, listingId: string): Promise<boolean>;
  remove(buyerUserId: string, listingId: string): Promise<void>;
  count(buyerUserId: string): Promise<number>;
}

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

export function parseListingId(v: unknown): Result<string> {
  return typeof v === "string" && UUID.test(v) ? { ok: true, value: v } : fail("invalid", "Invalid listing id.");
}

/** Bookmarks belong to buyers. Everyone else is refused. */
export const buyerOnly = (actor: Actor): Failure | null =>
  actor.userType === "buyer" ? null : fail("forbidden", "Buyers only.");

export async function saveListing(repo: SavedListingRepository, actor: Actor, listingId: string): Promise<Result<{ saved: true }>> {
  const denied = buyerOnly(actor);
  if (denied) return denied;
  if ((await repo.count(actor.userId)) >= MAX_SAVED_LISTINGS) return fail("conflict", `You can save up to ${MAX_SAVED_LISTINGS} homes.`);
  return (await repo.add(actor.userId, listingId)) ? { ok: true, value: { saved: true } } : fail("not_found", "Listing not found.");
}

/** Removes only the caller's own bookmark; removing one that is not there is fine. */
export async function unsaveListing(repo: SavedListingRepository, actor: Actor, listingId: string): Promise<Result<{ saved: false }>> {
  const denied = buyerOnly(actor);
  if (denied) return denied;
  await repo.remove(actor.userId, listingId);
  return { ok: true, value: { saved: false } };
}
