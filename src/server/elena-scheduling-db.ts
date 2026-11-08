import { noteSuggestion } from "./elena-wiring-db";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_TEMPLATES, KIND_LABEL, MESSAGE_KINDS, formatAppointment, parseDecision, pickTemplate, planMessages, renderTemplate,
  type MessageKind, type TemplateInput, type Voice
} from "../domain/elena-scheduling";
import type { Jurisdiction } from "../domain/inspection-marketplace";
import { notifyUser } from "./notifier";
import type { Queryable } from "./db";

// Constant SQL text: user input only travels as bound parameters; the acting user id always comes from the session.
// Elena only drafts. Nothing reaches the buyer until the inspector sends the draft (decide below).

const text = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export interface StoredTemplate { id: string; kind: MessageKind; voice: Voice; body: string; updatedAt: string }
export interface ScheduledMessage {
  id: string; bookingId: string; kind: MessageKind; kindLabel: string; status: "scheduled" | "suggested" | "sent" | "skipped" | "expired";
  listingTitle: string; scheduledAt: string; draftBody: string; finalBody?: string; edited: boolean; dueAt: string; decidedAt?: string;
}

// ---- Templates ------------------------------------------------------------------------------------------------------------------

/** Params: 1 owner (null = platform-wide). */
export const LIST_TEMPLATES_SQL =
  "SELECT id, kind, voice, body, updated_at FROM elena_message_template WHERE owner_user_id IS NOT DISTINCT FROM $1::uuid ORDER BY kind";
/** Params: 1 owner, 2 kind, 3 voice, 4 body, 5 updater. One template per owner and kind. */
export const UPSERT_OWN_TEMPLATE_SQL =
  "INSERT INTO elena_message_template (owner_user_id, kind, voice, body, updated_by) VALUES ($1::uuid, $2, $3, $4, $5::uuid) " +
  "ON CONFLICT (owner_user_id, kind) WHERE owner_user_id IS NOT NULL DO UPDATE SET voice = EXCLUDED.voice, body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING id";
export const UPSERT_GLOBAL_TEMPLATE_SQL =
  "INSERT INTO elena_message_template (owner_user_id, kind, voice, body, updated_by) VALUES (NULL, $1, $2, $3, $4::uuid) " +
  "ON CONFLICT (kind) WHERE owner_user_id IS NULL DO UPDATE SET voice = EXCLUDED.voice, body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING id";
export const DELETE_TEMPLATE_SQL = "DELETE FROM elena_message_template WHERE owner_user_id IS NOT DISTINCT FROM $1::uuid AND kind = $2 RETURNING id";

const tpl = (r: Record<string, unknown>): StoredTemplate => ({ id: text(r["id"]), kind: text(r["kind"]) as MessageKind, voice: text(r["voice"]) as Voice, body: text(r["body"]), updatedAt: iso(r["updated_at"]) });

export async function listTemplatesPg(db: Queryable, ownerId: string | null): Promise<StoredTemplate[]> {
  return (await db.query(LIST_TEMPLATES_SQL, [ownerId])).rows.map(tpl);
}
export async function saveTemplatePg(db: Queryable, ownerId: string | null, t: TemplateInput, byUserId: string): Promise<void> {
  if (ownerId) await db.query(UPSERT_OWN_TEMPLATE_SQL, [ownerId, t.kind, t.voice, t.body, byUserId]);
  else await db.query(UPSERT_GLOBAL_TEMPLATE_SQL, [t.kind, t.voice, t.body, byUserId]);
}
/** Resets to the next level down (an agent's own goes back to the platform wording, a platform one back to the built-in). */
export async function resetTemplatePg(db: Queryable, ownerId: string | null, kind: MessageKind): Promise<boolean> {
  return (await db.query(DELETE_TEMPLATE_SQL, [ownerId, kind])).rows.length > 0;
}
/** The built-in wording, so the admin pages can offer "start from". */
export const builtInTemplates = () => DEFAULT_TEMPLATES;

/** True when the user is an approved inspector, the only people Elena drafts for. */
export async function isApprovedInspector(db: Queryable, userId: string): Promise<boolean> {
  return (await db.query("SELECT 1 FROM inspector_profile WHERE user_id = $1::uuid AND status = 'approved'", [userId])).rows.length > 0;
}

// ---- Drafting -------------------------------------------------------------------------------------------------------------------

/** Params: 1 booking. The accepted booking with everything a draft needs. */
export const BOOKING_FOR_DRAFT_SQL =
  "SELECT b.id, b.buyer_id, b.inspector_user_id, b.scheduled_at, b.notes, l.title, l.address_text, l.jurisdiction, " +
  "bu.display_name AS buyer_name, COALESCE(NULLIF(p.business_name, ''), iu.display_name) AS agent_name " +
  "FROM inspection_booking b JOIN property_listing l ON l.id = b.listing_id JOIN app_user bu ON bu.id = b.buyer_id " +
  "JOIN app_user iu ON iu.id = b.inspector_user_id LEFT JOIN inspector_profile p ON p.user_id = b.inspector_user_id " +
  "WHERE b.id = $1::uuid AND b.status = 'scheduled' AND b.scheduled_at IS NOT NULL";
