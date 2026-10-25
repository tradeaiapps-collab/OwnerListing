import { createOllamaEngine, readAiConfig, type OllamaConfig, type OllamaEngine } from "../adapters/ollama-engine";
import { rulesOnlyEngine, type AiEnginePort } from "../domain/ai-engine";
import { aiSwitchOn } from "./ai-switch-db";
import { getDb } from "./context";

let cached: { key: string; engine: OllamaEngine } | null = null;

/** One adapter per config, so its concurrency cap covers every request on this server. */
export function engineForConfig(cfg: OllamaConfig): OllamaEngine {
  const key = JSON.stringify(cfg);
  if (cached?.key !== key) cached = { key, engine: createOllamaEngine(cfg) };
  return cached.engine;
}

/**
 * The AI engine for this request. Two keys, both needed: the server config (AI_ENGINE=ollama with a valid local endpoint) and the
 * super-admin switch at /staff/ai (default OFF). Anything else, including a database error, is the rules-only engine (AI off).
 */
export async function getAiEngine(): Promise<AiEnginePort> {
  const cfg = readAiConfig(process.env);
  if (!cfg.ok) return rulesOnlyEngine;
  if (!(await aiSwitchOn(getDb()))) return rulesOnlyEngine;
  return engineForConfig(cfg.config);
}
