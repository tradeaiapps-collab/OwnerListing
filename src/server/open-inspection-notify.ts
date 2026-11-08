import { JURISDICTION_TIME_ZONE } from "../domain/timezone";
import type { Jurisdiction } from "../domain/jurisdiction";
import { whenText } from "../domain/open-inspection";
import type { Queryable } from "./db";
import { notifyUser } from "./notifier";

type Env = Readonly<Record<string, string | undefined>>;

/** Hours before the start for each automatic reminder. The 1 hour one also covers the quarter hour either side of a 15 minute scheduler. */
export const REMINDER_WINDOWS = { "24hr": { hours: 24, minLeadHours: 24 }, "1hr": { minutes: 75, minLeadHours: 2 } } as const;

const DETAIL_COLS =
  "b.id, b.buyer_id, b.buyer_name, b.starts_at, l.address_text, l.title, l.jurisdiction, l.owner_user_id, " +
  "a.agent_user_id, COALESCE(ag.display_name, ow.display_name) AS contact_name, COALESCE(ag.email, ow.email)::text AS contact_email";
const DETAIL_FROM =
  "FROM open_inspection_booking b JOIN property_listing l ON l.id = b.listing_id JOIN app_user ow ON ow.id = l.owner_user_id " +
  "LEFT JOIN listing_agent_appointment a ON a.listing_id = l.id AND a.revoked_at IS NULL LEFT JOIN app_user ag ON ag.id = a.agent_user_id";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const contactOf = (x: Record<string, unknown>) => [x["contact_name"], x["contact_email"]].filter(Boolean).join(", ");
const params = (x: Record<string, unknown>, extra: Record<string, string> = {}) => ({
  listing: String(x["address_text"] ?? x["title"] ?? ""),
  when: whenText(iso(x["starts_at"]), JURISDICTION_TIME_ZONE[String(x["jurisdiction"]) as Jurisdiction] ?? "Australia/Sydney"),
  contact: contactOf(x), ...extra
});
/** The people who run the listing: the owner, and the appointed agent when there is one. */
const managers = (x: Record<string, unknown>) => [...new Set([String(x["owner_user_id"]), ...(x["agent_user_id"] ? [String(x["agent_user_id"])] : [])])];

async function details(db: Queryable, ids: readonly string[]) {
  return (await db.query(`SELECT ${DETAIL_COLS} ${DETAIL_FROM} WHERE b.id = ANY($1::uuid[])`, [ids])).rows;
}

/** Confirms the booking to the buyer and tells the owner and agent. Ids, addresses and times are looked up here, never taken from the request. Never throws. */
export async function notifyBooked(db: Queryable, bookingId: string, env: Env = process.env): Promise<void> {
  try {
    for (const x of await details(db, [bookingId])) {
      await notifyUser(db, String(x["buyer_id"]), "open_inspection_confirmed", { ...params(x), link: "/open-inspections" }, env);
      for (const m of managers(x)) await notifyUser(db, m, "open_inspection_new", { ...params(x), name: String(x["buyer_name"]), link: "/agent/inspections" }, env);
    }
  } catch { /* A notification never blocks the booking. */ }
}

/** Tells the other side about cancelled bookings. A buyer's cancellation goes to the managers; an agent's goes to each buyer with the next free times. */
export async function notifyCancelled(db: Queryable, bookingIds: readonly string[], by: "buyer" | "agent", nextTimes: (listingId: string) => Promise<string>, env: Env = process.env): Promise<void> {
  try {
    const rows = (await db.query(`SELECT ${DETAIL_COLS}, b.listing_id ${DETAIL_FROM} WHERE b.id = ANY($1::uuid[])`, [bookingIds])).rows;
    for (const x of rows) {
      if (by === "buyer") for (const m of managers(x)) await notifyUser(db, m, "open_inspection_cancelled", { ...params(x), next: `${String(x["buyer_name"])} cancelled.`, link: "/agent/inspections" }, env);
      else await notifyUser(db, String(x["buyer_id"]), "open_inspection_cancelled", { ...params(x), next: await nextTimes(String(x["listing_id"])), link: `/listings/${String(x["listing_id"])}/book-inspection` }, env);
    }
  } catch { /* A notification never blocks the cancellation. */ }
}

/** Sends the buyer a reminder now (the agent's "send reminder" action), recorded as a custom reminder. */
export async function sendReminderNow(db: Queryable, bookingIds: readonly string[], env: Env = process.env): Promise<number> {
  let sent = 0;
  try {
    await db.query("INSERT INTO open_inspection_reminder (booking_id, reminder_type) SELECT id, 'custom' FROM open_inspection_booking WHERE id = ANY($1::uuid[]) AND status = 'booked'", [bookingIds]);
    for (const x of await details(db, bookingIds)) { await notifyUser(db, String(x["buyer_id"]), "open_inspection_reminder_24h", { ...params(x), link: "/open-inspections" }, env); sent++; }
  } catch { /* A notification never blocks the agent's action. */ }
  return sent;
}

/**
 * One tick of the reminder job (every 15 minutes). A 24 hour reminder goes to each booked buyer whose slot starts within a day, and a 1 hour one within
 * the next 75 minutes, unless the booking was made too late for that reminder to make sense. Each reminder is claimed (a row in
 * open_inspection_reminder, unique per booking and type) before sending, so a repeat run never reminds twice.
 */
export async function runOpenInspectionReminders(db: Queryable, nowIso: string, env: Env = process.env): Promise<{ day: number; hour: number }> {
  const claim = async (type: "24hr" | "1hr", horizon: string, leadHours: number, minAheadMins: number) =>
    (await db.query(
      "WITH c AS (INSERT INTO open_inspection_reminder (booking_id, reminder_type, sent_at) SELECT b.id, $1::text, $2::timestamptz FROM open_inspection_booking b " +
      `WHERE b.status = 'booked' AND b.starts_at > $2::timestamptz + make_interval(mins => $4::int) AND b.starts_at <= ${horizon} AND b.created_at <= b.starts_at - make_interval(hours => $3::int) ` +
      "ON CONFLICT (booking_id, reminder_type) WHERE reminder_type <> 'custom' DO NOTHING RETURNING booking_id) " +
      `SELECT ${DETAIL_COLS} ${DETAIL_FROM} JOIN c ON c.booking_id = b.id`, [type, nowIso, leadHours, minAheadMins])).rows;
  const day = await claim("24hr", "$2::timestamptz + interval '24 hours'", REMINDER_WINDOWS["24hr"].minLeadHours, 120);
  const hour = await claim("1hr", "$2::timestamptz + interval '75 minutes'", REMINDER_WINDOWS["1hr"].minLeadHours, 0);
  for (const x of day) await notifyUser(db, String(x["buyer_id"]), "open_inspection_reminder_24h", { ...params(x), link: "/open-inspections" }, env);
  for (const x of hour) await notifyUser(db, String(x["buyer_id"]), "open_inspection_reminder_1h", { ...params(x), link: "/open-inspections" }, env);
  return { day: day.length, hour: hour.length };
}
