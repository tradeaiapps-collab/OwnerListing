import type { AuditEvent } from "./audit";
import { nextVerificationStep, type BuyerVerification } from "./buyer";
import type { Actor, Failure, Result } from "./listing-service";

/**
 * Inspection marketplace. A verified buyer asks for an inspection of a published listing and offers up to three start times.
 * An approved inspector working in that state accepts one time (first to accept wins) or passes. Accepting creates the `inspection`
 * record the existing report workflow uses (findings, photos, sharing, Elena's summary), so the report itself is not rebuilt here.
 * Staff approve inspectors. Pure functions; SQL lives in src/server/inspection-marketplace-db.ts.
 */

export const JURISDICTIONS = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"] as const;
export type Jurisdiction = typeof JURISDICTIONS[number];
export type InspectorStatus = "pending" | "approved" | "rejected" | "suspended";
export type BookingStatus = "pending_inspector_response" | "scheduled" | "completed" | "cancelled";

export const BOOKING_LIMITS = { maxSlots: 3, minLeadHours: 12, maxAheadDays: 30, maxNotes: 1000, maxBusinessName: 120, maxLicence: 80, maxReviewNote: 500 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const invalid = (message: string): Failure => ({ ok: false, code: "invalid", message });
const notFound: Failure = { ok: false, code: "not_found", message: "Not found." };
const forbidden = (message: string): Failure => ({ ok: false, code: "forbidden", message });
const conflict = (message: string): Failure => ({ ok: false, code: "conflict", message });

export interface InspectorProfile {
  userId: string; businessName: string; licenceRef: string; jurisdictions: Jurisdiction[]; status: InspectorStatus; reviewNote: string; createdAt: string;
}
export interface Booking {
  id: string; listingId: string; listingTitle: string; buyerId: string; slots: string[]; notes: string; status: BookingStatus;
  inspectionId?: string; inspectorName?: string; scheduledAt?: string; createdAt: string;
}
/** What an inspector sees before accepting: the property and the times, never the buyer's identity. */
export interface OpenRequest { id: string; listingId: string; listingTitle: string; address: string; jurisdiction: Jurisdiction; slots: string[]; notes: string; createdAt: string }
export interface StaffBookingRow extends Booking { buyerName: string; inspectorUserId?: string }

export interface BookingRepository {
  /** A published listing the buyer does not own: its jurisdiction and title. */
  bookableListing(listingId: string, buyerId: string): Promise<{ id: string; title: string; jurisdiction: Jurisdiction } | undefined>;
  buyerVerification(userId: string): Promise<BuyerVerification>;
  insertBooking(b: { id: string; listingId: string; buyerId: string; slots: string[]; notes: string }, audit: AuditEvent): Promise<boolean>;
  bookingsForBuyer(userId: string): Promise<Booking[]>;
  cancelBooking(id: string, buyerId: string, at: string, audit: AuditEvent): Promise<boolean>;
  profile(userId: string): Promise<InspectorProfile | undefined>;
  upsertProfile(p: Omit<InspectorProfile, "status" | "reviewNote" | "createdAt">, userType: string, audit: AuditEvent): Promise<boolean>;
  openRequests(inspectorId: string): Promise<OpenRequest[]>;
  bookingsForInspector(inspectorId: string): Promise<Booking[]>;
  /** One statement: booking still pending, inspector approved for the state, not the listing owner or the buyer; creates the inspection and shares it with the buyer. */
  accept(bookingId: string, inspectorId: string, slot: string, inspectionId: string, audit: AuditEvent): Promise<boolean>;
  pass(bookingId: string, inspectorId: string, audit: AuditEvent): Promise<boolean>;
  listProfiles(status?: InspectorStatus): Promise<(InspectorProfile & { name: string; email: string })[]>;
  reviewProfile(userId: string, status: InspectorStatus, note: string, staffId: string, from: readonly InspectorStatus[], audit: AuditEvent): Promise<boolean>;
  listBookings(status?: BookingStatus): Promise<StaffBookingRow[]>;
}
export type Ids = { newId: () => string; now: () => string };

function ev(ids: Ids, actorId: string, type: string, aggregate: string, payload: Record<string, unknown> = {}, aggregateType = "inspection_booking"): AuditEvent {
  return { id: ids.newId(), occurredAt: ids.now(), actorType: "user", actorId, aggregateType, aggregateId: aggregate, eventType: type, correlationId: ids.newId(), payload };
}

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** 1 to 3 distinct start times, from 12 hours to 30 days ahead, on a quarter hour. Returns ISO strings, earliest first. */
export function parseSlots(v: unknown, now: string): Result<string[]> {
  if (!Array.isArray(v) || v.length < 1 || v.length > BOOKING_LIMITS.maxSlots) return invalid(`Choose between 1 and ${BOOKING_LIMITS.maxSlots} times.`);
  const from = Date.parse(now) + BOOKING_LIMITS.minLeadHours * 3600_000, to = Date.parse(now) + BOOKING_LIMITS.maxAheadDays * 86_400_000;
  const out = new Set<string>();
  for (const s of v) {
    const t = typeof s === "string" ? Date.parse(s) : NaN;
    if (!Number.isFinite(t)) return invalid("A time was not understood.");
    if (t < from) return invalid(`Times must be at least ${BOOKING_LIMITS.minLeadHours} hours from now.`);
    if (t > to) return invalid(`Times must be within ${BOOKING_LIMITS.maxAheadDays} days.`);
    if (t % 900_000 !== 0) return invalid("Times must start on a quarter hour.");
    out.add(new Date(t).toISOString());
  }
  if (out.size !== v.length) return invalid("Choose different times.");
  return { ok: true, value: [...out].sort() };
}

const cleanText = (v: unknown, max: number): string | undefined => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return undefined;
  // Control characters out, then trimmed.
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return t.length <= max ? t : undefined;
};

