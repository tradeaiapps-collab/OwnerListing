import type { Jurisdiction } from "./jurisdiction";

export type LicenceStatus = "pending" | "verified" | "expired" | "revoked";

export interface AgentLicence {
  userId: string;
  jurisdiction: Jurisdiction;
  status: LicenceStatus;
  /** ISO date (YYYY-MM-DD). Absent means no recorded expiry. */
  expiresAt?: string;
}

/**
 * True only when a verified, unexpired licence exists for the agent in the given state.
 * `today` is passed in so the check is deterministic and testable.
 */
export function hasVerifiedLicence(
  licences: readonly AgentLicence[],
  userId: string,
  jurisdiction: Jurisdiction,
  today: string
): boolean {
  return licences.some(l =>
    l.userId === userId &&
    l.jurisdiction === jurisdiction &&
    l.status === "verified" &&
    (l.expiresAt === undefined || l.expiresAt >= today)
  );
}
