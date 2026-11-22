import { randomUUID } from "node:crypto";
import {
  DEFAULT_SETTINGS, TOPICS, checkReply, classify, overLimit, ownerSummary, plan, type EnquirySettings, type ListingFacts, type Topic
} from "../domain/elena-enquiries";
import type { Kind, NotificationParams } from "../domain/notifications";
import { parseBookingInput, whenText } from "../domain/open-inspection";
import { JURISDICTION_TIME_ZONE } from "../domain/timezone";
import type { Jurisdiction } from "../domain/jurisdiction";
import type { Queryable } from "./db";
import { appendAuditPg } from "./db";
import { notifyUser } from "./notifier";
import { createPgOpenInspectionRepo } from "./open-inspection-db";
import { notifyBooked } from "./open-inspection-notify";

// Constant SQL text; user input only travels as bound parameters. Elena's thread messages are insert-only (enquiry_message is append-only).
// Every owner-facing action checks owner_user_id inside the statement. Nothing here deletes anything.

const text = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const firstName = (n: string) => n.trim().split(/\s+/)[0] || "A buyer";

/** Sends one notification. Never throws. Tests pass their own to read what went out. */
export type Notify = (userId: string, kind: Kind, params: NotificationParams) => Promise<void>;
export const defaultNotify = (db: Queryable): Notify => async (userId, kind, params) => { await notifyUser(db, userId, kind, params).catch(() => undefined); };

export type ActResult = { ok: true } | { ok: false; code: "not_found" | "invalid" | "conflict" | "forbidden" | "rate_limited"; message: string };
const NF: ActResult = { ok: false, code: "not_found", message: "Not found." };

// ---- Settings -------------------------------------------------------------------------------------------------------------------

export const GET_SETTINGS_SQL = "SELECT enabled, offer_inspections, auto_send FROM elena_enquiry_settings WHERE listing_id = $1::uuid";
/** Params: 1 listing, 2 owner (must own the listing), 3 enabled, 4 offer inspections, 5 auto-send. Zero rows when the caller does not own it. */
export const SAVE_SETTINGS_SQL =
  "INSERT INTO elena_enquiry_settings (listing_id, enabled, offer_inspections, auto_send, updated_by) " +
  "SELECT l.id, $3::boolean, $4::boolean, $5::boolean AND $3::boolean, $2::uuid FROM property_listing l WHERE l.id = $1::uuid AND l.owner_user_id = $2::uuid " +
  "ON CONFLICT (listing_id) DO UPDATE SET enabled = EXCLUDED.enabled, offer_inspections = EXCLUDED.offer_inspections, auto_send = EXCLUDED.auto_send, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING listing_id";

export async function getSettings(db: Queryable, listingId: string): Promise<EnquirySettings> {
  const r = (await db.query(GET_SETTINGS_SQL, [listingId])).rows[0];
  return r ? { enabled: r["enabled"] === true, offerInspections: r["offer_inspections"] === true, autoSend: r["auto_send"] === true } : { ...DEFAULT_SETTINGS };
}
export async function saveSettings(db: Queryable, ownerId: string, listingId: string, s: EnquirySettings): Promise<boolean> {
  return (await db.query(SAVE_SETTINGS_SQL, [listingId, ownerId, s.enabled, s.offerInspections, s.autoSend])).rows.length === 1;
}
export function parseSettings(input: unknown): EnquirySettings | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  const e = o["enabled"], i = o["offerInspections"], a = o["autoSend"];
  if (typeof e !== "boolean" || typeof i !== "boolean" || typeof a !== "boolean") return undefined;
  return { enabled: e, offerInspections: i, autoSend: e && a };
}

// ---- Looking at a buyer message -------------------------------------------------------------------------------------------------

