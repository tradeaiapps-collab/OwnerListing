import { randomUUID } from "node:crypto";
import type { ChatRepository } from "../domain/job-chat-service";
import type { AssignmentStatus, ChatMessage, JobAssignment } from "../domain/job-chat";
import { getDb } from "./context";
import type { Queryable } from "./db";

// Every statement has constant text; user input only ever travels as a bound parameter.
// There is no UPDATE or DELETE on chat_message anywhere: it is an append-only record.
export const ASSIGNMENT_SQL =
  "SELECT id, listing_id, owner_user_id, contractor_user_id, kind, status FROM job_assignment WHERE id = $1::uuid";

export const LIST_MESSAGES_SQL =
  "SELECT id, assignment_id, sender_id, body, sent_at, attachment_refs FROM (" +
  "SELECT id, assignment_id, sender_id, body, sent_at, attachment_refs FROM chat_message " +
  "WHERE assignment_id = $1::uuid ORDER BY sent_at DESC, id DESC LIMIT $2) newest ORDER BY sent_at, id";

/** Inserts only if the assignment is approved and the sender is its owner or contractor. */
export const INSERT_MESSAGE_SQL =
  "INSERT INTO chat_message (id, assignment_id, sender_id, body, attachment_refs, sent_at) " +
  "SELECT $1::uuid, a.id, $3::uuid, $4, '[]'::jsonb, $5::timestamptz FROM job_assignment a " +
  "WHERE a.id = $2::uuid AND a.status = 'approved' AND $3::uuid IN (a.owner_user_id, a.contractor_user_id) " +
  "RETURNING id";

const text = (v: unknown) => String(v);

export function createPgChatRepository(db: Queryable): ChatRepository {
  return {
    async getAssignment(id) {
      const { rows } = await db.query(ASSIGNMENT_SQL, [id]);
      const r = rows[0];
      if (!r) return undefined;
      return {
        id: text(r["id"]),
        listingId: text(r["listing_id"]),
        ownerUserId: text(r["owner_user_id"]),
        contractorUserId: text(r["contractor_user_id"]),
        kind: text(r["kind"]) as JobAssignment["kind"],
        status: text(r["status"]) as AssignmentStatus
      };
    },
    async listMessages(assignmentId, limit) {
      const { rows } = await db.query(LIST_MESSAGES_SQL, [assignmentId, limit]);
      return rows.map(r => {
        const sentAt = r["sent_at"];
        const refs = r["attachment_refs"];
        return {
          id: text(r["id"]),
          assignmentId: text(r["assignment_id"]),
          senderId: text(r["sender_id"]),
          body: text(r["body"]),
          sentAt: sentAt instanceof Date ? sentAt.toISOString() : text(sentAt),
          attachmentRefs: Array.isArray(refs) ? refs.map(text) : []
        };
      });
    },
    async insertMessage(msg: ChatMessage) {
      const { rows } = await db.query(INSERT_MESSAGE_SQL, [msg.id, msg.assignmentId, msg.senderId, msg.body, msg.sentAt]);
      return rows.length === 1;
    }
  };
}

/** Wired from the shared pool in context.ts, so that file stays untouched. */
export const getChatRepo = () => createPgChatRepository(getDb());
export const chatIds = { newId: () => randomUUID(), now: () => new Date().toISOString() };
