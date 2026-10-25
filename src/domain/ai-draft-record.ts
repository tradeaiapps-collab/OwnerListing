import type { DraftProvenance } from "./ai-pipeline";
import type { DraftGuardResult } from "./ai-output-guard";
import type { OfferPolicyDecision } from "./offers";
import type { Risk, SafetyFlag } from "./message-safety";

/** A stored AI draft (db ai_draft). The text and provenance never change; the status moves once to a final state. */
export type AiDraftKind = "enquiry_reply" | "offer_response";
export type AiDraftStatus = "pending" | "sent" | "edited_sent" | "discarded" | "held";
export type AiDraftAction = "draft_reply" | "request_information" | "recommend_counter" | "reject";
export type EnquiryIntent = "availability" | "inspection" | "price" | "documents" | "offer" | "complaint" | "other";

export interface AiDraftRecord extends DraftProvenance {
  id: string;
  kind: AiDraftKind;
  listingId: string;
  enquiryId?: string;
  offerId?: string;
  action?: AiDraftAction;
  intent?: EnquiryIntent;
  text: string;
  policyDecision: OfferPolicyDecision;
  guardResult: DraftGuardResult;
  status: AiDraftStatus;
  createdBy: string;
  createdAt: string;
}

export interface AiDraftRepository {
  insert(d: AiDraftRecord): Promise<void>;
  get(id: string): Promise<AiDraftRecord | undefined>;
  /** Moves a pending or held draft to a final status in one guarded step. False when it was already final. */
  finish(id: string, to: "sent" | "edited_sent" | "discarded", by: string, at: string, sentMessageId?: string): Promise<boolean>;
}

export interface StoredSafetyFlag {
  id: string;
  enquiryId: string;
  messageId: string;
  risk: Exclude<Risk, "none">;
  flags: SafetyFlag[];
  handoff: boolean;
  staffReview: boolean;
  createdAt: string;
  reviewOutcome?: "confirmed" | "dismissed";
}

export function createInMemoryAiDraftRepository(): AiDraftRepository & { rows: (AiDraftRecord & { sentMessageId?: string })[] } {
  const rows: (AiDraftRecord & { sentMessageId?: string })[] = [];
  return {
    rows,
    async insert(d) { rows.push(structuredClone(d)); },
    async get(id) { const d = rows.find(r => r.id === id); return d ? structuredClone(d) : undefined; },
    async finish(id, to, _by, _at, sentMessageId) {
      const d = rows.find(r => r.id === id);
      if (!d || (d.status !== "pending" && d.status !== "held")) return false;
      d.status = to;
      if (sentMessageId) d.sentMessageId = sentMessageId;
      return true;
    }
  };
}