export const MESSAGE_CONTEXT_SQL =
  "SELECT m.id, m.enquiry_id, m.sender_user_id, m.automated, m.body, m.sent_at, e.listing_id, e.buyer_user_id, l.owner_user_id, l.address_text, l.suburb, l.postcode, l.price_cents, " +
  "l.bedrooms, l.bathrooms, l.parking, l.amenities, l.property_type, l.transaction_type, l.status, l.jurisdiction, u.display_name AS buyer_name, s.offer_inspections, s.auto_send " +
  "FROM enquiry_message m JOIN enquiry e ON e.id = m.enquiry_id JOIN property_listing l ON l.id = e.listing_id JOIN app_user u ON u.id = e.buyer_user_id " +
  "JOIN elena_enquiry_settings s ON s.listing_id = l.id WHERE m.id = $1::uuid AND s.enabled AND l.status = 'published'";
export const PUBLIC_DOCS_SQL =
  "SELECT title, kind FROM property_document WHERE listing_id = $1::uuid AND visibility = 'public' AND status = 'active' AND title IS NOT NULL AND kind NOT IN ('photo','photo_360','video','video_360') ORDER BY uploaded_at LIMIT 20";
export const SENT_COUNTS_SQL =
  "SELECT count(*) FILTER (WHERE enquiry_id = $1::uuid AND created_at > $3::timestamptz - interval '24 hours')::int AS day, " +
  "count(*) FILTER (WHERE created_at > $3::timestamptz - interval '1 hour')::int AS hour FROM elena_enquiry_action WHERE listing_id = $2::uuid AND kind = 'reply' AND status IN ('sent','pending_approval')";
const INSERT_ACTION_SQL =
  "INSERT INTO elena_enquiry_action (id, enquiry_id, listing_id, owner_user_id, buyer_user_id, trigger_message_id, kind, topics, body, status, reason, needs_owner, created_at) " +
  "VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::text,$8::text[],$9::text,$10::text,$11::text,$12::boolean,$13::timestamptz) ON CONFLICT (trigger_message_id) DO NOTHING RETURNING id";
const INSERT_BOOKING_SQL =
  "INSERT INTO elena_enquiry_action (id, enquiry_id, listing_id, owner_user_id, buyer_user_id, kind, topics, body, status, booking_id, sent_message_id, created_at) " +
  "VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::text,ARRAY['inspection'],$7::text,'sent',$8::uuid,$9::uuid,$10::timestamptz)";
const INSERT_MESSAGE_SQL =
  "INSERT INTO enquiry_message (id, enquiry_id, sender_user_id, automated, elena, body, sent_at) VALUES ($1::uuid,$2::uuid,NULL,true,true,$3::text,$4::timestamptz)";

const audit = (db: Queryable, actorId: string, enquiryId: string, eventType: string, payload: Record<string, unknown>, now: string) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType: actorId === "elena" ? "service" : "user", actorId, aggregateType: "enquiry", aggregateId: enquiryId, eventType, correlationId: randomUUID(), payload }).catch(() => undefined);

type Tx = <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>;
const inTx = (db: Queryable): Tx => fn => (db.transaction ? db.transaction(fn) : fn(db));

export type Outcome = "off" | "skipped" | "sent" | "pending_approval" | "handed_to_owner" | "blocked" | "rate_limited";

/** Tells the buyer's side that Elena replied. The listing is named by suburb only, so a notification never carries the street address. */
async function tellBuyer(notify: Notify, buyerId: string, enquiryId: string, suburb: string) {
  await notify(buyerId, "message_received", { listing: suburb || "the property", name: "Elena", link: `/enquiries/${enquiryId}` });
}

/**
 * Looks at one buyer message and, when the owner switched Elena on for the listing, answers or hands it over. Safe to call twice for the same
 * message (one action row per message). Returns what happened. Never sends without the owner's approval unless the owner turned auto-send on.
 */
