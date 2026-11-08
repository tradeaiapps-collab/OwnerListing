export interface ElenaConfig {
  port: number;
  /** name -> secret. Empty only allowed outside production. */
  apiKeys: Map<string, string>;
  mediaDir: string;
  /** Self-hosted text-to-speech endpoint: POST {"text"} -> audio bytes. Unset means /voice answers 501. */
  ttsUrl: string | undefined;
  ttsApiKey: string | undefined;
  requestsPerMinute: number;
  production: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, mediaDir: string): ElenaConfig {
  const apiKeys = new Map<string, string>();
  for (const part of (env["ELENA_API_KEYS"] ?? "").split(",")) {
    const i = part.indexOf(":");
    if (i > 0 && i < part.length - 1) apiKeys.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const production = env["NODE_ENV"] === "production";
  if (production && apiKeys.size === 0) throw new Error("ELENA_API_KEYS (name:secret,name:secret) is required in production.");
  return {
    port: Number(env["PORT"] ?? 3010), apiKeys, mediaDir: env["ELENA_MEDIA_DIR"] ?? mediaDir,
    ttsUrl: env["ELENA_TTS_URL"], ttsApiKey: env["ELENA_TTS_API_KEY"],
    requestsPerMinute: Number(env["ELENA_RATE_PER_MINUTE"] ?? 600), production
  };
}
