import { canReadChat, chatExists, isParticipant, type ChatMessage, type JobAssignment } from "./job-chat";
import type { Actor, Result } from "./listing-service";

export const CHAT_PAGE_SIZE = 200;
const MAX_BODY = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Storage for job chat. There is deliberately no update or delete method: the conversation is a
 * permanent record (CLAUDE.md), and the database also rejects UPDATE and DELETE (db/007 trigger).
 */
export interface ChatRepository {
  getAssignment(id: string): Promise<JobAssignment | undefined>;
  /** Newest `limit` messages, returned oldest first. */
  listMessages(assignmentId: string, limit: number): Promise<ChatMessage[]>;
  /** Inserts only while the assignment is approved and the sender is a party to it. False when refused. */
  insertMessage(msg: ChatMessage): Promise<boolean>;
}

const notFound = { ok: false, code: "not_found", message: "Chat not found." } as const;

/** Non-parties and malformed ids get the same not_found, so existence is never revealed. */
export async function readChat(repo: ChatRepository, actor: Actor, assignmentId: string): Promise<Result<ChatMessage[]>> {
  if (!UUID.test(assignmentId)) return notFound;
  const a = await repo.getAssignment(assignmentId);
  if (!a || !canReadChat(a, actor.userId)) return notFound;
  return { ok: true, value: await repo.listMessages(a.id, CHAT_PAGE_SIZE) };
}

export async function postChatMessage(
  repo: ChatRepository,
  actor: Actor,
  assignmentId: string,
  input: unknown,
  ids: { newId: () => string; now: () => string }
): Promise<Result<ChatMessage>> {
  if (!UUID.test(assignmentId)) return notFound;
  const a = await repo.getAssignment(assignmentId);
  if (!a || !chatExists(a) || !isParticipant(a, actor.userId)) return notFound;
  if (a.status !== "approved") return { ok: false, code: "conflict", message: "This chat is closed. Past messages stay readable." };

  if (typeof input !== "object" || input === null) return { ok: false, code: "invalid", message: "Send a JSON object with a body." };
  const raw = (input as Record<string, unknown>)["body"];
  if (typeof raw !== "string") return { ok: false, code: "invalid", message: "Message body is required." };
  const body = raw.trim();
  if (!body) return { ok: false, code: "invalid", message: "Message is empty." };
  if (body.length > MAX_BODY) return { ok: false, code: "invalid", message: "Message is too long." };
  // Attachment storage is not built yet (file upload needs its own security review).
  const refs = (input as Record<string, unknown>)["attachmentRefs"];
  if (refs !== undefined && !(Array.isArray(refs) && refs.length === 0)) {
    return { ok: false, code: "invalid", message: "Attachments are not supported yet." };
  }

  const msg: ChatMessage = { id: ids.newId(), assignmentId: a.id, senderId: actor.userId, body, sentAt: ids.now(), attachmentRefs: [] };
  // The repository re-checks "approved" and "party" inside the INSERT, so a status change between
  // the read above and the write cannot slip a message through.
  const stored = await repo.insertMessage(msg);
  return stored ? { ok: true, value: msg } : { ok: false, code: "conflict", message: "This chat is closed. Past messages stay readable." };
}

export function createInMemoryChatRepository(assignments: JobAssignment[] = []): ChatRepository & { messages: ChatMessage[] } {
  const messages: ChatMessage[] = [];
  return {
    messages,
    async getAssignment(id) { return assignments.find(a => a.id === id); },
    async listMessages(assignmentId, limit) {
      return messages.filter(m => m.assignmentId === assignmentId).slice(-limit);
    },
    async insertMessage(msg) {
      const a = assignments.find(x => x.id === msg.assignmentId);
      if (!a || a.status !== "approved" || !isParticipant(a, msg.senderId)) return false;
      messages.push(msg);
      return true;
    }
  };
}