export async function handleBuyerMessage(db: Queryable, messageId: string, nowIn: string, notify: Notify = defaultNotify(db)): Promise<Outcome> {
  const x = (await db.query(MESSAGE_CONTEXT_SQL, [messageId])).rows[0];
  if (!x) return "off";
  // Elena's reply always sorts after the message it answers, even when both land in the same millisecond.
  const now = new Date(Math.max(Date.parse(nowIn), Date.parse(iso(x["sent_at"])) + 1)).toISOString();
  if (x["automated"] === true || text(x["sender_user_id"]) !== text(x["buyer_user_id"])) return "skipped";
  const enquiryId = text(x["enquiry_id"]), listingId = text(x["listing_id"]), ownerId = text(x["owner_user_id"]), buyerId = text(x["buyer_user_id"]);
  const jurisdiction = text(x["jurisdiction"]).trim() as Jurisdiction;
  const timeZone = JURISDICTION_TIME_ZONE[jurisdiction] ?? "Australia/Sydney";
  const settings: EnquirySettings = { enabled: true, offerInspections: x["offer_inspections"] === true, autoSend: x["auto_send"] === true };
  const address = text(x["address_text"]), suburb = x["suburb"] ? text(x["suburb"]) : "";
  const buyer = firstName(text(x["buyer_name"]));

  const docs = (await db.query(PUBLIC_DOCS_SQL, [listingId])).rows.map(d => ({ title: text(d["title"]), kind: text(d["kind"]) }));
  const facts: ListingFacts = {
    transactionType: text(x["transaction_type"]) === "rent" ? "rent" : "sale", propertyType: text(x["property_type"]),
    ...(suburb ? { suburb } : {}), ...(x["postcode"] ? { postcode: text(x["postcode"]) } : {}),
    ...(x["bedrooms"] !== null ? { bedrooms: Number(x["bedrooms"]) } : {}), ...(x["bathrooms"] !== null ? { bathrooms: Number(x["bathrooms"]) } : {}),
    ...(x["parking"] !== null ? { parking: Number(x["parking"]) } : {}),
    amenities: Array.isArray(x["amenities"]) ? (x["amenities"] as unknown[]).map(text) : [], priceShown: x["price_cents"] !== null, documents: docs
  };

  // Inspection times only when the buyer asked and the owner allows it; read from the owner's open-inspection availability.
  let slots: { startsAt: string }[] = [];
  if (settings.offerInspections && classify(text(x["body"])).includes("inspection")) {
    const repo = createPgOpenInspectionRepo(db);
    const listing = await repo.publishedListing(listingId);
    if (listing) slots = (await repo.freeSlots(listing, now)).slice(0, 3).map(s => ({ startsAt: s.startsAt }));
  }
  const p = plan({ buyerText: text(x["body"]), facts, settings, slots, timeZone });
  const topics: Topic[] = p.topics;

  let status: "sent" | "pending_approval" | "handed_to_owner" | "blocked" | "rate_limited";
  let reason = p.reason ?? null;
  let body: string | null = p.reply ?? null;
  if (!p.reply) status = "handed_to_owner";
  else {
    const counts = (await db.query(SENT_COUNTS_SQL, [enquiryId, listingId, now])).rows[0];
    const chk = checkReply(p.reply, address);
    if (overLimit(Number(counts?.["day"] ?? 0), Number(counts?.["hour"] ?? 0))) { status = "rate_limited"; reason = "Elena reached her reply limit for this conversation."; }
    else if (!chk.ok) { status = "blocked"; reason = chk.reason; }
    else status = settings.autoSend ? "sent" : "pending_approval";
  }
  const needsOwner = p.needsOwner || status === "handed_to_owner" || status === "blocked" || status === "rate_limited";
  const actionId = randomUUID();
  const claimed = await inTx(db)(async q => {
    const c = await q.query(INSERT_ACTION_SQL, [actionId, enquiryId, listingId, ownerId, buyerId, messageId, "reply", topics, body, status, reason, needsOwner, now]);
    if (c.rows.length === 0) return false;
    if (status === "sent") {
      const mid = randomUUID();
      await q.query(INSERT_MESSAGE_SQL, [mid, enquiryId, body, now]);
      await q.query("UPDATE elena_enquiry_action SET sent_message_id = $2::uuid WHERE id = $1::uuid", [actionId, mid]);
    }
    return true;
  });
  if (!claimed) return "skipped";

  await audit(db, "elena", enquiryId, "enquiry.elena_" + status, { actionId, topics }, now);
  if (status === "sent") await tellBuyer(notify, buyerId, enquiryId, suburb);
  const kind = status === "sent" ? (needsOwner ? "handed_over" : "answered") : status === "pending_approval" ? "drafted" : status === "handed_to_owner" ? "handed_over" : "blocked";
  const note = ownerSummary(kind, buyer, topics);
  await notify(ownerId, "elena_enquiry", { title: note.title, text: note.text, link: `/enquiries/${enquiryId}` });
  return status;
}

