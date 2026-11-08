import type { Actor, Failure, Result } from "./listing-service";
import type { ReportView } from "./inspection";
import { readBrand } from "../config/brand";
import { buildTextPdf, type PdfBlock } from "./simple-pdf";

/**
 * Client self-service portal: the signed-in buyer or owner sees only their own documents, bookings and message threads.
 * Pure shaping and rules here; every read is scoped by the user id in src/server/client-portal-db.ts.
 */

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

/** Buyers, owners and agents have a portal. Vendors (inspectors and other providers) have their own job screens. */
export const portalAccess = (actor: Actor): Failure | undefined =>
  actor.userType === "vendor" ? fail("forbidden", "The client portal is for buyers, owners and agents.") : undefined;

export type DocKind = "offer" | "inspection" | "signed";
export const DOC_KINDS: readonly DocKind[] = ["offer", "inspection", "signed"];

export interface PortalDocument {
  kind: DocKind;
  id: string;
  title: string;
  listingId: string;
  listingTitle: string;
  at: string;
  status: string;
  /** Relative URL that downloads the file (the server decides again, per request, whether the caller may have it). */
  downloadUrl: string;
}

/** Newest first; ties broken by id so the order never flickers. */
export const sortDocuments = (docs: readonly PortalDocument[]): PortalDocument[] =>
  [...docs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1));

export const documentUrl = (kind: DocKind, id: string) =>
  kind === "signed" ? `/api/signing-documents/${id}/pdf` : `/api/client/portal/documents/${kind}/${id}`;

// ---- Offers ----

export interface OfferForPdf {
  id: string;
  listingTitle: string;
  address: string;
  priceCents: number;
  depositCents: number;
  settlementDays: number;
  conditions: readonly string[];
  status: string;
  submittedAt: string;
  /** "buyer" sees their own name; "owner" sees no buyer identity at all. */
  viewer: "buyer" | "owner";
  buyerName?: string;
  events: readonly { type: string; at: string; priceCents?: number }[];
}

