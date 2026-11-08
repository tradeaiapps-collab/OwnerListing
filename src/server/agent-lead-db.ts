import { randomUUID } from "node:crypto";
import { followupAt, followupDue, followupText, isLeadStatus, leadTone, parseLost, parseNoteText, MAX_NOTES, type LeadNote, type LeadStatus, type LeadTone, type LostReason } from "../domain/agent-leads";
import type { Queryable } from "./db";
import { notifyUser } from "./notifier";

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : new Date(String(v)).toISOString());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Res<T> = { ok: true; value: T } | { ok: false; error: string; notFound?: boolean };
const NOT_FOUND = { ok: false as const, error: "Lead not found.", notFound: true };

export interface LeadCard {
  id: string; listingId: string; listingTitle: string; buyerName: string; enquiryId: string | null; status: LeadStatus; tone: LeadTone;
  lostReason: LostReason | null; createdAt: string; lastInteractionAt: string; nextFollowupAt: string | null; followupNote: string; followupDue: boolean;
  firstResponseAt: string | null; awaitingReply: boolean; lastInteraction: string;
}
export interface LeadInteractionRow { id: string; type: string; actor: string; description: string; createdAt: string }
export interface LeadDetail extends LeadCard { lostNote: string; notes: LeadNote[]; interactions: LeadInteractionRow[]; convertedOfferId: string | null }

/**
 * A lead is the agent's only while they still hold an active appointment on the listing that allows enquiries; after a revoke it disappears from
 * their screens (the record stays). `$1` is the agent's user id.
 */
const VISIBLE =
  "FROM agent_lead a JOIN property_listing l ON l.id = a.listing_id JOIN app_user b ON b.id = a.buyer_id " +
  "LEFT JOIN enquiry e ON e.listing_id = a.listing_id AND e.buyer_user_id = a.buyer_id " +
  "WHERE a.agent_id = $1::uuid AND EXISTS (SELECT 1 FROM listing_agent_appointment p WHERE p.listing_id = a.listing_id AND p.agent_user_id = a.agent_id " +
  "AND p.revoked_at IS NULL AND (p.permissions IS NULL OR 'enquiries.handle' = ANY(p.permissions)))";
const COLUMNS =
  "a.id, a.listing_id, l.title AS listing_title, b.display_name AS buyer_name, e.id AS enquiry_id, a.status, a.lost_reason, a.lost_note, a.created_at, a.last_interaction_at, " +
  "a.last_buyer_at, a.last_agent_at, a.first_response_at, a.next_followup_at, a.followup_note, a.notes, a.converted_offer_id, " +
  "(SELECT i.description FROM lead_interaction i WHERE i.lead_id = a.id ORDER BY i.created_at DESC, i.id LIMIT 1) AS last_interaction";

function card(r: Record<string, unknown>, now: string): LeadCard {
  const status = String(r["status"]) as LeadStatus;
  const timing = { status, firstResponseAt: iso(r["first_response_at"]), lastBuyerAt: iso(r["last_buyer_at"])!, lastAgentAt: iso(r["last_agent_at"]), nextFollowupAt: iso(r["next_followup_at"]) };
  const tone = leadTone(timing, now);
  return {
    id: String(r["id"]), listingId: String(r["listing_id"]), listingTitle: String(r["listing_title"]), buyerName: String(r["buyer_name"]),
    enquiryId: r["enquiry_id"] ? String(r["enquiry_id"]) : null, status, tone, lostReason: r["lost_reason"] ? (String(r["lost_reason"]) as LostReason) : null,
    createdAt: iso(r["created_at"])!, lastInteractionAt: iso(r["last_interaction_at"])!, nextFollowupAt: timing.nextFollowupAt, followupNote: String(r["followup_note"] ?? ""),
    followupDue: followupDue(timing, now),
    firstResponseAt: timing.firstResponseAt, awaitingReply: timing.lastAgentAt === null || Date.parse(timing.lastBuyerAt) > Date.parse(timing.lastAgentAt),
    lastInteraction: String(r["last_interaction"] ?? "")
  };
}