// ---- Owner decisions ------------------------------------------------------------------------------------------------------------

/** The owner approves (sends) or discards a waiting reply. Body is re-checked at send time; a reply that no longer passes is blocked. */
export async function decide(db: Queryable, ownerId: string, actionId: string, decision: unknown, now: string, notify: Notify = defaultNotify(db)): Promise<ActResult> {
  if (decision !== "approve" && decision !== "discard") return { ok: false, code: "invalid", message: "Decision must be approve or discard." };
  const row = (await db.query(
    "SELECT a.id, a.enquiry_id, a.buyer_user_id, a.body, l.address_text, l.suburb FROM elena_enquiry_action a JOIN property_listing l ON l.id = a.listing_id " +
    "WHERE a.id = $1::uuid AND a.owner_user_id = $2::uuid AND a.kind = 'reply' AND a.status = 'pending_approval'", [actionId, ownerId])).rows[0];
  if (!row) return (await db.query("SELECT 1 FROM elena_enquiry_action WHERE id = $1::uuid AND owner_user_id = $2::uuid", [actionId, ownerId])).rows.length
    ? { ok: false, code: "conflict", message: "That reply was already sent or discarded." } : NF;
  const enquiryId = text(row["enquiry_id"]);
  if (decision === "discard") {
    const r = await db.query("UPDATE elena_enquiry_action SET status = 'discarded', needs_owner = true, decided_by = $2::uuid, decided_at = $3::timestamptz WHERE id = $1::uuid AND status = 'pending_approval' RETURNING id", [actionId, ownerId, now]);
    if (!r.rows.length) return { ok: false, code: "conflict", message: "That reply was already sent or discarded." };
    await audit(db, ownerId, enquiryId, "enquiry.elena_discarded", { actionId }, now);
    return { ok: true };
  }
  const chk = checkReply(text(row["body"]), text(row["address_text"]));
  if (!chk.ok) {
    await db.query("UPDATE elena_enquiry_action SET status = 'blocked', reason = $2::text, needs_owner = true, decided_by = $3::uuid, decided_at = $4::timestamptz WHERE id = $1::uuid AND status = 'pending_approval'", [actionId, chk.reason, ownerId, now]);
    return { ok: false, code: "invalid", message: chk.reason };
  }
  const sent = await inTx(db)(async q => {
    const r = await q.query("UPDATE elena_enquiry_action SET status = 'sent', decided_by = $2::uuid, decided_at = $3::timestamptz WHERE id = $1::uuid AND status = 'pending_approval' RETURNING id", [actionId, ownerId, now]);
    if (!r.rows.length) return false;
    const mid = randomUUID();
    await q.query(INSERT_MESSAGE_SQL, [mid, enquiryId, text(row["body"]), now]);
    await q.query("UPDATE elena_enquiry_action SET sent_message_id = $2::uuid WHERE id = $1::uuid", [actionId, mid]);
    return true;
  });
  if (!sent) return { ok: false, code: "conflict", message: "That reply was already sent or discarded." };
  await audit(db, ownerId, enquiryId, "enquiry.elena_approved", { actionId }, now);
  await tellBuyer(notify, text(row["buyer_user_id"]), enquiryId, row["suburb"] ? text(row["suburb"]) : "");
  return { ok: true };
}

