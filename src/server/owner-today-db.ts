import { digestDay, digestText, rank, type TodayItem } from "../domain/owner-today";
import { topicLabels, TOPICS, type Topic } from "../domain/elena-enquiries";
import { JURISDICTION_TIME_ZONE } from "../domain/timezone";
import type { Jurisdiction } from "../domain/jurisdiction";
import { whenText } from "../domain/open-inspection";
import type { Queryable } from "./db";
import { defaultNotify, type Notify } from "./elena-enquiries-db";

// Constant SQL; the owner id is always a bound parameter taken from the signed-in user. Read-only except the digest bookkeeping.
const text = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const first = (n: unknown) => text(n).trim().split(/\s+/)[0] || "A buyer";
const topicsOf = (v: unknown): Topic[] => (Array.isArray(v) ? v.map(text).filter((t): t is Topic => (TOPICS as readonly string[]).includes(t)) : []);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const APPROVALS_SQL =
  "SELECT a.id, a.enquiry_id, a.topics, a.body, a.created_at, u.display_name AS buyer FROM elena_enquiry_action a JOIN app_user u ON u.id = a.buyer_user_id " +
  "WHERE a.owner_user_id = $1::uuid AND a.status = 'pending_approval' ORDER BY a.created_at LIMIT 20";
/** Questions still waiting on the owner personally: no later message from the owner in the thread. */
export const QUESTIONS_SQL =
  "SELECT a.id, a.enquiry_id, a.topics, a.status, a.created_at, u.display_name AS buyer FROM elena_enquiry_action a JOIN app_user u ON u.id = a.buyer_user_id " +
  "WHERE a.owner_user_id = $1::uuid AND a.kind = 'reply' AND a.needs_owner AND a.status <> 'pending_approval' " +
  "AND NOT EXISTS (SELECT 1 FROM enquiry_message m WHERE m.enquiry_id = a.enquiry_id AND m.sender_user_id = a.owner_user_id AND m.sent_at > a.created_at) ORDER BY a.created_at LIMIT 20";
export const OFFERS_SQL =
  "SELECT o.id, o.listing_id, o.submitted_at, l.title FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id " +
  "WHERE l.owner_user_id = $1::uuid AND o.status IN ('submitted','under_review','buyer_countered') ORDER BY o.submitted_at LIMIT 20";
export const JOBS_SQL =
  "SELECT j.id, j.assignment_id, j.state, j.kind, j.proposed_at, j.proposed_by, j.needs_owner_reason, j.updated_at, l.title, l.jurisdiction FROM elena_job j JOIN property_listing l ON l.id = j.listing_id " +
  "WHERE j.owner_user_id = $1::uuid AND (j.state = 'needs_owner' OR (j.state = 'negotiating' AND j.proposed_by = 'contractor' AND j.proposed_at > $2::timestamptz)) ORDER BY j.updated_at LIMIT 20";
export const INSPECTIONS_SQL =
  "SELECT b.id, b.starts_at, b.buyer_name, l.title, l.jurisdiction FROM open_inspection_booking b JOIN property_listing l ON l.id = b.listing_id " +
  "WHERE l.owner_user_id = $1::uuid AND b.status = 'booked' AND b.starts_at > $2::timestamptz AND b.starts_at <= $2::timestamptz + interval '24 hours' ORDER BY b.starts_at LIMIT 20";
export const DRAFTS_SQL =
  "SELECT id, title, created_at FROM property_listing WHERE owner_user_id = $1::uuid AND status = 'draft' AND created_at < $2::timestamptz - interval '1 day' ORDER BY created_at LIMIT 3";

const tz = (j: unknown) => JURISDICTION_TIME_ZONE[text(j).trim() as Jurisdiction] ?? "Australia/Sydney";

