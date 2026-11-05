import { randomUUID } from "node:crypto";
import { JURISDICTION_TIME_ZONE } from "../domain/timezone";
import type { Jurisdiction } from "../domain/jurisdiction";
import {
  ACTION_FROM, ACTION_TO, MAX_LIVE_BOOKINGS_PER_BUYER, MAX_RULES, SLOT_DAYS, generateOpenSlots, overlaps,
  type AgentAction, type Block, type BookingInput, type Rule, type RuleInput, type Slot
} from "../domain/open-inspection";
import type { Result } from "../domain/listing-service";
import { getDb } from "./context";
import type { Queryable } from "./db";

// Constant SQL text; every value is a bound parameter. Who may manage a listing is decided here from the session user's id (owner, or the
// agent with an active appointment), never from the request. Bookings are never deleted (the table refuses it); each write also inserts an audit_event row.

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const dateOnly = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const fail = (code: "invalid" | "not_found" | "forbidden" | "conflict", message: string): Result<never> => ({ ok: false, code, message });

/** True when $n owns the listing (`l`) or is its appointed agent (active appointment). */
export const managerOf = (n: number) =>
  `(l.owner_user_id = $${n}::uuid OR EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = l.id AND a.agent_user_id = $${n}::uuid AND a.revoked_at IS NULL))`;

const audit = (actor: number, aggregateType: string, event: string, ids: string) =>
  `INSERT INTO audit_event (id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload) ` +
  `SELECT gen_random_uuid(), now(), 'user', $${actor}::text, '${aggregateType}', x.id::text, '${event}', gen_random_uuid()::text, '{}'::jsonb FROM ${ids} x`;

export interface OpenListing { id: string; title: string; address: string; jurisdiction: Jurisdiction; timezone: string; ownerId: string; contactName: string; contactEmail: string }

/** Params: 1 listing. Published listings only; the contact is the appointed agent, else the owner. */
export const LISTING_SQL =
  "SELECT l.id, l.title, l.address_text, l.jurisdiction, l.owner_user_id, " +
  "COALESCE(ag.display_name, ow.display_name) AS contact_name, COALESCE(ag.email, ow.email)::text AS contact_email " +
  "FROM property_listing l JOIN app_user ow ON ow.id = l.owner_user_id " +
  "LEFT JOIN listing_agent_appointment a ON a.listing_id = l.id AND a.revoked_at IS NULL LEFT JOIN app_user ag ON ag.id = a.agent_user_id " +
  "WHERE l.id = $1::uuid AND l.status = 'published'";
/** Params: 1 listing, 2 user. Any listing (draft too) the user manages, so the schedule can be set before publishing. */
export const MANAGED_LISTING_SQL =
  "SELECT l.id, l.title, l.address_text, l.jurisdiction, l.owner_user_id, ow.display_name AS contact_name, ow.email::text AS contact_email FROM property_listing l JOIN app_user ow ON ow.id = l.owner_user_id " +
  `WHERE l.id = $1::uuid AND ${managerOf(2)}`;
/** Params: 1 user. Listings the user manages, for the agent's listing picker. */
export const MY_LISTINGS_SQL =
  `SELECT l.id, l.title, l.address_text, l.status, l.jurisdiction FROM property_listing l WHERE ${managerOf(1)} AND l.status IN ('published','draft','pending_review') ORDER BY l.created_at DESC, l.id LIMIT 200`;

export const RULES_SQL =
  "SELECT id, recurrence, day_of_week, on_date, start_min, end_min, slot_minutes, capacity, end_date FROM open_inspection_availability WHERE listing_id = $1::uuid AND removed_at IS NULL " +
  "AND (recurrence = 'weekly' AND (end_date IS NULL OR end_date >= (now() AT TIME ZONE 'UTC')::date - 1) OR recurrence = 'once' AND on_date >= (now() AT TIME ZONE 'UTC')::date - 1) ORDER BY recurrence DESC, day_of_week, on_date, start_min";
