import { checkProviders } from "../../config/provider-check.mjs";
import { ProviderError, type ProviderId } from "./errors";
import { createProviderClient } from "./registry";

type Env = Record<string, string | undefined>;
export interface ProviderHealth {
  provider: ProviderId; label: string;
  /** Mirrors npm run check:providers: ready | off | incomplete | invalid. Never holds key values. */
  config: "ready" | "off" | "incomplete" | "invalid";
  missing: string[];
  /** Only when probed and configured. reachable: the server answered. credentialsAccepted: it did not answer 401/403. */
  probe?: { reachable: boolean; credentialsAccepted: boolean | null; latencyMs: number; error?: string };
}

/** Maps check:providers ids to provider ids (webpush has no provider table row and is left out). */
const CHECK_IDS: Record<ProviderId, string> = { fcm: "fcm", apns: "apns", mls: "mls", zillow: "zillow" };

/**
 * Configuration status for every provider, plus (probe=true) a live GET against the MLS and Zillow API (MLS_HEALTH_PATH /
 * ZILLOW_HEALTH_PATH, default "/"). FCM and APNs are not probed yet: their clients land with their own PRs. A probe sends the
 * real API key, so it is for staff to run on purpose, never on a public route.
 */
export async function providerHealth(env: Env, opts: { probe?: boolean; now?: () => number } = {}, over: Parameters<typeof createProviderClient>[2] = {}): Promise<ProviderHealth[]> {
  const checks = checkProviders(env);
  const now = opts.now ?? Date.now;
  const out: ProviderHealth[] = [];
  for (const id of Object.keys(CHECK_IDS) as ProviderId[]) {
    const c = checks.find(x => x.id === CHECK_IDS[id]);
    if (!c) continue;
    const h: ProviderHealth = { provider: id, label: c.label, config: c.status, missing: c.missing };
    if (opts.probe && c.status === "ready" && (id === "mls" || id === "zillow")) {
      const started = now();
      const path = env[`${id.toUpperCase()}_HEALTH_PATH`]?.trim() || "/";
      try {
        // One attempt only: a health check should report a flaky provider, not hide it behind retries.
        await createProviderClient(id, env, { maxRetries: 0, timeoutMs: 5_000, ...over }).get(path);
        h.probe = { reachable: true, credentialsAccepted: true, latencyMs: now() - started };
      } catch (e) {
        const pe = e instanceof ProviderError ? e : undefined;
        const answered = pe?.status !== undefined;
        h.probe = { reachable: answered, credentialsAccepted: answered ? pe!.code !== "auth" : null, latencyMs: now() - started, error: pe?.code ?? "unknown" };
      }
    }
    out.push(h);
  }
  return out;
}
