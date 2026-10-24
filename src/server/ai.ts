import { rulesOnlyEngine, type AiEnginePort } from "../domain/ai-engine";

/** The AI engine for this server. Until the self-hosted model is installed and wired here, it is the rules-only engine (AI off). */
export function getAiEngine(): AiEnginePort {
  return rulesOnlyEngine;
}