export const BLOCKS_SQL = "SELECT id, starts_at, ends_at, note FROM open_inspection_block WHERE listing_id = $1::uuid AND removed_at IS NULL AND ends_at > now() ORDER BY starts_at";
export const TAKEN_SQL =
  "SELECT starts_at, count(*)::int AS n FROM open_inspection_booking WHERE listing_id = $1::uuid AND status = 'booked' AND starts_at > now() GROUP BY starts_at";

const ruleOf = (x: Record<string, unknown>): Rule => ({
  id: String(x["id"]), recurrence: x["recurrence"] as "once" | "weekly", dayOfWeek: x["day_of_week"] === null ? null : Number(x["day_of_week"]),
  onDate: x["on_date"] === null ? null : dateOnly(x["on_date"]), startMin: Number(x["start_min"]), endMin: Number(x["end_min"]),
  slotMinutes: Number(x["slot_minutes"]), capacity: Number(x["capacity"]), endDate: x["end_date"] === null ? null : dateOnly(x["end_date"])
});

export interface BookingRow {
  id: string; listingId: string; title: string; address: string; timezone: string; startsAt: string; endsAt: string; status: string;
  buyerName: string; buyerPhone: string; buyerEmail: string; notes: string; contactName?: string; contactEmail?: string;
}
const rowOf = (x: Record<string, unknown>): BookingRow => ({
  id: String(x["id"]), listingId: String(x["listing_id"]), title: String(x["title"]), address: String(x["address_text"]),
  timezone: JURISDICTION_TIME_ZONE[String(x["jurisdiction"]) as Jurisdiction] ?? "Australia/Sydney", startsAt: iso(x["starts_at"]), endsAt: iso(x["ends_at"]), status: String(x["status"]),
  buyerName: String(x["buyer_name"]), buyerPhone: String(x["buyer_phone"]), buyerEmail: String(x["buyer_email"]), notes: String(x["notes"]),
  ...(x["contact_name"] !== undefined ? { contactName: String(x["contact_name"]), contactEmail: String(x["contact_email"] ?? "") } : {})
});
const BOOKING_COLS = "b.id, b.listing_id, l.title, l.address_text, l.jurisdiction, b.starts_at, b.ends_at, b.status, b.buyer_name, b.buyer_phone, b.buyer_email, b.notes";

/** Params: 1 buyer. Own bookings, soonest first among upcoming, with the contact for the listing. */
export const BUYER_BOOKINGS_SQL =
  `SELECT ${BOOKING_COLS}, COALESCE(ag.display_name, ow.display_name) AS contact_name, COALESCE(ag.email, ow.email)::text AS contact_email ` +
  "FROM open_inspection_booking b JOIN property_listing l ON l.id = b.listing_id JOIN app_user ow ON ow.id = l.owner_user_id " +
  "LEFT JOIN listing_agent_appointment a ON a.listing_id = l.id AND a.revoked_at IS NULL LEFT JOIN app_user ag ON ag.id = a.agent_user_id " +
  "WHERE b.buyer_id = $1::uuid ORDER BY (b.starts_at < now()), CASE WHEN b.starts_at >= now() THEN b.starts_at END, b.starts_at DESC, b.id LIMIT 100";
/** Params: 1 manager, 2 from, 3 to, 4 optional listing. Bookings on listings the user manages, in a date range. */
export const MANAGER_BOOKINGS_SQL =
  `SELECT ${BOOKING_COLS} FROM open_inspection_booking b JOIN property_listing l ON l.id = b.listing_id ` +
  `WHERE ${managerOf(1)} AND b.starts_at >= $2::timestamptz AND b.starts_at < $3::timestamptz AND ($4::uuid IS NULL OR b.listing_id = $4::uuid) ORDER BY b.starts_at, b.id LIMIT 500`;