/** The agent's leads, most urgent first. `status` filters; `listingId` narrows to one listing. */
export async function listAgentLeads(db: Queryable, agentId: string, now: string, f: { status?: LeadStatus; listingId?: string } = {}): Promise<LeadCard[]> {
  const params: unknown[] = [agentId];
  let where = "";
  if (f.status) { params.push(f.status); where += ` AND a.status = $${params.length}::text`; }
  else where += " AND a.status NOT IN ('lost','converted')";
  if (f.listingId && UUID.test(f.listingId)) { params.push(f.listingId); where += ` AND a.listing_id = $${params.length}::uuid`; }
  const rows = (await db.query(`SELECT ${COLUMNS} ${VISIBLE}${where} ORDER BY a.last_interaction_at ASC, a.id LIMIT 500`, params)).rows;
  const order = { red: 0, yellow: 1, green: 2, closed: 3 } as const;
  return rows.map(r => card(r, now)).sort((x, y) => order[x.tone] - order[y.tone] || Date.parse(x.lastInteractionAt) - Date.parse(y.lastInteractionAt));
}

export async function getAgentLead(db: Queryable, agentId: string, id: string, now: string): Promise<LeadDetail | undefined> {
  if (!UUID.test(id)) return undefined;
  const r = (await db.query(`SELECT ${COLUMNS} ${VISIBLE} AND a.id = $2::uuid`, [agentId, id])).rows[0];
  if (!r) return undefined;
  const interactions = (await db.query("SELECT id, interaction_type, actor, description, created_at FROM lead_interaction WHERE lead_id = $1::uuid ORDER BY created_at DESC, id LIMIT 200", [id])).rows
    .map(i => ({ id: String(i["id"]), type: String(i["interaction_type"]), actor: String(i["actor"]), description: String(i["description"]), createdAt: iso(i["created_at"])! }));
  return { ...card(r, now), lostNote: String(r["lost_note"] ?? ""), notes: (r["notes"] as LeadNote[]) ?? [], interactions, convertedOfferId: r["converted_offer_id"] ? String(r["converted_offer_id"]) : null };
}

async function owned(db: Queryable, agentId: string, id: string): Promise<boolean> {
  return UUID.test(id) && (await db.query(`SELECT 1 ${VISIBLE} AND a.id = $2::uuid`, [agentId, id])).rows.length > 0;
}
async function log(db: Queryable, leadId: string, type: string, description: string): Promise<void> {
  await db.query("INSERT INTO lead_interaction (lead_id, interaction_type, actor, description) VALUES ($1::uuid,$2,'agent',$3)", [leadId, type, description]);
}

export async function addLeadNote(db: Queryable, agentId: string, id: string, text: unknown, now: string): Promise<Res<LeadNote>> {
  const p = parseNoteText(text);
  if (!p.ok) return p;
  if (!(await owned(db, agentId, id))) return NOT_FOUND;
  const note: LeadNote = { id: randomUUID(), at: now, by: agentId, text: p.text };
  const r = await db.query(
    "UPDATE agent_lead SET notes = notes || $3::jsonb WHERE id = $1::uuid AND agent_id = $2::uuid AND jsonb_array_length(notes) < $4::int RETURNING id",
    [id, agentId, JSON.stringify([note]), MAX_NOTES]);
  return r.rows.length > 0 ? { ok: true, value: note } : { ok: false, error: `A lead can hold ${MAX_NOTES} notes.` };
}

