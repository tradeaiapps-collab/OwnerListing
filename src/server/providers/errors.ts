export const PROVIDER_IDS = ["fcm", "apns", "mls", "zillow"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const isProviderId = (v: unknown): v is ProviderId => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);

export type ProviderErrorCode = "not_configured" | "timeout" | "network" | "rate_limited" | "auth" | "client" | "server" | "bad_response";

/** A failed call to an outside provider. The message never holds keys, headers or response bodies. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
    /** Worth trying again later (timeouts, 429, 5xx). */
    readonly retryable = false
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "server" : "client";
}
export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