export interface OpenInspectionRepo {
  managedListing(listingId: string, userId: string): Promise<OpenListing | undefined>;
  publishedListing(listingId: string): Promise<OpenListing | undefined>;
  myListings(userId: string): Promise<{ id: string; title: string; address: string; status: string }[]>;
  schedule(listingId: string): Promise<{ rules: Rule[]; blocks: (Block & { id: string; note: string })[] }>;
  freeSlots(listing: OpenListing, nowIso: string): Promise<Slot[]>;
  addRule(listing: OpenListing, userId: string, rule: RuleInput): Promise<Result<{ id: string }>>;
  removeRule(listingId: string, ruleId: string, userId: string): Promise<boolean>;
  addBlock(listing: OpenListing, userId: string, block: { startsAt: string; endsAt: string; note: string }): Promise<{ id: string; cancelled: string[] }>;
  removeBlock(listingId: string, blockId: string, userId: string): Promise<boolean>;
  book(listing: OpenListing, buyerId: string, input: BookingInput, nowIso: string): Promise<Result<{ id: string }>>;
  buyerBookings(buyerId: string): Promise<BookingRow[]>;
  profile(userId: string): Promise<{ name: string; email: string; phone: string }>;
  managerBookings(userId: string, from: string, to: string, listingId?: string): Promise<BookingRow[]>;
  buyerCancel(bookingId: string, buyerId: string): Promise<{ id: string } | undefined>;
  applyAction(userId: string, ids: string[], action: AgentAction): Promise<{ id: string; buyerId: string }[]>;
}