/** Buyer step. The buyer id always comes from the session. Needs the same verification as contacting a seller. */
export async function requestInspection(repo: BookingRepository, actor: Actor, listingId: string, input: unknown, ids: Ids): Promise<Result<{ id: string }>> {
  if (!isUuid(listingId)) return notFound;
  const o = obj(input);
  if (!o) return invalid("Send a JSON object.");
  const step = nextVerificationStep(await repo.buyerVerification(actor.userId));
  if (step !== null) return forbidden("Finish identity verification before booking an inspection.");
  const slots = parseSlots(o["slots"], ids.now());
  if (!slots.ok) return slots;
  const notes = cleanText(o["notes"], BOOKING_LIMITS.maxNotes);
  if (notes === undefined) return invalid(`Notes can be up to ${BOOKING_LIMITS.maxNotes} characters.`);
  if (!(await repo.bookableListing(listingId, actor.userId))) return notFound;
  const id = ids.newId();
  const ok = await repo.insertBooking({ id, listingId, buyerId: actor.userId, slots: slots.value, notes }, ev(ids, actor.userId, "inspection_booking.requested", id, { listingId, slots: slots.value }));
  return ok ? { ok: true, value: { id } } : conflict("You already have an open inspection request for this property.");
}

export async function cancelBooking(repo: BookingRepository, actor: Actor, bookingId: string, ids: Ids): Promise<Result<true>> {
  if (!isUuid(bookingId)) return notFound;
  const ok = await repo.cancelBooking(bookingId, actor.userId, ids.now(), ev(ids, actor.userId, "inspection_booking.cancelled", bookingId));
  return ok ? { ok: true, value: true } : notFound;
}

