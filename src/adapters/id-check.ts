/**
 * Third-party ID check (document + live selfie). The provider holds the images; we keep only the provider reference
 * and the outcome. Results arrive by signed webhook (see src/server/id-check-webhook.ts).
 */
export interface IdCheckPort {
  /** False until a real provider is configured. Starting a session is refused while false. */
  readonly configured: boolean;
  /** `reference` is our opaque per-session value (never a name or email). Returns the provider's session reference and the URL to send the buyer to. */
  startSession(reference: string): Promise<{ providerRef: string; redirectUrl: string }>;
}

export function createUnconfiguredIdCheck(): IdCheckPort {
  return { configured: false, async startSession() { throw new Error("ID check is not configured."); } };
}

/** Add a real provider here. Any unknown or missing setting fails closed. */
export function idCheckFromEnv(_env: Readonly<Record<string, string | undefined>>): IdCheckPort {
  return createUnconfiguredIdCheck();
}