/** Params: 1 author, 2 kind. The agent's own template first, else the platform one. */
export const TEMPLATE_FOR_SQL =
  "SELECT voice, body, owner_user_id FROM elena_message_template WHERE kind = $2 AND (owner_user_id = $1::uuid OR owner_user_id IS NULL)";
/** Params: 1 id, 2 booking, 3 kind, 4 author, 5 recipient, 6 draft, 7 status, 8 due at. A repeat for the same booking and kind does nothing. */
export const INSERT_MESSAGE_SQL =
  "INSERT INTO elena_scheduled_message (id, booking_id, kind, author_user_id, recipient_user_id, draft_body, status, due_at) " +
  "VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8::timestamptz) ON CONFLICT (booking_id, kind) DO NOTHING RETURNING id";

/**
 * Called after an inspector accepts a booking. Drafts the confirmation (offered now) and schedules the 24-hour reminder.
 * Never throws: a failure to draft must not undo the accepted booking. Returns how many drafts were created.
 */
export async function draftBookingMessages(db: Queryable, bookingId: string, now: string = new Date().toISOString(), env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  try {
    const b = (await db.query(BOOKING_FOR_DRAFT_SQL, [bookingId])).rows[0];
    if (!b) return 0;
    const author = text(b["inspector_user_id"]), recipient = text(b["buyer_id"]);
    const when = iso(b["scheduled_at"]);
    const vars = {
      buyer_name: text(b["buyer_name"]).split(" ")[0] ?? "", agent_name: text(b["agent_name"]), property_address: text(b["address_text"]),
      appointment_time: formatAppointment(when, text(b["jurisdiction"]) as Jurisdiction), listing_title: text(b["title"]), buyer_notes: ""
    };
    const notes = text(b["notes"]).trim();
    let created = 0, suggestedNow = false;
    for (const p of planMessages(when, now)) {
      const rows = (await db.query(TEMPLATE_FOR_SQL, [author, p.kind])).rows;
      const own = rows.find(r => r["owner_user_id"] !== null), global = rows.find(r => r["owner_user_id"] === null);
      const chosen = pickTemplate(p.kind, own && { voice: text(own["voice"]) as Voice, body: text(own["body"]) }, global && { voice: text(global["voice"]) as Voice, body: text(global["body"]) });
      // The buyer's own booking note is echoed back only in the confirmation, as a line the agent can edit or drop.
      const draft = renderTemplate(chosen.body, { ...vars, buyer_notes: p.kind === "booking_confirmation" && notes ? `You mentioned: "${notes.slice(0, 300)}"` : "" });
      const msgId = randomUUID();
      const r = await db.query(INSERT_MESSAGE_SQL, [msgId, bookingId, p.kind, author, recipient, draft, p.status, p.dueAt]);
      if (r.rows.length === 1) {
        // The draft's id doubles as the suggestion id, so the weekly sweep can read what the agent did (sent, edited, skipped) from the draft itself.
        await noteSuggestion(db, { id: msgId, feature: "inspection_responder", type: p.kind, userId: author, userRole: "inspector", region: text(b["jurisdiction"]).trim(), source: "ai_draft", context: { kind: p.kind } });
        created++; if (p.status === "suggested") suggestedNow = true; }
    }
    if (suggestedNow) await notifyUser(db, author, "scheduling_suggestion", { title: "Elena drafted a message", text: `A confirmation for ${text(b["title"])} is ready to review.`, link: "/inspector/messages" }, env);
    return created;
  } catch {
    return 0;
  }
}

/**
 * Cron tick (every ~10 minutes, inside the automation job). Reminders whose time has come become suggestions for the agent; drafts for a
 * booking that was cancelled, or whose appointment has started, expire. Returns the counts.
 */
export const EXPIRE_SQL =
  "UPDATE elena_scheduled_message m SET status = 'expired' FROM inspection_booking b WHERE b.id = m.booking_id AND m.status IN ('scheduled', 'suggested') " +
  "AND (b.status <> 'scheduled' OR b.scheduled_at <= $1::timestamptz) RETURNING m.id";
export const PROMOTE_SQL =
  "UPDATE elena_scheduled_message m SET status = 'suggested' WHERE m.status = 'scheduled' AND m.due_at <= $1::timestamptz RETURNING m.author_user_id, m.booking_id, m.kind";
export async function runDueSchedulingMessages(db: Queryable, now: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ expired: number; suggested: number }> {
  const expired = (await db.query(EXPIRE_SQL, [now])).rows.length;
  const promoted = (await db.query(PROMOTE_SQL, [now])).rows;
  for (const r of promoted) {
    await notifyUser(db, text(r["author_user_id"]), "scheduling_suggestion", { title: "Elena drafted a reminder", text: "A reminder for tomorrow's inspection is ready to review.", link: "/inspector/messages" }, env);
  }
  return { expired, suggested: promoted.length };
}

// ---- The agent's queue ----------------------------------------------------------------------------------------------------------