/** Inspector application. Anyone with a vendor or agent account may apply; staff decide. A rejected inspector may re-apply, an approved or suspended one may not edit. */
export async function applyAsInspector(repo: BookingRepository, actor: Actor, input: unknown, ids: Ids): Promise<Result<true>> {
  if (actor.userType !== "vendor" && actor.userType !== "agent") return forbidden("Inspector accounts are vendor or agent accounts.");
  const o = obj(input);
  if (!o) return invalid("Send a JSON object.");
  const businessName = cleanText(o["businessName"], BOOKING_LIMITS.maxBusinessName);
  if (!businessName) return invalid("Enter your business name.");
  const licenceRef = cleanText(o["licenceRef"], BOOKING_LIMITS.maxLicence);
  if (licenceRef === undefined) return invalid(`Licence reference can be up to ${BOOKING_LIMITS.maxLicence} characters.`);
  const j = o["jurisdictions"];
  if (!Array.isArray(j) || j.length < 1 || j.length > JURISDICTIONS.length || j.some(x => !(JURISDICTIONS as readonly unknown[]).includes(x))) return invalid("Choose the states you work in.");
  const jurisdictions = [...new Set(j as Jurisdiction[])];
  const existing = await repo.profile(actor.userId);
  if (existing && (existing.status === "approved" || existing.status === "suspended")) return conflict("This profile is already reviewed. Contact support to change it.");
  const ok = await repo.upsertProfile({ userId: actor.userId, businessName, licenceRef, jurisdictions }, actor.userType, ev(ids, actor.userId, "inspector.applied", actor.userId, { jurisdictions }, "inspector_profile"));
  return ok ? { ok: true, value: true } : conflict("This profile cannot be changed right now.");
}

export async function acceptBooking(repo: BookingRepository, actor: Actor, bookingId: string, slot: unknown, ids: Ids): Promise<Result<{ inspectionId: string }>> {
  if (!isUuid(bookingId)) return notFound;
  const t = typeof slot === "string" ? Date.parse(slot) : NaN;
  if (!Number.isFinite(t)) return invalid("Choose one of the times.");
  const inspectionId = ids.newId();
  const chosen = new Date(t).toISOString();
  const ok = await repo.accept(bookingId, actor.userId, chosen, inspectionId, ev(ids, actor.userId, "inspection_booking.accepted", bookingId, { inspectionId, scheduledAt: chosen }));
  // One answer for every reason (gone, taken, not approved, wrong state, own listing, time not offered) so nothing can be probed.
  return ok ? { ok: true, value: { inspectionId } } : conflict("This request is no longer available.");
}

export async function passBooking(repo: BookingRepository, actor: Actor, bookingId: string, ids: Ids): Promise<Result<true>> {
  if (!isUuid(bookingId)) return notFound;
  const ok = await repo.pass(bookingId, actor.userId, ev(ids, actor.userId, "inspection_booking.passed", bookingId));
  return ok ? { ok: true, value: true } : notFound;
}

const REVIEW_FROM: Record<"approved" | "rejected" | "suspended", readonly InspectorStatus[]> = {
  approved: ["pending", "rejected", "suspended"], rejected: ["pending"], suspended: ["approved"]
};
export function isReviewDecision(v: unknown): v is keyof typeof REVIEW_FROM { return v === "approved" || v === "rejected" || v === "suspended"; }

export async function reviewInspector(repo: BookingRepository, staffId: string, userId: unknown, decision: unknown, note: unknown, ids: Ids): Promise<Result<true>> {
  if (!isUuid(userId)) return notFound;
  if (!isReviewDecision(decision)) return invalid("Unknown decision.");
  const n = cleanText(note, BOOKING_LIMITS.maxReviewNote);
  if (n === undefined) return invalid(`Note can be up to ${BOOKING_LIMITS.maxReviewNote} characters.`);
  if (decision !== "approved" && !n) return invalid("Add a short reason.");
  const ok = await repo.reviewProfile(userId, decision, n, staffId, REVIEW_FROM[decision], ev(ids, staffId, `inspector.${decision}`, userId, { note: n }, "inspector_profile"));
  return ok ? { ok: true, value: true } : conflict("That inspector is not in a state that allows this.");
}

export const canAccept = (p: InspectorProfile | undefined, jurisdiction: Jurisdiction) => p?.status === "approved" && p.jurisdictions.includes(jurisdiction);
