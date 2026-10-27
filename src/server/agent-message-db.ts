import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentMessageRepository } from "../domain/agent-messages";
import { getDb } from "./context";
import type { Queryable } from "./db";

// Constant SQL text; user input only travels as bound parameters. Nothing here updates or deletes a message.

const text = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export const GET_APPOINTMENT_SQL =
  "SELECT a.id, a.listing_id, l.owner_user_id, a.agent_user_id, a.scope, a.appointed_at, a.revoked_at, l.title, " +
  "o.display_name AS owner_name, g.display_name AS agent_name " +
  "FROM listing_agent_appointment a JOIN property_listing l ON l.id = a.listing_id " +
  "JOIN app_user o ON o.id = l.owner_user_id JOIN app_user g ON g.id = a.agent_user_id WHERE a.id = $1::uuid";
/** Params: 1 appointment, 2 limit. Newest first here; reversed in code. */
export const LIST_SQL =
  "SELECT id, appointment_id, sender_user_id, body, sent_at FROM agent_message WHERE appointment_id = $1::uuid ORDER BY sent_at DESC, id DESC LIMIT $2::int";
/** Params: 1 id, 2 appointment, 3 sender, 4 body, 5 sent at. Inserts only while active and only for the listing owner or the agent. */
export const INSERT_SQL =
  "INSERT INTO agent_message (id, appointment_id, sender_user_id, body, sent_at) " +
  "SELECT $1::uuid, a.id, $3::uuid, $4::text, $5::timestamptz FROM listing_agent_appointment a JOIN property_listing l ON l.id = a.listing_id " +
  "WHERE a.id = $2::uuid AND a.revoked_at IS NULL AND $3::uuid IN (l.owner_user_id, a.agent_user_id) RETURNING id";

export function createPgAgentMessageRepository(db: Queryable): AgentMessageRepository {
  return {
    async getAppointment(id) {
      const r = (await db.query(GET_APPOINTMENT_SQL, [id])).rows[0];
      if (!r) return undefined;
      return {
        id: text(r["id"]), listingId: text(r["listing_id"]), ownerUserId: text(r["owner_user_id"]), agentUserId: text(r["agent_user_id"]),
        scope: r["scope"] === "full" ? "full" : "enquiries_and_offers", appointedAt: iso(r["appointed_at"]),
        ...(r["revoked_at"] !== null && r["revoked_at"] !== undefined ? { revokedAt: iso(r["revoked_at"]) } : {}),
        listingTitle: text(r["title"]), ownerName: text(r["owner_name"]), agentName: text(r["agent_name"])
      };
    },
    async listMessages(appointmentId, limit) {
      const { rows } = await db.query(LIST_SQL, [appointmentId, limit]);
      return rows.reverse().map((r): AgentMessage => ({
        id: text(r["id"]), appointmentId: text(r["appointment_id"]), senderUserId: text(r["sender_user_id"]), body: text(r["body"]), sentAt: iso(r["sent_at"])
      }));
    },
    async insertMessage(m) {
      const { rows } = await db.query(INSERT_SQL, [m.id, m.appointmentId, m.senderUserId, m.body, m.sentAt]);
      return rows.length === 1;
    }
  };
}

export const getAgentMessageRepo = () => createPgAgentMessageRepository(getDb());
export const agentMessageIds = { newId: () => randomUUID(), now: () => new Date().toISOString() };