const COLS =
  "m.id, m.booking_id, m.kind, m.status, m.draft_body, m.final_body, m.edited, m.due_at, m.decided_at, l.title, b.scheduled_at " +
  "FROM elena_scheduled_message m JOIN inspection_booking b ON b.id = m.booking_id JOIN property_listing l ON l.id = b.listing_id";
/** Params: 1 author. Waiting for a decision first (oldest due first), then the 30 most recent others. */
export const QUEUE_SQL =
  `SELECT ${COLS} WHERE m.author_user_id = $1::uuid AND m.status = 'suggested' ORDER BY m.due_at, m.id LIMIT 100`;
export const HISTORY_SQL =
  `SELECT ${COLS} WHERE m.author_user_id = $1::uuid AND m.status <> 'suggested' ORDER BY COALESCE(m.decided_at, m.due_at) DESC, m.id LIMIT 30`;

const msg = (r: Record<string, unknown>): ScheduledMessage => ({
  id: text(r["id"]), bookingId: text(r["booking_id"]), kind: text(r["kind"]) as MessageKind, kindLabel: KIND_LABEL[text(r["kind"]) as MessageKind],
  status: text(r["status"]) as ScheduledMessage["status"], listingTitle: text(r["title"]), scheduledAt: iso(r["scheduled_at"]), draftBody: text(r["draft_body"]),
  ...(r["final_body"] ? { finalBody: text(r["final_body"]) } : {}), edited: r["edited"] === true, dueAt: iso(r["due_at"]), ...(r["decided_at"] ? { decidedAt: iso(r["decided_at"]) } : {})
});

export async function queueForAuthor(db: Queryable, authorId: string): Promise<{ suggestions: ScheduledMessage[]; history: ScheduledMessage[] }> {
  const [q, h] = await Promise.all([db.query(QUEUE_SQL, [authorId]), db.query(HISTORY_SQL, [authorId])]);
  return { suggestions: q.rows.map(msg), history: h.rows.map(msg) };
}

/** Params: 1 id, 2 author. */
export const GET_DRAFT_SQL = "SELECT m.draft_body, m.recipient_user_id, l.title, COALESCE(NULLIF(p.business_name, ''), u.display_name) AS agent_name FROM elena_scheduled_message m " +
  "JOIN inspection_booking b ON b.id = m.booking_id JOIN property_listing l ON l.id = b.listing_id JOIN app_user u ON u.id = m.author_user_id LEFT JOIN inspector_profile p ON p.user_id = m.author_user_id " +
  "WHERE m.id = $1::uuid AND m.author_user_id = $2::uuid AND m.status = 'suggested'";
/**
 * Params: 1 id, 2 author, 3 new status, 4 final body (null when skipped), 5 edited, 6 at, 7..11 audit (id, at, type, correlation, payload).
 * Only the author, only while the draft is still waiting, and only while the booking is still scheduled. One statement, with its audit row.
 */
export const DECIDE_SQL =
  "WITH done AS (UPDATE elena_scheduled_message m SET status = $3, final_body = $4::text, edited = $5::boolean, decided_at = $6::timestamptz FROM inspection_booking b " +
  "WHERE m.id = $1::uuid AND m.author_user_id = $2::uuid AND m.status = 'suggested' AND b.id = m.booking_id AND b.status = 'scheduled' RETURNING m.id::text AS aggregate_id) " +
  "INSERT INTO audit_event (id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload) " +
  "SELECT $7::uuid, $8::timestamptz, 'user', $2::text, 'elena_scheduled_message', done.aggregate_id, $9::text, $10::text, $11::jsonb FROM done RETURNING aggregate_id";

export type DecideResult = { ok: true; sent: boolean } | { ok: false; code: "not_found" | "invalid"; message: string };

/** Send (as drafted or edited) or skip. Sending delivers the text to the buyer in the app; the draft and final text are both kept. */
export async function decideMessage(
  db: Queryable, authorId: string, id: string, input: unknown, now: string = new Date().toISOString(), env: Readonly<Record<string, string | undefined>> = process.env
): Promise<DecideResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { ok: false, code: "not_found", message: "Not found." };
  const draft = (await db.query(GET_DRAFT_SQL, [id, authorId])).rows[0];
  if (!draft) return { ok: false, code: "not_found", message: "This draft is no longer waiting." };
  const d = parseDecision(input, text(draft["draft_body"]));
  if (!d.ok) return { ok: false, code: "invalid", message: d.error };
  const sent = d.action === "send";
  const payload = { sent, edited: sent && d.edited };
  const r = await db.query(DECIDE_SQL, [id, authorId, sent ? "sent" : "skipped", sent ? d.body : null, sent && d.edited, now, randomUUID(), now, sent ? "elena_message.sent" : "elena_message.skipped", randomUUID(), JSON.stringify(payload)]);
  if (r.rows.length !== 1) return { ok: false, code: "not_found", message: "This draft is no longer waiting." };
  if (sent) await notifyUser(db, text(draft["recipient_user_id"]), "scheduling_message", { title: `Message from ${text(draft["agent_name"])} about ${text(draft["title"])}`.slice(0, 80), text: d.body, link: "/inspections" }, env);
  return { ok: true, sent };
}

export { MESSAGE_KINDS };
