import { randomUUID } from "node:crypto";
import type { AiEnginePort } from "../domain/ai-engine";
import type { Enquiry, EnquiryMessage } from "../domain/enquiry-service";
import { mergeAiReview, reviewWithAi, scanInboundMessage, type SafetyResult } from "../domain/message-safety";
import { insertSafetyFlagPg, setAiPausePg } from "./ai-records-db";
import type { Queryable } from "./db";

/** The AI second opinion may add a flag but must never hold up a buyer's message. */
export const AI_REVIEW_BUDGET_MS = 3000;

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>(res => setTimeout(() => res(undefined), ms).unref?.())]);

export interface ScreenDeps {
  db: Queryable;
  engine: () => Promise<AiEnginePort>;
  appendAudit: (e: import("../domain/audit").AuditEvent) => Promise<void>;
  now: () => string;
}

/**
 * Runs the safety filter on a message the buyer just sent and records the result. Owner and agent messages are not screened.
 * Never throws: a failure here must not lose the buyer's message, which is already stored.
 */
export async function screenBuyerMessage(deps: ScreenDeps, enquiry: Enquiry, message: EnquiryMessage): Promise<SafetyResult | undefined> {
  if (message.automated || message.senderUserId !== enquiry.buyerUserId) return undefined;
  try {
    let result = scanInboundMessage(message.body);
    if (result.risk !== "high") result = mergeAiReview(result, await within(reviewWithAi(await deps.engine(), message.body), AI_REVIEW_BUDGET_MS));
    if (result.risk === "none") return result;
    const at = deps.now();
    if (await insertSafetyFlagPg(deps.db, randomUUID(), enquiry.id, message.id, result, at)) {
      if (result.handoff) await setAiPausePg(deps.db, enquiry.id, true, `Safety filter: ${result.flags.map(f => f.category).join(", ")}`, null, at);
      await deps.appendAudit({
        id: randomUUID(), occurredAt: at, actorType: "system", actorId: "system:message-safety",
        aggregateType: "enquiry", aggregateId: enquiry.id, eventType: "enquiry.safety_flagged", correlationId: randomUUID(),
        payload: { messageId: message.id, risk: result.risk, categories: result.flags.map(f => f.category), handoff: result.handoff, staffReview: result.staffReview }
      });
    }
    return result;
  } catch {
    return undefined;
  }
}

/** Wired from the shared pool, like getEnquiryDeps. */
export async function screenWithDefaults(enquiry: Enquiry, message: EnquiryMessage): Promise<SafetyResult | undefined> {
  try {
    const { getDb, getDeps } = await import("./context");
    const { getAiEngine } = await import("./ai");
    const base = getDeps();
    return await screenBuyerMessage({ db: getDb(), engine: getAiEngine, appendAudit: base.appendAudit, now: base.now }, enquiry, message);
  } catch {
    return undefined;
  }
}
