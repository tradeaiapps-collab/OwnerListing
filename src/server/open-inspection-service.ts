import { MAX_LIVE_BOOKINGS_PER_BUYER, SLOT_DAYS, parseAgentAction, parseBlock, parseBookingInput, parseRule, whenText, type AgentAction } from "../domain/open-inspection";
import type { Actor, Result } from "../domain/listing-service";
import { getDb } from "./context";
import { getOpenInspectionRepo, type BookingRow, type OpenInspectionRepo, type OpenListing } from "./open-inspection-db";
import { notifyBooked, notifyCancelled, sendReminderNow } from "./open-inspection-notify";

const fail = (code: "invalid" | "not_found" | "forbidden" | "conflict", message: string): Result<never> => ({ ok: false, code, message });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
export { MAX_LIVE_BOOKINGS_PER_BUYER, SLOT_DAYS };

const isManagerType = (a: Actor) => a.userType === "owner" || a.userType === "agent";

/** "Saturday 12 Dec, 10:00 am, Sunday ..." for the next few free slots of a listing, for a cancellation notice. */
export async function nextFreeTimes(repo: OpenInspectionRepo, listing: OpenListing, nowIso: string, count = 3): Promise<string> {
  const slots = (await repo.freeSlots(listing, nowIso)).slice(0, count);
  return slots.length === 0 ? "There are no other times right now; check back soon." : `Next free times: ${slots.map(s => whenText(s.startsAt, listing.timezone)).join("; ")}.`;
}

/** A manager's view of one listing's published times and blocks. */
export async function scheduleFor(repo: OpenInspectionRepo, actor: Actor, listingId: string): Promise<Result<{ listing: { id: string; title: string; address: string; timezone: string }; rules: unknown; blocks: unknown }>> {
  if (!isId(listingId) || !isManagerType(actor)) return fail("not_found", "Listing not found.");
  const listing = await repo.managedListing(listingId, actor.userId);
  if (!listing) return fail("not_found", "Listing not found.");
  const s = await repo.schedule(listing.id);
  return { ok: true, value: { listing: { id: listing.id, title: listing.title, address: listing.address, timezone: listing.timezone }, rules: s.rules, blocks: s.blocks } };
}

/** Body `{ type: "rule", ...rule }` or `{ type: "block", startsAt, endsAt, note? }`. A block also cancels bookings inside it and tells those buyers the next free times. */
export async function publishTime(repo: OpenInspectionRepo, actor: Actor, listingId: string, body: unknown, nowIso: string, db = getDb()): Promise<Result<{ id: string; cancelled?: number }>> {
  if (!isId(listingId) || !isManagerType(actor)) return fail("not_found", "Listing not found.");
  const listing = await repo.managedListing(listingId, actor.userId);
  if (!listing) return fail("not_found", "Listing not found.");
  const type = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["type"] : undefined;
  if (type === "block") {
    const b = parseBlock(body, nowIso, listing.timezone);
    if (!b.ok) return b;
    const r = await repo.addBlock(listing, actor.userId, b.value);
    if (r.cancelled.length) await notifyCancelled(db, r.cancelled, "agent", () => nextFreeTimes(repo, listing, nowIso), process.env);
    return { ok: true, value: { id: r.id, cancelled: r.cancelled.length } };
  }
  const rule = parseRule(body, nowIso);
  if (!rule.ok) return rule;
  return repo.addRule(listing, actor.userId, rule.value);
}

export async function removeTime(repo: OpenInspectionRepo, actor: Actor, listingId: string, kind: string, itemId: string): Promise<Result<true>> {
  if (!isId(listingId) || !isId(itemId) || !isManagerType(actor) || (kind !== "rule" && kind !== "block")) return fail("not_found", "Not found.");
  const done = kind === "rule" ? await repo.removeRule(listingId, itemId, actor.userId) : await repo.removeBlock(listingId, itemId, actor.userId);
  return done ? { ok: true, value: true } : fail("not_found", "Not found.");
}

/** Free slots a buyer may book on a published listing (no sign-in needed to look). */
export async function openSlots(repo: OpenInspectionRepo, listingId: string, nowIso: string) {
  if (!isId(listingId)) return fail("not_found", "Listing not found.");
  const listing = await repo.publishedListing(listingId);
  if (!listing) return fail("not_found", "This property is not open for inspection booking.");
  return { ok: true as const, value: { listing: { id: listing.id, title: listing.title, address: listing.address, timezone: listing.timezone, contactName: listing.contactName, contactEmail: listing.contactEmail }, slots: await repo.freeSlots(listing, nowIso) } };
}

/** Body: { listingId, startsAt, name, phone?, email?, notes? }. A signed-in buyer books one free slot; confirmation and the agent's alert go out at once. */
export async function bookInspection(repo: OpenInspectionRepo, actor: Actor, body: unknown, nowIso: string, db = getDb()): Promise<Result<{ id: string }>> {
  if (actor.userType !== "buyer") return fail("forbidden", "Sign in as a buyer to book an inspection.");
  const listingId = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["listingId"] : undefined;
  if (!isId(listingId)) return fail("invalid", "Choose a property.");
  const input = parseBookingInput(body);
  if (!input.ok) return input;
  const listing = await repo.publishedListing(listingId);
  if (!listing) return fail("not_found", "This property is not open for inspection booking.");
  const r = await repo.book(listing, actor.userId, input.value, nowIso);
  if (r.ok) await notifyBooked(db, r.value.id);
  return r;
}

export async function cancelOwnBooking(repo: OpenInspectionRepo, actor: Actor, bookingId: string, db = getDb()): Promise<Result<true>> {
  if (!isId(bookingId)) return fail("not_found", "Booking not found.");
  const done = await repo.buyerCancel(bookingId, actor.userId);
  if (!done) return fail("conflict", "That inspection can no longer be cancelled.");
  await notifyCancelled(db, [done.id], "buyer", async () => "");
  return { ok: true, value: true };
}

/** Agent bulk action over bookings on listings they manage. `remind` sends the buyers a reminder now. Only bookings the action fits are touched; the count says how many. */
export async function actOnBookings(repo: OpenInspectionRepo, actor: Actor, body: unknown, nowIso: string, db = getDb()): Promise<Result<{ action: AgentAction; changed: number }>> {
  if (!isManagerType(actor)) return fail("forbidden", "Only owners and agents manage inspections.");
  const a = parseAgentAction(body);
  if (!a.ok) return a;
  const changed = await repo.applyAction(actor.userId, a.value.ids, a.value.action);
  const ids = changed.map(c => c.id);
  if (ids.length && a.value.action === "cancel") {
    const byListing = new Map<string, string>();
    await notifyCancelled(db, ids, "agent", async listingId => {
      if (!byListing.has(listingId)) { const l = await repo.publishedListing(listingId); byListing.set(listingId, l ? await nextFreeTimes(repo, l, nowIso) : ""); }
      return byListing.get(listingId)!;
    });
  } else if (ids.length && a.value.action === "remind") await sendReminderNow(db, ids);
  return { ok: true, value: { action: a.value.action, changed: ids.length } };
}

export type { BookingRow };
export const repo = () => getOpenInspectionRepo();