// ---- Booking an inspection from the thread --------------------------------------------------------------------------------------

/** What the thread shows the buyer: whether Elena can book, and the free times (soonest first). Nothing for anyone but the thread's buyer. */
export async function bookableTimes(db: Queryable, buyerId: string, enquiryId: string, now: string): Promise<{ enabled: boolean; slots: { startsAt: string; label: string }[] }> {
  const e = (await db.query(
    "SELECT e.listing_id, l.jurisdiction FROM enquiry e JOIN property_listing l ON l.id = e.listing_id JOIN elena_enquiry_settings s ON s.listing_id = l.id " +
    "WHERE e.id = $1::uuid AND e.buyer_user_id = $2::uuid AND s.enabled AND s.offer_inspections AND l.status = 'published'", [enquiryId, buyerId])).rows[0];
  if (!e) return { enabled: false, slots: [] };
  const repo = createPgOpenInspectionRepo(db);
  const listing = await repo.publishedListing(text(e["listing_id"]));
  if (!listing) return { enabled: false, slots: [] };
  return { enabled: true, slots: (await repo.freeSlots(listing, now)).slice(0, 6).map(s => ({ startsAt: s.startsAt, label: whenText(s.startsAt, listing.timezone) })) };
}

/** The buyer picks a time Elena offered. Uses the normal inspection booking (free slot, per-buyer cap, confirmations and reminders), then logs it and tells the owner. */
export async function bookSlot(db: Queryable, buyerId: string, enquiryId: string, startsAt: unknown, now: string, notify: Notify = defaultNotify(db)): Promise<ActResult & { bookingId?: string }> {
  const e = (await db.query(
    "SELECT e.listing_id, l.owner_user_id, l.suburb, u.display_name AS buyer_name FROM enquiry e JOIN property_listing l ON l.id = e.listing_id JOIN app_user u ON u.id = e.buyer_user_id " +
    "JOIN elena_enquiry_settings s ON s.listing_id = l.id WHERE e.id = $1::uuid AND e.buyer_user_id = $2::uuid AND s.enabled AND s.offer_inspections AND l.status = 'published'", [enquiryId, buyerId])).rows[0];
  if (!e) return NF;
  const repo = createPgOpenInspectionRepo(db);
  const listing = await repo.publishedListing(text(e["listing_id"]));
  if (!listing || listing.ownerId === buyerId) return NF;
  const profile = await repo.profile(buyerId);
  const input = parseBookingInput({ startsAt, name: profile.name || text(e["buyer_name"]), phone: profile.phone, email: profile.email, notes: "Booked through Elena" });
  if (!input.ok) return { ok: false, code: "invalid", message: input.message };
  const r = await repo.book(listing, buyerId, input.value, now);
  if (!r.ok) return { ok: false, code: (["forbidden", "not_found", "conflict", "rate_limited"] as const).find(c => c === r.code) ?? "invalid", message: r.message };
  await notifyBooked(db, r.value.id);
  const when = whenText(input.value.startsAt, listing.timezone);
  const ownerId = text(e["owner_user_id"]);
  const message = `You're booked to inspect on ${when}. A confirmation with the details is on its way, and I'll remind you before the inspection.\n\nElena, the owner's assistant (AI)`;
  const summary = ownerSummary("booked", firstName(text(e["buyer_name"])), ["inspection"], when);
  await inTx(db)(async q => {
    const mid = randomUUID();
    await q.query(INSERT_MESSAGE_SQL, [mid, enquiryId, message, now]);
    await q.query(INSERT_BOOKING_SQL, [randomUUID(), enquiryId, text(e["listing_id"]), ownerId, buyerId, "booking", message, r.value.id, mid, now]);
    await q.query(INSERT_BOOKING_SQL, [randomUUID(), enquiryId, text(e["listing_id"]), ownerId, buyerId, "summary", summary.text, r.value.id, null, now]);
  });
  await audit(db, "elena", enquiryId, "enquiry.elena_booked", { bookingId: r.value.id }, now);
  await notify(ownerId, "elena_enquiry", { title: summary.title, text: summary.text, link: "/agent/inspections" });
  return { ok: true, bookingId: r.value.id };
}

