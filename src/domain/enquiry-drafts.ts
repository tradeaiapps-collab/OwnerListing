import { decideAutoReply, type AutoReplySettings } from "./auto-reply";
import { looksLikeOffer } from "./offer-intake";
import type { OfferPolicyDecision } from "./offers";

/**
 * AI auto-reply PREVIEW. The AI engine is off until installed, and nothing here sends a message: a routine reply
 * from an owner-approved template is only queued as a draft that waits for the owner's review window.
 * The owner can read, discard or send it; the pause switch stops new drafts.
 */
export interface ReplyTemplate { id: string; ownerUserId: string; body: string }
export type DraftStatus = "queued" | "cancelled" | "sent_by_owner";
export interface ReplyDraft {
  id: string; enquiryId: string; templateId: string; body: string; reviewUntil: string; status: DraftStatus; createdAt: string;
}

export const DEFAULT_AUTO_REPLY: AutoReplySettings = { enabled: false, paused: false, reviewWindowMinutes: 30 };

export interface DraftRepository {
  getSettings(ownerUserId: string): Promise<AutoReplySettings>;
  saveSettings(ownerUserId: string, s: AutoReplySettings): Promise<void>;
  addTemplate(t: ReplyTemplate, approvedAt: string): Promise<void>;
  /** The owner's oldest approved template, if any. */
  approvedTemplate(ownerUserId: string): Promise<ReplyTemplate | undefined>;
  /** False when the thread already has a queued draft. */
  insertDraft(d: ReplyDraft): Promise<boolean>;
  get(id: string): Promise<ReplyDraft | undefined>;
  /** Queued drafts for threads on the owner's listings, oldest first. */
  listQueued(ownerUserId: string): Promise<ReplyDraft[]>;
  /** Moves queued to the new status in one guarded step. False when it was no longer queued. */
  finish(id: string, to: Exclude<DraftStatus, "queued">): Promise<boolean>;
}

/** Routine reply to a buyer's message. Offer-like messages are never answered from a template. */
export async function queueReplyDraft(
  repo: DraftRepository, ownerUserId: string, enquiryId: string, buyerText: string, now: string, newId: () => string
): Promise<ReplyDraft | undefined> {
  if (looksLikeOffer(buyerText)) return undefined;
  const template = await repo.approvedTemplate(ownerUserId);
  if (!template) return undefined;
  const routine: OfferPolicyDecision = { mayDraft: true, requiresHumanApproval: true, withinMandate: true, reason: "Routine enquiry reply." };
  const decision = decideAutoReply("draft_reply", routine, await repo.getSettings(ownerUserId), true, now);
  if (decision.kind !== "send_after") return undefined;
  const draft: ReplyDraft = {
    id: newId(), enquiryId, templateId: template.id, body: template.body, reviewUntil: decision.sendAfter, status: "queued", createdAt: now
  };
  return (await repo.insertDraft(draft)) ? draft : undefined;
}

export function createInMemoryDraftRepository(ownerOf: (enquiryId: string) => string | undefined = () => undefined): DraftRepository & { drafts: ReplyDraft[] } {
  const settings = new Map<string, AutoReplySettings>();
  const templates: ReplyTemplate[] = [];
  const drafts: ReplyDraft[] = [];
  return {
    drafts,
    async getSettings(o) { return settings.get(o) ?? DEFAULT_AUTO_REPLY; },
    async saveSettings(o, s) { settings.set(o, s); },
    async addTemplate(t) { templates.push(t); },
    async approvedTemplate(o) { return templates.find(t => t.ownerUserId === o); },
    async insertDraft(d) {
      if (drafts.some(x => x.enquiryId === d.enquiryId && x.status === "queued")) return false;
      drafts.push(d);
      return true;
    },
    async get(id) { return drafts.find(d => d.id === id); },
    async listQueued(o) { return drafts.filter(d => d.status === "queued" && ownerOf(d.enquiryId) === o); },
    async finish(id, to) {
      const d = drafts.find(x => x.id === id);
      if (!d || d.status !== "queued") return false;
      d.status = to;
      return true;
    }
  };
}
