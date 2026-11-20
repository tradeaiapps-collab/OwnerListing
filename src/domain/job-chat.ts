export type AssignmentStatus = "proposed" | "approved" | "completed" | "cancelled";

export interface JobAssignment {
  id: string;
  listingId: string;
  ownerUserId: string;
  contractorUserId: string;
  kind: "photographer" | "solicitor" | "inspector" | "agent" | "pest_control" | "other";
  status: AssignmentStatus;
  /** Public job number (5001 and up), assigned by the database on insert. Shown as JOB-5001. */
  jobNumber?: number;
  /** The contractor's own displayed price for the chosen service, copied at booking so later edits never change an old job. */
  serviceName?: string;
  priceCents?: number;
  note?: string;
  requestedTime?: string;
  offerSource?: "owner" | "elena";
}

export interface ChatMessage {
  id: string;
  assignmentId: string;
  senderId: string;
  body: string;
  sentAt: string;
  attachmentRefs: readonly string[];
}

const MAX_BODY = 5000;

/** A chat exists once the assignment is approved, and stays readable after the job ends. */
export function chatExists(a: JobAssignment): boolean {
  return a.status === "approved" || a.status === "completed" || a.status === "cancelled";
}

export function isParticipant(a: JobAssignment, userId: string): boolean {
  return userId === a.ownerUserId || userId === a.contractorUserId;
}

/**
 * Appends a message. There is deliberately no edit or delete function: the conversation is a
 * permanent record. New messages are only accepted while the assignment is approved.
 */
export function appendChatMessage(
  a: JobAssignment,
  existing: readonly ChatMessage[],
  msg: ChatMessage
): readonly ChatMessage[] {
  if (a.status !== "approved") throw new Error("Chat is open only while the assignment is approved.");
  if (msg.assignmentId !== a.id) throw new Error("Message does not belong to this assignment.");
  if (!isParticipant(a, msg.senderId)) throw new Error("Only the owner and the assigned contractor can post.");
  const body = msg.body.trim();
  if (!body) throw new Error("Message is empty.");
  if (body.length > MAX_BODY) throw new Error("Message is too long.");
  if (existing.some(m => m.id === msg.id)) throw new Error("Duplicate message id.");
  return [...existing, { ...msg, body, attachmentRefs: [...msg.attachmentRefs] }];
}

/** Only the two parties can read their chat. Dispute access by staff must go through an audited process. */
export function canReadChat(a: JobAssignment, userId: string): boolean {
  return chatExists(a) && isParticipant(a, userId);
}