// ---- What the owner sees --------------------------------------------------------------------------------------------------------

export interface ActionView { id: string; enquiryId: string; kind: string; topics: string[]; body?: string; status: string; reason?: string; needsOwner: boolean; at: string }
const toView = (r: Record<string, unknown>): ActionView => ({
  id: text(r["id"]), enquiryId: text(r["enquiry_id"]), kind: text(r["kind"]), topics: (r["topics"] as unknown[] | null ?? []).map(text).filter(t => (TOPICS as readonly string[]).includes(t)),
  ...(r["body"] ? { body: text(r["body"]) } : {}), status: text(r["status"]), ...(r["reason"] ? { reason: text(r["reason"]) } : {}), needsOwner: r["needs_owner"] === true, at: iso(r["created_at"])
});

/** Params: 1 listing, 2 owner. Elena's log for one listing, newest first. */
export const LISTING_LOG_SQL =
  "SELECT a.id, a.enquiry_id, a.kind, a.topics, a.body, a.status, a.reason, a.needs_owner, a.created_at FROM elena_enquiry_action a " +
  "WHERE a.listing_id = $1::uuid AND a.owner_user_id = $2::uuid ORDER BY a.created_at DESC, a.id LIMIT 50";
export const THREAD_LOG_SQL =
  "SELECT a.id, a.enquiry_id, a.kind, a.topics, a.body, a.status, a.reason, a.needs_owner, a.created_at FROM elena_enquiry_action a " +
  "WHERE a.enquiry_id = $1::uuid AND a.owner_user_id = $2::uuid ORDER BY a.created_at DESC, a.id LIMIT 30";

export async function listLogForOwner(db: Queryable, ownerId: string, listingId: string): Promise<ActionView[]> {
  return (await db.query(LISTING_LOG_SQL, [listingId, ownerId])).rows.map(toView);
}
export async function threadLogForOwner(db: Queryable, ownerId: string, enquiryId: string): Promise<ActionView[]> {
  return (await db.query(THREAD_LOG_SQL, [enquiryId, ownerId])).rows.map(toView);
}

// ---- Scheduled tick -------------------------------------------------------------------------------------------------------------

/** Buyer messages from the last two days, sent after the owner last changed the settings, that Elena has not looked at yet (a message whose request was missed). */
export const UNHANDLED_SQL =
  "SELECT m.id FROM enquiry_message m JOIN enquiry e ON e.id = m.enquiry_id JOIN elena_enquiry_settings s ON s.listing_id = e.listing_id AND s.enabled " +
  "WHERE NOT m.automated AND m.sender_user_id = e.buyer_user_id AND m.sent_at >= s.updated_at AND m.sent_at > $1::timestamptz - interval '2 days' AND m.sent_at < $1::timestamptz - interval '1 minute' " +
  "AND NOT EXISTS (SELECT 1 FROM elena_enquiry_action a WHERE a.trigger_message_id = m.id) ORDER BY m.sent_at LIMIT 50";

export async function runDueElenaEnquiries(db: Queryable, now: string, notify: Notify = defaultNotify(db)): Promise<{ handled: number }> {
  let handled = 0;
  for (const r of (await db.query(UNHANDLED_SQL, [now])).rows) {
    const o = await handleBuyerMessage(db, text(r["id"]), now, notify).catch(() => "skipped" as Outcome);
    if (o !== "skipped" && o !== "off") handled++;
  }
  return { handled };
}