const aud = (cents: number) => `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** A summary of the offer, not a contract: an accepted offer only becomes binding when both sides sign with their solicitors. */
export function buildOfferPdf(o: OfferForPdf, printedAt: string): Uint8Array {
  const lines: string[] = [
    `Property: ${o.listingTitle}`,
    `Address: ${o.address}`,
    `Offer price: ${aud(o.priceCents)}`,
    `Deposit: ${aud(o.depositCents)}`,
    `Settlement: ${o.settlementDays} days`,
    `Status: ${o.status.replace(/_/g, " ")}`,
    `Submitted: ${o.submittedAt}`,
    o.viewer === "buyer" ? `Buyer: ${o.buyerName ?? "you"}` : "Buyer: identity withheld by the platform"
  ];
  return buildTextPdf([
    { text: "Offer summary", size: 16, bold: true, gap: 6 },
    { text: lines.join("\n"), gap: 8 },
    { text: "Conditions", size: 13, bold: true, gap: 2 },
    { text: o.conditions.length ? o.conditions.map((c, i) => `${i + 1}. ${c}`).join("\n") : "None", gap: 8 },
    { text: "History", size: 13, bold: true, gap: 2 },
    { text: o.events.length ? o.events.map(e => `${e.at}  ${e.type.replace(/_/g, " ")}${e.priceCents ? `  ${aud(e.priceCents)}` : ""}`).join("\n") : "No events", gap: 8 },
    { text: `Offer id: ${o.id}\nPrinted: ${printedAt}`, size: 8, gap: 4 },
    { text: `This is a summary of an offer made on ${readBrand().name}. It is not a contract. The platform holds no money and the owner alone decides every offer.`, size: 8 }
  ]);
}

// ---- Inspection reports ----

export function buildInspectionPdf(r: ReportView, printedAt: string): Uint8Array {
  const i = r.inspection;
  const blocks: PdfBlock[] = [
    { text: "Inspection report", size: 16, bold: true, gap: 6 },
    { text: `Property: ${i.listingTitle}\nType: ${i.type.replace(/_/g, " ")}\nInspector: ${i.inspectorName}\nDate: ${i.scheduledAt}\nStatus: ${i.status}`, gap: 8 }
  ];
  if (i.summary) blocks.push({ text: "Summary", size: 13, bold: true, gap: 2 }, { text: i.summary.text, gap: 8 });
  blocks.push({ text: `Findings (${r.findings.length})`, size: 13, bold: true, gap: 2 });
  for (const f of r.findings) {
    blocks.push({ text: `[${f.severity.toUpperCase()}] ${f.area}: ${f.title}`, bold: true, gap: 0 }, { text: f.detail || "No further detail.", gap: 6 });
  }
  if (r.findings.length === 0) blocks.push({ text: "No findings recorded.", gap: 6 });
  blocks.push({ text: `Inspection id: ${i.id}\nPrinted: ${printedAt}\nPhotos stay on the platform and are not included in this file.`, size: 8, gap: 0 });
  return buildTextPdf(blocks);
}

// ---- Viewing and consultation bookings ----

export type BookingKind = "viewing" | "consultation";
export type BookingStatus = "requested" | "confirmed" | "declined" | "cancelled";

export interface BookingRow {
  id: string;
  listingId: string;
  listingTitle: string;
  kind: BookingKind;
  startsAt: string;
  note: string;
  status: BookingStatus;
  /** "requester" asked for the time; "manager" is the listing's owner or full-scope agent who decides. */
  role: "requester" | "manager";
  otherPartyName: string;
}

export interface NewBooking { listingId: string; kind: BookingKind; startsAt: string; note: string }

export const BOOKING_LIMITS = { minLeadMs: 60 * 60 * 1000, maxAheadMs: 90 * 24 * 60 * 60 * 1000, maxNote: 500, maxOpenPerUser: 20 } as const;

export function parseBooking(body: unknown, nowIso: string): Result<NewBooking> {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const listingId = typeof b["listingId"] === "string" ? b["listingId"] : "";
  if (!isUuid(listingId)) return fail("invalid", "Choose a listing.");
  const kind = b["kind"];
  if (kind !== "viewing" && kind !== "consultation") return fail("invalid", "Choose a viewing or a consultation.");
  const raw = typeof b["startsAt"] === "string" ? b["startsAt"] : "";
  const t = Date.parse(raw);
  if (!raw || Number.isNaN(t)) return fail("invalid", "Choose a date and time.");
  const now = Date.parse(nowIso);
  if (t < now + BOOKING_LIMITS.minLeadMs) return fail("invalid", "Choose a time at least an hour from now.");
  if (t > now + BOOKING_LIMITS.maxAheadMs) return fail("invalid", "Choose a time within the next 90 days.");
  const note = typeof b["note"] === "string" ? b["note"].trim() : "";
  if (note.length > BOOKING_LIMITS.maxNote) return fail("invalid", `Keep the note under ${BOOKING_LIMITS.maxNote} characters.`);
  return { ok: true, value: { listingId, kind, startsAt: new Date(t).toISOString(), note } };
}

export type BookingAction = "confirm" | "decline" | "cancel";
export const parseBookingAction = (body: unknown): BookingAction | undefined => {
  const a = body && typeof body === "object" ? (body as Record<string, unknown>)["action"] : undefined;
  return a === "confirm" || a === "decline" || a === "cancel" ? a : undefined;
};

/** Which side may take which action, and from which statuses. The requester can only cancel; the manager confirms or declines. */
export const BOOKING_TRANSITIONS: Record<BookingAction, { side: "requester" | "manager"; from: readonly BookingStatus[]; to: BookingStatus }> = {
  confirm: { side: "manager", from: ["requested"], to: "confirmed" },
  decline: { side: "manager", from: ["requested"], to: "declined" },
  cancel: { side: "requester", from: ["requested", "confirmed"], to: "cancelled" }
};

// ---- Repository ----

export interface ClientPortalRepository {
  documentsFor(userId: string): Promise<PortalDocument[]>;
  /** The offer only when `userId` made it (buyer) or owns its listing (owner); otherwise undefined. */
  offerFor(userId: string, offerId: string): Promise<OfferForPdf | undefined>;
  bookingsFor(userId: string): Promise<BookingRow[]>;
  /** False when the listing is not published, is the requester's own, or the requester already has too many open requests. */
  createBooking(userId: string, b: NewBooking, id: string, correlationId: string): Promise<"created" | "not_bookable" | "duplicate" | "too_many">;
  /** False when the booking is not the caller's to change from its current status. */
  transitionBooking(userId: string, bookingId: string, action: BookingAction, correlationId: string): Promise<boolean>;
}

export async function listPortal(repo: ClientPortalRepository, actor: Actor): Promise<Result<{ documents: PortalDocument[]; bookings: BookingRow[] }>> {
  const denied = portalAccess(actor);
  if (denied) return denied;
  const [documents, bookings] = await Promise.all([repo.documentsFor(actor.userId), repo.bookingsFor(actor.userId)]);
  return { ok: true, value: { documents: sortDocuments(documents), bookings } };
}

export async function offerDownload(repo: ClientPortalRepository, actor: Actor, offerId: string, printedAt: string): Promise<Result<Uint8Array>> {
  const denied = portalAccess(actor);
  if (denied) return denied;
  const o = isUuid(offerId) ? await repo.offerFor(actor.userId, offerId) : undefined;
  return o ? { ok: true, value: buildOfferPdf(o, printedAt) } : fail("not_found", "Document not found.");
}

export async function requestBooking(repo: ClientPortalRepository, actor: Actor, body: unknown, ids: { newId(): string; now(): string }): Promise<Result<{ id: string }>> {
  const denied = portalAccess(actor);
  if (denied) return denied;
  const parsed = parseBooking(body, ids.now());
  if (!parsed.ok) return parsed;
  const id = ids.newId();
  const r = await repo.createBooking(actor.userId, parsed.value, id, ids.newId());
  if (r === "created") return { ok: true, value: { id } };
  if (r === "duplicate") return fail("conflict", "You already asked for that time.");
  if (r === "too_many") return fail("rate_limited", "You have too many open requests. Cancel one first.");
  return fail("not_found", "That listing cannot be booked.");
}

export async function changeBooking(repo: ClientPortalRepository, actor: Actor, bookingId: string, body: unknown, correlationId: string): Promise<Result<{ ok: true }>> {
  const denied = portalAccess(actor);
  if (denied) return denied;
  const action = parseBookingAction(body);
  if (!action) return fail("invalid", "Choose confirm, decline or cancel.");
  const done = isUuid(bookingId) && (await repo.transitionBooking(actor.userId, bookingId, action, correlationId));
  return done ? { ok: true, value: { ok: true } } : fail("not_found", "Booking not found, or it cannot be changed.");
}