/** "Remind me in N days" (or clear with days = null). Replaces any earlier reminder and re-arms the notification. */
export async function scheduleFollowup(db: Queryable, agentId: string, id: string, days: unknown, note: unknown, now: string): Promise<Res<{ nextFollowupAt: string | null }>> {
  if (!(await owned(db, agentId, id))) return NOT_FOUND;
  const text = typeof note === "string" ? note.trim().slice(0, 300) : "";
  if (days === null) {
    await db.query("UPDATE agent_lead SET next_followup_at = NULL, followup_note = '', followup_notified_at = NULL WHERE id = $1::uuid", [id]);
    return { ok: true, value: { nextFollowupAt: null } };
  }
  const at = typeof days === "number" ? followupAt(now, days) : undefined;
  if (!at) return { ok: false, error: "Choose 1, 2, 3, 7 or 14 days." };
  await db.query("UPDATE agent_lead SET next_followup_at = $2::timestamptz, followup_note = $3, followup_notified_at = NULL WHERE id = $1::uuid AND status NOT IN ('lost','converted')", [id, at, text]);
  await log(db, id, "message", `Follow-up set for ${at.slice(0, 10)}`);
  return { ok: true, value: { nextFollowupAt: at } };
}

/** Marks the lead lost (with a reason) or back to an open status. Converted comes from an accepted offer, never from a click. */
export async function setLeadStatus(db: Queryable, agentId: string, id: string, status: unknown, reason: unknown, note: unknown): Promise<Res<true>> {
  if (!isLeadStatus(status) || status === "converted") return { ok: false, error: "Unknown status." };
  if (!(await owned(db, agentId, id))) return NOT_FOUND;
  if (status === "lost") {
    const p = parseLost(reason, note);
    if (!p.ok) return p;
    const r = await db.query("UPDATE agent_lead SET status = 'lost', lost_reason = $2, lost_note = $3, next_followup_at = NULL, last_agent_at = COALESCE(last_agent_at, now()) WHERE id = $1::uuid AND status <> 'converted' RETURNING id", [id, p.reason, p.note]);
    if (r.rows.length === 0) return { ok: false, error: "A converted lead cannot be marked lost." };
    await log(db, id, "message", `Marked lost: ${p.reason}${p.note ? ` (${p.note})` : ""}`);
    return { ok: true, value: true };
  }
  const r = await db.query("UPDATE agent_lead SET status = $2, lost_reason = NULL, lost_note = '' WHERE id = $1::uuid AND status <> 'converted' RETURNING id", [id, status]);
  if (r.rows.length === 0) return { ok: false, error: "A converted lead cannot be changed." };
  await log(db, id, "message", `Status set to ${status.replace("_", " ")}`);
  return { ok: true, value: true };
}

/**
 * Sends each due reminder once (in-app, plus email/push/SMS per the agent's own notification settings) and records that it went.
 * Claims the row first so two overlapping ticks cannot both send. Returns how many agents were told.
 */
export async function sendDueLeadReminders(db: Queryable, now: string, limit = 200): Promise<number> {
  const rows = (await db.query(
    `UPDATE agent_lead a SET followup_notified_at = $1::timestamptz
      WHERE a.id IN (SELECT x.id FROM agent_lead x WHERE x.next_followup_at <= $1::timestamptz AND x.followup_notified_at IS NULL AND x.status NOT IN ('lost','converted')
        AND EXISTS (SELECT 1 FROM listing_agent_appointment p WHERE p.listing_id = x.listing_id AND p.agent_user_id = x.agent_id AND p.revoked_at IS NULL)
        ORDER BY x.next_followup_at LIMIT $2::int FOR UPDATE SKIP LOCKED)
      RETURNING a.id, a.agent_id, a.followup_note, (SELECT display_name FROM app_user WHERE id = a.buyer_id) AS buyer_name,
        (SELECT title FROM property_listing WHERE id = a.listing_id) AS listing_title`, [now, limit])).rows;
  for (const r of rows) {
    await notifyUser(db, String(r["agent_id"]), "lead_followup_due", {
      name: String(r["buyer_name"]), listing: String(r["listing_title"]), text: followupText(String(r["buyer_name"]), String(r["listing_title"]), String(r["followup_note"] ?? "")), link: `/agent/leads/${String(r["id"])}`
    });
  }
  return rows.length;
}
