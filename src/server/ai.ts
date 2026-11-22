import { createOllamaEngine, readAiConfig, type OllamaConfig, type OllamaEngine } from "../adapters/ollama-engine";
import { createHostedEngine, readHostedConfig, type HostedConfig, type HostedEngine } from "../adapters/hosted-engine";
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

let cachedHosted: { key: string; engine: HostedEngine } | null = null;
export function hostedEngineForConfig(cfg: HostedConfig): HostedEngine {
  const key = JSON.stringify(cfg);
  if (cachedHosted?.key !== key) cachedHosted = { key, engine: createHostedEngine(cfg) };
  return cachedHosted.engine;
}

/**
 * The AI engine for this request. Two keys, both needed: the server config (AI_ENGINE=ollama with a valid local endpoint) and the
 * super-admin switch at /staff/ai (default OFF). Anything else, including a database error, is the rules-only engine (AI off).
 */
export async function getAiEngine(): Promise<AiEnginePort> {
  const hosted = readHostedConfig(process.env);
  const cfg = hosted.ok ? undefined : readAiConfig(process.env);
  if (!hosted.ok && !cfg?.ok) return rulesOnlyEngine;
  if (!(await aiSwitchOn(getDb()))) return rulesOnlyEngine;
  return hosted.ok ? hostedEngineForConfig(hosted.config) : engineForConfig((cfg as { ok: true; config: OllamaConfig }).config);
}
