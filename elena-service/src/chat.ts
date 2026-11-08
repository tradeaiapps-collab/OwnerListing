import { createHash } from "node:crypto";
import { CONTACT_RE, chatAnswer, chatWelcome, showMeFor, type ChatTopic, type ShowMe } from "./engine.ts";
import { ELENA_RULES } from "./rules.ts";
import { BadRequest, type ChatRequest } from "./schema.ts";

export type AnswerType = "advice" | "info" | "clarification";
const answerType = (t: ChatTopic): AnswerType => (t === "advice" || t === "privacy" ? "advice" : t === "unknown" ? "clarification" : "info");

export interface ChatResponse {
  version: "v1"; rules_version: string; response_id: string; text: string; answer_type: AnswerType; topic: ChatTopic;
  pose: string; suggestions: string[]; show_me?: ShowMe; highlight?: { places: ShowMe["places"] }; voice_url: string;
}

/** Same request, same id, so the voice cache can be shared between callers and retries. */
export const responseId = (text: string) => createHash("sha256").update(ELENA_RULES.version).update(text).digest("hex").slice(0, 24);

export function answerChat(req: ChatRequest): ChatResponse {
  if (req.question !== undefined && CONTACT_RE.test(req.question)) {
    throw new BadRequest("Please leave phone numbers, emails and links out of questions to Elena.", 422);
  }
  const a = req.question === undefined ? chatWelcome(req.facts, req.personaName) : chatAnswer(req.facts, req.role, req.question);
  const showMe = showMeFor(a.topic, req.role, req.facts);
  const id = responseId(a.text);
  return {
    version: "v1", rules_version: ELENA_RULES.version, response_id: id, text: a.text, answer_type: answerType(a.topic), topic: a.topic,
    pose: a.pose, suggestions: a.suggestions, ...(showMe ? { show_me: showMe, highlight: { places: showMe.places } } : {}), voice_url: `/api/v1/voice/${id}`
  };
}