/** Every open item for one owner, most urgent first. All of it is read from live tables; nothing is stored. */
export async function ownerToday(db: Queryable, ownerId: string, now: string): Promise<TodayItem[]> {
  const [approvals, questions, offers, jobs, inspections, drafts] = await Promise.all([
    db.query(APPROVALS_SQL, [ownerId]), db.query(QUESTIONS_SQL, [ownerId]), db.query(OFFERS_SQL, [ownerId]),
    db.query(JOBS_SQL, [ownerId, now]), db.query(INSPECTIONS_SQL, [ownerId, now]), db.query(DRAFTS_SQL, [ownerId, now])
  ]);
  const items: TodayItem[] = [];
  for (const r of approvals.rows) items.push({
    id: `approval:${text(r["id"])}`, kind: "approval", urgency: 1, at: iso(r["created_at"]),
    title: `Approve Elena's reply to ${first(r["buyer"])} about ${topicsLabel(r["topics"])}`, detail: clip(text(r["body"]).split("\n\n")[0] ?? "", 200),
    action: { type: "post", url: `/api/elena-enquiries/${text(r["id"])}`, body: { decision: "approve" }, label: "Approve and send" },
    more: { type: "link", href: `/enquiries/${text(r["enquiry_id"])}`, label: "Read the thread" }
  });
  for (const r of questions.rows) items.push({
    id: `question:${text(r["id"])}`, kind: "question", urgency: 1, at: iso(r["created_at"]),
    title: `${first(r["buyer"])} asked about ${topicsLabel(r["topics"])}`,
    detail: text(r["status"]) === "blocked" ? "Elena's reply didn't pass the safety checks, so it was not sent." : "Elena couldn't answer all of it from the listing.",
    action: { type: "link", href: `/enquiries/${text(r["enquiry_id"])}`, label: "Reply" }
  });
  for (const r of offers.rows) items.push({
    id: `offer:${text(r["id"])}`, kind: "offer", urgency: 1, at: iso(r["submitted_at"]),
    title: `Offer waiting on ${text(r["title"])}`, detail: "Offers are decided by you. Elena never accepts or negotiates.",
    action: { type: "link", href: `/listings/${text(r["listing_id"])}/offers/${text(r["id"])}`, label: "Review offer" }
  });
  for (const r of jobs.rows) {
    const label = text(r["kind"]).replace(/_/g, " ");
    if (text(r["state"]) === "needs_owner") items.push({
      id: `job:${text(r["id"])}`, kind: "job_blocked", urgency: 2, at: iso(r["updated_at"]),
      title: `The ${label} job needs you`, detail: r["needs_owner_reason"] ? clip(text(r["needs_owner_reason"]), 200) : "Elena handed it back to you.",
      action: { type: "link", href: `/jobs/${text(r["assignment_id"])}`, label: "Open the job" }
    });
    else items.push({
      id: `job:${text(r["id"])}`, kind: "job_time", urgency: 2, at: iso(r["updated_at"]),
      title: `Confirm the ${label} visit on ${whenText(iso(r["proposed_at"]), tz(r["jurisdiction"]))}`, detail: "The contractor suggested this time.",
      action: { type: "post", url: `/api/elena-jobs/${text(r["id"])}`, body: { action: "accept" }, label: "Accept this time" },
      more: { type: "link", href: `/jobs/${text(r["assignment_id"])}`, label: "See the job" }
    });
  }
  for (const r of inspections.rows) items.push({
    id: `inspection:${text(r["id"])}`, kind: "inspection", urgency: 2, at: iso(r["starts_at"]),
    title: `Inspection ${whenText(iso(r["starts_at"]), tz(r["jurisdiction"]))}: ${first(r["buyer_name"])}`, detail: text(r["title"]),
    action: { type: "link", href: "/agent/inspections", label: "See bookings" }
  });
  for (const r of drafts.rows) items.push({
    id: `draft:${text(r["id"])}`, kind: "listing_blocker", urgency: 3, at: iso(r["created_at"]),
    title: `Finish and publish ${text(r["title"])}`, detail: "This listing is still a draft, so buyers can't see it.",
    action: { type: "link", href: `/listings/${text(r["id"])}/edit`, label: "Finish listing" }
  });
  return rank(items);
}
const topicsLabel = (v: unknown) => topicsOf(v).length ? topicsLabelOf(topicsOf(v)) : "a general question";
const topicsLabelOf = (t: Topic[]) => topicLabels(t);

// ---- Daily digest ---------------------------------------------------------------------------------------------------------------

export async function getDigest(db: Queryable, userId: string): Promise<{ enabled: boolean }> {
  const r = (await db.query("SELECT enabled FROM owner_digest_setting WHERE user_id = $1::uuid", [userId])).rows[0];
  return { enabled: r?.["enabled"] === true };
}
export async function setDigest(db: Queryable, userId: string, enabled: boolean): Promise<void> {
  await db.query(
    "INSERT INTO owner_digest_setting (user_id, enabled) VALUES ($1::uuid, $2::boolean) ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()", [userId, enabled]);
}

export const DIGEST_DUE_SQL =
  "SELECT s.user_id, s.last_sent_on::text AS last_sent_on, COALESCE((SELECT jurisdiction FROM property_listing WHERE owner_user_id = s.user_id ORDER BY created_at DESC LIMIT 1), 'NSW') AS jurisdiction " +
  "FROM owner_digest_setting s JOIN app_user u ON u.id = s.user_id WHERE s.enabled AND u.status = 'active' LIMIT 500";

/** Sends each opted-in owner one digest per local day, from 7 am their time, only when something needs them. Claimed before sending, so a repeat run never double-sends. */
export async function runOwnerDigests(db: Queryable, now: string, notify: Notify = defaultNotify(db)): Promise<{ sent: number }> {
  let sent = 0;
  for (const r of (await db.query(DIGEST_DUE_SQL, [])).rows) {
    const last = r["last_sent_on"] ? text(r["last_sent_on"]).slice(0, 10) : undefined;
    const day = digestDay(last, now, tz(r["jurisdiction"]));
    if (!day) continue;
    const claim = await db.query("UPDATE owner_digest_setting SET last_sent_on = $2::date WHERE user_id = $1::uuid AND enabled AND last_sent_on IS DISTINCT FROM $2::date RETURNING user_id", [text(r["user_id"]), day]);
    if (!claim.rows.length) continue;
    const items = await ownerToday(db, text(r["user_id"]), now);
    if (!items.length) continue;
    const d = digestText(items);
    await notify(text(r["user_id"]), "owner_digest", { title: d.title, text: d.text, link: "/dashboard" });
    sent++;
  }
  return { sent };
}
