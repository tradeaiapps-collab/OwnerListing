import type { AppointmentRecord } from "./agent-appointment-service";
import type { Actor, Result } from "./listing-service";

export const AGENT_MESSAGE_PAGE_SIZE = 200;
const MAX_BODY = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AgentMessage {
  id: string;
  appointmentId: string;
  senderUserId: string;
  body: string;
  sentAt: string;
}

/** A conversation as its reader sees it. `mine` marks the reader's own messages; email addresses are never returned. */
export interface AgentConversation {
  appointmentId: string;
  listingId: string;
  listingTitle: string;
  counterpartName: string;
  /** False once the appointment is revoked: the owner can still read, nobody can write. */
  open: boolean;
  messages: (AgentMessage & { mine: boolean })[];
}

/**
 * Storage for owner-agent messages. There is deliberately no update or delete method: messages are a permanent
 * record (CLAUDE.md) and the database rejects UPDATE and DELETE (db/20261025200000 trigger).
 */
export interface AgentMessageRepository {
  getAppointment(id: string): Promise<(AppointmentRecord & { listingTitle: string; ownerName: string; agentName: string }) | undefined>;
  /** Newest `limit` messages, oldest first. */
  listMessages(appointmentId: string, limit: number): Promise<AgentMessage[]>;
  /** Inserts only while the appointment is active and the sender is its owner or agent. False when refused. */
  insertMessage(msg: AgentMessage): Promise<boolean>;
}

const notFound = { ok: false, code: "not_found", message: "Conversation not found." } as const;
const closed = { ok: false, code: "conflict", message: "This appointment has ended. Past messages stay readable for the owner." } as const;

/**
 * The owner can always read the conversation for their listing's appointments. The agent can read only while the
 * appointment is active: revoking ends their access at once. Everyone else gets not_found.
 */
export async function readAgentConversation(repo: AgentMessageRepository, actor: Actor, appointmentId: string): Promise<Result<AgentConversation>> {
  if (!UUID.test(appointmentId)) return notFound;
  const a = await repo.getAppointment(appointmentId);
  const isOwner = !!a && a.ownerUserId === actor.userId;
  const isAgent = !!a && a.agentUserId === actor.userId && !a.revokedAt;
  if (!a || (!isOwner && !isAgent)) return notFound;
  const messages = await repo.listMessages(a.id, AGENT_MESSAGE_PAGE_SIZE);
  return {
    ok: true,
    value: {
      appointmentId: a.id, listingId: a.listingId, listingTitle: a.listingTitle,
      counterpartName: isOwner ? a.agentName : a.ownerName, open: !a.revokedAt,
      messages: messages.map(m => ({ ...m, mine: m.senderUserId === actor.userId }))
    }
  };
}

export async function sendAgentMessage(
  repo: AgentMessageRepository, actor: Actor, appointmentId: string, input: unknown, ids: { newId: () => string; now: () => string }
): Promise<Result<AgentMessage>> {
  if (!UUID.test(appointmentId)) return notFound;
  const a = await repo.getAppointment(appointmentId);
  const isOwner = !!a && a.ownerUserId === actor.userId;
  const isAgent = !!a && a.agentUserId === actor.userId && !a.revokedAt;
  if (!a || (!isOwner && !isAgent)) return notFound;
  if (a.revokedAt) return closed;

  if (typeof input !== "object" || input === null) return { ok: false, code: "invalid", message: "Send a JSON object with a body." };
  const raw = (input as Record<string, unknown>)["body"];
  if (typeof raw !== "string") return { ok: false, code: "invalid", message: "Message body is required." };
  const body = raw.trim();
  if (!body) return { ok: false, code: "invalid", message: "Message is empty." };
  if (body.length > MAX_BODY) return { ok: false, code: "invalid", message: "Message is too long." };

  const msg: AgentMessage = { id: ids.newId(), appointmentId: a.id, senderUserId: actor.userId, body, sentAt: ids.now() };
  // The repository re-checks "active" and "party" inside the INSERT, so a revoke between the read and the write cannot slip a message in.
  return (await repo.insertMessage(msg)) ? { ok: true, value: msg } : closed;
}

export function createInMemoryAgentMessageRepository(
  appointments: (AppointmentRecord & { listingTitle?: string; ownerName?: string; agentName?: string })[] = []
): AgentMessageRepository & { messages: AgentMessage[] } {
  const messages: AgentMessage[] = [];
  return {
    messages,
    async getAppointment(id) {
      const a = appointments.find(x => x.id === id);
      return a ? { ...a, listingTitle: a.listingTitle ?? "Listing", ownerName: a.ownerName ?? "Owner", agentName: a.agentName ?? "Agent" } : undefined;
    },
    async listMessages(appointmentId, limit) { return messages.filter(m => m.appointmentId === appointmentId).slice(-limit); },
    async insertMessage(msg) {
      const a = appointments.find(x => x.id === msg.appointmentId);
      if (!a || a.revokedAt || (msg.senderUserId !== a.ownerUserId && msg.senderUserId !== a.agentUserId)) return false;
      messages.push({ ...msg });
      return true;
    }
  };
}
