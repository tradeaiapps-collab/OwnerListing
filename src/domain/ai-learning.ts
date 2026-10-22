/** Admin chooses which engine runs. Default is the safer prompts-and-templates engine. */
export type AiEngine = "prompts_templates" | "trained_model";

export interface AiEngineSetting { engine: AiEngine; changedBy: string; changedAt: string }

export function selectEngine(latest?: AiEngineSetting): AiEngine {
  return latest?.engine ?? "prompts_templates";
}

export interface HumanDecisionEvent {
  id: string;
  occurredAt: string;
  area: "negotiation" | "enquiry" | "contract" | "broker";
  aiSuggestion: string;
  humanAction: "accepted" | "edited" | "rejected" | "took_over";
  humanFinalText?: string;
  /** Coded facts about the situation (round number, offer vs list %, conditions). No names or contact details. */
  situation: Readonly<Record<string, string | number | boolean>>;
  /** Pseudonymous key chosen by the platform. Never an email, name or phone number. */
  subjectKey: string;
  /** True only when the person accepted a terms version containing the AI-learning clause (see aiLearningCovered). */
  consentForTraining: boolean;
}

export interface TrainingRecord {
  id: string;
  area: HumanDecisionEvent["area"];
  aiSuggestion: string;
  humanAction: HumanDecisionEvent["humanAction"];
  humanFinalText?: string;
  situation: Readonly<Record<string, string | number | boolean>>;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(\+?61|0)[\s-]?\d(?:[\s-]?\d){7,9}/g;

/** Defence in depth only: removes obvious emails and phone numbers. Real de-identification needs review. */
export function redact(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
}

/** Returns null unless the person consented. The subject key is dropped so the record is not linked back. */
export function toTrainingRecord(e: HumanDecisionEvent): TrainingRecord | null {
  if (!e.consentForTraining) return null;
  const rec: TrainingRecord = {
    id: e.id,
    area: e.area,
    aiSuggestion: redact(e.aiSuggestion),
    humanAction: e.humanAction,
    situation: e.situation
  };
  if (e.humanFinalText !== undefined) rec.humanFinalText = redact(e.humanFinalText);
  return rec;
}