export function createPgOpenInspectionRepo(db: Queryable): OpenInspectionRepo {
  const listingOf = (x: Record<string, unknown>): OpenListing => ({
    id: String(x["id"]), title: String(x["title"]), address: String(x["address_text"]), jurisdiction: String(x["jurisdiction"]) as Jurisdiction,
    timezone: JURISDICTION_TIME_ZONE[String(x["jurisdiction"]) as Jurisdiction] ?? "Australia/Sydney", ownerId: String(x["owner_user_id"]),
    contactName: String(x["contact_name"] ?? ""), contactEmail: String(x["contact_email"] ?? "")
  });
  async function slotsOf(q: Queryable, listing: OpenListing, nowIso: string): Promise<Slot[]> {
    const [rules, blocks, taken] = await Promise.all([q.query(RULES_SQL, [listing.id]), q.query(BLOCKS_SQL, [listing.id]), q.query(TAKEN_SQL, [listing.id])]);
    return generateOpenSlots(rules.rows.map(ruleOf), blocks.rows.map(b => ({ startsAt: iso(b["starts_at"]), endsAt: iso(b["ends_at"]) })),
      new Map(taken.rows.map(t => [iso(t["starts_at"]), Number(t["n"])] as const)), listing.timezone, nowIso, SLOT_DAYS);
  }
  return {
    async managedListing(listingId, userId) { const x = (await db.query(MANAGED_LISTING_SQL, [listingId, userId])).rows[0]; return x ? listingOf(x) : undefined; },
    async publishedListing(listingId) { const x = (await db.query(LISTING_SQL, [listingId])).rows[0]; return x ? listingOf(x) : undefined; },
    async myListings(userId) { return (await db.query(MY_LISTINGS_SQL, [userId])).rows.map(x => ({ id: String(x["id"]), title: String(x["title"]), address: String(x["address_text"]), status: String(x["status"]) })); },
    async schedule(listingId) {
      const [rules, blocks] = await Promise.all([db.query(RULES_SQL, [listingId]), db.query(BLOCKS_SQL, [listingId])]);
      return { rules: rules.rows.map(ruleOf), blocks: blocks.rows.map(b => ({ id: String(b["id"]), startsAt: iso(b["starts_at"]), endsAt: iso(b["ends_at"]), note: String(b["note"]) })) };
    },
    freeSlots: (listing, nowIso) => slotsOf(db, listing, nowIso),
    async addRule(listing, userId, rule) {
      const existing = (await db.query(RULES_SQL, [listing.id])).rows.map(ruleOf);
      if (existing.length >= MAX_RULES) return fail("conflict", "That listing has the most open times it can hold. Remove one first.");
      if (existing.some(r => overlaps(r, rule))) return fail("conflict", "That overlaps an open time you already published for the same day.");
      const id = randomUUID();
      await db.query(
        "WITH done AS (INSERT INTO open_inspection_availability (id, listing_id, created_by, recurrence, day_of_week, on_date, start_min, end_min, slot_minutes, capacity, end_date) " +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::smallint, $6::date, $7::smallint, $8::smallint, $9::smallint, $10::smallint, $11::date) RETURNING id) " + audit(3, "open_inspection_availability", "open_inspection.times_published", "done"),
        [id, listing.id, userId, rule.recurrence, rule.dayOfWeek, rule.onDate, rule.startMin, rule.endMin, rule.slotMinutes, rule.capacity, rule.endDate]);
      return { ok: true, value: { id } };
    },
    async removeRule(listingId, ruleId, userId) {
      const r = await db.query(
        "WITH done AS (UPDATE open_inspection_availability r SET removed_at = now() FROM property_listing l WHERE r.id = $1::uuid AND r.listing_id = $2::uuid AND l.id = r.listing_id AND r.removed_at IS NULL " +
        `AND ${managerOf(3)} RETURNING r.id) ` + audit(3, "open_inspection_availability", "open_inspection.times_removed", "done") + " RETURNING aggregate_id", [ruleId, listingId, userId]);
      return r.rows.length > 0;
    },
    async addBlock(listing, userId, block) {
      const id = randomUUID();
      await db.query("INSERT INTO open_inspection_block (id, listing_id, created_by, starts_at, ends_at, note) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz, $6::text)",
        [id, listing.id, userId, block.startsAt, block.endsAt, block.note]);
      // Anyone already booked inside the blocked time is cancelled by the agent, so the caller can tell them the next free times.
      const hit = await db.query(
        "WITH done AS (UPDATE open_inspection_booking SET status = 'cancelled', cancelled_by = $2::uuid, decided_at = now() WHERE listing_id = $1::uuid AND status = 'booked' " +
        "AND starts_at < $4::timestamptz AND ends_at > $3::timestamptz RETURNING id) " + audit(2, "open_inspection_booking", "open_inspection.cancelled_by_agent", "done") + " RETURNING aggregate_id",
        [listing.id, userId, block.startsAt, block.endsAt]);
      return { id, cancelled: hit.rows.map(r => String(r["aggregate_id"])) };
    },
    async removeBlock(listingId, blockId, userId) {
      const r = await db.query(
        "UPDATE open_inspection_block b SET removed_at = now() FROM property_listing l WHERE b.id = $1::uuid AND b.listing_id = $2::uuid AND l.id = b.listing_id AND b.removed_at IS NULL " + `AND ${managerOf(3)} RETURNING b.id`,
        [blockId, listingId, userId]);
      return r.rows.length > 0;
    },
    async book(listing, buyerId, input, nowIso) {
      if (!db.transaction) throw new Error("open inspections need a transactional database");
      return db.transaction(async tx => {
        // Serialise bookings per listing so two buyers cannot take the last spot of one slot.
        const locked = (await tx.query("SELECT l.id FROM property_listing l WHERE l.id = $1::uuid AND l.status = 'published' AND l.owner_user_id <> $2::uuid FOR UPDATE", [listing.id, buyerId])).rows[0];
        if (!locked) return fail("not_found", "This property is not open for inspection booking.");
        const live = Number((await tx.query("SELECT count(*)::int AS n FROM open_inspection_booking WHERE buyer_id = $1::uuid AND status = 'booked' AND starts_at > now()", [buyerId])).rows[0]?.["n"] ?? 0);
        if (live >= MAX_LIVE_BOOKINGS_PER_BUYER) return fail("conflict", `You already have ${MAX_LIVE_BOOKINGS_PER_BUYER} upcoming inspections. Cancel one to book another.`);
        const slot = (await slotsOf(tx, listing, nowIso)).find(s => s.startsAt === input.startsAt);
        if (!slot) return fail("conflict", "That time is no longer available. Choose another slot.");
        const dup = (await tx.query("SELECT 1 FROM open_inspection_booking WHERE listing_id = $1::uuid AND buyer_id = $2::uuid AND starts_at = $3::timestamptz AND status = 'booked'", [listing.id, buyerId, slot.startsAt])).rows[0];
        if (dup) return fail("conflict", "You have already booked that time.");
        const id = randomUUID();
        await tx.query(
          "WITH done AS (INSERT INTO open_inspection_booking (id, listing_id, buyer_id, buyer_name, buyer_phone, buyer_email, starts_at, ends_at, notes) " +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::timestamptz, $8::timestamptz, $9::text) RETURNING id) " + audit(3, "open_inspection_booking", "open_inspection.booked", "done"),
          [id, listing.id, buyerId, input.name, input.phone, input.email, slot.startsAt, slot.endsAt, input.notes]);
        return { ok: true as const, value: { id } };
      });
    },
    async profile(userId) {
      const x = (await db.query("SELECT u.display_name, u.email::text AS email, bv.phone_e164 FROM app_user u LEFT JOIN buyer_verification bv ON bv.user_id = u.id AND bv.phone_verified_at IS NOT NULL WHERE u.id = $1::uuid", [userId])).rows[0];
      return { name: String(x?.["display_name"] ?? ""), email: String(x?.["email"] ?? ""), phone: String(x?.["phone_e164"] ?? "") };
    },
    async buyerBookings(buyerId) { return (await db.query(BUYER_BOOKINGS_SQL, [buyerId])).rows.map(rowOf); },
    async managerBookings(userId, from, to, listingId) { return (await db.query(MANAGER_BOOKINGS_SQL, [userId, from, to, listingId ?? null])).rows.map(rowOf); },
    async buyerCancel(bookingId, buyerId) {
      const r = await db.query(
        "WITH done AS (UPDATE open_inspection_booking SET status = 'cancelled', cancelled_by = $2::uuid, decided_at = now() WHERE id = $1::uuid AND buyer_id = $2::uuid AND status = 'booked' AND starts_at > now() RETURNING id) " +
        audit(2, "open_inspection_booking", "open_inspection.cancelled_by_buyer", "done") + " RETURNING aggregate_id", [bookingId, buyerId]);
      return r.rows[0] ? { id: String(r.rows[0]["aggregate_id"]) } : undefined;
    },
    async applyAction(userId, ids, action) {
      const to = ACTION_TO[action];
      const guard = `b.id = ANY($1::uuid[]) AND l.id = b.listing_id AND b.status = ANY($3::text[]) AND ${managerOf(2)}` + (action === "complete" || action === "no_show" ? " AND b.starts_at <= now()" : action === "cancel" || action === "remind" ? " AND b.starts_at > now()" : "");
      if (!to) { // remind: changes nothing, only says who may be reminded
        return (await db.query(`SELECT b.id, b.buyer_id FROM open_inspection_booking b JOIN property_listing l ON l.id = b.listing_id WHERE ${guard}`, [ids, userId, [...ACTION_FROM[action]]])).rows
          .map(x => ({ id: String(x["id"]), buyerId: String(x["buyer_id"]) }));
      }
      const r = await db.query(
        `WITH done AS (UPDATE open_inspection_booking b SET status = '${to}', decided_at = now()${action === "cancel" ? ", cancelled_by = $2::uuid" : ""} FROM property_listing l WHERE ${guard} RETURNING b.id, b.buyer_id), ` +
        `a AS (${audit(2, "open_inspection_booking", `open_inspection.${to}`, "done")} RETURNING 1) SELECT id, buyer_id FROM done`, [ids, userId, [...ACTION_FROM[action]]]);
      return r.rows.map(x => ({ id: String(x["id"]), buyerId: String(x["buyer_id"]) }));
    }
  };
}

let singleton: OpenInspectionRepo | undefined;
/** Lazily wired so importing this file never opens a connection. */
export const getOpenInspectionRepo = (): OpenInspectionRepo => (singleton ??= createPgOpenInspectionRepo(getDb()));
